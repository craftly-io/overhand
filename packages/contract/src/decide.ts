/**
 * Decision cards: for each thing that reaches you, what it is, why it waits on you, what Overhand recommends, the facts
 * behind it, what you can do (as actions the dashboard runs) and what happens if you do nothing.
 */
import { z } from "zod";
import { buildsItself } from "./autonomy";
import type { CheckupFinding, DashboardState, Lead } from "./index";
import { openText } from "./leads";
import { clip, plainLine, questionLine } from "./plain";

/** The dashboard's words, by key (`@overhand/themes`), for the few briefs that reuse them. */
type Words = Readonly<Record<string, string>>;

/** What an action card's buttons do; Show and Connect are the dashboard's own, the rest Overhand does. */
export const CardButtonSchema = z.enum([
  "stop",
  "allow-until",
  "always-allow",
  "connect",
  "one-at-a-time",
  "close-pr",
  "keep",
  "pause",
  "show",
  "more-time",
  "resend",
  "drop",
  "quiet",
]);

/** Every kind of item a brief can be about. */
export const BRIEF_KINDS = [
  "ticket",
  "lead",
  "pr",
  "review",
  /** Several reviews asked of you in one repo, as Needs you groups them ("reviews:<repo>"). */
  "reviews",
  /** Several of your PRs in one repo with changes asked ("changes:<repo>"). */
  "changes",
  "ci",
  "errors",
  "held",
  "card",
  "guard",
  "disk",
  "account",
  "checkup",
  "organise",
] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

const opt = <T extends z.ZodRawShape>(shape: T) => z.object({ id: z.string(), ...shape });

/**
 * One thing you can do about an item, as an action the dashboard runs (never a merge: that stays yours, on the code host).
 * `answer` sends `text` to a lead; `reply` answers a ticket's question with `text` (posted and re-queued, or on watch
 * held for you to post); `assign` hands it to an agent (a ticket, a held finding or a task); `ready` marks an
 * agent's draft PR ready; `link` opens it outside (`what` says where); `drawer` opens it here; `card` presses an action
 * card's button; `quiet` turns quiet mode on; `post` sends a held comment; `dismiss` drops it; `snooze` hides it from
 * Needs you for `hours`; `organise` acts on an organising suggestion; `replan` drops a plan and puts its request back
 * in the command bar to say it differently.
 */
export const BriefOptionSchema = z.discriminatedUnion("do", [
  opt({ do: z.literal("answer"), lead: z.string(), text: z.string() }),
  opt({ do: z.literal("reply"), key: z.string(), text: z.string() }),
  opt({
    do: z.literal("assign"),
    project: z.string(),
    key: z.string().default(""),
    finding: z.string().default(""),
    title: z.string().default(""),
    brief: z.string().default(""),
  }),
  opt({ do: z.literal("ready"), key: z.string() }),
  opt({ do: z.literal("link"), url: z.string(), what: z.enum(["ticket", "pr", "review", "merge", "ci", "error"]) }),
  opt({
    do: z.literal("drawer"),
    drawer: z.enum(["ticket", "review", "lead", "sweep", "settings", "crew", "health"]),
    key: z.string().default(""),
    tab: z.string().default(""),
  }),
  opt({ do: z.literal("card"), card: z.string(), button: CardButtonSchema }),
  opt({ do: z.literal("quiet"), hours: z.number() }),
  opt({ do: z.literal("post"), finding: z.string(), key: z.string() }),
  opt({ do: z.literal("dismiss"), what: z.enum(["held", "lead"]), target: z.string() }),
  opt({ do: z.literal("snooze"), hours: z.number() }),
  opt({ do: z.literal("replan"), finding: z.string(), project: z.string(), text: z.string() }),
  // an organising suggestion (organise.ts): apply it, show its dry run, or leave it; `label` says what applying does
  opt({ do: z.literal("organise"), suggestion: z.string(), action: z.enum(["apply", "dismiss", "preview"]), label: z.string() }),
]);
export type BriefOption = z.infer<typeof BriefOptionSchema>;

/** A plan an agent wrote for a request you started: what it would change and what you'll see, in plain words. */
export const PlanPointsSchema = z.object({ changes: z.array(z.string()), see: z.array(z.string()) });
export type PlanPoints = z.infer<typeof PlanPointsSchema>;

/**
 * Reads an agent's plan into its two parts. It is asked for "What changes:" and "What you'll see:" with a few points
 * each; free text (no headings) becomes its first sentences as what changes.
 */
export function planPoints(text: string): PlanPoints {
  const out: PlanPoints = { changes: [], see: [] };
  let part: keyof PlanPoints | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head =
      /^(?:#+\s*)?\**\s*what\s+(?:(changes|i'?d\s+change|will\s+change)|(you'?ll\s+see|you\s+will\s+see))\s*\**\s*:?\s*\**\s*(.*)$/i.exec(
        line,
      );
    if (head) {
      part = head[1] ? "changes" : "see";
      if (head[3]?.trim()) out[part].push(head[3].trim());
      continue;
    }
    const point = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (part && point) out[part].push(point);
  }
  if (out.changes.length || out.see.length) return { changes: out.changes.slice(0, 4), see: out.see.slice(0, 2) };
  // free text: its lines are the points, or a single paragraph's sentences
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const points = lines.length > 1 ? lines : (text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map((s) => s.trim());
  return { changes: points.filter(Boolean).slice(0, 4), see: [] };
}

/** The brief on one item: built from facts, then (when an agent account is free) phrased by one short read-only call. */
export const BriefSchema = z.object({
  /** `<kind>:<key>`, the same item id the team feed uses (`ticket:EW-1`, `lead:core`, `pr:EW-1`, `ci:Proj/repo@main`). */
  id: z.string(),
  kind: z.enum(BRIEF_KINDS),
  project: z.string(),
  /** One plain sentence. */
  what: z.string(),
  /** The actual blocker. */
  why: z.string(),
  /** `option` is one of `options`' ids. */
  recommend: z.object({ option: z.string(), reason: z.string(), confidence: z.enum(["low", "medium", "high"]) }),
  evidence: z.array(z.object({ text: z.string(), url: z.string().default("") })),
  /** The source text in full (a lead's question, the agent's comment), as Markdown: shown under Details, never cut. */
  detail: z.string().optional(),
  options: z.array(BriefOptionSchema),
  /** What happens if you don't act: the default and when it applies (`at`, 0 = no deadline); null when nothing happens. */
  ifNothing: z.object({ text: z.string(), at: z.number() }).nullable(),
  /** `agent`: phrased by your agent account from the facts; `facts`: the facts alone (no account free, capped, or failed). */
  source: z.enum(["agent", "facts"]),
  /** The facts' hash: the brief is phrased again only when it changes. */
  hash: z.string(),
  at: z.number(),
  /** An agent is phrasing it now: ask again in a few seconds. */
  pending: z.boolean().default(false),
  /** A plan waiting for your go-ahead: shown in full on its card. */
  plan: PlanPointsSchema.optional(),
});
export type Brief = z.infer<typeof BriefSchema>;

/** The ids an agent's answer choices get (`choice-1`…): its recommendation may name one before they exist. */
export const CHOICE_IDS = ["choice-1", "choice-2", "choice-3"] as const;

/**
 * Answer choices as one-click options, ahead of the rest: a lead's become `answer`s, a blocked ticket's `reply`s (what
 * its agent asked). Texts already offered are skipped; other kinds take none.
 */
export function withChoices(b: Brief, choices: readonly string[]): BriefOption[] {
  const said = (o: BriefOption) => (o.do === "answer" || o.do === "reply" ? o.text.toLowerCase() : "");
  const have = new Set(b.options.map(said).filter(Boolean));
  const key = b.id.slice(b.kind.length + 1);
  const fresh = choices.filter((c) => !have.has(c.toLowerCase())).slice(0, CHOICE_IDS.length);
  const extra: BriefOption[] =
    b.kind === "lead"
      ? fresh.map((text, i) => ({ id: `choice-${i + 1}`, do: "answer", lead: key, text }))
      : b.kind === "ticket"
        ? fresh.map((text, i) => ({ id: `choice-${i + 1}`, do: "reply", key, text }))
        : [];
  return [...extra, ...b.options];
}

/** The kind an item id names, or null when it names none. */
export function briefKindOf(id: string): BriefKind | null {
  const head = id.split(":")[0];
  return BRIEF_KINDS.find((k) => k === head) ?? null;
}

/** Facts beyond the dashboard's state: a ticket's description and newest comments, a check-up finding. */
export interface MoreFacts {
  description?: string;
  comments?: string[];
  checkup?: { repo: string; finding: CheckupFinding };
}

type Body = Omit<Brief, "id" | "kind" | "source" | "hash" | "at" | "pending">;

const fill = (t: string, facts: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k: string) => String(facts[k] ?? ""));
const snooze: BriefOption = { id: "snooze", do: "snooze", hours: 24 };
const list = <T>(x: T[] | string): T[] => (Array.isArray(x) ? x : []);
const autonomyOf = (s: DashboardState, project: string) => s.clients.find((c) => c.name === project)?.autonomy ?? "act";
/** Assign an agent is offered on watch and propose; on act agents build on their own already (the daemon refuses it). */
const assignable = (s: DashboardState, project: string, key = "") =>
  s.clients.some((c) => c.name === project) && !buildsItself(autonomyOf(s, project)) && !(key && s.assigned.some((a) => a.key === key));
function ticketBrief(s: DashboardState, key: string, more: MoreFacts): Body | null {
  const [project, t] =
    Object.entries(s.tickets)
      .flatMap(([c, ts]) => list(ts).map((x) => [c, x] as const))
      .find(([, x]) => x.key === key) ?? [];
  if (!project || !t) return null;
  const pr = s.prs.find((p) => p.key === key);
  const ghPr = pr ? s.status.myPrs.find((p) => p.url === pr.url) : undefined;
  const split = s.splits[key];
  const blocked = t.labels.includes(s.labels.blocked);
  const asked = more.comments?.at(-1)?.trim() ?? "";
  // the agent's question may name its answers (`Options: A | B`): each is one click
  const replies: BriefOption[] = blocked ? leadChoices(asked).map((text, i) => ({ id: `reply-${i + 1}`, do: "reply", key, text })) : [];
  const options: BriefOption[] = [...replies, { id: "open-ticket", do: "link", url: t.url, what: "ticket" }];
  if (pr) options.push({ id: "review", do: "drawer", drawer: "review", key, tab: "" });
  if (split) options.push({ id: "split", do: "drawer", drawer: "ticket", key, tab: "" });
  if (assignable(s, project, key)) options.push({ id: "assign", do: "assign", project, key, finding: "", title: t.title, brief: "" });
  options.push(snooze);
  const evidence = [
    { text: `${key} · ${t.status} · ${t.priority || "no priority"}`, url: t.url },
    ...(pr ? [{ text: `PR ${ghPr ? `#${ghPr.number}` : pr.branch}${ghPr ? ` · checks ${ghPr.checks || "none"}` : ""}`, url: pr.url }] : []),
    ...(more.description && plainLine(more.description) ? [{ text: `Asks for: ${plainLine(more.description, 160)}`, url: "" }] : []),
  ];
  const detail = asked || undefined;
  if (split)
    return {
      project,
      what: `${key} is too big for one PR; the agent proposed ${split.length} smaller tickets.`,
      why: "Nothing is built until you file the split (edited or as proposed).",
      recommend: { option: "split", reason: "Smaller tickets each fit one reviewable PR.", confidence: "medium" },
      evidence: [...evidence, ...split.map((p, i) => ({ text: `Part ${i + 1}: ${p.title}`, url: "" }))],
      detail,
      options,
      ifNothing: { text: "It stays unbuilt; no agent picks up a ticket waiting on a split.", at: 0 },
    };
  return {
    project,
    what: blocked ? `${key} waits on your answer: ${t.title}` : `${key}: ${t.title}`,
    why: blocked
      ? asked
        ? `The agent stopped and asked: ${plainLine(asked, 160) || "see Details."}`
        : `The agent stopped and labelled it ${s.labels.blocked}: it needs a decision only you can make, on the ticket.`
      : `It's ${t.status.toLowerCase()} in the tracker.`,
    recommend: {
      option: "open-ticket",
      reason: blocked
        ? `Answer on the ticket, then hand it back${assignable(s, project, key) ? " with Assign" : ` by removing ${s.labels.blocked}`}.`
        : "The tracker has the full story.",
      confidence: blocked ? "medium" : "low",
    },
    evidence,
    detail,
    options,
    ifNothing: blocked ? { text: "It stays blocked: no agent picks it up until you answer.", at: 0 } : null,
  };
}

/** A lead question's answer choices from its own `Options: A | B` line. */
export function leadChoices(text: string): string[] {
  const line = text.split("\n").find((l) => /^\s*options?:/i.test(l));
  return line
    ? line
        .replace(/^\s*options?:/i, "")
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
}

function leadBrief(s: DashboardState, key: string, now: number): Body | null {
  const g: Lead | undefined = s.godmode.find((x) => x.key === key);
  if (!g) return null;
  // only what's open: the file also holds the conversation before it (answers, messages, replies)
  const text = openText(g.inbox?.text ?? "");
  // the question as one plain sentence, outside tables and code (the whole text is under Details)
  const question = questionLine(text, 100);
  const ask = g.ask;
  const options: BriefOption[] = leadChoices(text).map((c, i) => ({ id: `answer-${i + 1}`, do: "answer", lead: key, text: c }));
  if (ask?.default) options.push({ id: "answer-default", do: "answer", lead: key, text: `Go with your default: ${ask.default}` });
  options.push({ id: "write", do: "drawer", drawer: "lead", key, tab: "" });
  if (ask?.stale) options.push({ id: "dismiss", do: "dismiss", what: "lead", target: key });
  if (autonomyOf(s, g.project) === "watch" && text)
    options.push({
      id: "assign",
      do: "assign",
      project: g.project,
      key: "",
      finding: "",
      title: `${g.label}: ${clip(question, 100)}`,
      brief: text,
    });
  options.push(snooze);
  const stale = ask?.stale?.closed.length ? `It names ${ask.stale.closed.join(", ")}, closed since it asked.` : "";
  const recommend: Brief["recommend"] = stale
    ? { option: "dismiss", reason: "What it asks about has closed since; the question may no longer apply.", confidence: "medium" }
    : ask?.default
      ? { option: "answer-default", reason: "The lead's own default is reasonable and keeps it moving.", confidence: "low" }
      : { option: "write", reason: "There's no default: only your answer moves it.", confidence: "medium" };
  return {
    project: g.project,
    what: question ? `${g.label} asks: ${question}` : `${g.label} waits for your answer.`,
    why: [`${g.label} stopped on ${g.project} until you decide.`, stale].filter(Boolean).join(" "),
    recommend,
    evidence: g.inbox ? [{ text: `Asked ${new Date(g.inbox.at).toISOString().slice(11, 16)} UTC`, url: "" }] : [],
    detail: text || undefined,
    options,
    ifNothing: !ask?.default
      ? { text: "It waits for you; nothing moves on this.", at: 0 }
      : { text: `${g.label} goes with: ${ask.default}`, at: ask.deadline > now || ask.deadline === 0 ? ask.deadline : now },
  };
}

function prBrief(s: DashboardState, key: string): Body | null {
  const p = s.prs.find((x) => x.key === key);
  if (!p) return null;
  const gh = s.status.myPrs.find((x) => x.url === p.url);
  const project = gh?.client ?? s.clients.find((c) => key.startsWith(`${c.prefix}-`))?.name ?? "";
  const block = p.corners.filter((c) => c.severity === "block");
  const red = /FAILURE|ERROR/.test(gh?.checks ?? "");
  const gaps = p.proof?.gaps ?? [];
  const options: BriefOption[] = [{ id: "review", do: "drawer", drawer: "review", key, tab: "" }];
  if (p.draft) options.push({ id: "ready", do: "ready", key });
  options.push({ id: "open-pr", do: "link", url: p.url, what: p.draft || red || block.length ? "pr" : "merge" }, snooze);
  const evidence = [
    { text: `${gh ? `#${gh.number} ` : ""}${gh?.title ?? p.branch}`, url: p.url },
    ...(gh ? [{ text: `Checks ${gh.checks || "none"} · review ${gh.review || "none yet"}`, url: p.url }] : []),
    ...(p.fixes ? [{ text: `${p.fixes} fix round${p.fixes === 1 ? "" : "s"} so far`, url: "" }] : []),
    ...block.slice(0, 3).map((c) => ({ text: `${c.kind} in ${c.file}${c.line ? `:${c.line}` : ""}`, url: "" })),
    ...gaps.slice(0, 3).map((g) => ({ text: `Proof gap: ${clip(g, 160)}`, url: "" })),
  ];
  const [what, why, rec]: [string, string, Brief["recommend"]] = block.length
    ? [
        `${key}'s PR may have cut a corner worth stopping for.`,
        `Its diff ${[...new Set(block.map((c) => c.kind))].join(", ")}: look before it goes further.`,
        { option: "review", reason: "Read the flagged lines in the diff; send it back if the corner was cut.", confidence: "high" },
      ]
    : red
      ? [
          `${key}'s PR has failing checks.`,
          `Checks ${gh?.checks}; the agent has had ${p.fixes} fix round${p.fixes === 1 ? "" : "s"}.`,
          { option: "open-pr", reason: "See which check fails and whether it's the PR or the base branch.", confidence: "medium" },
        ]
      : gaps.length
        ? [
            `${key}'s PR has gaps in its proof.`,
            `${clip(gaps.slice(0, 2).join("; "), 200)}: what the agent didn't check is yours to check.`,
            { option: "review", reason: "See what was and wasn't checked before you trust it.", confidence: "medium" },
          ]
        : p.draft
          ? [
              `${key}'s draft PR is ready for your review.`,
              "It's a draft until you mark it ready; it never merges on its own.",
              { option: "review", reason: "Checks pass; reviewing it is the one step left before the team sees it.", confidence: "high" },
            ]
          : gh?.review === "CHANGES_REQUESTED"
            ? [
                `Changes were requested on ${key}'s PR.`,
                "A reviewer asked for changes; the agent picks them up on its next fix round.",
                { option: "review", reason: "Check the request is clear enough for the agent to act on.", confidence: "medium" },
              ]
            : p.ship?.on
              ? [
                  `${key}'s PR merges on Ship once CI is green.`,
                  "GitHub's auto-merge is on: it merges when every required check passes.",
                  {
                    option: "review",
                    reason: "Nothing to do, unless you want to stop it: request changes or close the PR.",
                    confidence: "low",
                  },
                ]
              : [
                  `${key}'s PR is open.`,
                  p.ship?.why
                    ? `It waits for review and merge on the code host. ${p.ship.why}`
                    : "It waits for review and merge on the code host.",
                  { option: "open-pr", reason: "Merging is yours: open it to merge when it's approved.", confidence: "medium" },
                ];
  return { project, what, why, recommend: rec, evidence, options, ifNothing: null };
}

function reviewBrief(s: DashboardState, url: string): Body | null {
  const p = [...s.status.reviews, ...s.status.myPrs].find((x) => x.url === url);
  if (!p) return null;
  const mine = s.status.myPrs.includes(p);
  const red = /FAILURE|ERROR/.test(p.checks);
  return {
    project: p.client,
    what: mine ? `Your PR #${p.number} in ${p.repo}: ${p.title}` : `#${p.number} in ${p.repo} asks for your review: ${p.title}`,
    why: mine
      ? red
        ? `Its checks fail (${p.checks}).`
        : "A reviewer requested changes."
      : "A teammate is waiting on your review to merge.",
    recommend: {
      option: "open-pr",
      reason: mine ? "The fix is yours to push." : "A quick review unblocks a teammate.",
      confidence: "medium",
    },
    evidence: [
      { text: `${p.repo}#${p.number}${p.draft ? " (draft)" : ""}`, url: p.url },
      { text: `Checks ${p.checks || "none"} · updated ${p.updated.slice(0, 16).replace("T", " ")}`, url: "" },
    ],
    options: [{ id: "open-pr", do: "link", url: p.url, what: mine ? "pr" : "review" }, snooze],
    ifNothing: mine ? null : { text: "It keeps waiting on you; the author can't merge without a review.", at: 0 },
  };
}

/** A repo's pull-request list on its host, filtered ("…/pull/12" → "…/pulls?q=…"); as Needs you links a group. */
export const repoPulls = (prUrl: string, query: string): string =>
  `${prUrl.replace(/\/pull\/\d+.*$/, "/pulls")}?q=${encodeURIComponent(`is:pr is:open ${query}`)}`;

/** Needs you's grouped item for one repo: reviews asked of you, or your PRs with changes asked ("reviews:dashboard"). */
function groupBrief(s: DashboardState, repo: string, mine: boolean): Body | null {
  const inRepo = (p: { repo: string }) => (p.repo.split("/")[1] ?? p.repo) === repo;
  const ps = mine
    ? s.status.myPrs.filter((p) => inRepo(p) && p.review === "CHANGES_REQUESTED" && !/FAILURE|ERROR/.test(p.checks))
    : s.status.reviews.filter(inRepo);
  const [one] = ps;
  if (!one) return null;
  return {
    project: one.client,
    what: mine ? `${ps.length} of your PRs in ${repo} have changes requested` : `${ps.length} reviews asked of you in ${repo}`,
    why: mine ? "Reviewers asked for changes; each waits on your push." : "Teammates are waiting on your review to merge.",
    recommend: {
      option: "open-list",
      reason: mine ? "Work through them in one sitting on the code host." : "One pass through the list unblocks them all.",
      confidence: "medium",
    },
    evidence: ps.map((p) => ({ text: `#${p.number} ${p.title}`, url: p.url })),
    options: [
      { id: "open-list", do: "link", url: repoPulls(one.url, mine ? "author:@me" : "review-requested:@me"), what: mine ? "pr" : "review" },
      snooze,
    ],
    ifNothing: mine ? null : { text: "They keep waiting on you; their authors can't merge without a review.", at: 0 },
  };
}

function ciBrief(s: DashboardState, rest: string): Body | null {
  const c = s.status.ci.find((x) => `${x.client}/${x.repo}@${x.branch}` === rest);
  if (!c) return null;
  const options: BriefOption[] = [{ id: "open-ci", do: "link", url: c.url, what: "ci" }];
  if (assignable(s, c.client))
    options.push({
      id: "assign",
      do: "assign",
      project: c.client,
      key: "",
      finding: "",
      title: `Make the build on ${c.repo}${c.branch ? ` ${c.branch}` : ""} pass again`,
      brief: `CI is red on ${c.repo} ${c.branch}. Failing: ${c.failing.join(", ") || "unknown"}. ${c.url}`,
    });
  options.push(snooze);
  const red = c.state === "fail";
  return {
    project: c.client,
    what: red ? `The build on ${c.repo}${c.branch ? ` ${c.branch}` : ""} is red.` : `The build on ${c.repo} is ${c.state}.`,
    why: red ? `Failing: ${c.failing.join(", ") || "a check"}. Every PR into it inherits the red.` : "Nothing is failing.",
    recommend: options.some((o) => o.id === "assign")
      ? { option: "assign", reason: "An agent can read the failing run and fix it in a PR you review.", confidence: "medium" }
      : { option: "open-ci", reason: "The run's log shows whether it's the code or the pipeline.", confidence: "medium" },
    evidence: [
      { text: `${c.repo} ${c.branch} · ${c.state}`, url: c.url },
      ...c.failing.slice(0, 4).map((f) => ({ text: `Failing: ${f}`, url: "" })),
    ],
    options,
    ifNothing: red ? { text: `It stays red; agents' PRs into ${c.branch || "it"} can't show green.`, at: 0 } : null,
  };
}

function errorsBrief(s: DashboardState, client: string): Body | null {
  const xs = list(s.status.sentry).filter((i) => i.client === client && (i.isNew || i.count >= 100));
  const [top] = [...xs].sort((a, b) => b.users - a.users);
  if (!top) return null;
  const users = xs.reduce((n, i) => n + i.users, 0);
  const options: BriefOption[] = xs
    .slice(0, 3)
    .map((i, n) => ({ id: `open-error-${n}`, do: "link" as const, url: i.url, what: "error" as const }));
  if (assignable(s, client))
    options.push({
      id: "assign",
      do: "assign",
      project: client,
      key: "",
      finding: "",
      title: `Fix: ${clip(top.title, 100)}`,
      brief: `${top.title} (${top.count} events, ${top.users} users). ${top.url}`,
    });
  options.push(snooze);
  return {
    project: client,
    what: xs.length > 1 ? `${xs.length} errors in ${client} reach ${users} users.` : `${top.title} in ${client}.`,
    why: `${top.title}: ${top.count} events, ${top.users} users${top.isNew ? ", new since the last check" : ""}.`,
    recommend: {
      option: options.some((o) => o.id === "assign") ? "assign" : "open-error-0",
      reason: "The trace says which change caused it.",
      confidence: "medium",
    },
    evidence: xs
      .slice(0, 4)
      .map((i) => ({ text: `${i.title} · ${i.count} events · ${i.users} users${i.isNew ? " · new" : ""}`, url: i.url })),
    options,
    ifNothing: { text: "More users hit it; nothing fixes it on its own.", at: 0 },
  };
}

/**
 * A plan for a task you started from a sentence: the agent's first pass only read the project and changed nothing. Going
 * ahead builds that same task at the project's own level (merged only on Ship, once CI is green); nothing happens until
 * you say so.
 */
function planBrief(s: DashboardState, f: DashboardState["findings"][number], task: string): Body {
  const asked = s.assigned.find((a) => a.key === task)?.title ?? f.title;
  return {
    project: f.project,
    what: `${f.project}: "${clip(asked, 120)}"`,
    why: "An agent read the project and wrote down what it would change. It changed nothing; it waits for your go-ahead.",
    recommend: {
      option: "go",
      reason:
        autonomyOf(s, f.project) === "ship"
          ? "It builds this as a pull request that merges on Ship once CI is green; Undo reverts it."
          : "It builds this as a pull request you review; nothing merges without you.",
      confidence: "medium",
    },
    evidence: [],
    plan: f.plan ?? planPoints(f.text),
    options: [
      { id: "go", do: "assign", project: f.project, key: "", finding: f.id, title: "", brief: "" },
      { id: "replan", do: "replan", finding: f.id, project: f.project, text: asked },
      { id: "drop", do: "dismiss", what: "held", target: f.id },
    ],
    ifNothing: { text: "Nothing is built until you say go ahead.", at: 0 },
  };
}

function heldBrief(s: DashboardState, id: string): Body | null {
  const f = s.findings.find((x) => x.id === id);
  if (!f) return null;
  if (f.task) return planBrief(s, f, f.task);
  const options: BriefOption[] = [];
  if (f.key && f.post) options.push({ id: "post", do: "post", finding: f.id, key: f.key });
  if (assignable(s, f.project, f.key))
    options.push({ id: "assign", do: "assign", project: f.project, key: "", finding: f.id, title: "", brief: "" });
  if (f.key) options.push({ id: "open-ticket", do: "drawer", drawer: "ticket", key: f.key, tab: "" });
  options.push({ id: "dismiss", do: "dismiss", what: "held", target: f.id }, snooze);
  const rec: Brief["recommend"] =
    options.some((o) => o.id === "assign") && f.from !== "inbox"
      ? { option: "assign", reason: "It's work an agent found; assigning it builds it as a PR you review.", confidence: "low" }
      : options.some((o) => o.id === "post")
        ? { option: "post", reason: "It's feedback for the ticket; posting it puts it where the team reads.", confidence: "low" }
        : { option: "dismiss", reason: "Nothing to post or build from it.", confidence: "low" };
  return {
    project: f.project,
    what: plainLine(f.title) || f.title,
    why: `${f.project} is on Plan and warn only: Overhand holds what it would post, so you decide what goes out.`,
    recommend: rec,
    evidence: [{ text: `From the ${f.from}${f.key ? ` on ${f.key}` : ""}`, url: "" }],
    detail: f.text || undefined,
    options,
    ifNothing: { text: "It stays held; nothing is posted.", at: 0 },
  };
}

/** Each kind of action card's words, as Needs you shows them. */
const CARD: Record<string, [string, string]> = {
  "quiet-heavy": ["cardQuietHeavy", "cardQuietHeavySub"],
  "unmanaged-heavy": ["cardUnmanaged", "cardUnmanagedSub"],
  competing: ["cardCompeting", "cardCompetingSub"],
  "foreign-pr": ["cardForeignPr", "cardForeignPrSub"],
  "same-files": ["cardSameFiles", "cardSameFilesSub"],
  silent: ["cardSilent", "cardSilentSub"],
  overdue: ["cardOverdue", "cardOverdueSub"],
  strain: ["cardStrain", "cardStrainSub"],
};

function cardBrief(s: DashboardState, id: string, w: Words): Body | null {
  const c = s.control.cards.find((x) => x.id === id);
  const words = c ? CARD[c.kind] : undefined;
  if (!c || !words) return null;
  const options: BriefOption[] = c.buttons.map((b) =>
    b === "show" || b === "connect"
      ? { id: `card-${b}`, do: "drawer", drawer: "crew", key: "", tab: "" }
      : { id: `card-${b}`, do: "card", card: c.id, button: b },
  );
  const [first] = options;
  if (!first) return null;
  return {
    project: c.project,
    what: fill(w[words[0]] ?? "", c.facts),
    why: fill(w[words[1]] ?? "", c.facts),
    recommend: { option: first.id, reason: c.auto ? (w.cardAuto ?? "") : "It's the safest step that resolves it.", confidence: "medium" },
    evidence: Object.entries(c.facts)
      .slice(0, 5)
      .map(([k, v]) => ({ text: `${k}: ${v}`, url: "" })),
    options,
    ifNothing: c.auto ? { text: w.cardAuto ?? "", at: 0 } : null,
  };
}

function diskBrief(s: DashboardState): Body | null {
  const d = s.disk;
  if (!d || d.freeGb >= d.warnGb) return null;
  const floor = d.freeGb < d.floorGb;
  return {
    project: "",
    what: `${d.freeGb.toFixed(1)} GB free on this Mac.`,
    why: floor
      ? `Below ${d.floorGb} GB no new agent starts.`
      : d.freeGb < d.heavyGb
        ? `Below ${d.heavyGb} GB heavy jobs (browsers, suites, builds) wait.`
        : `It's under the ${d.warnGb} GB warning line.`,
    recommend: { option: "sweep", reason: "Clean up shows what goes first (merged worktrees, old versions, caches).", confidence: "high" },
    evidence: [{ text: `Free ${d.freeGb.toFixed(1)} GB · floor ${d.floorGb} GB · heavy jobs wait under ${d.heavyGb} GB`, url: "" }],
    options: [{ id: "sweep", do: "drawer", drawer: "sweep", key: "", tab: "" }, snooze],
    ifNothing: { text: floor ? "Agents stay stopped until there's room." : "Heavy jobs start waiting as it fills.", at: 0 },
  };
}

function accountBrief(s: DashboardState, name: string, now: number): Body | null {
  const a = s.accounts.find((x) => x.name === name);
  if (!a) return null;
  const cooling = a.coolUntil > now;
  const others = s.accounts.filter((x) => x.name !== name && x.coolUntil <= now).map((x) => x.name);
  return {
    project: "",
    what: cooling ? `${name} is at its limit until ${new Date(a.coolUntil).toISOString().slice(11, 16)} UTC.` : `${name} has capacity.`,
    why: cooling ? "Runs on it wait for the window to reset; Overhand never moves work onto another subscription." : "Nothing waits on it.",
    recommend: {
      option: "accounts",
      reason: others.length
        ? `${others.join(", ")} can take a project's runs if you route it there.`
        : "Add another account to keep work moving.",
      confidence: "low",
    },
    evidence: [{ text: `${a.provider} · ${a.model || "default model"} · ${a.runtime}`, url: "" }],
    ...(a.usage ? { detail: `\`\`\`json\n${JSON.stringify(a.usage, null, 2)}\n\`\`\`` } : {}),
    options: [{ id: "accounts", do: "drawer", drawer: "settings", key: "", tab: "accounts" }, snooze],
    ifNothing: cooling ? { text: "Its runs resume when the window resets.", at: a.coolUntil } : null,
  };
}

function guardBrief(s: DashboardState, at: string): Body | null {
  const b = s.guardrails.find((x) => String(x.at) === at);
  if (!b) return null;
  return {
    project: b.project,
    what: `The guard stopped ${b.run || "an agent"} running ${b.tool}.`,
    why: `It broke the rule: ${b.rule}.`,
    recommend: { option: "health", reason: "Usually right: agents work around a block. Look only if it repeats.", confidence: "medium" },
    evidence: [{ text: `Rule ${b.rule}`, url: "" }],
    detail: `What it tried (${b.tool}):\n\n\`\`\`\n${b.action}\n\`\`\``,
    options: [
      { id: "health", do: "drawer", drawer: "health", key: "", tab: "" },
      ...(b.run && /^[A-Z][A-Z0-9]+-\d+/.test(b.run)
        ? [{ id: "ticket", do: "drawer" as const, drawer: "ticket" as const, key: b.run.replace(/-fix$/, ""), tab: "" }]
        : []),
      snooze,
    ],
    ifNothing: { text: "Nothing: it stayed blocked, and the agent carried on without it.", at: 0 },
  };
}

function checkupBrief(more: MoreFacts): Body | null {
  const c = more.checkup;
  if (!c) return null;
  const f = c.finding;
  return {
    project: "",
    what: `${c.repo}: ${f.title}`,
    why: f.task ? `An agent could take it: ${f.task.title}.` : "Worth knowing; there's nothing for an agent to do about it.",
    recommend: f.task
      ? { option: "health", reason: "A small, safe task: a good one to hand an agent.", confidence: "medium" }
      : { option: "snooze", reason: "Nothing to act on now.", confidence: "low" },
    evidence: [{ text: `${c.repo} · ${f.tone}`, url: "" }],
    options: [{ id: "health", do: "drawer", drawer: "health", key: "", tab: "" }, snooze],
    ifNothing: null,
  };
}

/**
 * The brief on one item from facts alone (no model): null when the item isn't there. `more` carries what the tracker or
 * a check-up said beyond the dashboard's state; `w` is the dashboard's words (an action card's what and why). Pure: `now`
 * is passed in.
 */
export function factsBrief(s: DashboardState, id: string, more: MoreFacts = {}, now = Date.now(), w: Words = {}): Brief | null {
  const kind = briefKindOf(id);
  if (!kind) return null;
  const rest = id.slice(kind.length + 1);
  const body: Record<BriefKind, () => Body | null> = {
    ticket: () => ticketBrief(s, rest, more),
    lead: () => leadBrief(s, rest, now),
    pr: () => prBrief(s, rest),
    review: () => reviewBrief(s, rest),
    reviews: () => groupBrief(s, rest, false),
    changes: () => groupBrief(s, rest, true),
    ci: () => ciBrief(s, rest),
    errors: () => errorsBrief(s, rest),
    held: () => heldBrief(s, rest),
    card: () => cardBrief(s, rest, w),
    disk: () => diskBrief(s),
    account: () => accountBrief(s, rest, now),
    guard: () => guardBrief(s, rest),
    checkup: () => checkupBrief(more),
    // the daemon builds these from its organising suggestions (core suggestions.ts), not from the dashboard's state
    organise: () => null,
  };
  const b = body[kind]();
  return b && { id, kind, ...b, source: "facts", hash: "", at: now, pending: false };
}
