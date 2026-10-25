/**
 * The control room's daemon side: the session registry (every agent session on this machine, Overhand's and yours),
 * action cards (correlated signals turned into a decision with buttons), what each button does with the owner's
 * authority, and standing approvals that let Overhand do it without asking. Stopping only ever targets one identified
 * process tree inside a registered session, never a protected process, never a broad pkill.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, join } from "node:path";
import {
  type ActionCard,
  type CardButton,
  type ControlAction,
  ControlActionSchema,
  type ControlSession,
  type SessionRequest,
} from "@overhand/contract";
import { z } from "zod";
import type { Config } from "./config";
import {
  type Approval,
  allowUntil,
  type Beat,
  branchOf,
  clock,
  controlDir,
  exempt,
  extend,
  extended,
  FILES_FRESH_MS,
  loadBeats,
  loadHolds,
  loadRequests,
  moveRequest,
  quietEnd,
  repoOf,
  rulesVersion,
  setHold,
} from "./control";
import {
  HEADLESS,
  HEAVY,
  type Heavy,
  holders,
  killTree,
  type Lock,
  type Proc,
  processTable,
  protectedProc,
  setQuiet,
  treeOf,
} from "./governor";
import type { LiveSession } from "./sessions";
import { STRAIN, sustained } from "./strain";

const MIN = 60_000;

/** A registry row with what the control room acts on; `ControlSession` is what the dashboard gets. */
export interface Row extends ControlSession {
  /** Claude Code's session id when connected, else "". */
  id: string;
  startedAt: number;
  files: Beat["files"];
  prs: Beat["prs"];
  /** The session's jobs as process trees to stop: its direct children holding a slot's job or a headless browser. */
  roots: number[];
  jobs: (Lock & { kind: Heavy })[];
}

/** What the registry is built from; tests pass fixtures. */
export interface RegistryInput {
  live: Pick<LiveSession, "pid" | "kind" | "label" | "name" | "client" | "cwd" | "active">[];
  beats: Beat[];
  table: Proc[];
  /** Listening TCP ports by pid. */
  ports: Map<number, number[]>;
  locks: (Lock & { kind: Heavy })[];
  holds: Record<string, { reason: string }>;
  rulesVersion: string;
  home: string;
  git: (cwd: string) => { repo: string; branch: string };
  now: number;
  /** The name a lead goes by, from the label its session carries (leads.ts leadNameByLabel); left out, the label. */
  leadName?: (label: string) => string;
}

/** A headless browser's main process (its helpers carry --type=). */
const isBrowser = (p: Proc): boolean => HEADLESS.test(p.cmd) && !/--type=/.test(p.cmd);

function row(
  s: { pid: number; kind: ControlSession["kind"]; label: string; name: string; client: string; cwd: string; active: boolean },
  beat: Beat | undefined,
  i: RegistryInput,
): Row {
  const tree = s.pid ? treeOf(s.pid, i.table) : [];
  const inTree = new Set(tree);
  const jobs = i.locks.filter((l) => inTree.has(l.pid) || (beat !== undefined && l.session === beat.id));
  const browsers = i.table.filter((p) => inTree.has(p.pid) && isBrowser(p));
  const jobPids = new Set(jobs.flatMap((j) => [j.pid, j.pgid]));
  const roots = i.table
    .filter((c) => c.ppid === s.pid && s.pid > 0)
    .filter((c) => treeOf(c.pid, i.table).some((p) => jobPids.has(p) || browsers.some((b) => b.pid === p)))
    .map((c) => c.pid);
  const { repo, branch } = i.git(s.cwd);
  const project = beat?.project || (s.client && s.client !== "Other" ? s.client : basename(repo || s.cwd));
  return {
    key: beat ? beat.id : `pid:${s.pid}`,
    id: beat?.id ?? "",
    pid: s.pid,
    kind: s.kind,
    // a lead goes by its one name (your rename first), so Crew never shows it under two
    label: s.kind === "lead" ? (i.leadName?.(s.label) ?? s.label) : s.name || (s.kind === "you" ? project : s.label),
    name: s.name,
    project,
    repo,
    branch,
    cwd: s.cwd,
    connected: beat !== undefined,
    registered: s.kind !== "you" || beat !== undefined,
    procs: tree.length,
    ports: [...new Set(tree.flatMap((p) => i.ports.get(p) ?? []))].sort((a, b) => a - b),
    browsers: browsers.length,
    heavy: jobs.map((j) => ({ kind: j.kind, cmd: j.cmd.slice(0, 200), since: j.since })),
    lastAt: beat?.lastAt ?? 0,
    active: s.active || (beat !== undefined && i.now - beat.lastAt < 2 * MIN),
    rulesAck: beat?.rulesSeen === i.rulesVersion,
    paused: beat ? (i.holds[beat.id]?.reason ?? "") : "",
    startedAt: beat?.startedAt ?? 0,
    files: beat?.files ?? [],
    prs: beat?.prs ?? [],
    roots,
    jobs,
  };
}

/**
 * Every agent session on this machine: the live `claude` processes (Overhand's agents and leads, and yours), joined with
 * the heartbeats connected sessions report through the guard hook. A connected session whose process ps doesn't call
 * `claude` still counts while it's alive (or, without a known pid, while it reported in the last 10 minutes).
 */
export function buildRegistry(i: RegistryInput): Row[] {
  const used = new Set<string>();
  const rows = i.live.map((s) => {
    const beat = i.beats.find((b) => b.pid === s.pid);
    if (beat) used.add(beat.id);
    return row({ ...s, cwd: s.cwd.replace(/^~(?=\/|$)/, i.home) }, beat, i);
  });
  for (const b of i.beats) {
    if (used.has(b.id)) continue;
    if (b.pid ? !i.table.some((p) => p.pid === b.pid) : i.now - b.lastAt > 10 * MIN) continue;
    const kind = !b.run ? "you" : b.run.startsWith("lead-") ? "lead" : "agent";
    rows.push(row({ pid: b.pid, kind, label: b.run || b.project, name: "", client: b.project, cwd: b.cwd, active: false }, b, i));
  }
  return rows;
}

/** What the dashboard shows of a row. */
export const toSession = ({ id: _, startedAt: __, files: ___, prs: ____, roots: _____, jobs: ______, ...s }: Row): ControlSession => s;

// ---------- action cards ----------

/** A card with what its buttons act on. */
export interface Card extends ActionCard {
  /** Process trees a Stop (or Run one at a time) takes down. */
  targets: number[];
  /** The session it's about (a connected session's id), for Allow until and Pause. */
  session: string;
  /** Until when Allow until lets it run (quiet's end). */
  until: number;
  pgid: number;
  request: string;
  pr: { repo: string; dir: string; branch: string } | null;
}

/** What the cards are read from. */
export interface CardContext {
  rows: Row[];
  /** When quiet ends (quiet mode or a quiet window), 0 when it's not quiet. */
  quietUntil: number;
  load1: number;
  loadPerCore: number;
  maxLoadPerCore: number;
  silentMin: number;
  requests: SessionRequest[];
  approvals: Approval[];
  snoozed: Record<string, number>;
  exempt: (r: Row) => boolean;
  extended: (pgid: number) => boolean;
  /** The machine has been red for several samples in a row: by how much, and who's causing it. */
  strain?: { cpu: number; cause: string } | null;
  now: number;
}

/** Which standing approval lets Overhand act on a kind of card by itself, and the button it presses. */
const APPROVAL_FOR: Partial<Record<ActionCard["kind"], [Approval["action"], CardButton]>> = {
  "quiet-heavy": ["stop-heavy-in-quiet", "stop"],
  competing: ["one-at-a-time", "one-at-a-time"],
  "foreign-pr": ["close-foreign-pr", "close-pr"],
  "same-files": ["pause-same-files", "pause"],
  silent: ["stop-silent", "stop"],
};

const blank = { targets: [], session: "", until: 0, pgid: 0, request: "", pr: null };

/**
 * The action cards for this moment, most urgent first:
 * - quiet-heavy: during quiet mode a registered session runs heavy jobs or headless browsers;
 * - unmanaged-heavy: a session Overhand can't act on (not connected) runs headless browsers while it's quiet or busy;
 * - competing: three or more heavy jobs at once across sessions;
 * - foreign-pr: a session opened a PR in another repository than its own;
 * - same-files: two sessions edited the same files on one branch in the last 30 minutes;
 * - silent: a heavy job printed nothing for half the governor's silence limit (it's killed at the limit);
 * - overdue: a request past its deadline that isn't done;
 * - strain: the machine has been overloaded for several minutes, named by its biggest cause.
 * Snoozed cards are left out; one a standing approval covers is marked `auto`.
 */
export function detectCards(c: CardContext): Card[] {
  const out: Card[] = [];
  if (c.strain)
    out.push({
      ...blank,
      id: "strain",
      kind: "strain",
      project: "*",
      facts: { cause: c.strain.cause, x: Math.round(c.strain.cpu * 10) / 10 },
      buttons: ["one-at-a-time", "quiet"],
      auto: false,
    });
  const who = (r: Row) => r.label;
  const quiet = c.quietUntil > c.now;
  const busy = c.loadPerCore > c.maxLoadPerCore;
  for (const r of c.rows) {
    if (!r.jobs.length && !r.browsers) continue;
    const facts = { who: who(r), browsers: r.browsers, jobs: r.jobs.length, load: Math.round(c.load1), until: clock(c.quietUntil) };
    if (r.registered && quiet && !c.exempt(r))
      out.push({
        ...blank,
        id: `quiet-heavy:${r.key}`,
        kind: "quiet-heavy",
        project: r.project,
        facts,
        buttons: ["stop", "allow-until", "always-allow"],
        auto: false,
        targets: r.roots,
        session: r.id,
        until: c.quietUntil,
      });
    else if (!r.registered && r.browsers && (quiet || busy))
      out.push({
        ...blank,
        id: `unmanaged-heavy:${r.key}`,
        kind: "unmanaged-heavy",
        project: r.project,
        facts,
        buttons: ["connect", "keep"],
        auto: false,
      });
  }
  // every job across registered sessions, oldest slot first; unslotted browser trees after them
  const jobs = c.rows
    .filter((r) => r.registered)
    .flatMap((r) =>
      r.roots.map((root) => {
        const lock = r.jobs.find((j) => j.pid === root || j.pgid === root);
        return { root, since: lock?.since ?? Number.MAX_SAFE_INTEGER };
      }),
    )
    .sort((a, b) => a.since - b.since);
  if (jobs.length >= 3)
    out.push({
      ...blank,
      id: "competing",
      kind: "competing",
      project: "*",
      facts: { n: jobs.length, load: Math.round(c.load1) },
      buttons: ["one-at-a-time", "keep"],
      auto: false,
      targets: jobs.slice(1).map((j) => j.root),
    });
  for (const r of c.rows)
    for (const pr of r.prs)
      out.push({
        ...blank,
        id: `foreign-pr:${r.key}:${pr.repo}:${pr.branch}`,
        kind: "foreign-pr",
        project: r.project,
        facts: { who: who(r), repo: pr.repo, branch: pr.branch },
        buttons: ["close-pr", "keep"],
        auto: false,
        session: r.id,
        pr,
      });
  const editing = c.rows.filter((r) => r.registered && r.id && r.branch && r.files.some((f) => c.now - f.at < FILES_FRESH_MS));
  const seen = new Set<string>();
  for (const a of editing)
    for (const b of editing) {
      const place = `${a.repo}:${a.branch}`;
      if (a.key >= b.key || place !== `${b.repo}:${b.branch}` || seen.has(place)) continue;
      const mine = new Set(a.files.filter((f) => c.now - f.at < FILES_FRESH_MS).map((f) => f.path));
      const shared = b.files.filter((f) => c.now - f.at < FILES_FRESH_MS && mine.has(f.path));
      if (!shared.length) continue;
      seen.add(place);
      const [first, later] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
      out.push({
        ...blank,
        id: `same-files:${place}`,
        kind: "same-files",
        project: a.project,
        facts: { who: who(later), other: who(first), files: shared.length, branch: a.branch, file: basename(shared[0]?.path ?? "") },
        buttons: ["pause", "show"],
        auto: false,
        session: later.id,
      });
    }
  for (const r of c.rows)
    for (const j of r.jobs) {
      const quietMin = (c.now - (j.lastOut || j.since)) / MIN;
      if (!r.registered || j.kind === "devserver" || quietMin < c.silentMin / 2 || c.extended(j.pgid)) continue;
      out.push({
        ...blank,
        id: `silent:${j.pgid}`,
        kind: "silent",
        project: r.project,
        facts: { who: who(r), cmd: j.cmd.slice(0, 120), min: Math.round(quietMin), kind: j.kind },
        buttons: ["stop", "more-time"],
        auto: false,
        targets: [j.pgid],
        pgid: j.pgid,
      });
    }
  for (const q of c.requests)
    if (q.by && c.now > q.by && (q.state === "sent" || q.state === "acknowledged"))
      out.push({
        ...blank,
        id: `overdue:${q.id}`,
        kind: "overdue",
        project: c.rows.find((r) => r.id === q.to)?.project ?? "",
        facts: { who: q.toLabel, text: q.text.slice(0, 160), by: clock(q.by), state: q.state },
        buttons: ["resend", "drop"],
        auto: false,
        request: q.id,
      });
  return out
    .filter((card) => (c.snoozed[card.id] ?? 0) <= c.now)
    .map((card) => {
      const ap = APPROVAL_FOR[card.kind];
      const auto = !!ap && c.approvals.some((a) => a.action === ap[0] && (a.project === "*" || a.project === card.project));
      return { ...card, auto };
    });
}

/** What the dashboard shows of a card. */
export const toCard = ({ targets: _, session: __, until: ___, pgid: ____, request: _____, pr: ______, ...c }: Card): ActionCard => c;

// ---------- stopping one process tree ----------

/**
 * The processes a Stop takes down, or why it refuses: only `root`'s own tree, only inside a session Overhand started or
 * you connected, never a whole session, never Overhand itself, never a protected process.
 */
export function planStop(
  root: number,
  table: Proc[],
  rows: Row[],
  isProtected: (pid: number) => string | null,
  self = process.pid,
): { pids: number[] } | { refuse: string } {
  if (!(root > 1)) return { refuse: "no process to stop" };
  if (rows.some((r) => r.pid === root)) return { refuse: "that's a whole session, not a job; the control room stops jobs" };
  const owner = rows.find((r) => r.registered && r.pid > 0 && treeOf(r.pid, table).includes(root));
  if (!owner) return { refuse: `process ${root} isn't part of a session Overhand started or one you connected` };
  const pids = treeOf(root, table);
  if (pids.includes(self)) return { refuse: "that would stop Overhand itself" };
  for (const pid of pids) {
    const why = isProtected(pid);
    if (why) return { refuse: why };
  }
  return { pids };
}

// ---------- the files: snoozes and the action log ----------

const SnoozeSchema = z.record(z.string(), z.number());
const snoozeFile = (ops: string) => join(controlDir(ops), "snooze.json");
const actionsFile = (ops: string) => join(controlDir(ops), "actions.jsonl");

/** Snoozed cards by id, until when. */
function loadSnoozed(ops: string): Record<string, number> {
  try {
    const r = SnoozeSchema.safeParse(JSON.parse(readFileSync(snoozeFile(ops), "utf8")));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

function snooze(ops: string, id: string, until: number, now: number): void {
  const kept = Object.fromEntries(Object.entries(loadSnoozed(ops)).filter(([, t]) => t > now));
  mkdirSync(controlDir(ops), { recursive: true });
  writeFileSync(snoozeFile(ops), JSON.stringify({ ...kept, [id]: until }), { mode: 0o600 });
}

/** The latest `max` things Overhand did from the control room, oldest first. */
export function loadActions(ops: string, max = 50): ControlAction[] {
  if (!existsSync(actionsFile(ops))) return [];
  // ponytail: reads the whole log; rotate it if it ever grows past a few MB
  return readFileSync(actionsFile(ops), "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const r = ControlActionSchema.safeParse(JSON.parse(l));
        return r.success ? [r.data] : [];
      } catch {
        return [];
      }
    })
    .slice(-max);
}

function logAction(ops: string, a: ControlAction): void {
  try {
    mkdirSync(controlDir(ops), { recursive: true });
    appendFileSync(actionsFile(ops), `${JSON.stringify(a)}\n`, { mode: 0o600 });
  } catch {
    // a full disk: the action happened either way
  }
}

// ---------- acting on a card ----------

/** What a button needs from outside; tests pass fakes. */
export interface ActEnv {
  ops: string;
  cfg: Config;
  save: (c: Config) => void;
  table: () => Proc[];
  isProtected: (pid: number) => string | null;
  kill: (root: number) => Promise<unknown>;
  run: (cmd: string[], cwd: string) => { ok: boolean; out: string; err: string };
  now: number;
}

const WEEK = 7 * 24 * 60 * MIN;

/**
 * Presses one of a card's buttons with the owner's authority (or, `auto`, under a standing approval) and logs what
 * happened. "Show" and "Connect" are the dashboard's own; they do nothing here.
 */
export async function act(card: Card, button: CardButton, rows: Row[], e: ActEnv, auto = false): Promise<ControlAction> {
  const done = (result: string, ok = true): ControlAction => {
    const a = { at: e.now, card: card.id, button, result, ok, auto };
    logAction(e.ops, a);
    return a;
  };
  if (!card.buttons.includes(button)) return done(`that card has no ${button} button`, false);
  // strain is a reading, not an event: once you've answered, it doesn't ask again for half an hour
  if (card.kind === "strain") snooze(e.ops, card.id, e.now + 30 * MIN, e.now);
  const stop = async (roots: number[]): Promise<{ stopped: number[]; refused: string[] }> => {
    const table = e.table();
    const stopped: number[] = [];
    const refused: string[] = [];
    for (const root of roots) {
      const plan = planStop(root, table, rows, e.isProtected);
      if ("refuse" in plan) refused.push(plan.refuse);
      else {
        await e.kill(root);
        stopped.push(root);
      }
    }
    return { stopped, refused };
  };
  const said = (r: { stopped: number[]; refused: string[] }) =>
    [r.stopped.length ? `stopped ${r.stopped.length} job(s) (pid ${r.stopped.join(", ")})` : "", ...r.refused].filter(Boolean).join("; ") ||
    "nothing left to stop";
  switch (button) {
    case "stop": {
      const r = await stop(card.targets);
      return done(`${card.facts.who ?? ""}: ${said(r)}`, !r.refused.length);
    }
    case "allow-until": {
      const key = card.session ? `session:${card.session}` : `project:${card.project}`;
      allowUntil(e.ops, key, card.until, e.now);
      snooze(e.ops, card.id, card.until, e.now);
      return done(`${card.facts.who ?? card.project} may run heavy jobs until ${clock(card.until)}`);
    }
    case "always-allow": {
      const approvals = [...e.cfg.control.approvals, { action: "allow-heavy-in-quiet" as const, project: card.project, at: e.now }];
      e.save({ ...e.cfg, control: { ...e.cfg.control, approvals } });
      return done(`${card.project} may always run heavy jobs in quiet mode (revoke it in Settings › Safety)`);
    }
    case "one-at-a-time": {
      const slots = Object.fromEntries(HEAVY.map((k) => [k, 1])) as Record<Heavy, number>;
      e.save({ ...e.cfg, governor: { ...e.cfg.governor, slots } });
      if (!card.targets.length) return done("heavy jobs run one at a time from now");
      const r = await stop(card.targets);
      return done(`heavy jobs run one at a time from now; ${said(r)}`, !r.refused.length);
    }
    case "quiet": {
      const until = setQuiet(e.ops, 2, e.now);
      return done(`quiet mode until ${clock(until)}: no new heavy jobs start`);
    }
    case "close-pr": {
      if (!card.pr) return done("no PR to close", false);
      const repo = card.pr.repo.includes("/") ? ["--repo", card.pr.repo] : [];
      const r = e.run(
        [
          "gh",
          "pr",
          "close",
          card.pr.branch,
          ...repo,
          "--comment",
          "Closed by the owner via Overhand: opened from another project's session.",
        ],
        card.pr.dir,
      );
      if (r.ok) snooze(e.ops, card.id, e.now + WEEK, e.now);
      return done(
        r.ok ? `closed the PR from ${card.pr.branch} in ${card.pr.repo}` : `couldn't close it: ${(r.err || r.out).trim().slice(0, 200)}`,
        r.ok,
      );
    }
    case "keep":
      snooze(e.ops, card.id, e.now + WEEK, e.now);
      return done("kept as it is");
    case "pause": {
      if (!card.session) return done("that session isn't connected, so it can't be paused", false);
      setHold(e.ops, card.session, `another session edits the same files on ${card.facts.branch ?? "this branch"}`, e.now);
      return done(`paused ${card.facts.who ?? "the session"}: its tool calls are held until you resume it`);
    }
    case "more-time": {
      extend(e.ops, card.pgid, e.now + 20 * MIN, e.now);
      snooze(e.ops, card.id, e.now + 20 * MIN, e.now);
      return done(`gave ${card.facts.cmd ?? "the job"} 20 more minutes`);
    }
    case "resend": {
      const r = moveRequest(e.ops, card.request, "sent", "", e.now);
      snooze(e.ops, card.id, e.now + 15 * MIN, e.now);
      return done(r ? `sent request ${r.id} to ${r.toLabel} again` : "that request is gone", r !== null);
    }
    case "drop": {
      const r = moveRequest(e.ops, card.request, "dropped", "", e.now);
      return done(r ? `dropped request ${r.id}` : "that request is gone", r !== null);
    }
    default:
      return done("nothing to do here", false);
  }
}

// ---------- the live room ----------

/** Listening TCP ports by pid, from one lsof call. */
function listening(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let pid = 0;
  try {
    const r = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    for (const l of r.stdout.toString().split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("n")) {
        const port = Number(l.split(":").at(-1));
        if (port > 0) out.set(pid, [...(out.get(pid) ?? []), port]);
      }
    }
  } catch {
    // no lsof: no ports shown
  }
  return out;
}

/** The registry and cards now, from this machine. `live` is liveSessions(). */
export function room(
  ops: string,
  cfg: Config,
  live: LiveSession[],
  home: string,
  now = Date.now(),
  leadName?: (label: string) => string,
): { rows: Row[]; cards: Card[] } {
  const table = processTable();
  const rows = buildRegistry({
    live,
    beats: loadBeats(ops),
    table,
    ports: listening(),
    locks: holders(ops),
    holds: loadHolds(ops),
    rulesVersion: rulesVersion(cfg.control, cfg.governor.protect),
    home,
    git: (cwd) => ({ repo: repoOf(cwd), branch: branchOf(cwd) }),
    now,
    leadName,
  });
  const load1 = loadavg()[0] ?? 0;
  const cards = detectCards({
    rows,
    quietUntil: quietEnd(ops, cfg.control, now),
    load1,
    loadPerCore: load1 / Math.max(1, cpus().length),
    maxLoadPerCore: cfg.governor.maxLoadPerCore,
    silentMin: cfg.governor.silentMin,
    requests: loadRequests(ops),
    approvals: cfg.control.approvals,
    snoozed: loadSnoozed(ops),
    exempt: (r) => exempt(ops, cfg.control, { project: r.project, session: r.id }, now),
    extended: (pgid) => extended(ops, pgid, now),
    strain: sustained(STRAIN) ? { cpu: STRAIN.history.at(-1)?.cpu ?? 0, cause: STRAIN.cause || "other apps" } : null,
    now,
  });
  return { rows, cards };
}

/** The live environment a button runs in. */
export function liveActEnv(ops: string, cfg: Config, save: (c: Config) => void, run: ActEnv["run"]): ActEnv {
  return {
    ops,
    cfg,
    save,
    table: processTable,
    isProtected: (pid) => protectedProc(pid, cfg.governor.protect),
    kill: (root) => killTree(root),
    run,
    now: Date.now(),
  };
}

/**
 * The connected session a request goes to, by its id (or the first 6+ characters), pid, name, label or project; an
 * error when none or several match. Only connected sessions can be handed a request.
 */
export function resolveTarget(query: string, rows: Row[]): Row | string {
  const q = query.trim().toLowerCase();
  if (!q) return "name a session: its project, name, pid or id";
  const reach = rows.filter((r) => r.id);
  const exact = reach.filter((r) => r.id === q || String(r.pid) === q || (q.length >= 6 && r.id.startsWith(q)));
  const named = exact.length ? exact : reach.filter((r) => [r.name, r.label, r.project].some((x) => x.toLowerCase() === q));
  const [one, ...more] = named;
  if (one && !more.length) return one;
  if (more.length)
    return `"${query}" matches ${named.length} sessions (${named.map((r) => `${r.label} ${r.id.slice(0, 8)}`).join(", ")}); use its id`;
  const unconnected = rows.find((r) => !r.id && [r.label, r.project, String(r.pid)].some((x) => x.toLowerCase() === q));
  return unconnected
    ? `${unconnected.label} isn't connected, so it can't be handed requests: overhand connect ${unconnected.repo || unconnected.cwd}`
    : `no connected session called "${query}"`;
}
