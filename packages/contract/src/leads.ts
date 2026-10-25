/**
 * Ready-made leads and the evidence that wakes them, plus the short names people see for leads, sessions and worktrees.
 * Pure: the daemon wakes leads with `leadWork` and the dashboard suggests them from the same function, so a suggestion's
 * count is exactly what would wake the lead.
 */
import type { Advisory, Ci, Deploy, ErrorIssue, FileCount, Outdated, PullRequest, Ticket } from "./index";

/** The kinds of work a ready-made lead takes on, in the order they're suggested. */
export const LEAD_WORK = ["reviews", "ci", "errors", "deps", "current", "untested", "todos", "backlog"] as const;
export type LeadWorkKind = (typeof LEAD_WORK)[number];

/**
 * Ready-made leads, one per kind of work: what the lead is told to work toward. Each sleeps until Overhand finds its
 * kind of work on the project (`leadWork`), and goes as far as the project's mode allows. Their names are in words.ts.
 */
export const LEAD_TEMPLATES = {
  reviews: {
    goal: "Answer the review comments on this project's open pull requests: make each requested change, reply to the comment, and keep the checks green until the reviewer is satisfied.",
  },
  ci: {
    goal: "Keep CI green: when a build on the default branch, a pull request's checks or a production deploy goes red, find the root cause (flaky tests included) and fix it; never just retry or skip a test.",
  },
  errors: {
    goal: "Fix new production errors: reproduce each one, find the cause, and fix it with a test that covers it.",
  },
  deps: {
    goal: "Keep dependencies safe: for each open security advisory, upgrade the affected package to the smallest version that fixes it, on its own branch with one pull request per advisory, and keep the repo's checks green. When no fixed version exists yet, say so instead of changing anything.",
  },
  current: {
    goal: "Keep dependencies current: update the direct dependencies that have patch or minor updates, all together in one pull request at most once a week. Never apply a major update; list each one in that pull request's description for the owner to decide.",
  },
  untested: {
    goal: "Test what's untested: of the files listed (changed most in the last 30 days, and no test names them), pick the riskiest few and add tests that pin down what they do today, in the repo's own test style. Don't change their behaviour; when a test finds a bug, report it rather than fix it in the same pull request.",
  },
  todos: {
    goal: "Clear the TODOs: do the small, safe TODO, FIXME and HACK notes in the files listed. File each one that's bigger, or needs a decision, as a ticket in the project's tracker; when the project has no tracker, list them in the pull request's description instead.",
  },
  backlog: {
    goal: "Work the backlog: take the tickets marked for agents, smallest first, one pull request each.",
  },
} as const satisfies Record<LeadWorkKind, { goal: string }>;

/**
 * How every lead works, whatever its goal: written once, and put into each lead's prompt by the code that builds it
 * (core leadPrompt), never pasted into a goal. Short, since every prompt carries it.
 */
export const WAY_OF_WORKING =
  "How to work: read the repo's own rules first (AGENTS.md, CLAUDE.md, CONTRIBUTING) and match its style and commit conventions. Make the smallest change that fixes the root cause. Open one pull request per change, with a description that says what changed and why. Add or adjust a test for every change in behaviour, and run the project's own checks before opening it. Never skip a test, disable a check or force-push. When a choice is a product decision, ask.";

/** The config key of a project's lead made from a template, e.g. "honeycrust-web-ci". */
export const templateKey = (project: string, id: string): string => `${project.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id}`;

/** One piece of work Overhand found on a project: its kind, a short reference, and the line the lead is woken with. */
export interface LeadWorkItem {
  kind: LeadWorkKind;
  /** "shop#4", "shop main", "SHOP-142": what a person calls it. */
  ref: string;
  url: string;
  /** The line in the lead's wake-up brief. */
  brief: string;
}

/** The signals `leadWork` reads: the dashboard's `status`, or the daemon's live one. A string is a list's fetch error. */
export interface WorkSignals {
  ci: readonly Ci[];
  myPrs: readonly PullRequest[];
  sentry: readonly ErrorIssue[] | string;
  deploys?: readonly Deploy[] | string;
  /** Open Dependabot alerts; absent where they're off or unreadable, so no advisory work is found there. */
  advisories?: readonly Advisory[];
  /** Direct dependencies with updates; only patch and minor ones are work (a major waits for a person). */
  outdated?: readonly Outdated[];
  /** Often-changed source files no test names. */
  untested?: readonly FileCount[];
  /** Files with TODO notes, from the check-up's count. */
  todos?: readonly FileCount[];
}

/**
 * The work Overhand found for a project's leads, in brief order: red builds, new errors, review feedback, failing
 * checks, failed production deploys, open security advisories, patch and minor dependency updates, often-changed files
 * no test names, files with TODO notes and tickets armed for agents (`queueLabel`).
 */
export function leadWork(project: string, st: WorkSignals, tix: readonly Ticket[], queueLabel: string): LeadWorkItem[] {
  const mine = <T extends { client: string }>(xs: readonly T[] | string | undefined): T[] =>
    Array.isArray(xs) ? xs.filter((x) => x.client === project) : [];
  const prs = mine(st.myPrs);
  const changes = (p: PullRequest) => p.review === "CHANGES_REQUESTED";
  return [
    ...mine(st.ci)
      .filter((c) => c.state === "fail")
      .map((c) => ({
        kind: "ci" as const,
        ref: `${c.repo} ${c.branch}`,
        url: c.url,
        brief: `Red build on ${c.repo} ${c.branch}: ${c.failing.join(", ")} ${c.url}`,
      })),
    ...mine<ErrorIssue>(st.sentry)
      .filter((i) => i.isNew)
      .map((i) => ({ kind: "errors" as const, ref: i.id, url: i.url, brief: `New error: ${i.title} ${i.url}` })),
    ...prs.filter(changes).map((p) => ({
      kind: "reviews" as const,
      ref: `${p.repo}#${p.number}`,
      url: p.url,
      brief: `Review feedback on ${p.repo}#${p.number}: ${p.title} ${p.url}`,
    })),
    ...prs
      .filter((p) => !changes(p) && /FAILURE|ERROR/.test(p.checks))
      .map((p) => ({
        kind: "ci" as const,
        ref: `${p.repo}#${p.number}`,
        url: p.url,
        brief: `Failing checks on ${p.repo}#${p.number}: ${p.title} ${p.url}`,
      })),
    ...mine<Deploy>(st.deploys)
      .filter((d) => /ERROR|CANCELED/.test(d.state) && d.target === "production")
      .map((d) => ({ kind: "ci" as const, ref: d.project, url: d.url, brief: `Failed production deploy of ${d.project}: ${d.url}` })),
    ...mine<Advisory>(st.advisories).map((a) => ({
      kind: "deps" as const,
      ref: `${a.package} in ${a.repo}`,
      url: a.url,
      brief: `Security advisory ${a.repo}#${a.number} on ${a.package} (${a.ecosystem}, ${a.severity}): ${a.summary}; ${a.fix ? `fixed in ${a.fix}` : "no fixed version yet"} ${a.url}`,
    })),
    ...mine<Outdated>(st.outdated)
      .filter((o) => o.update !== "major")
      .map((o) => ({
        kind: "current" as const,
        ref: `${o.package} in ${o.repo}`,
        url: "",
        brief: `${o.update} update in ${o.repo}: ${o.package} ${o.current} → ${o.next} (${o.manager})`,
      })),
    ...mine<FileCount>(st.untested).map((f) => ({
      kind: "untested" as const,
      ref: `${f.repo}/${f.path}`,
      url: "",
      brief: `No test names ${f.repo}/${f.path}, changed in ${f.n} commits in the last 30 days`,
    })),
    ...mine<FileCount>(st.todos).map((f) => ({
      kind: "todos" as const,
      ref: `${f.repo}/${f.path}`,
      url: "",
      brief: `${f.n} TODO, FIXME or HACK notes in ${f.repo}/${f.path}`,
    })),
    ...tix
      .filter((t) => t.labels.includes(queueLabel))
      .map((t) => ({ kind: "backlog" as const, ref: t.key, url: t.url, brief: `Armed ticket ${t.key}: ${t.title} ${t.url}` })),
  ];
}

/** Branches that name no work of their own. */
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "head", "staging", "production"]);
/** Words a branch starts with that say its kind of change, not its work. */
const KINDS = new Set("feat feature fix bugfix hotfix chore docs refactor test tests ci build perf style wip".split(" "));
/** Words that name a tool, never the work: dropped wherever they are, so no vendor reaches a name. */
const TOOLS = new Set("worktree worktrees wt agent agents claude codex cursor copilot gemini devin aider openai anthropic".split(" "));
const ACRONYMS = new Set(["ci", "pr", "api", "ui", "ux", "css", "html", "sdk", "url", "id", "ios", "seo", "csv", "pdf"]);
/** A generated id rather than a word: letters and digits mixed, or a long hex run. */
const generated = (w: string) => (/\d/.test(w) && /[a-z]/i.test(w) && w.length >= 5) || /^[0-9a-f]{7,}$/i.test(w);
const TICKET_KEY = /\b([a-z][a-z0-9]+-\d+)\b/i;

/**
 * A branch as the words a person would say: "feat/pricing-fix" → "Pricing fix", at most four words, its kind and its
 * tool dropped. "" for a default branch, or one with nothing left but generated ids.
 */
export function branchWords(branch: string): string {
  if (DEFAULT_BRANCHES.has(branch.toLowerCase())) return "";
  const words = branch
    .replace(TICKET_KEY, " ")
    .split(/[/_\-.\s]+/)
    .filter((w) => w && !generated(w) && !/^\d+$/.test(w) && !TOOLS.has(w.toLowerCase()));
  // "fix/ci" keeps "CI": a kind word goes only while work words remain after it
  while (words.length > 1 && KINDS.has((words[0] ?? "").toLowerCase())) words.shift();
  const out = words.slice(0, 4).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const first = out[0];
  if (!first) return "";
  out[0] = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  return out.join(" ");
}

/** Small words a sentence needs and a name doesn't. */
const FILLER = new Set(
  "a an the and or but of to in on at for from with by is are was be when so its it their our my this that".split(" "),
);
const CONVENTIONAL = /^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i;

/**
 * A PR title or commit subject as a name, the way a branch is read: "fix(cart): keep the cart when a session expires"
 * → "Keep cart session expires". Its conventional prefix, punctuation and filler words go; "" when nothing is left.
 */
export function titleWords(title: string): string {
  const words = title
    .replace(CONVENTIONAL, "")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  return branchWords(words.join(" "));
}

/**
 * The short name of a piece of work (a session, a subagent, a worktree), from the person's own words first: their
 * rename in Overhand, the name they gave it in their agent, its branch, the title of the ticket the branch names (when
 * short; else the key); then the project's own words for it (`vocab`, best first: its PR's title, its own commits'
 * subjects, its folder), each read by `titleWords`; and otherwise `fallback`, a job or place name. Only this project's
 * tickets and words are passed in (the daemon leaves out any carrying another project's private words), so a name never
 * carries another project's words.
 */
export function workName(o: {
  renamed?: string;
  own?: string;
  branch: string;
  tickets: readonly Ticket[];
  vocab?: readonly string[];
  fallback: string;
}): string {
  const key = o.branch.match(TICKET_KEY)?.[1]?.toUpperCase() ?? "";
  const t = key ? o.tickets.find((x) => x.key.toUpperCase() === key) : undefined;
  const title = t && t.title.trim().split(/\s+/).length <= 4 ? t.title.trim() : t?.key;
  const vocab = (o.vocab ?? []).map(titleWords).find(Boolean);
  return o.renamed?.trim() || o.own?.trim() || branchWords(o.branch) || title || vocab || o.fallback;
}

/** The id a person's rename of a piece of work is kept under: its project and branch, so it holds in every list. */
export const workId = (project: string, branch: string): string => `work:${project}/${branch}`;
/** The id a person's rename of a lead is kept under. */
export const leadId = (key: string): string => `lead:${key}`;
/** Where the names something went by before its latest rename are kept (newest first, one per line), so older log lines still name it. */
export const wasId = (id: string): string => `${id}#was`;

/**
 * When a message sent to a lead now reaches it: at its next step (a running session that takes requests), when this run
 * ends (any other running agent), or Overhand starts it for it.
 */
export const LEAD_HEARS = ["now", "after-run", "starts"] as const;
export type LeadHears = (typeof LEAD_HEARS)[number];

/** One part of a lead's questions file, read as a conversation. */
export interface ThreadEntry {
  /** You (an answer or message from you, or a teammate on your behalf), Overhand (its own answers), or the lead. */
  who: "you" | "overhand" | "lead";
  kind: "question" | "answer" | "message" | "report" | "reply";
  /** A question's own heading; "" for the rest. */
  title: string;
  /** When it was written, from the heading's stamp (UTC "YYYY-MM-DD HH:MM"); 0 when it has none. */
  at: number;
  body: string;
}

/** The body Overhand writes for an answer you gave outside it, when you add no note. */
export const ELSEWHERE_TEXT = "Answered outside Overhand: re-read the current state before continuing.";
/** The note beside that answer's stamp. */
export const ELSEWHERE_NOTE = "given outside Overhand";
/** The body of a dismissed question. */
export const DISMISS_TEXT = "Dismissed: this no longer applies; re-read the current state.";
/** The note beside a message's stamp: an answer you sent with no question open. */
export const MESSAGE_NOTE = "message";

/** A questions file section's heading as Overhand writes it: "## <head> (<note>, <stamp>)", stamped in UTC to the minute. */
export const sectionHeading = (head: string, note: string, at: Date): string =>
  `## ${head} (${[note, at.toISOString().slice(0, 16).replace("T", " ")].filter(Boolean).join(", ")})`;

/** "## <heading> (<notes>, <stamp>)": the heading and what its brackets hold. */
const HEADING = /^## (.*?)(?:\s+\(([^()]*)\))?\s*$/;
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d$/;

/**
 * A lead's questions file as a conversation, oldest first: "## Answer from Overhand" is Overhand's, any other "## Answer
 * from" is yours (a message when its note says so), "## Report" and "## Reply" are the lead's, and every other heading is
 * the lead's question. Text before the first heading, or a file with none, is the lead's too.
 */
export function threadOf(text: string): ThreadEntry[] {
  return text
    .split(/^(?=## )/m)
    .filter((p) => p.trim())
    .map((p): ThreadEntry => {
      if (!p.startsWith("## ")) return { who: "lead", kind: "question", title: "", at: 0, body: p.trim() };
      const [first = "", ...rest] = p.split("\n");
      const body = rest.join("\n").trim();
      const [, head = "", note = ""] = first.match(HEADING) ?? [];
      const stamp = note.split(", ").at(-1) ?? "";
      const at = STAMP.test(stamp) ? Date.parse(`${stamp.replace(" ", "T")}:00Z`) : 0;
      if (head.startsWith("Answer from ")) {
        const overhand = head === "Answer from Overhand";
        const kind = !overhand && note.split(", ")[0] === MESSAGE_NOTE ? "message" : "answer";
        return { who: overhand ? "overhand" : "you", kind, title: "", at, body };
      }
      if (head === "Reply" || head === "Report") return { who: "lead", kind: head === "Reply" ? "reply" : "report", title: "", at, body };
      return { who: "lead", kind: "question", title: first.slice(3).trim(), at: 0, body };
    });
}

/** What's still open in a conversation: everything the lead wrote after the newest answer, message or reply. */
export const openPart = (thread: readonly ThreadEntry[]): ThreadEntry[] =>
  thread.slice(thread.findLastIndex((e) => e.who !== "lead" || e.kind === "reply") + 1);

/** The open part of a lead's questions file as Markdown again: the question, never the conversation above it. */
export const openText = (text: string): string =>
  openPart(threadOf(text))
    .map((e) => [e.title && `## ${e.title}`, e.body].filter(Boolean).join("\n\n"))
    .join("\n\n");
