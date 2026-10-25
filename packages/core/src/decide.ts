/**
 * Decision cards: a brief on each item that reaches you. Facts first, gathered without a model (the dashboard's state, the
 * ticket and its comments from the tracker, the lead's question and default), and that's the card. Only when you press
 * Explain does ONE short read-only call on your own agent account phrase what / why / the recommendation from those
 * facts alone. Cached by the facts' hash, capped per day, bounded in time, and the facts alone stand in whenever no call
 * can be made. Nothing here writes to a tracker or a repo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Brief,
  CHOICE_IDS,
  clip,
  type DashboardState,
  factsBrief as fromFacts,
  type MoreFacts,
  plainLine,
  plainText,
  withChoices,
} from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { z } from "zod";
import { activeRepos } from "./agent";
import { cachedCheckup } from "./checkup";
import { claude } from "./claude";
import { redactSecrets } from "./corners";
import { CLIENTS, OPS, today } from "./env";
import { loadState, readJson, writeJsonAtomic } from "./state";
import { tickets } from "./trackers/index";

/** Briefs an agent phrases per day (each one an Explain you pressed); past it, the facts alone stand in until tomorrow. */
const DAILY_CAP = 40;
/** How long one phrasing may take before the facts stand in (it isn't asked again until the item changes). */
const ITEM_TIMEOUT_MS = 90_000;
/** The cheapest model that writes a good sentence; runtimes other than Claude Code use their account's own model. */
const BRIEF_MODEL = "haiku";

/** The brief on one item from facts alone, in plain words (an action card's own words). Null when the item isn't there. */
export const factsBrief = (s: DashboardState, id: string, more: MoreFacts = {}, now = Date.now()): Brief | null =>
  fromFacts(s, id, more, now, plainWords);

/** What the agent is shown: the facts, secrets blanked, nothing but text (never code, never a path to read). */
export function briefFacts(b: Brief, more: MoreFacts): string {
  const options = b.options.map(({ id, ...o }) => ({ id, ...o, ...("brief" in o ? { brief: clip(o.brief, 200) } : {}) }));
  const facts = {
    kind: b.kind,
    project: b.project,
    what: b.what,
    why: b.why,
    evidence: b.evidence.map((e) => e.text),
    ...(b.detail ? { detail: clip(b.detail, 1500) } : {}),
    options,
    ifNothing: b.ifNothing?.text ?? "",
    ...(more.description ? { description: clip(more.description, 800) } : {}),
    ...(more.comments?.length ? { comments: more.comments.slice(-3).map((c) => clip(c, 500)) } : {}),
  };
  return redactSecrets(JSON.stringify(facts));
}

/** What the agent answers: the brief's three sentences and its pick; for a lead, up to three answers to offer. */
const AnswerSchema = z.object({
  what: z.string().min(1).max(300),
  why: z.string().min(1).max(400),
  recommend: z.object({ option: z.string(), reason: z.string().min(1).max(300), confidence: z.enum(["low", "medium", "high"]) }),
  choices: z.array(z.string().min(1).max(200)).max(3).optional(),
});
type Answer = z.infer<typeof AnswerSchema>;

/** Whether the item asks a question an answer choice settles: a lead's, or the agent's on a blocked ticket. */
const choosing = (b: Brief) => b.kind === "lead" || (b.kind === "ticket" && b.ifNothing !== null);

/** The JSON Schema the agent's answer is held to; `option` must be one of the brief's option ids. */
function answerSchema(b: Brief): string {
  const str = { type: "string" };
  return JSON.stringify({
    type: "object",
    properties: {
      what: str,
      why: str,
      recommend: {
        type: "object",
        properties: {
          option: { type: "string", enum: [...b.options.map((o) => o.id), ...(choosing(b) ? CHOICE_IDS : [])] },
          reason: str,
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["option", "reason", "confidence"],
      },
      ...(choosing(b) ? { choices: { type: "array", items: str, maxItems: 3 } } : {}),
    },
    required: ["what", "why", "recommend"],
  });
}

/** The prompt: the facts, and the rules (no tools, no merge, plain words). */
function briefPrompt(facts: string): string {
  return [
    "Write a decision card for a busy engineering lead about ONE item in their Overhand, from the FACTS below only.",
    "Use no tools: don't read files, run commands, browse, or post anything anywhere.",
    "what: one plain sentence (at most 20 words). why: the actual blocker (at most 30 words).",
    "recommend.option: the id of the one option they should take; recommend.reason: why (at most 25 words); confidence: low, medium or high.",
    "Never recommend merging: merging stays a person's, on the code host (or GitHub's auto-merge, on a Ship project). For a question (a lead's, or the agent's on a ticket), choices: up to 3 short answers in the owner's voice, and recommend the best as choice-1, choice-2 or choice-3.",
    "Reply with only the JSON object.",
    "",
    `FACTS: ${facts}`,
  ].join("\n");
}

/** The agent's answer laid over the facts: its words and pick (when the pick is a real option), its answer choices added. */
export function withAnswer(b: Brief, a: Answer): Brief {
  const options = choosing(b) ? withChoices(b, a.choices ?? []) : b.options;
  const recommend = options.some((o) => o.id === a.recommend.option) ? a.recommend : b.recommend;
  // its words as plain sentences, whatever Markdown it slipped in: the card leads with them
  const what = plainLine(a.what, 140) || b.what;
  const why = clip(plainText(a.why), 240) || b.why;
  return { ...b, what, why, recommend, options, source: "agent" };
}

// ---------- the cache, the cap, the call ----------

interface Store {
  day: string;
  /** Agent phrasings today. */
  used: number;
  briefs: Record<string, Brief>;
  snoozed: Record<string, number>;
}

const FILE = () => join(OPS, "briefs.json");
const blank = (): Store => ({ day: today(), used: 0, briefs: {}, snoozed: {} });
function load(): Store {
  const s = { ...blank(), ...readJson<Partial<Store>>(FILE(), {}) };
  return s.day === today() ? s : { ...s, day: today(), used: 0 };
}
function save(s: Store): void {
  // the newest 300 briefs are plenty; the rest are for items long gone
  const briefs = Object.fromEntries(
    Object.entries(s.briefs)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, 300),
  );
  writeJsonAtomic(FILE(), { ...s, briefs });
}

/** Snoozes an item for `hours`: Needs you leaves it out till then. */
export function snoozeItem(id: string, hours: number, now = Date.now()): number {
  const s = load();
  const until = now + hours * 3_600_000;
  s.snoozed[id] = until;
  save(s);
  return until;
}

/** Items snoozed now, until when. */
export function snoozedItems(now = Date.now()): Record<string, number> {
  return Object.fromEntries(Object.entries(load().snoozed).filter(([, until]) => until > now));
}

/** One phrasing: the agent's answer, or null when no account could take it or the answer didn't fit. */
export type Phrase = (b: Brief, facts: string) => Promise<Answer | null>;

/**
 * The real phrasing: one short run on the user's own agent account (the project's accounts when it has any), with the
 * cheapest capable model, read-only whatever the project's level, in an empty folder so there's no code to read.
 */
export async function phrase(b: Brief, facts: string, agent: typeof claude = claude): Promise<Answer | null> {
  const client = CLIENTS.find((c) => c.name === b.project);
  const cwd = mkdtempSync(join(tmpdir(), "overhand-brief-"));
  try {
    const run = await agent<unknown>(loadState(), briefPrompt(facts), cwd, answerSchema(b), `brief-${b.kind}`, {
      model: BRIEF_MODEL,
      autonomy: "watch",
      ...(client ? { client } : {}),
    });
    const r = run ? AnswerSchema.safeParse(run.out) : null;
    return r?.success ? r.data : null;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const inflight = new Map<string, Promise<void>>();

/**
 * The brief on one item: the agent's phrasing when it's cached for these facts, else the facts. With `explain` (you
 * pressed Explain), and when the day's cap and the budget pause allow, one phrasing starts in the background
 * (`pending`); one that fails leaves the facts, and Explain asks again. Null when the item isn't there.
 */
export function briefFor(
  s: DashboardState,
  id: string,
  more: MoreFacts = {},
  opts: { explain?: boolean; phrase?: Phrase; now?: number; timeoutMs?: number; cap?: number } = {},
): { brief: Brief; done: Promise<void> } | null {
  const now = opts.now ?? Date.now();
  const facts = factsBrief(s, id, more, now);
  if (!facts) return null;
  const text = briefFacts(facts, more);
  const hash = Bun.hash(text).toString(36);
  const store = load();
  const hit = store.briefs[id];
  if (hit && hit.hash === hash) return { brief: { ...hit, pending: false }, done: Promise.resolve() };
  const base = { ...facts, hash };
  const running = inflight.get(id);
  if (running) return { brief: { ...base, pending: true }, done: running };
  if (!opts.explain || store.used >= (opts.cap ?? DAILY_CAP) || s.paused) return { brief: base, done: Promise.resolve() };
  store.used += 1;
  save(store);
  const call = opts.phrase ?? phrase;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((ok) => {
    timer = setTimeout(() => ok(null), opts.timeoutMs ?? ITEM_TIMEOUT_MS);
  });
  // ponytail: a timed-out run is left to its CLI's own task timeout; the facts stand in until Explain asks again
  const done = Promise.race([call(base, text).catch(() => null), timeout])
    .then((a) => {
      if (!a) return;
      const st = load();
      st.briefs[id] = { ...withAnswer(base, a), at: Date.now() };
      save(st);
    })
    .finally(() => {
      clearTimeout(timer);
      inflight.delete(id);
    });
  inflight.set(id, done);
  return { brief: { ...base, pending: true }, done };
}

const memo = new Map<string, { at: number; more: MoreFacts }>();

/**
 * What the tracker and the check-up add for one item, read-only: a ticket's description and newest comments (kept for two
 * minutes, so a drawer asking again doesn't refetch), a check-up finding (`checkup:<repo>:<finding id>`). Empty otherwise.
 */
export async function moreFacts(id: string): Promise<MoreFacts> {
  const hit = memo.get(id);
  if (hit && Date.now() - hit.at < 120_000) return hit.more;
  let more: MoreFacts = {};
  if (id.startsWith("ticket:")) {
    const key = id.slice("ticket:".length);
    const c = CLIENTS.find((x) => key.startsWith(`${x.prefix}-`));
    const t = c ? (await tickets(c, { key }).catch(() => []))[0] : undefined;
    if (t) more = { description: t.description, comments: t.comments.slice(-3) };
  } else if (id.startsWith("checkup:")) {
    const [, repo = "", finding = ""] = id.split(":");
    const path = CLIENTS.flatMap((c) => activeRepos(c)).find((p) => basename(p) === repo);
    if (path) {
      const r = await cachedCheckup(path).catch(() => null);
      const f = r?.findings.find((x) => x.id === finding);
      if (r && f) more = { checkup: { repo, finding: f } };
    }
  }
  memo.set(id, { at: Date.now(), more });
  return more;
}
