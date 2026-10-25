/** Supervised godmode leads. This module owns the running lead processes (leadChildren). */

import { appendFileSync, copyFileSync, existsSync, type FSWatcher, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type LeadHears,
  type LeadWorkKind,
  leadId,
  leadWork,
  OVERHAND_MARK,
  questionLine,
  sectionHeading,
  type Ticket,
  WAY_OF_WORKING,
  type WorkSignals,
} from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { AGENT_HOMES, guardHooks, runHome, runMcpServers } from "./agent-home";
import { leadRules } from "./autonomy";
import { budgetUntil, recordedBilling } from "./billing";
import { writeShims } from "./broker";
import { accountsFor, mainCheckout, readyHome } from "./claude";
import type { Config } from "./config";
import { addRequest, type Beat, ingestOutboxes, recordSpawn } from "./control";
import { ACCOUNTS, CFG, CLIENTS, CODE, clientOf, LABEL, MIN, OPS, OWNER, providerOf, runtimeOf, SRC, sh, shAsync, today } from "./env";
import { autonomyFor, groupOf, leadAccounts } from "./groups";
import { GUARD_LOG } from "./guard";
import { identityOf } from "./history";
import { backAt, bench, benchedUntil, outOfUsage } from "./limits";
import { diskLow, enforceBudget, errorText, notify, report } from "./notify";
import { keepAwakeWhile, readSecret } from "./platform";
import { branchesPushed, prsOpened } from "./proof";
import { type NtfyAction, replyActions } from "./replies";
import { RUNTIMES } from "./runtimes";
import { writeRunFiles } from "./runtimes/claude-code";
import { type AgentRuntime, gitCommonDir } from "./runtimes/runtime";
import { projectSandbox, sandboxRefusals, sandboxSpawn, waitsForSignIn } from "./sandbox";
import { disarmForPush, loadShips, type Run, type ShipRecord } from "./ship";
import { loadNames, loadState, readJson, saveState, type TrackedPr, ticketCache, writeJsonAtomic } from "./state";
import { status } from "./status/types";
import { exhaustedUntil, loadUsage, recordUsage } from "./usage";

export type Godmode = Config["godmode"][number];

export interface LeadState {
  stopped: boolean;
  reason: string;
  pid: number; // the session ops started last, so Stop still works after a daemon restart
  startedAt: number;
  lastExit: number;
  crashes: number[]; // failed exits, kept for an hour
  inboxAt: number;
  /** It exited with a question open; held until you answer (the inbox changes) or press Start. */
  waiting?: boolean;
  account?: string; // the Claude account the current or last run used
  log?: string;
  /** How the current or last run ran: inside the OS sandbox, on the guard only (its project's choice), or neither. */
  ran?: RunMode;
  /** Every allowed account is limited; it resumes when one frees up. */
  waitingLimit?: boolean;
  /** Its last start failed before it ran (an account missing its key, a CLI refusing the repo): which, and why. */
  cantStart?: { account: string; why: string };
  /** Start was pressed: the next start skips restartAfterMin, even if the stopped run's exit lands after the press. */
  startNow?: boolean;
  /** The work that woke an on-demand lead last; it wakes again only when this changes. */
  lastBrief?: string;
  /** Clean exits in a row that came within QUICK_EXIT_MIN: the lead found nothing to do, so it rests longer each time. */
  idle?: number;
  /**
   * The open question as Overhand first saw it: its headings (`id`), when it was asked (the file's mtime then), when
   * Overhand first saw it (`seen`, which starts the wait for its default), and the
   * issues and PRs it names that the cached status showed open since, so one closing later marks it out of date.
   */
  question?: { id: string; at: number; seen: number; seenOpen: string[] };
  /**
   * Pull requests its runs opened (`prsOpened`), with the run's log and when it ran, until the work pass takes them in
   * for Ship (lead-prs.ts).
   */
  opened?: { url: string; log: string; from: number; to: number }[];
  /** Branches its runs pushed by name (`branchesPushed`), with the run's log and when it ran: a fresh proof for a lead PR. */
  pushed?: { branch: string; log: string; from: number; to: number }[];
  /** A message from you waits for the lead's next start, which brings it in its brief (messageLead). */
  message?: boolean;
  /** This run owes you a reply: its final message is filed as `## Reply` when it exits (recordLeadExit). */
  replyDue?: boolean;
}

export type RunMode = "sandboxed" | "guard only" | "unsandboxed";

/**
 * The log line for a lead's exit: how it ran when known, and for a failed sandboxed run the sandbox's refused writes
 * when they could be read (`refusals`).
 */
export function exitLine(name: string, how: string, min: number, ran?: RunMode, refusals: number | null = null): string {
  const said = refusals === null ? "" : `, ${refusals} sandbox refusal${refusals === 1 ? "" : "s"}`;
  return `⚡ ${name} exited (${[how, ran ? `${ran}${said}` : ""].filter(Boolean).join(", ")}) after ${Math.round(min)} min`;
}

/** A clean exit sooner than this means the lead found nothing to do. */
const QUICK_EXIT_MIN = 5;
/** The longest an always-on lead rests between looks when it keeps finding nothing. */
const MAX_REST_MIN = 240;

/**
 * Minutes from a lead's exit to its next start: restartAfterMin, doubled for each clean exit in a row that found
 * nothing to do (5, 10, 20 … up to MAX_REST_MIN), so an idle lead stops waking every few minutes all day. The cap
 * bounds only that doubling: a lead set to rest longer (1440 for daily, 10080 for weekly) rests as long as it's set to.
 */
export const restartDelayMin = (g: Pick<Godmode, "restartAfterMin">, st: Pick<LeadState, "idle">): number =>
  Math.max(g.restartAfterMin, Math.min(MAX_REST_MIN, g.restartAfterMin * 2 ** Math.min(st.idle ?? 0, 8)));
const LEADS_FILE = join(OPS, ".leads.json");
export const leadChildren = new Map<string, Bun.Subprocess>();
/** Every lead's supervisor state from .leads.json. */
export const loadLeads = (): Record<string, LeadState> => readJson(LEADS_FILE, {});
/** Writes .leads.json atomically. */
export const saveLeads = (l: Record<string, LeadState>): void => writeJsonAtomic(LEADS_FILE, l);
/** A lead's supervisor state before its first run. */
/**
 * When every account a lead may use is benched (its own limit hits, the agent cooldown, a used-up week): the one that
 * frees up first and when. Empty while any of them is free now.
 */
export function limitBack(freeAt: Record<string, number>, now = Date.now()): { limitAccount?: string; limitBack?: number } {
  const all = Object.entries(freeAt);
  if (!all.length || all.some(([, t]) => t <= now)) return {};
  // an account waiting for its sign-in has no time it's back (waitsForSignIn)
  const timed = all.filter(([, t]) => Number.isFinite(t));
  if (!timed.length) return {};
  const [account, at] = timed.reduce((x, y) => (y[1] < x[1] ? y : x));
  return { limitAccount: account, limitBack: at };
}

export const blankLead = (): LeadState => ({ stopped: false, reason: "", pid: 0, startedAt: 0, lastExit: 0, crashes: [], inboxAt: 0 });

/** The lead's entry in a loaded .leads.json, created blank when it has none yet. */
export function leadOf(leads: Record<string, LeadState>, key: string): LeadState {
  const st = leads[key] ?? blankLead();
  leads[key] = st;
  return st;
}
const alive = (pid: number): boolean => {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch {
    return false;
  }
};

const AGENT_CLI = new RegExp(
  Object.values(RUNTIMES)
    .map((r) => r.bin)
    .join("|"),
);
/** True when pid is a live agent CLI process (pids get reused, so a bare liveness check isn't enough). */
const isAgent = (pid: number): boolean => alive(pid) && AGENT_CLI.test(sh(["ps", "-p", String(pid), "-o", "command="]).out);

/** The pid holding the godmode lock when it is alive and its heartbeat is fresh, else 0. */
export function lockHolder(g: Godmode): number {
  const f = g.lockFile && join(CODE, g.lockFile);
  if (!f || !existsSync(f)) return 0;
  try {
    const l = JSON.parse(readFileSync(f, "utf8")) as { pid?: number; heartbeat?: number };
    const fresh = Date.now() - Number(l.heartbeat ?? 0) < g.lockStaleMin * MIN;
    return fresh && alive(Number(l.pid)) ? Number(l.pid) : 0;
  } catch {
    return 0;
  }
}

/** The questions a godmode session left for you, with when the file last changed. */
/** Where a lead writes questions for you: its configured file, else ops' own leads/<key>/questions.md. */
export const inboxPathOf = (g: Godmode): string => (g.inboxFile ? join(CODE, g.inboxFile) : join(OPS, "leads", g.key, "questions.md"));

/**
 * The name a lead goes by everywhere it is told about (pushes, the activity log, the team feed): yours from the
 * dashboard first, then its config name, then its label. The dashboard's leadName says the same.
 */
export const leadName = (g: Pick<Godmode, "key" | "name" | "label">): string => loadNames()[leadId(g.key)] || g.name || g.label;
/** leadName for the label a lead's session carries; a label no lead has comes back as it is. */
export const leadNameByLabel = (label: string): string => {
  const g = CFG.godmode.find((x) => x.label === label);
  return g ? leadName(g) : label;
};

/**
 * Where a lead works. Ops' own lead gets a worktree: the daemon runs and serves whatever the ops checkout holds, so a
 * lead switching branches there would change the live dashboard under it.
 */
export function leadDir(g: Godmode): string {
  const dir = join(CODE, g.dir);
  return dir === SRC ? join(SRC, ".claude", "worktrees", `lead-${g.key}`) : dir;
}

/** Creates ops' lead worktree from origin/main on first use, with its own dependencies and config; false when that failed. */
function prepareLeadDir(g: Godmode): boolean {
  const dir = leadDir(g);
  if (dir === join(CODE, g.dir) || existsSync(dir)) return true;
  const steps = [
    ["git", "fetch", "--quiet", "origin"],
    ["git", "worktree", "add", "--detach", dir, "origin/main"],
  ];
  for (const cmd of steps) {
    const r = sh(cmd);
    if (!r.ok) {
      report(`⚡ ${leadName(g)}: couldn't create its worktree (${r.err.slice(0, 200)}), not starting`);
      return false;
    }
  }
  sh(["bun", "install", "--frozen-lockfile"], dir); // its own node_modules: a lead's install must not touch the daemon's
  copyFileSync(join(OPS, "overhand.config.json"), join(dir, "overhand.config.json")); // run.ts loads it on import, so the tests need it
  return true;
}

/** What happens to an unanswered question, in the lead's prompt. */
const waitLine = (g: Godmode): string =>
  g.answerWaitHours > 0
    ? `If ${OWNER} hasn't answered within ${g.answerWaitHours} h, Overhand answers "Go with your default" for you, so make it something you'd stand behind.`
    : `${OWNER} answers every question; nothing goes ahead on its default.`;

const answersFirst = "1. Answers to your earlier questions (below): act on them first.";
/** A generic lead's run: everything on the project, in this order. */
const sweep = [
  "Each run, sweep in this order and fix what you find:",
  answersFirst,
  "2. Anything Overhand woke you for (listed at the end, when there is something).",
  "3. CI on each repo's default branch and on open pull requests: red builds, failing checks, flaky tests.",
  "4. Open pull requests: review feedback to address, conflicts to resolve, stale branches to update.",
  "5. Errors in production (Sentry or the project's tracker), failed deploys, broken health checks you can read without credentials.",
  "6. Tickets assigned to you or labelled for the agent, in priority order; then the oldest open bugs.",
  "7. Dependency and security alerts (`gh api repos/{owner}/{repo}/dependabot/alerts`, `npm audit`/`bun audit` equivalents): patch what is safe.",
  "8. Anything in the project map that looks wrong: expiring certificates or keys you can see dates for, deprecated APIs, config drift between environments.",
];
/** A ready-made lead's run (config `watch`): only the work it was woken for, so it does what its preview said. */
const focused = [
  "Each run:",
  answersFirst,
  "2. What Overhand woke you for (listed at the end): that is your work. Stay on your goal; other kinds of work belong to other leads, so leave them.",
];

/** How a lead tells your message from an answer, and that its replies are Overhand's to keep. */
const MESSAGE_LINE = `An answer with no question above it is a message from ${OWNER}: a question to answer or direction to follow, within the same rules as everything else here. Leave "## Reply" sections in place; Overhand writes and trims them.`;

/**
 * What tells a lead a message from you waits: its brief when it starts for it, or a Control Room request handed to its
 * running session at its next tool call. It points at the file and never carries the message: only Overhand writes it.
 */
export const messageText = (g: Godmode): string =>
  `${OWNER} left you a message in ${inboxPathOf(g)}; read it now. Your final message is shown to ${OWNER} as your reply, so start it with the answer.`;

/**
 * The lead's first instruction: the configured one (a repo's own lead skill), else ops' generic lead, which keeps its
 * notes and questions in ops' leads/<key>/ folder so nothing extra lands in the project's repo.
 */
export function leadPrompt(g: Godmode, brief = ""): string {
  const woken = brief ? `Overhand woke you because of this:\n${brief}` : "";
  // the project's autonomy level comes last before the brief, so it overrides whatever the instruction above allows
  const rules = [
    leadRules(autonomyFor(CFG, g.project)),
    // you post as the owner: the marker keeps your words from being learned as their review feedback (learn.ts)
    `End every comment or review you post on GitHub with ${OVERHAND_MARK} on its own line, so Overhand can tell it from ${OWNER}'s own feedback.`,
  ]
    .filter(Boolean)
    .join("\n");
  if (g.prompt.trim())
    return [
      g.prompt,
      WAY_OF_WORKING,
      rules,
      `End every question you leave for ${OWNER} with a line "If there's no answer: <what you'll do>". ${waitLine(g)}`,
      MESSAGE_LINE,
      woken,
    ]
      .filter(Boolean)
      .join("\n\n");
  const dir = join(OPS, "leads", g.key);
  const name = g.project || g.label;
  return [
    `You are the lead for ${name}, working in ${leadDir(g)}. You run this project for ${OWNER}: find what needs doing, do it, and only bring ${OWNER} what truly needs a human.`,
    `Goal: ${g.goal.trim() || "keep the project healthy and moving: nothing red, nothing stuck, the backlog shrinking"}.`,
    "",
    `Memory: ${join(dir, "notes.md")} is yours. Read it first (create it if missing) and update it after every step, so a fresh run continues where you left off. Keep a "Project map" section in it:`,
    "- every repo under your folder: what it is, its default branch, how to build, test and lint it (from its README, CLAUDE.md, AGENTS.md, package.json, Makefile, CI config);",
    "- every service it uses, read from the code and config (never from secret values): hosting and deploys (Vercel, AWS, Fly, Expo/EAS…), databases, auth, payments (Stripe…), email, error tracking (Sentry…), analytics, queues, third-party APIs, and where each is configured;",
    "- the tracker, the CI, and the people and channels involved. Refresh the map when you find something new; it is how you know what to check.",
    "",
    ...(g.watch?.length ? focused : sweep),
    "",
    WAY_OF_WORKING,
    "Work on a feature branch named after the ticket or problem, and review your own diff before you open the pull request.",
    "Never push to protected branches, merge, deploy, run destructive migrations, or touch production data or secrets. Those stay with people.",
    "Your git push, fetch and pull and your gh commands run through Overhand, which holds the sign-in you don't: use them as usual. To check a pull request out, fetch and switch to its branch (gh pr checkout isn't one of them).",
    "",
    `Questions: decide yourself whenever a reasonable engineer could. Ask ${OWNER} only for product decisions, money, legal, access you don't have, or anything irreversible. Append each question under its own "## " heading to ${inboxPathOf(g)}, with your recommendation, and end it with a line "If there's no answer: <what you'll do>", then carry on with other work. ${waitLine(g)} When it's a choice between two, put a line "Options: <first> | <second>" above that one so ${OWNER} can answer from the notification. Overhand shows these to ${OWNER} and as a notification.`,
    `${OWNER}'s answers appear in that file under "## Answer from ${OWNER}". Read them at the start of every run, act on them, and remove questions once handled. Leave the file empty when none are open: any text in it shows as a question.`,
    MESSAGE_LINE,
    "",
    "Before you stop, write a short report at the top of your notes: what you fixed (with PR links), what's still red and why, and what you're waiting on. Stop when nothing else can move.",
    rules && `\n${rules}`,
    woken,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A heading that closes what's above it: your answer (or Overhand's), or the lead's reply to your message. */
const CLOSING = /^## (Answer from|Reply\b)/;
/** How much of a lead's questions file the dashboard gets: the newest of it. */
const INBOX_MAX = 16_000;

/**
 * The lead's questions file, its newest INBOX_MAX characters from a "## " heading (so the conversation never starts
 * halfway through someone's words); open until an answer or a reply is its newest heading (the lead asks again under a
 * new heading).
 */
export function leadInbox(g: Godmode): { text: string; at: number; open: boolean } | null {
  const f = inboxPathOf(g);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8").trim();
  if (!text) return null;
  const open = !CLOSING.test(text.match(/^## .*/gm)?.at(-1) ?? "");
  const tail = text.slice(-INBOX_MAX);
  const from = text.length > INBOX_MAX ? tail.indexOf("\n## ") + 1 : 0;
  return { text: tail.slice(from), at: statSync(f).mtimeMs, open };
}

const HOUR = 60 * MIN;
/** A question this old may be out of date even when nothing it names has closed. */
const STALE_HOURS = 24;

/**
 * The open questions in a questions file: every "## " section after the newest answer, reports left out. A file with
 * no "## " heading at all is one question.
 */
export function openQuestions(text: string): string[] {
  if (!/^## /m.test(text)) return text.trim() ? [text.trim()] : [];
  const sections = text.split(/^(?=## )/m).filter((x) => x.startsWith("## "));
  const answered = sections.findLastIndex((x) => x.startsWith("## Answer from"));
  return sections.slice(answered + 1).filter((x) => !/^## (Report|Reply)\b/.test(x));
}

const DEFAULT_LINE = /^[\s>*-]*\**\s*if there(?:['’]s| is) no answer\s*\**\s*:\s*\**\s*(.+?)\s*$/gim;
/** The default a question states on its "If there's no answer: …" line (the last one); "" when it states none. */
export function questionDefault(question: string): string {
  return [...question.matchAll(DEFAULT_LINE)].at(-1)?.[1]?.trim() ?? "";
}

const GITHUB_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/g;
const REPO_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const BARE_REF = /(?<![\w/#])#(\d+)\b/g;
/** The issues and PRs a question names, as "owner/repo#N" (from a GitHub URL or a full reference) or a bare "#N". */
export function refsIn(text: string): string[] {
  const out = new Set<string>();
  const keep = (_: string, repo: string, n: string): string => {
    out.add(`${repo}#${n}`);
    return " ";
  };
  const rest = text.replace(GITHUB_URL, keep).replace(REPO_REF, keep);
  for (const m of rest.matchAll(BARE_REF)) out.add(`#${m[1]}`);
  return [...out];
}

/**
 * The issues and PRs Overhand's cached status and tickets show open for a project, as "owner/repo#N" and bare "#N";
 * null before the status was first read, when nothing can be said. Reads only what is cached: no network.
 */
export function openRefs(project: string): Set<string> | null {
  if (!status.at) return null;
  const out = new Set<string>();
  const add = (repo: string, n: number, ours: boolean) => {
    out.add(`${repo}#${n}`);
    if (ours) out.add(`#${n}`);
  };
  for (const p of [...status.myPrs, ...status.reviews]) add(p.repo, p.number, !project || p.client === project);
  for (const [client, tix] of Object.entries(ticketCache.data))
    for (const t of Array.isArray(tix) ? tix : []) {
      const m = [...t.url.matchAll(GITHUB_URL)][0];
      if (m?.[1] && m[2]) add(m[1], Number(m[2]), !project || client === project);
    }
  return out;
}

/** What the dashboard says about a lead's open question. */
export interface LeadAsk {
  /** The stated default ("" when a question gives none); with several questions, one "heading: default" per line. */
  default: string;
  /** When Overhand answers with the default; 0 when it waits for you (no default, or answerWaitHours 0). */
  deadline: number;
  /** Why it may be out of date: issues/PRs it names that closed since, and its age in hours once past a day (else 0). */
  stale: { closed: string[]; hours: number } | null;
  /** No default: when Overhand asks the lead to re-check and give one (recheckQuestion); 0 when it has a default. */
  recheck: number;
}

const questionId = (qs: string[]): string => qs.map((q) => q.split("\n")[0] ?? "").join("\n");

/**
 * Keeps `st.question` on the open question: when it was asked (the file's mtime), when Overhand first saw it (`now`,
 * which starts the wait for its default), and which issues and PRs it names were seen open since (`open`, from
 * openRefs). Cleared when nothing is open. True when it's a question Overhand hadn't seen before.
 */
export function trackQuestion(st: LeadState, box: ReturnType<typeof leadInbox>, open: Set<string> | null, now = Date.now()): boolean {
  const qs = box?.open ? openQuestions(box.text) : [];
  if (!box || !qs.length) {
    delete st.question;
    return false;
  }
  const id = questionId(qs);
  const fresh = st.question?.id !== id;
  if (fresh || !st.question) st.question = { id, at: box.at, seen: now, seenOpen: [] };
  const q = st.question;
  for (const r of refsIn(qs.join("\n"))) if (open?.has(r) && !q.seenOpen.includes(r)) q.seenOpen.push(r);
  return fresh;
}

/**
 * The one notification a lead's questions file is worth this tick, if any: for a question Overhand sees for the first
 * time with a default, the heads-up "<lead> goes with its default at HH:MM unless you answer" (this includes every
 * question already open when Overhand was upgraded, so none goes ahead without that notice); else, when the file
 * changed, "Question from <lead>" (plainWords.alLeadNeeds). Marks the file's change as seen.
 */
export function leadNotice(
  g: Godmode,
  st: LeadState,
  box: ReturnType<typeof leadInbox>,
  now = Date.now(),
): { title: string; body: string; actions: NtfyAction[] } | null {
  const fresh = trackQuestion(st, box, openRefs(g.project), now);
  if (!box) return null;
  const changed = box.at !== st.inboxAt;
  const known = st.inboxAt !== 0; // a lead's first look at its file isn't news; a question with a deadline still is
  st.inboxAt = box.at;
  const ask = fresh ? leadAsk(g, st, box, null, now) : null;
  const actions = () => (box.open ? replyActions(g.key, box.at, box.text) : []);
  if (ask?.deadline)
    return {
      title: `${leadName(g)} goes with its default at ${clock(ask.deadline)} unless you answer`,
      body: ask.default,
      actions: actions(),
    };
  if (!changed || !known) return null;
  return {
    title: plainWords.alLeadNeeds.replace("{lead}", leadName(g)),
    body: questionLine(box.text, 160),
    actions: actions(),
  };
}

/** "10:30", this machine's local time. */
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** The lead's open question as the dashboard shows it (LeadAsk); null when none is open. `open` is from openRefs. */
export function leadAsk(
  g: Godmode,
  st: LeadState,
  box: ReturnType<typeof leadInbox>,
  open: Set<string> | null,
  now = Date.now(),
): LeadAsk | null {
  const qs = box?.open ? openQuestions(box.text) : [];
  if (!box || !qs.length) return null;
  const defaults = qs.map(questionDefault);
  const heading = (q: string) => (q.split("\n")[0] ?? "").replace(/^##\s*/, "");
  const def = !defaults.every(Boolean)
    ? ""
    : qs.length === 1
      ? (defaults[0] ?? "")
      : qs.map((q, i) => `${heading(q)}: ${defaults[i]}`).join("\n");
  const asked = st.question?.id === questionId(qs) ? st.question : null;
  const closed = open ? (asked?.seenOpen ?? []).filter((r) => !open.has(r)) : [];
  // its age comes from the file; the wait for its default from when Overhand first saw it (not yet: from now), so a
  // question that was already old when Overhand started watching still gets the whole wait, with notice
  const hours = Math.floor((now - (asked?.at ?? box.at)) / HOUR);
  const old = hours >= STALE_HOURS ? hours : 0;
  return {
    default: def,
    deadline: def && g.answerWaitHours > 0 ? (asked?.seen ?? now) + g.answerWaitHours * HOUR : 0,
    stale: closed.length || old ? { closed, hours: old } : null,
    // from when Overhand first saw it, like the default's wait; not yet seen: never due this tick
    recheck: def || !asked ? 0 : asked.seen + RECHECK_HOURS * HOUR,
  };
}

/** The body of an answer that goes with the lead's default. */
export const defaultText = (def: string): string =>
  def.includes("\n") ? `Go with your defaults:\n${def}` : `Go with your default: ${def}`;

/**
 * Appends an answer to a lead's questions file under "## Answer from <by> (<note>, <stamp>)" and returns the file's new
 * mtime, so the caller can mark the change as seen (an answer isn't news that the lead needs you).
 */
export function appendAnswer(g: Godmode, by: string, body: string, note = "", now = new Date()): number {
  return appendSection(g, `Answer from ${by}`, body, note, now);
}

/** Appends "## <heading> (<note>, <stamp>)" and its body to a lead's questions file; returns the file's new mtime. */
function appendSection(g: Godmode, heading: string, body: string, note = "", now = new Date()): number {
  mkdirSync(dirname(inboxPathOf(g)), { recursive: true });
  appendFileSync(inboxPathOf(g), `\n\n${sectionHeading(heading, note, now)}\n\n${body}\n`);
  return statSync(inboxPathOf(g)).mtimeMs;
}

/** How many of a lead's replies its questions file keeps; older ones are trimmed after it exits. */
export const KEEP_REPLIES = 5;
/** The longest reply or report filed; a reply is told to start with the answer, so its start is kept. */
const REPLY_MAX = 6000;

/** A questions file with only its newest `keep` "## Reply" sections; everything else stays as it is. */
export function trimReplies(text: string, keep = KEEP_REPLIES): string {
  const parts = text.split(/^(?=## )/m);
  const replies = parts.flatMap((p, i) => (p.startsWith("## Reply") ? [i] : []));
  const drop = new Set(replies.slice(0, Math.max(0, replies.length - keep)));
  return parts.filter((_, i) => !drop.has(i)).join("");
}

/** True while the lead runs: Overhand's own run, or one someone started by hand that holds its lock. */
export const leadRunning = (g: Godmode, st: LeadState): boolean => !!(leadPid(g, st) || lockHolder(g));

/**
 * The Control Room session of the lead's current run (its run is `lead-<key>` and it beat since this run started), if
 * any: only a CLI whose hook reports sessions takes a message mid-run.
 */
export const leadSession = (g: Godmode, st: LeadState, beats: readonly Beat[]): Beat | undefined =>
  beats.find((b) => b.run === `lead-${g.key}` && b.lastAt >= st.startedAt);

/** When a message sent now reaches the lead: at its next step, when this run ends, or Overhand starts it for it. */
export const leadHears = (running: boolean, session: Beat | undefined): LeadHears => (!running ? "starts" : session ? "now" : "after-run");

/**
 * After you left a lead a message (an answer with no question open): a running session that takes requests gets one
 * at its next tool call and owes you a reply; otherwise the message waits for the lead's next start, which the
 * supervisor makes at once (or as soon as this run ends), with the message in its brief. Returns when it hears it.
 */
export function messageLead(g: Godmode, st: LeadState, running: boolean, beats: readonly Beat[]): LeadHears {
  const session = running ? leadSession(g, st, beats) : undefined;
  if (session) {
    addRequest(OPS, { from: OWNER, to: session.id, toLabel: leadName(g), text: messageText(g), by: 0 });
    st.replyDue = true;
  } else st.message = true;
  return leadHears(running, session);
}

/**
 * Goes with the lead's stated default once its question has waited `answerWaitHours` unanswered: appends Overhand's
 * answer, marks it seen, and returns the default it went with ("" when nothing was due).
 */
export function autoDefault(g: Godmode, st: LeadState, box: ReturnType<typeof leadInbox>, now = Date.now()): string {
  const ask = leadAsk(g, st, box, null, now);
  if (!ask?.deadline || now < ask.deadline) return "";
  st.inboxAt = appendAnswer(g, "Overhand", defaultText(ask.default), `no reply in ${g.answerWaitHours} h`, new Date(now));
  delete st.question;
  return ask.default;
}

/** How long a question with no default waits for you before Overhand asks the lead for one. */
export const RECHECK_HOURS = 4;
/** What Overhand writes to a lead whose question gave no default and has waited RECHECK_HOURS. */
export const RECHECK_TEXT = `No answer yet, and your question gives no default, so it would wait for ${OWNER} forever. Re-read the current state. If it no longer applies, carry on. If it still needs ${OWNER}, ask it again in two lines (what's needed and why now), with your recommendation and a line "If there's no answer: <what you'll do>".`;

/**
 * A question with no default never answers itself: once it has waited RECHECK_HOURS, Overhand asks the lead to re-check
 * and, if it still needs you, ask again with a default, so the question either goes or comes back able to go ahead
 * without you. Once per question (answering closes it). Returns true when it asked.
 */
export function recheckQuestion(g: Godmode, st: LeadState, box: ReturnType<typeof leadInbox>, now = Date.now()): boolean {
  const ask = leadAsk(g, st, box, null, now);
  if (!ask || ask.default || !ask.recheck || now < ask.recheck) return false;
  st.inboxAt = appendAnswer(g, "Overhand", RECHECK_TEXT, `no default after ${RECHECK_HOURS} h`, new Date(now));
  delete st.question;
  return true;
}

/** True while the lead is held on an unanswered question: it exited with one open, and it's still open. */
export const heldOnQuestion = (st: LeadState, box: ReturnType<typeof leadInbox>): boolean => !!st.waiting && !!box?.open;

let questionWatch: { key: string; stop: () => void } | null = null;
/**
 * Watches every lead's questions file (its folder, since editors replace files) and calls `onChange` a moment after one
 * changes, so an answer written by any route is picked up in seconds rather than at the next minute's tick. Cheap to
 * call every tick: it re-arms only when the set of files changed. A folder that doesn't exist yet is left to the tick.
 */
export function watchQuestions(onChange: () => void, debounceMs = 500): void {
  const files = CFG.godmode.map(inboxPathOf);
  const key = files.join("\n");
  if (questionWatch?.key === key) return;
  questionWatch?.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  for (const dir of new Set(files.map((f) => dirname(f)))) {
    if (dir.startsWith(join(OPS, "leads"))) mkdirSync(dir, { recursive: true }); // Overhand's own folder; never a project's
    if (!existsSync(dir)) continue;
    const names = new Set(files.filter((f) => dirname(f) === dir).map((f) => basename(f)));
    try {
      watchers.push(
        watch(dir, (_, name) => {
          if (name && !names.has(String(name))) return;
          clearTimeout(timer);
          timer = setTimeout(onChange, debounceMs);
        }),
      );
    } catch {
      // the minute tick still picks it up
    }
  }
  questionWatch = {
    key,
    stop: () => {
      clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}

/** Stops watching the questions files (for tests; the daemon watches for its whole life). */
export function unwatchQuestions(): void {
  questionWatch?.stop();
  questionWatch = null;
}

/** The pid of the lead ops started, from this daemon or (after an ops restart) from .leads.json. */
export const leadPid = (g: Godmode, st: LeadState): number => leadChildren.get(g.key)?.pid ?? (isAgent(st.pid) ? st.pid : 0);

/**
 * The account a lead should run on next: its own (`account`, else the first), unless this lead or the ticket agents found
 * it out of capacity; local code may offer others (`accountsFor`). Empty while it waits for its limit to reset.
 */
export function leadAccount(g: Godmode): string {
  return Object.entries(leadFreeAt(g)).find(([, t]) => t < Date.now())?.[0] ?? "";
}

/**
 * True when today's spend cap is what holds every account a lead may use (`free`: when each is free again; `capUntil`:
 * until when the budget holds it, 0 = it doesn't): the one place that tells a cap pause from a usage limit, for the
 * push and the lead's status line alike.
 */
export function heldByCap(free: Record<string, number>, capUntil: (account: string) => number): boolean {
  const accounts = Object.keys(free);
  return accounts.length > 0 && accounts.every((a) => capUntil(a) > 0 && capUntil(a) >= (free[a] ?? 0));
}

/** Why a lead with no account free waits, in the dashboard's words: today's cap (`heldByCap`), else a usage limit. */
export function leadHeldWhy(free: Record<string, number>, capUntil: (account: string) => number): string {
  return heldByCap(free, capUntil) ? plainWords.leadWaitingCap : plainWords.leadHeldLimit;
}

/** When each account a lead may use (in its order) is free again: out of usage on any run (limits.ts), a used-up week, the daily budget. */
export function leadFreeAt(g: Godmode): Record<string, number> {
  const usage = loadUsage(OPS);
  return Object.fromEntries(
    accountsFor(ACCOUNTS, leadAccounts(CFG, g), g.fallbackToAll, 0).map((a) => [
      a,
      // one waiting for its sign-in is free once it's signed in: not at a time
      waitsForSignIn(a, g.project)
        ? Number.POSITIVE_INFINITY
        : Math.max(benchedUntil(a), exhaustedUntil(usage[a], Date.now(), CFG.limits.paceWeekly), budgetUntil(a)),
    ]),
  );
}

/** The lead's process to start on `account` (its CLI's own argv and env); throws when that CLI can't run it here. */
function leadSpawn(g: Godmode, account: string, brief: string, osSandbox: boolean): ReturnType<AgentRuntime["lead"]> {
  const kind = runtimeOf(account).kind;
  const configDir = runHome(account);
  readyHome(kind, configDir);
  return RUNTIMES[kind].lead({
    osSandbox,
    account,
    cwd: leadDir(g),
    prompt: leadPrompt(g, brief),
    schema: "",
    schemaFile: "",
    alias: "",
    provider: providerOf(account),
    model: runtimeOf(account).model,
    tune: runtimeOf(account),
    attribution: CFG.outward.aiAttribution,
    args: [],
    // your MCP servers by flag, strictly, whatever the folder; a config folder of Overhand's (runHome) has the guard
    // written in, your own config (an account still waiting for its own sign-in) gets it by flag
    configDir,
    mcpServers: runMcpServers(mainCheckout(leadDir(g))),
    ...(configDir.startsWith(`${AGENT_HOMES}/`) ? {} : { hooks: guardHooks() }),
    instructions: "",
    read: readSecret,
    autonomy: autonomyFor(CFG, g.project),
    run: `lead-${g.key}`,
    project: g.project,
  });
}

function startLead(g: Godmode, st: LeadState, account: string, brief = ""): void {
  if (!prepareLeadDir(g)) return;
  let spawn: ReturnType<typeof sandboxSpawn>;
  let leadFiles: () => void = () => {};
  try {
    // the OS sandbox (sandbox.ts), from this start on: a lead already running keeps the process it has
    const sb = projectSandbox(g.project);
    const { files, ...lead } = leadSpawn(g, account, brief, sb.effective !== "off");
    leadFiles = writeRunFiles(files); // its MCP servers can carry their tokens
    spawn = sandboxSpawn(
      {
        ...lead,
        // its git push, fetch and gh go through Overhand, which has your sign-in it doesn't (broker.ts)
        env: { ...lead.env, PATH: [writeShims(), lead.env.PATH ?? process.env.PATH ?? ""].join(":") },
        cwd: leadDir(g),
        runtime: runtimeOf(account).kind,
        configDir: runHome(account),
        run: `lead-${g.key}`,
        readOnly: autonomyFor(CFG, g.project) === "watch",
        also: [join(OPS, "leads", g.key)],
      },
      sb,
      gitCommonDir,
    );
  } catch (e) {
    // a CLI that refuses this repo, or an account missing its key: the lead waits and says why, like a held one
    report(`⚠ ${leadName(g)} can't start on ${account}: ${errorText(e)}`);
    st.cantStart = { account, why: errorText(e) };
    st.lastExit = Date.now();
    return;
  }
  const { argv, env } = spawn;
  const logDir = join(OPS, "logs", today());
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `godmode-${g.key}-${Date.now()}.log`);
  const log = Bun.file(logPath);
  // detached: its own process group, so restarting or updating ops (launchd kills ops' whole group; the systemd unit uses KillMode=process) doesn't kill the lead
  mkdirSync(join(OPS, "leads", g.key), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: leadDir(g), env, stdout: log, stderr: log, detached: true });
  recordSpawn(OPS, proc, env, spawn.sandboxed, leadDir(g), spawn.guardOnly);
  const startedAt = Date.now();
  void proc.exited.then(() => {
    spawn.done(startedAt);
    leadFiles();
    if (spawn.sandboxed) ingestOutboxes(OPS, GUARD_LOG);
  });
  proc.unref();
  keepAwakeWhile(proc.pid); // exactly as long as the lead lives
  leadChildren.set(g.key, proc);
  const ran: RunMode = spawn.sandboxed ? "sandboxed" : spawn.guardOnly ? "guard only" : "unsandboxed";
  Object.assign(st, { pid: proc.pid, startedAt: Date.now(), account, log: logPath, waitingLimit: false, startNow: false, ran });
  // a waiting message rode in on this run's brief: this run owes the reply
  Object.assign(st, { replyDue: !!st.message, message: false });
  delete st.cantStart;
  report(
    `⚡ ${leadName(g)} started headless (pid ${proc.pid}, ${account}${spawn.guardOnly ? ", guard only: its project runs without the OS sandbox" : ""})`,
  );
}

/**
 * Books a finished lead run: usage, cost, an exhausted account, crashes, and whether it now waits on your answer.
 * `code` is null when it ended while Overhand was restarting, so the run can't count as a crash.
 */
export function recordLeadExit(g: Godmode, st: LeadState, box: ReturnType<typeof leadInbox>, code: number | null, how: string): void {
  st.lastExit = Date.now();
  const whole = st.log && existsSync(st.log) ? readFileSync(st.log, "utf8") : "";
  const parsed = RUNTIMES[runtimeOf(st.account ?? "").kind].parse(whole, "", code);
  if (parsed.usage && st.account) recordUsage(OPS, st.account, parsed.usage);
  // the PRs this run opened, for Ship: the work pass takes them in with this run's transcript as their proof
  const log = st.log ?? "";
  const ran = { log, from: st.startedAt, to: st.lastExit };
  const opened = log ? prsOpened(whole).map((url) => ({ url, ...ran })) : [];
  if (opened.length) st.opened = [...(st.opened ?? []), ...opened];
  const pushed = log ? branchesPushed(whole).map((branch) => ({ branch, ...ran })) : [];
  if (pushed.length) st.pushed = [...(st.pushed ?? []), ...pushed];
  const final = parsed.ok ? parsed.text.trim() : "";
  if (st.replyDue && final) {
    // its final message answers yours: filed as its reply (on watch too, instead of a report, so it isn't held), the
    // oldest replies trimmed now that nothing else writes the file, and a push that carries none of its words
    appendSection(g, "Reply", final.slice(0, REPLY_MAX));
    writeFileSync(inboxPathOf(g), trimReplies(readFileSync(inboxPathOf(g), "utf8")));
    st.inboxAt = statSync(inboxPathOf(g)).mtimeMs; // a reply isn't a question: no "Question from" for it
    notify(plainWords.alLeadReplied.replace("{lead}", leadName(g)), "");
  } else if (autonomyFor(CFG, g.project) === "watch" && final) {
    // a lead on watch runs read-only and can't write its questions file: its final message is the report, filed for you
    appendSection(g, "Report", final.slice(-REPLY_MAX));
    st.waiting = true; // the next look comes after you've read it and answered (or pressed Start)
  }
  st.replyDue = false;
  const cost = parsed.cost;
  mkdirSync(join(OPS, "runs"), { recursive: true });
  const run = {
    name: `lead-${g.key}`,
    account: st.account,
    start: st.startedAt,
    end: st.lastExit,
    cost,
    ok: code === 0 || code === null,
    kind: "lead",
    project: g.project,
    key: "",
    ...identityOf(st.account ?? ""),
    // only a known billing type is recorded; a guessed one stays open until the account's billing is known
    billing: recordedBilling(st.account ?? ""),
  };
  if (cost) appendFileSync(join(OPS, "runs", `${today()}.jsonl`), `${JSON.stringify(run)}\n`);
  // the log is the run's stdout and stderr; its tail is where a CLI's last error lands
  const until = code !== 0 && !st.stopped ? outOfUsage(whole.slice(-4000), parsed.usage) : 0;
  const limited = until > 0;
  if (limited && st.account) {
    // out of capacity isn't a crash: bench that account for every run; the lead waits for it (local code may offer another)
    bench(st.account, until);
    st.lastExit = 0;
    report(`⏸ ${leadName(g)} hit the usage limit on ${st.account} (back at ${backAt(until)})`);
  }
  const failed = code !== null && code !== 0 && !st.stopped && !limited;
  st.crashes = [...st.crashes.filter((t) => Date.now() - t < 60 * MIN), ...(failed ? [Date.now()] : [])];
  const ranMin = (Date.now() - st.startedAt) / MIN;
  // a failed sandboxed run says how many writes the sandbox refused, read from the unified log after the fact
  const mode = st.ran;
  if (failed && mode === "sandboxed") void sandboxRefusals(st.startedAt).then((n) => report(exitLine(leadName(g), how, ranMin, mode, n)));
  else report(exitLine(leadName(g), how, ranMin, mode));
  if (code === 0 && ranMin < QUICK_EXIT_MIN) {
    st.idle = (st.idle ?? 0) + 1;
    if (st.idle >= 2) report(`💤 ${leadName(g)} found nothing to do; next look in ${restartDelayMin(g, st)} min`);
  } else if (code !== null) st.idle = 0;
  st.pid = 0;
  if (box?.open) st.waiting = true;
  if (st.crashes.length >= g.maxCrashesPerHour) {
    Object.assign(st, { stopped: true, reason: `crashed ${st.crashes.length} times within an hour` });
    notify(
      `${leadName(g)} stopped`,
      `It crashed ${st.crashes.length} times within an hour. Its log in Crew says why; press Start when it's fixed.`,
    );
    report(`🛑 ${leadName(g)}: ${st.reason}, not restarting`);
  }
}

/**
 * What ops found for a project that an on-demand lead should handle (only the kinds in `watch`, when given); empty when
 * there is nothing. The dashboard counts the same work (`leadWork`) to suggest ready-made leads.
 */
export function demandBrief(
  project: string,
  st: WorkSignals,
  tix: Ticket[],
  queueLabel: string,
  watch: readonly LeadWorkKind[] = [],
): string {
  return leadWork(project, st, tix, queueLabel)
    .filter((i) => !watch.length || watch.includes(i.kind))
    .map((i) => `- ${i.brief}`)
    .join("\n");
}

const inside = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`);
/**
 * True when lead `g` may push to `project`'s repos: it's that project's lead, its group's (it works in every member's
 * repos), or a lead with no project whose folder holds the project's folder or sits inside it.
 */
export function leadCovers(g: Pick<Godmode, "project" | "dir">, project: string): boolean {
  if (g.project) return g.project === project || groupOf(CFG, project)?.name === g.project;
  const c = CLIENTS.find((x) => x.name === project);
  if (!c) return false;
  const [lead, own] = [join(CODE, g.dir), join(CODE, c.dir)];
  return inside(lead, own) || inside(own, lead);
}

/** The projects lead `g` may push to (`leadCovers`). */
export const projectsOf = (g: Pick<Godmode, "project" | "dir">): string[] =>
  CLIENTS.filter((c) => leadCovers(g, c.name)).map((c) => c.name);

/** True while any lead that may push to `project` runs: Ship never turns auto-merge on for a lead's PR then. */
export function leadBusy(project: string, leads: Record<string, LeadState> = loadLeads()): boolean {
  return CFG.godmode.some((g) => leadCovers(g, project) && (lockHolder(g) || leadPid(g, leads[g.key] ?? blankLead())));
}

/** A lead PR's key (lead-prs.ts `leadPrKey`): its project's prefix, then `-LEAD-`. */
export const isLeadPrKey = (key: string): boolean => /^[A-Z][A-Z0-9]*-LEAD-/.test(key);

/**
 * The lead PRs of `project` whose auto-merge may be on, by key: what state.json says is armed, and every Ship request
 * on record for one that was neither merged nor turned off since, so a request a work pass made and hasn't saved yet
 * counts too. Each comes back marked armed, so turning it off is never skipped.
 */
export function armedLeadPrs(
  project: string,
  prs: Record<string, TrackedPr>,
  ships: readonly ShipRecord[] = loadShips(),
): [string, TrackedPr][] {
  const out = new Map<string, TrackedPr>();
  const on = (p: TrackedPr): TrackedPr => ({ ...p, ship: { on: true, why: "", head: p.ship?.head ?? "", final: false } });
  for (const [key, p] of Object.entries(prs)) if (p.lead && p.ship?.on && clientOf(key)?.name === project) out.set(key, on(p));
  const last = new Map(ships.filter((s) => s.project === project && isLeadPrKey(s.key)).map((s) => [s.url, s]));
  for (const s of last.values())
    if (!s.merged && !s.off && !out.has(s.key)) {
      const known = prs[s.key];
      const { url, repo, number, base, mainRepo } = s;
      const bare: TrackedPr = { url, host: "github", repo, number, base, mainRepo, repoPath: mainRepo, branch: "", seen: "", fixes: 0 };
      out.set(s.key, on(known ?? bare));
    }
  return [...out];
}

let releasing = false;
/**
 * Before a lead starts (or while one runs by hand), its project's lead PRs whose auto-merge may be on get it turned
 * off, so nothing a lead pushes can merge unchecked; their proof goes too, since the lead may change them, and comes
 * back only from a later run that pushed that branch (lead-prs.ts), else the PR waits for you. True while any is still
 * on: the start waits, also when turning one off failed.
 */
export function shipHolds(project: string, run: Run = shAsync): boolean {
  return holdArmed(armedLeadPrs(project, loadState().prs), run);
}

/** `shipHolds` for every project lead `g` may push to (`projectsOf`): a group's lead or a folder's holds them all. */
export function leadShipHolds(g: Pick<Godmode, "project" | "dir">, run: Run = shAsync): boolean {
  const prs = loadState().prs;
  return holdArmed(
    projectsOf(g).flatMap((p) => armedLeadPrs(p, prs)),
    run,
  );
}

function holdArmed(armed: [string, TrackedPr][], run: Run): boolean {
  if (!armed.length) return false;
  if (!releasing) {
    releasing = true;
    void releaseLeadPrs(armed, run).finally(() => {
      releasing = false;
    });
  }
  return true;
}

/** `shipHolds`' work: auto-merge off on each, then their state saved with their proof cleared (`proofOff`). */
export async function releaseLeadPrs(armed: readonly [string, TrackedPr][], run: Run = shAsync): Promise<void> {
  for (const [key, pr] of armed) await disarmForPush(key, pr, run).catch((e: unknown) => report(`⚠ ${key}: Ship: ${errorText(e)}`));
  // read-modify-write of state.json: a work pass that saves an older copy can only re-mark one armed, which the next
  // tick turns off again (already off on GitHub counts as off); its stale proof can't arm it, as its head moved on
  const s = loadState();
  for (const [key, pr] of armed) {
    const p = s.prs[key];
    if (!p) continue;
    p.ship = pr.ship;
    if (!pr.ship?.on) Object.assign(p, { proof: undefined, proofOff: Date.now() });
  }
  saveState(s);
}

/**
 * Whether the lead starts now and with what brief, or null while it rests. It starts at once for an answered question
 * (`waiting`), Start (`startNow`) or a message waiting for it; else an on-demand lead for new work (`demand`, from
 * demandBrief) and an always-on one once it has rested restartDelayMin. A waiting message rides in the brief.
 */
export function wakeBrief(g: Godmode, st: LeadState, demand: string, now = Date.now()): string | null {
  const due = st.waiting || st.startNow || st.message;
  const rests = g.onDemand ? !demand || demand === st.lastBrief : now - st.lastExit < restartDelayMin(g, st) * MIN;
  if (!due && rests) return null;
  return [demand, st.message ? messageText(g) : ""].filter(Boolean).join("\n");
}

/**
 * Runs every minute: keeps exactly one lead per supervised godmode entry, restarts it restartDelayMin after an exit,
 * stops restarting after maxCrashesPerHour failed exits, and notifies when its inbox file changes.
 */
export function superviseLeads(): void {
  enforceBudget();
  const leads = loadLeads();
  for (const g of CFG.godmode) {
    const st = leadOf(leads, g.key);
    let box = leadInbox(g);
    const went = autoDefault(g, st, box);
    if (went) {
      report(`⏩ ${leadName(g)}: no reply in ${g.answerWaitHours} h, went with its default: ${went}`);
      notify(`${leadName(g)} went with its default`, went);
      box = leadInbox(g);
    } else if (recheckQuestion(g, st, box)) {
      report(`🔁 ${leadName(g)}: its question gave no default in ${RECHECK_HOURS} h; asked it to re-check and re-ask with one`);
      box = leadInbox(g);
    }
    const notice = leadNotice(g, st, box);
    if (notice) notify(notice.title, notice.body, notice.actions);
    const child = leadChildren.get(g.key);
    if (child && child.exitCode === null && child.signalCode === null) continue;
    if (child) {
      leadChildren.delete(g.key);
      // killed by a signal: a crash, unless it's the run you stopped just before pressing Start
      recordLeadExit(g, st, box, child.exitCode ?? (st.startNow ? null : 1), String(child.exitCode ?? child.signalCode));
    } else if (st.pid && st.startedAt > st.lastExit && !isAgent(st.pid)) {
      // a lead started before an ops restart has no child handle; its pid being gone is its exit, status unknown
      recordLeadExit(g, st, box, null, "while Overhand was restarting");
    }
    // a lead someone runs by hand may push too: its project's lead PRs go back to waiting all the same
    if (lockHolder(g)) leadShipHolds(g);
    if (!g.supervised || st.stopped || existsSync(join(OPS, "PAUSE")) || lockHolder(g) || diskLow()) continue;
    if (isAgent(st.pid) && st.pid !== child?.pid) continue; // ours from before a daemon restart, still starting up
    if (heldOnQuestion(st, box)) continue; // still unanswered: restarting would only re-ask
    let demand = "";
    if (g.onDemand) {
      const tix = ticketCache.data[g.project];
      demand = demandBrief(g.project, status, Array.isArray(tix) ? tix : [], LABEL.queue, g.watch);
      if (!demand) st.lastBrief = ""; // nothing now: the same trouble returning later wakes it again
    }
    const brief = wakeBrief(g, st, demand);
    if (brief === null) continue;
    const account = leadAccount(g);
    if (!account) {
      const free = leadFreeAt(g);
      const { limitAccount, limitBack: at } = limitBack(free);
      // the cap's line already says when it resumes; a usage limit names the account back first
      const back =
        limitAccount && at && !heldByCap(free, budgetUntil) ? `${limitAccount} is back first, at ${new Date(at).toLocaleString()}` : "";
      if (!st.waitingLimit) notify(`${leadName(g)} is waiting`, [leadHeldWhy(free, budgetUntil), back].filter(Boolean).join(" "));
      st.waitingLimit = true;
      continue;
    }
    if (leadShipHolds(g)) continue; // the armed lead PRs of every project it may push to go back to waiting first
    if (st.waiting || st.startNow || st.message || demand) st.idle = 0; // there is something to do now: back to the normal pace
    st.waiting = false;
    if (demand) st.lastBrief = demand;
    startLead(g, st, account, brief); // an answered question resumes at once rather than after restartAfterMin
  }
  saveLeads(leads);
}
