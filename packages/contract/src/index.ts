/**
 * The contract between the daemon and every client (the web dashboard, the World view, the CLI).
 * The daemon's `/api/state` returns a `DashboardState`; the schemas let either side validate the other.
 */
import { z } from "zod";
import { AutonomySchema } from "./autonomy";
import { BillingSchema } from "./billing";
import { CardButtonSchema, PlanPointsSchema } from "./decide";
import { GuideSchema } from "./guide";
import { ProjectInstructionsSchema } from "./instructions";
import { LEAD_WORK } from "./leads";
import { LeakSchema } from "./outward";
import { ProgressionSchema } from "./progression";
import { ProofSchema } from "./proof";
import { RuleSuggestionSchema } from "./rules";
import { SandboxStatusSchema } from "./sandbox";
import { RouteSuggestionSchema, RoutingModeSchema, RunKindSchema, ScorecardSchema } from "./scorecard";
import { TeamStateSchema } from "./team";
import { UpdateStatusSchema } from "./updates";

export * from "./autonomy";
export * from "./billing";
export * from "./decide";
export * from "./features";
export * from "./feedback";
export * from "./guard";
export * from "./guide";
export * from "./instructions";
export * from "./leads";
export * from "./links";
export * from "./organise";
export * from "./outward";
export * from "./plain";
export * from "./plans";
export * from "./progression";
export * from "./proof";
export * from "./relay";
export * from "./rules";
export * from "./sandbox";
export * from "./scorecard";
export * from "./summary";
export * from "./team";
export * from "./updates";
export * from "./workreport";

/** How old a read (Slack, an account's usage) may be when you come back to the app before a fresh one is asked for. */
export const FRESH_MIN = 10;

/** Whether something read at `at` (0: never) is more than `min` minutes old at `now`. */
export const isStale = (at: number, now: number, min = FRESH_MIN): boolean => now - at > min * 60_000;

/**
 * A throttle for automatic asks (the app coming back into view): true at most once per `min` minutes, and only when
 * what it would refresh (read at `readAt`) is that old too. One per kind of read, on each side: the app keeps a tab from
 * asking on every glance, the daemon keeps many tabs and devices from multiplying the cost.
 */
export function askGate(min = FRESH_MIN): (readAt: number, now: number) => boolean {
  let askedAt = 0;
  return (readAt, now) => {
    if (!isStale(readAt, now, min) || !isStale(askedAt, now, min)) return false;
    askedAt = now;
    return true;
  };
}

/** One Claude account's subscription windows, as Claude Code reports them. */
export const AccountUsageSchema = z.object({
  /** Share of the 5-hour window used, 0–1; -1 when Claude Code didn't report it. */
  fiveHour: z.number(),
  fiveHourResetsAt: z.number(),
  sevenDay: z.number(),
  sevenDayResetsAt: z.number(),
  /** allowed | allowed_warning | rejected */
  status: z.string(),
  at: z.number(),
});

export const AccountSchema = z.object({
  name: z.string(),
  /** Epoch ms until the account is usable again; 0 = usable. */
  coolUntil: z.number(),
  usage: AccountUsageSchema.nullable(),
  /** Model backend: claude | bedrock | vertex | gateway (older daemons send none: claude). */
  provider: z.string().default("claude"),
  /** The model it's pinned to; empty = the backend's default. */
  model: z.string().default(""),
  /** Agent CLI: claude-code | codex | gemini | cursor | opencode | aider (older daemons send none: claude-code). */
  runtime: z.string().default("claude-code"),
  /** How it's paid for: plan, pay-per-use, cloud or local (older daemons send none: plan). */
  billing: BillingSchema.default("plan"),
  /** `billing` is known (set, or read from its sign-in), not a guess; a guess counts toward the budget and Needs you asks. */
  billingSure: z.boolean().default(true),
  /** Still on your own agent config where the OS sandbox is enforced: its runs wait for one sign-in in its own folder. */
  waitsSignIn: z.boolean().default(false),
});

export const TicketSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  labels: z.array(z.string()),
  url: z.string(),
});

/** What a corner-cut finding is about: a weakened test, check or CI step, or a secret in the diff. */
export const CORNER_KINDS = [
  "test-deleted",
  "tests-removed",
  "assertions-removed",
  "test-skipped",
  "test-focused",
  "check-loosened",
  "threshold-lowered",
  "ci-weakened",
  "snapshots-rewritten",
  "secret",
] as const;

/**
 * One way an agent PR may have cut a corner, found in its diff without a model. `block`: look before merging; `warn`:
 * worth a glance. `text` is the added (`+`) or removed (`-`) line with secrets redacted, or a short note when the finding
 * is about whole files; `line` is its line number on that side, 0 for whole files.
 */
export const CornerSchema = z.object({
  kind: z.enum(CORNER_KINDS),
  severity: z.enum(["warn", "block"]),
  file: z.string(),
  line: z.number(),
  sign: z.enum(["+", "-"]),
  text: z.string(),
});

/** One tool call the guard blocked, as the guardrail log (guardrails.jsonl) keeps it, secrets in `action` redacted. */
export const GuardBlockSchema = z.object({
  at: z.number(),
  /** The project; empty when the guard couldn't tell. */
  project: z.string(),
  /** The run's log name (a ticket key, `HONEY-1-fix`) or `lead-<key>`; empty when unknown. */
  run: z.string(),
  tool: z.string(),
  /** The command or path it tried, redacted and cut short. */
  action: z.string(),
  /** The rule that blocked it. */
  rule: z.string(),
});

// ---------- the control room ----------

/** A typed request from one session (or the owner) to another, delivered by the guard hook at the target's next tool call. */
export const RequestSchema = z.object({
  id: z.string(),
  /** Who asked: a Overhand run, a project, or "owner". */
  from: z.string(),
  /** The target session's id (Claude Code's session id) and how it was named. */
  to: z.string(),
  toLabel: z.string(),
  text: z.string(),
  /** The deadline (ms), or 0. */
  by: z.number(),
  state: z.enum(["sent", "acknowledged", "done", "refused", "dropped"]),
  at: z.number(),
  /** When the hook last handed it to the session, 0 = not yet. */
  deliveredAt: z.number().default(0),
  /** When it reached its current state. */
  changedAt: z.number().default(0),
  /** What the session said with its ack, done or refusal. */
  note: z.string().default(""),
});

/** One thing Overhand did from the control room with the owner's authority: a button, or a standing approval (auto). */
export const ControlActionSchema = z.object({
  at: z.number(),
  card: z.string(),
  button: z.string(),
  /** What happened, in a line. */
  result: z.string(),
  ok: z.boolean(),
  auto: z.boolean(),
});

/** Every agent session on this machine, Overhand-started or opened by hand, as the control room sees it. */
export const ControlSessionSchema = z.object({
  /** Claude Code's session id when its project is connected (the hook reported it), else `pid:<pid>`. */
  key: z.string(),
  pid: z.number(),
  kind: z.enum(["agent", "lead", "you"]),
  label: z.string(),
  name: z.string(),
  project: z.string(),
  /** The repository folder and branch it works in. */
  repo: z.string(),
  branch: z.string(),
  cwd: z.string(),
  /** The guard hook reports it: house rules and the governor apply to it. */
  connected: z.boolean(),
  /** Overhand started it or it's connected: the control room may act on its processes. */
  registered: z.boolean(),
  /** Processes in its tree, the TCP ports they listen on, headless browsers among them. */
  procs: z.number(),
  ports: z.array(z.number()),
  browsers: z.number(),
  /** Heavy jobs it holds a governor slot for. */
  heavy: z.array(z.object({ kind: z.string(), cmd: z.string(), since: z.number() })),
  lastAt: z.number(),
  active: z.boolean(),
  /** It has been handed the current house rules. */
  rulesAck: z.boolean(),
  /** Why its tool calls are held (the owner paused it), or "". */
  paused: z.string(),
});

const LevelSchema = z.enum(["ok", "warn", "bad"]);

/** How hard this machine works: plain gauges, a 3-hour line with spikes named by cause, and who's using it while strained. */
export const StrainSchema = z.object({
  level: LevelSchema,
  /** cpu: × capacity (load per core); mem: share in use; disk: GB free; battery: percent; heat: throttling. */
  gauges: z.array(z.object({ what: z.enum(["cpu", "mem", "disk", "battery", "heat"]), level: LevelSchema, value: z.number() })),
  history: z.array(z.object({ at: z.number(), cpu: z.number(), mem: z.number(), level: LevelSchema, cause: z.string() })),
  /** By agent session, largest first: CPU as a share of capacity, memory in MB; `other` is everything else, unnamed. */
  groups: z.array(z.object({ label: z.string(), cpu: z.number(), memMb: z.number() })),
  other: z.object({ cpu: z.number(), memMb: z.number() }),
  cause: z.string(),
});

/** Correlated signals turned into a decision: Overhand does what the button says, with the owner's authority. */
export const ActionCardSchema = z.object({
  id: z.string(),
  kind: z.enum(["quiet-heavy", "unmanaged-heavy", "competing", "foreign-pr", "same-files", "silent", "overdue", "strain"]),
  project: z.string(),
  /** The facts its words are filled from (who, browsers, load, until, repo, branch, files, cmd, min, n, text). */
  facts: z.record(z.string(), z.union([z.string(), z.number()])),
  buttons: z.array(CardButtonSchema),
  /** A standing approval covers it: Overhand acts on its own within a minute and reports it. */
  auto: z.boolean(),
});

/** A pull request the agent opened and ops tracks until it merges. */
export const AgentPrSchema = z.object({
  key: z.string(),
  url: z.string(),
  fixes: z.number(),
  branch: z.string(),
  /** Opened as a draft and still one: it waits for you to review it. Optional for older daemons. */
  draft: z.boolean().default(false),
  /** Corners its diff may have cut, as of its last push. Empty for older daemons. */
  corners: z.array(CornerSchema).default([]),
  /** What the agent ran and checked, and the gaps, as of its last run (proof.ts). Null for older daemons and PRs. */
  proof: ProofSchema.nullable().optional(),
  /** Where to see it running: its deploy preview, found on its head commit (Vercel, Cloudflare, Netlify, Render). "" = none. */
  preview: z.string().default(""),
  /** The fix round your notes on its preview became; 0 = none sent. */
  reviewRound: z.number().default(0),
  /**
   * On a Ship project: `on` when GitHub's auto-merge is on (it merges once every required check passes), else `why` it
   * waits for your merge. Null off Ship, before Ship looked at it, and from older daemons.
   */
  ship: z.object({ on: z.boolean(), why: z.string() }).nullable().optional(),
});

/** A PR that merged on Ship (GitHub's auto-merge, once CI was green) in the last two days, with its Undo. */
export const ShippedSchema = z.object({
  key: z.string(),
  project: z.string(),
  url: z.string(),
  merged: z.number(),
  /** The revert PR Undo opened; "" = none yet. */
  revert: z.string().default(""),
});
export type Shipped = z.infer<typeof ShippedSchema>;

/** A Slack request waiting out the veto window before it becomes a ticket. */
export const PendingTicketSchema = z.object({
  id: z.string(),
  client: z.string(),
  title: z.string(),
  details: z.string(),
  permalink: z.string(),
  from: z.string(),
  createAfter: z.number(),
  created: z.string().optional(),
  /** Feedback for this ticket: commented on it instead of filing a new one. */
  ticket: z.string().optional(),
});

/** One part of a split an agent proposed for a ticket too big for one PR (#9). */
export const SplitPartSchema = z.object({
  title: z.string().trim().min(1).max(200),
  scope: z.string().max(4000),
});

export const SubagentSchema = z.object({
  name: z.string(),
  description: z.string(),
  color: z.string(),
  active: z.boolean(),
  lastAt: z.number(),
  model: z.string(),
  mode: z.string(),
  /** Where it works, from its own transcript, when that differs from its session's: folder, project and branch. Empty for older daemons. */
  cwd: z.string().optional(),
  client: z.string().optional(),
  branch: z.string().optional(),
});

/** A Claude Code process running on this machine. */
export const SessionSchema = z.object({
  pid: z.number(),
  kind: z.enum(["agent", "lead", "you"]),
  label: z.string(),
  client: z.string(),
  cwd: z.string(),
  upSec: z.number(),
  /** Wrote to its transcript in the last 2 minutes. */
  active: z.boolean(),
  name: z.string(),
  model: z.string(),
  mode: z.string(),
  lastAction: z.string(),
  subagents: z.array(SubagentSchema),
  /** The branch checked out where it works now (its transcript's latest folder); "" when not a repo, and for older daemons. */
  branch: z.string().optional(),
});

export const ClientSchema = z.object({
  name: z.string(),
  prefix: z.string(),
  host: z.string(),
  /** Optional for older daemons, which always acted. */
  autonomy: AutonomySchema.default("act"),
  /** How far a ticket you assign an agent to goes there (watch and propose only). Optional for older daemons. */
  assignedAutonomy: AutonomySchema.default("act"),
  /** Why Ship can't be on here (no required check on the base branch, not GitHub); "" = it can, or not read yet. */
  shipBlock: z.string().optional(),
  /** Other words that name it (config aliases, its folder), for telling which project a sentence is about. Optional for older daemons. */
  aliases: z.array(z.string()).optional(),
});

export const LeadInboxSchema = z.object({ text: z.string(), at: z.number(), open: z.boolean() });

/** A long-running lead session ops supervises for one project. */
export const LeadSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Its character name from config; empty means the dashboard names it from the theme's cast. Optional for older daemons. */
  name: z.string().default(""),
  project: z.string(),
  supervised: z.boolean(),
  /** Sleeps until ops finds work for the project (#31). */
  onDemand: z.boolean(),
  /** The kinds of work that wake it (a ready-made lead's own); empty or absent = any. */
  watch: z.array(z.enum(LEAD_WORK)).optional(),
  running: z.boolean(),
  /** Ops started it (as opposed to a session opened by hand). */
  mine: z.boolean(),
  since: z.number(),
  stopped: z.boolean(),
  reason: z.string(),
  waiting: z.boolean(),
  waitingLimit: z.boolean(),
  /** Its last start failed before it ran: the account it tried and why (a missing key, a CLI refusing the repo). */
  cantStart: z.object({ account: z.string(), why: z.string() }).nullish(),
  /** The benched account that frees up first and when; absent when no account is benched. */
  limitAccount: z.string().optional(),
  limitBack: z.number().optional(),
  /** Today's spend cap holds every account it may use (only billed or not-yet-known accounts count); absent from older daemons. */
  capHeld: z.boolean().optional(),
  nextAt: z.number(),
  account: z.string(),
  inbox: LeadInboxSchema.nullable(),
  open: z.boolean(),
  /**
   * The open question: its stated default ("If there's no answer: …", "" when none), when Overhand goes with it (0 = it
   * waits for you), and why it may be out of date (issues/PRs it names that closed since; its age in hours past a day).
   * Null when nothing is open or from an older daemon.
   */
  ask: z
    .object({
      default: z.string(),
      deadline: z.number(),
      stale: z.object({ closed: z.array(z.string()), hours: z.number() }).nullable(),
      /** No default: when Overhand asks the lead to re-check and give one; 0 when it has a default (or older daemon). */
      recheck: z.number().default(0),
    })
    .nullable()
    .default(null),
});

export const LabelsSchema = z.object({
  queue: z.string(),
  working: z.string(),
  review: z.string(),
  blocked: z.string(),
  fromSlack: z.string(),
});

/** One finished headless run (ticket agent, planner, Slack triage, lead). */
export const RunSchema = z.object({
  name: z.string(),
  account: z.string().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  cost: z.number(),
  ok: z.boolean(),
  // what the scorecard reads; lines written before it existed have none of these, and the history derives them
  kind: RunKindSchema.optional(),
  project: z.string().optional(),
  key: z.string().optional(),
  runtime: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /** Killed at the task timeout. */
  timedOut: z.boolean().optional(),
  /** The account's billing type when the run was written; lines from before it was recorded have none. */
  billing: BillingSchema.optional(),
});

export const CurrentRunSchema = z.object({
  name: z.string(),
  account: z.string(),
  cwd: z.string(),
  startedAt: z.number(),
  pid: z.number(),
  model: z.string().optional(),
  mode: z.string().optional(),
});

export const WeekSchema = z.object({
  opened: z.number(),
  merged: z.number(),
  failed: z.number(),
  questions: z.number(),
  fixes: z.number(),
  successRate: z.number().nullable(),
  /** Every run at API prices (for comparison, not a bill). */
  cost: z.number(),
  /** Estimated billed: runs on pay-per-use and cloud accounts. Optional for older daemons. */
  billed: z.number().default(0),
  /** At API prices, per account and per project. */
  byAccount: z.record(z.string(), z.number()),
  byClient: z.record(z.string(), z.number()),
  days: z.array(z.object({ date: z.string(), cost: z.number(), billed: z.number().default(0), done: z.number(), failed: z.number() })),
});

export const PullRequestSchema = z.object({
  client: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  draft: z.boolean(),
  review: z.string(),
  checks: z.string(),
  updated: z.string(),
});

export const CiSchema = z.object({
  client: z.string(),
  repo: z.string(),
  branch: z.string(),
  state: z.enum(["pass", "fail", "running", "none"]),
  failing: z.array(z.string()),
  url: z.string(),
});

export const DeploySchema = z.object({
  client: z.string(),
  project: z.string(),
  state: z.string(),
  target: z.string(),
  url: z.string(),
  created: z.number(),
});

export const ErrorIssueSchema = z.object({
  client: z.string(),
  id: z.string(),
  title: z.string(),
  count: z.number(),
  users: z.number(),
  isNew: z.boolean(),
  level: z.string(),
  url: z.string(),
});

/** One open security advisory on a project's repo: GitHub's own Dependabot alert, read with the person's signed-in gh. */
export const AdvisorySchema = z.object({
  client: z.string(),
  repo: z.string(),
  /** The alert's number in its repo. */
  number: z.number(),
  package: z.string(),
  ecosystem: z.string(),
  severity: z.string(),
  summary: z.string(),
  /** The first version that fixes it; "" when none is published yet. */
  fix: z.string(),
  url: z.string(),
});

/** A direct dependency with a newer version, read from its repo's own package manager without installing anything. */
export const OutdatedSchema = z.object({
  client: z.string(),
  repo: z.string(),
  /** What it was read with: "bun", "npm", "pnpm" or "pip". */
  manager: z.string(),
  package: z.string(),
  current: z.string(),
  /** The version it would go to: the latest, or the newest its range allows when only that stays within a minor. */
  next: z.string(),
  update: z.enum(["patch", "minor", "major"]),
});

/** A file in a repo and a count about it: its commits in the last 30 days (untested), or its TODO notes (todos). */
export const FileCountSchema = z.object({ client: z.string(), repo: z.string(), path: z.string(), n: z.number() });

export const CalendarEventSchema = z.object({ title: z.string(), start: z.number(), end: z.number(), allDay: z.boolean() });

/** A list, or the reason it couldn't be fetched (shown to the user as a hint). */
const listOrReason = <T extends z.ZodType>(item: T) => z.union([z.array(item), z.string()]);

/** Background signals refreshed every few minutes: PRs, CI, deploys, errors, calendar. */
export const StatusSchema = z.object({
  at: z.number(),
  myPrs: z.array(PullRequestSchema),
  reviews: z.array(PullRequestSchema),
  ci: z.array(CiSchema),
  deploys: listOrReason(DeploySchema),
  sentry: listOrReason(ErrorIssueSchema),
  /** Open Dependabot alerts on the GitHub repos where they're on and readable; absent from older daemons. */
  advisories: z.array(AdvisorySchema).optional(),
  /** Direct dependencies with updates, from each repo's package manager; absent from older daemons. */
  outdated: z.array(OutdatedSchema).optional(),
  /** Often-changed source files no test names, in repos that have tests; absent from older daemons. */
  untested: z.array(FileCountSchema).optional(),
  /** Files with TODO, FIXME, HACK or XXX notes; absent from older daemons. */
  todos: z.array(FileCountSchema).optional(),
  calendar: listOrReason(CalendarEventSchema),
  errors: z.array(z.string()),
});

/** The kinds of small, safe task a first win can be, in the order they're looked for. */
export const FIRST_WIN_KINDS = ["lint", "dependency", "readme", "test"] as const;
export type FirstWinKind = (typeof FIRST_WIN_KINDS)[number];
/** Every kind of task an agent can be handed from a check-up: the first-win kinds, plus CI, docs and TODOs. */
export const TASK_KINDS = [...FIRST_WIN_KINDS, "ci", "contributing", "todo"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * One thing the project check-up found in a repo. `tone`: bad (broken), warn (worth fixing), info (worth knowing), ok
 * (checked and fine). `task` is what an agent would do about it, when one can.
 */
export const CheckupFindingSchema = z.object({
  id: z.string(),
  tone: z.enum(["bad", "warn", "info", "ok"]),
  title: z.string(),
  task: z.object({ kind: z.enum(TASK_KINDS), title: z.string() }).nullable(),
});
export type CheckupFinding = z.infer<typeof CheckupFindingSchema>;

/** `GET /api/checkup`: one repo's read-only check-up. */
export const CheckupReportSchema = z.object({
  repo: z.string(),
  /** Its folder on this machine: what `POST /api/checkup/pick` names. */
  path: z.string(),
  stack: z.string(),
  findings: z.array(CheckupFindingSchema),
  at: z.number(),
});
export type CheckupReport = z.infer<typeof CheckupReportSchema>;

/**
 * The first win: right after setup, one small safe task Overhand found in your own repos and runs at once. `looking`
 * while it searches, `queued` until a work pass starts it, `running`, then `pr` (a draft PR), `report` (a watch project:
 * findings only) or `failed`; `none` when nothing suitable turned up.
 */
export const FirstWinSchema = z.object({
  state: z.enum(["looking", "queued", "running", "pr", "report", "failed", "none"]),
  kind: z.enum(TASK_KINDS).nullable(),
  /** The task, imperative; empty while looking and when none was found. */
  title: z.string(),
  project: z.string(),
  /** The repo by name, never its path. */
  repo: z.string(),
  /** Its local key (the project's prefix and 0): no tracker ticket is ever made for it. */
  key: z.string(),
  url: z.string(),
  /** The agent's summary, a watch project's report, or why it failed. */
  message: z.string(),
  at: z.number(),
});
export type FirstWin = z.infer<typeof FirstWinSchema>;

/**
 * Something an agent, lead or the Slack inbox found on a project where Overhand may not post on its own (watch): it waits
 * here for you instead of reaching the tracker. `post` is the comment Overhand would have left on `key`, sent only when
 * you press Post it; `key` is empty when no ticket goes with it.
 */
export const FindingSchema = z.object({
  id: z.string(),
  project: z.string(),
  key: z.string(),
  title: z.string(),
  text: z.string(),
  post: z.string(),
  /**
   * Who found it: a ticket agent, the Slack inbox, the tracker (a queue label someone other than you added), or a
   * teammate who handed it to your crew (`text` then names them and carries their note).
   */
  from: z.enum(["agent", "inbox", "tracker", "team"]),
  at: z.number(),
  /** Held by the outward firewall: what matched and where it was going (Edit and post, Post anyway, Dismiss). */
  leak: LeakSchema.optional(),
  /** A task you started from a sentence: this is its agent's plan, and going ahead builds that same task. */
  task: z.string().optional(),
  /** That plan, read into what changes and what you'll see (older plans have only `text`). */
  plan: PlanPointsSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** The dashboard self-check's last result: `browser` when it rendered the page headless, `schema` when it couldn't. */
export const SelfCheckSchema = z.object({
  ok: z.boolean(),
  at: z.number(),
  mode: z.enum(["browser", "schema", "none"]),
  error: z.string(),
});
export type SelfCheck = z.infer<typeof SelfCheckSchema>;

/**
 * A ticket (or a task with no ticket, `local`) you assigned an agent to build on a watch or propose project; it runs at
 * the project's `assignedAutonomy` until its PR is merged or closed.
 */
export const AssignmentSchema = z.object({
  key: z.string(),
  project: z.string(),
  title: z.string(),
  by: z.enum(["dashboard", "tracker"]),
  local: z.boolean(),
  at: z.number(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

/** Everything the dashboard shows, in one payload from `GET /api/state`. */
export const DashboardStateSchema = z.object({
  now: z.number(),
  today: z.string(),
  paused: z.boolean(),
  pauseReason: z.string(),
  /** The daemon wrote a heartbeat in the last 30 seconds. */
  daemon: z.boolean(),
  /** No config saved yet: the dashboard shows its setup wizard. Optional for older daemons. */
  setup: z.boolean().default(false),
  /** Headless agent runs in progress, oldest first. */
  running: z.array(CurrentRunSchema),
  accounts: z.array(AccountSchema),
  prs: z.array(AgentPrSchema),
  /** Ship merges of the last two days, newest first, each with its Undo. Empty for older daemons. */
  shipped: z.array(ShippedSchema).default([]),
  pending: z.array(PendingTicketSchema),
  /** When Overhand last read Slack (epoch ms); 0 when it never has or Slack isn't set up. */
  slackReadAt: z.number().default(0),
  /** Proposed splits by ticket key, waiting for you to accept or edit them. */
  splits: z.record(z.string(), z.array(SplitPartSchema)),
  /** Today's plan file, line by line. */
  plan: z.array(z.string()),
  /** Today's activity log, line by line. */
  reports: z.array(z.string()),
  /** What today's runs would cost at API prices, every account and leads included: a comparison, never a bill. */
  cost: z.number(),
  /** Today's estimated billed dollars: runs on pay-per-use and cloud accounts only, what the daily budget counts. */
  billed: z.number().default(0),
  /** What the daily budget counts today: `billed`, plus runs of accounts whose billing isn't known yet (it may be billed). */
  budgetSpent: z.number().default(0),
  /** The daily budget on billed spend in dollars (`limits.dailyBudgetUsd`); 0 = none. Optional for older daemons. */
  budgetUsd: z.number().default(0),
  /** Claude accounts are paced across their week (`limits.paceWeekly`). Optional for older daemons. */
  paceWeekly: z.boolean().default(false),
  /** Checkouts where a run changed where git finds the repository: no daemon git there until you allow it; "*" = everywhere. */
  gitBlocked: z.array(z.string()).default([]),
  /** Why no run can start on this computer when the OS sandbox can't run here and the config requires it; "" when runs can. */
  sandboxRefuse: z.string().default(""),
  /** The menu bar item is on (`menubar`); null where this computer has none (not a Mac, or not installed). */
  menubar: z.boolean().nullable().default(null),
  /** No agent has run on an earlier day: a fresh install's first day. Optional for older daemons. */
  dayOne: z.boolean().default(false),
  sessions: z.array(SessionSchema),
  /** Open tickets per client, or the error that client's tracker returned. */
  tickets: z.record(z.string(), listOrReason(TicketSchema)),
  clients: z.array(ClientSchema),
  godmode: z.array(LeadSchema),
  labels: LabelsSchema,
  opsBehind: z.number(),
  /** Free disk space and the floor below which new agents don't start. Optional for older daemons. */
  disk: z
    .object({
      freeGb: z.number(),
      floorGb: z.number(),
      /** Below this, Needs you warns; below `heavyGb`, heavy jobs (browsers, suites, builds) wait. Optional for older daemons. */
      warnGb: z.number().default(0),
      heavyGb: z.number().default(0),
    })
    .optional(),
  /** The machine governor: quiet mode's end (0 = off) and the heavy jobs holding a slot now. Optional for older daemons. */
  governor: z
    .object({
      quietUntil: z.number(),
      /** Why a new heavy job would wait right now (load, battery, heat, disk, quiet), or "". */
      holding: z.string().default(""),
      jobs: z.array(z.object({ kind: z.string(), run: z.string(), cmd: z.string(), since: z.number() })),
      /** How hard the machine works now, the last 3 hours, and (while strained) who's causing it. Empty for older daemons. */
      strain: StrainSchema.default({ level: "ok", gauges: [], history: [], groups: [], other: { cpu: 0, memMb: 0 }, cause: "" }),
    })
    .default({
      quietUntil: 0,
      holding: "",
      jobs: [],
      strain: { level: "ok", gauges: [], history: [], groups: [], other: { cpu: 0, memMb: 0 }, cause: "" },
    }),
  /** The control room: every session, the action cards, typed requests and what Overhand did. Empty for older daemons. */
  control: z
    .object({
      sessions: z.array(ControlSessionSchema),
      cards: z.array(ActionCardSchema),
      requests: z.array(RequestSchema),
      actions: z.array(ControlActionSchema),
    })
    .default({ sessions: [], cards: [], requests: [], actions: [] }),
  /**
   * An installed copy's version and the latest release (empty until the daily check has an answer, and for a checkout,
   * which uses `opsBehind`), and `command`: how this copy updates (its install kind decides). Defaults for older daemons.
   */
  update: z
    .object({ latest: z.string(), current: z.string(), command: z.string().default("overhand update") })
    .default({ latest: "", current: "", command: "overhand update" }),
  taskTimeoutMin: z.number(),
  owner: z.string(),
  runs: z.array(RunSchema),
  week: WeekSchema,
  status: StatusSchema,
  /** The agent and model scorecard over 7 and 30 days. Defaults for older daemons. */
  scorecard: z
    .object({ week: ScorecardSchema, month: ScorecardSchema })
    .default({ week: { days: 7, overall: [], projects: [] }, month: { days: 30, overall: [], projects: [] } }),
  /** How runs pick their account, and (suggest) where another combo does clearly better. Off for older daemons. */
  routing: z.object({ mode: RoutingModeSchema, suggestions: z.array(RouteSuggestionSchema) }).default({ mode: "off", suggestions: [] }),
  /** Each project's agent instruction files, parsed, with their checks. Empty for older daemons. */
  instructions: z.array(ProjectInstructionsSchema).default([]),
  /** What the guard blocked in the last day, oldest first. Empty for older daemons. */
  guardrails: z.array(GuardBlockSchema).default([]),
  /** Each status update channel's last send, for Health. Empty for older daemons. */
  updates: z.array(UpdateStatusSchema).default([]),
  /** Guidance given on two PRs or more that no instruction file says yet, offered as rules. Empty for older daemons. */
  rules: z.array(RuleSuggestionSchema).default([]),
  /** The first win after setup, while there is one to show. Null for older daemons. */
  firstWin: FirstWinSchema.nullable().default(null),
  /** What each project has earned and what is broken there, and the season: the world's memory. Bare for older daemons. */
  progression: ProgressionSchema.prefault({}),
  /** Each project's onboarding guide, its drift and any generation under way. Empty for older daemons. */
  guides: z.array(GuideSchema).default([]),
  /** What agents and the inbox found on watch projects, held for you instead of posted. Empty for older daemons. */
  findings: z.array(FindingSchema).default([]),
  /** The daemon's last look at this dashboard (every 15 min). A pass for older daemons. */
  selfCheck: SelfCheckSchema.default({ ok: true, at: 0, mode: "none", error: "" }),
  /** Items you snoozed (a brief's id, `ticket:EW-1`), until when: Needs you leaves them out till then. Empty for older daemons. */
  snoozed: z.record(z.string(), z.number()).default({}),
  /** Decisions Needs you showed in the last 7 days and the 7 before, each counted once (calls.ts). Zero for older daemons. */
  calls: z.object({ week: z.number(), last: z.number() }).default({ week: 0, last: 0 }),
  /** Tickets you assigned an agent to on watch and propose projects. Empty for older daemons. */
  assigned: z.array(AssignmentSchema).default([]),
  /** Your team (docs/teams.md): the roster and the live metadata feed. Null with no team, and for older daemons. */
  team: TeamStateSchema.nullable().default(null),
  /** Names you gave leads and work (`leadId`, `workId`): they win over every name Overhand makes. Empty for older daemons. */
  names: z.record(z.string(), z.string()).default({}),
});

export type AccountUsage = z.infer<typeof AccountUsageSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type AgentPr = z.infer<typeof AgentPrSchema>;
export type Corner = z.infer<typeof CornerSchema>;
export type CornerKind = Corner["kind"];
export type GuardBlock = z.infer<typeof GuardBlockSchema>;
export type PendingTicket = z.infer<typeof PendingTicketSchema>;
export type SplitPart = z.infer<typeof SplitPartSchema>;
export type Subagent = z.infer<typeof SubagentSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionRequest = z.infer<typeof RequestSchema>;
export type ControlAction = z.infer<typeof ControlActionSchema>;
export type ControlSession = z.infer<typeof ControlSessionSchema>;
export type ActionCard = z.infer<typeof ActionCardSchema>;
export type CardButton = ActionCard["buttons"][number];
export type Client = z.infer<typeof ClientSchema>;
export type Lead = z.infer<typeof LeadSchema>;
export type Labels = z.infer<typeof LabelsSchema>;
export type Run = z.infer<typeof RunSchema>;
export type CurrentRun = z.infer<typeof CurrentRunSchema>;
export type Week = z.infer<typeof WeekSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type Ci = z.infer<typeof CiSchema>;
export type Deploy = z.infer<typeof DeploySchema>;
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;
export type Advisory = z.infer<typeof AdvisorySchema>;
export type Outdated = z.infer<typeof OutdatedSchema>;
export type FileCount = z.infer<typeof FileCountSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type DashboardState = z.infer<typeof DashboardStateSchema>;

// ---------- the dashboard's other endpoints ----------

/** `GET /api/lead/log?key=…`: the tail of a lead's current log. */
export const LeadLogSchema = z.object({ text: z.string(), at: z.number() });

/** `GET /api/pr/review?key=…`: an agent PR as the Review drawer shows it, its diff included. */
export const PrReviewSchema = z.object({
  key: z.string(),
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  /** The GitHub account Overhand acts as; approving your own PR isn't possible, so then it only marks it ready. */
  viewer: z.string(),
  draft: z.boolean(),
  state: z.string(),
  checks: z.array(z.object({ name: z.string(), state: z.string() })),
  /** Unified diff text (`gh pr diff`). */
  diff: z.string(),
  /** The diff was cut short because it was too big to show. */
  truncated: z.boolean(),
  /** Corners the diff may have cut (see CornerSchema). Empty for older daemons. */
  corners: z.array(CornerSchema).default([]),
});
export type PrReview = z.infer<typeof PrReviewSchema>;

/** The sizes a preview is looked at in: a laptop window, or a phone. */
export const PreviewViewportSchema = z.enum(["wide", "phone"]);
export type PreviewViewport = z.infer<typeof PreviewViewportSchema>;

/** One note pinned on a still of the preview: where (page pixels), what you said, and the spot cropped before and after. */
export const PreviewPinSchema = z.object({
  n: z.number(),
  x: z.number(),
  y: z.number(),
  note: z.string(),
  /** Image URLs of the pinned spot as it was when you sent the note, and on the agent's next preview. "" = not taken. */
  before: z.string().default(""),
  after: z.string().default(""),
});
export type PreviewPin = z.infer<typeof PreviewPinSchema>;

/**
 * Reviewing an agent PR on its preview site: the still you pinned on, your notes, and where the fix round stands.
 * Pins sit on a still (a screenshot the daemon takes) because a preview on another site can't be read from the dashboard.
 */
export const PreviewReviewSchema = z.object({
  key: z.string(),
  /** The preview address, and whether its site lets the dashboard show it live in a frame. */
  url: z.string(),
  frameable: z.boolean(),
  viewport: PreviewViewportSchema,
  /** The still to pin on, its size in page pixels; "" until taken. */
  still: z.string().default(""),
  width: z.number().default(0),
  height: z.number().default(0),
  pins: z.array(PreviewPinSchema).default([]),
  /** The fix round your notes became (0 = not sent), and whether the agent has pushed since (so the fix can be checked). */
  round: z.number().default(0),
  pushed: z.boolean().default(false),
  /** Why the last still or crop couldn't be taken, in plain words; "" when it could. */
  note: z.string().default(""),
});
export type PreviewReview = z.infer<typeof PreviewReviewSchema>;

/** `POST /api/pr/ready`: whether an approval went along with marking it ready. */
export const PrReadyResultSchema = z.object({ approved: z.boolean() });

/** One thing ops needs on this machine (a binary, a folder, a Keychain token). */
export const CheckSchema = z.object({
  ok: z.boolean(),
  what: z.string(),
  fix: z.string().optional(),
  /** The secret store item that fixes it, when it is a missing token. */
  secret: z.string().optional(),
  optional: z.boolean().optional(),
});

/** `GET /api/settings`: the config as plain JSON (the daemon validates it on save), plus what it checks. */
export const SettingsSchema = z.object({
  config: z.record(z.string(), z.json()),
  checks: z.array(CheckSchema),
  codeRoot: z.string(),
  /** Folders under the Code root, offered when picking a project or lead folder. */
  folders: z.array(z.string()),
  /** Where secrets go on this machine (Keychain, the keyring, or the OVERHAND_SECRETS_FILE path), for labels. Defaults for older daemons. */
  secretStore: z.string().default("the secret store"),
  /** The Slack inbox's MCP server file, by full path. */
  slackMcp: z.string().default("slack-mcp.json"),
  /** Each account's config folder (read-only in Settings); empty from older daemons. */
  homes: z.record(z.string(), z.string()).default({}),
  /** The OS sandbox on this machine; off from older daemons. */
  sandbox: SandboxStatusSchema.default({ mode: "off", effective: "off", ok: true, why: "", refuse: false, platform: "", suggest: {} }),
});

/** The services Setup and Settings show as one row each. */
export const SERVICE_IDS = ["github", "linear", "jira", "slack", "sentry", "vercel"] as const;

/**
 * One service as `GET /api/connections` reports it. `state`: Overhand reads it itself (`connected`), only your agents
 * reach it through their own MCP server (`agent`), or neither (`none`). `via` says how: `gh` and `cli` (a CLI's own
 * login, `detail` its account), `mcp` (Overhand's own MCP sign-in), `token` (an API token in the secret store), `inbox`
 * (slack-mcp.json), `agent` (`detail` names the CLI and server). `connect`: its MCP server supports a one-click sign-in.
 */
export const ConnectionSchema = z.object({
  id: z.enum(SERVICE_IDS),
  label: z.string(),
  state: z.enum(["connected", "agent", "none"]),
  via: z.enum(["gh", "cli", "mcp", "token", "inbox", "agent", ""]),
  detail: z.string(),
  connect: z.boolean(),
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const ConnectionsSchema = z.object({ services: z.array(ConnectionSchema) });

/** `POST /api/settings` and `POST /api/secret` answer with the saved config's checks. */
export const SettingsSavedSchema = z.object({ config: z.record(z.string(), z.json()).optional(), checks: z.array(CheckSchema) });

/** Disk cleanup's categories, in the order the dashboard shows them; each has an on/off switch in `cleanup.categories`. */
export const CLEANUP_CATEGORIES = [
  "worktrees",
  "versions",
  "caches",
  "builds",
  "clones",
  "history",
  "models",
  "tools",
  "temp",
  "docker",
  "simulators",
  "logs",
] as const;
export const CleanupCategorySchema = z.enum(CLEANUP_CATEGORIES);

export const CleanupItemSchema = z.object({
  /** Stable across a plan and its run: category and path. */
  id: z.string(),
  category: CleanupCategorySchema,
  /** How it goes: `git worktree remove`, the whole folder, only the folder's contents, or a tool's own cleanup command. */
  kind: z.enum(["worktree", "dir", "contents", "command"]),
  /** The folder, or the command for `command`. */
  path: z.string(),
  why: z.string(),
  /** What removing it frees, in KB; 0 when that can't be known beforehand (the drawer says "size unknown"). */
  kb: z.number(),
  /** Ticked by default (it rebuilds itself). A run removes only ticked items in categories that are on. */
  checked: z.boolean(),
  /** Safe for an unattended cleanup (caches, old versions, old logs, merged worktrees). */
  auto: z.boolean().default(false),
  repo: z.string().optional(),
  /** For a second clone: the clone of the same remote that stays. */
  keep: z.string().optional(),
  /** When it was last used (ms), when known. */
  usedAt: z.number().optional(),
  /**
   * Inside your own checkout: one Overhand linked instead of cloning, or any repo outside its projects folder and code
   * root; or yours by nature: an agent's history, a model, an installed CLI, work in no commit. Never cleaned unattended,
   * never ticked by default, and removed only with `confirmed` naming its path.
   */
  personal: z.boolean().default(false),
  /** The path you confirmed removing (a personal item only goes when this equals `path`). */
  confirmed: z.string().default(""),
  /** The rule that proposed it: its row in docs/cleanup-sources.md. */
  source: z.string().optional(),
});

/** A personal cleanup item that's yours by nature (history, a model, a CLI, uncommitted work), not by being in your checkout. */
export const ownData = (i: { category: string; source?: string }): boolean =>
  ["history", "models", "tools"].includes(i.category) || i.source === "orphan-worktrees";

export const CleanupResultSchema = z.object({
  removed: z.number(),
  /** Free space gained, measured on the volume before and after (du overcounts APFS clones). */
  freedKb: z.number(),
  /** Items git or a tool refused to remove. */
  failed: z.array(z.string()),
  /** Items left alone because re-checking them right before removal found them unsafe, with why. */
  skipped: z.array(z.object({ path: z.string(), why: z.string() })).default([]),
});

/** The cleanup settings the drawer shows and switches (`cleanup` in the config). */
export const CleanupConfigSchema = z.object({
  categories: z.record(CleanupCategorySchema, z.looseObject({ enabled: z.boolean() })),
  auto: z.object({ schedule: z.enum(["off", "weekly", "daily"]), belowFreeGb: z.number() }),
  minFreeGb: z.number(),
});

/** `POST /api/cleanup/config`: the drawer's switches, saved into the config's `cleanup`. */
export const CleanupSwitchesSchema = z.object({
  categories: z.partialRecord(CleanupCategorySchema, z.boolean()).optional(),
  schedule: z.enum(["off", "weekly", "daily"]).optional(),
});

/**
 * `POST /api/settings/quick`: one day-to-day switch from Quick settings, saved into the config without opening the
 * whole Settings form: the daily budget (0 = off), weekly pacing, the menu bar item, or one project's autonomy.
 */
export const QuickSettingSchema = z.union([
  z.object({ budgetUsd: z.number().min(0).max(100_000) }),
  z.object({ paceWeekly: z.boolean() }),
  z.object({ menubar: z.boolean() }),
  z.object({ project: z.string().min(1), autonomy: AutonomySchema }),
]);
export type QuickSetting = z.infer<typeof QuickSettingSchema>;

/** `GET /api/cleanup`: the disk cleanup's progress, written by the cleanup worker, plus the live settings and free space. */
export const CleanupStatusSchema = z.object({
  status: z.enum(["idle", "planning", "ready", "running", "done", "error"]),
  at: z.number().default(0),
  items: z.array(CleanupItemSchema).optional(),
  result: CleanupResultSchema.optional(),
  /** While running: items handled so far out of the ticked ones. */
  progress: z.object({ done: z.number(), total: z.number() }).optional(),
  /** This pass was the unattended one (`cleanup.auto`). */
  auto: z.boolean().optional(),
  error: z.string().optional(),
  config: CleanupConfigSchema.optional(),
  freeGb: z.number().optional(),
});

/** `POST /api/quiet`: hold off heavy jobs for `hours` (0 ends quiet mode now). */
export const QuietSchema = z.object({ hours: z.number().min(0).max(72) });

/** Answers to the action POSTs that carry more than `{ ok: true }`. */
export const AlloutResultSchema = z.object({ armed: z.number(), started: z.array(z.string()) });
export const LeadStartResultSchema = z.object({ running: z.boolean() });
export const LeadStopResultSchema = z.object({ other: z.number() });
export const RestartResultSchema = z.object({ busy: z.boolean(), startAgain: z.string() });
export const SelfUpdateResultSchema = z.object({ message: z.string() });

/** `POST /api/name`: a person's own name for a lead or a piece of work (`leadId`, `workId`); "" goes back to Overhand's. */
export const NameSchema = z.object({ id: z.string().min(1).max(400), name: z.string().trim().max(60) });

/** One git worktree of a project's repo, as `GET /api/worktrees` lists it. */
export const WorktreeSchema = z.object({
  /** Its folder, with the home folder as ~. */
  path: z.string(),
  repo: z.string(),
  /** "" when detached. */
  branch: z.string(),
  /** The repo's own checkout rather than an added worktree. */
  main: z.boolean(),
  /** Who works in it now: sessions, subagents, leads and agent runs, by the name the dashboard shows. */
  who: z.array(z.object({ kind: z.enum(["you", "agent", "lead", "subagent"]), label: z.string() })),
  /** Its branch's pull request on the code host ("" = none found) and that PR's state (OPEN, MERGED, CLOSED, DRAFT). */
  pr: z.string(),
  prState: z.string(),
  /** Last change in it (its folder, index or HEAD moving), ms. */
  usedAt: z.number(),
  /** Size on disk in KB; -1 when it couldn't be measured in time. */
  kb: z.number(),
  /** Why Cleanup's latest scan offers to remove it; "" = not offered. */
  cleanup: z.string(),
  /**
   * The project's own words for its work, best first, for its name (`workName`'s vocab): its PR's title, then the
   * subjects of its own commits. Read on this machine; any carrying another project's private words are left out.
   * Absent from older daemons.
   */
  words: z.array(z.string()).optional(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;
/** `GET /api/worktrees`: each project's worktrees, the main checkout first. */
export const WorktreesSchema = z.object({ at: z.number(), projects: z.record(z.string(), z.array(WorktreeSchema)) });
export type Worktrees = z.infer<typeof WorktreesSchema>;

export type LeadLog = z.infer<typeof LeadLogSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type CleanupItem = z.infer<typeof CleanupItemSchema>;
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;
export type CleanupCategory = z.infer<typeof CleanupCategorySchema>;
export type CleanupResult = z.infer<typeof CleanupResultSchema>;
export type CleanupConfig = z.infer<typeof CleanupConfigSchema>;

/** Whether release `latest` is newer than `current` (both like "1.2.3" or "v1.2.3"); false when either isn't a version. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .match(/^(\d+)\.(\d+)\.(\d+)$/)
      ?.slice(1)
      .map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
