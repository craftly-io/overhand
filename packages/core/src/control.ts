/**
 * The control room's hook side and its files: every connected session reports itself through the guard hook (a
 * heartbeat per Claude Code session id), gets the owner's house rules applied and handed to it, and receives typed
 * requests at its next tool call. Everything lives under OPS/control, which agents can't touch (selfPaths), and the
 * house rules and standing approvals live in Overhand's config. Kept light: the guard imports this on every tool call.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GuardBlockSchema, RequestSchema, type SessionRequest } from "@overhand/contract";
import { z } from "zod";
import type { Config } from "./config";
import { alive, type Heavy, quietUntil } from "./governor";
import { lstart, procInfo } from "./platform";

export type Control = Config["control"];
export type Approval = Control["approvals"][number];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** How long an edited file counts as "being edited" by a session. */
export const FILES_FRESH_MS = 30 * MIN;
/** A request not yet acknowledged is handed over again this often. */
const REMIND_MS = 10 * MIN;

/** The control room's folder. */
export const controlDir = (ops: string): string => join(ops, "control");

const readText = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** Writes through a temp file (0600) and a rename, so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A JSON file through a schema, or `fallback` when it's missing or doesn't fit. */
function readParsed<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const r = schema.safeParse(JSON.parse(readText(file)));
    return r.success ? r.data : fallback;
  } catch {
    return fallback;
  }
}

/** "HH:MM" local time. */
export const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** "HH:MM" on `now`'s day, in ms. */
function todayAt(hm: string, now: number): number {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** "16:20" as the next time it's 16:20 (today, or tomorrow when that has passed); null when it isn't a time. */
export function nextAt(hm: string, now = Date.now()): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(hm)) return null;
  const t = todayAt(hm.padStart(5, "0"), now);
  return t > now ? t : t + DAY;
}

// ---------- house rules ----------

/**
 * When the hold window covering `now` for `kind` ends (ms), or 0 when none does. A window whose end is before its start
 * runs past midnight; windows with no kinds hold every kind (a quiet window).
 */
export function windowUntil(windows: Control["windows"], kind: Heavy | null, now: number): number {
  let end = 0;
  for (const w of windows) {
    if (kind && w.kinds.length && !w.kinds.includes(kind)) continue;
    if (!kind && w.kinds.length) continue;
    let from = todayAt(w.from, now);
    let to = todayAt(w.to, now);
    if (to <= from) {
      if (now >= from) to += DAY;
      else from -= DAY;
    }
    if (now >= from && now < to) end = Math.max(end, to);
  }
  return end;
}

/** Quiet as the owner set it: quiet mode, or a quiet window (one holding every kind). When it ends, or 0. */
export function quietEnd(ops: string, c: Control, now = Date.now()): number {
  return Math.max(quietUntil(ops, now), windowUntil(c.windows, null, now));
}

const AllowSchema = z.record(z.string(), z.number());
const allowFile = (ops: string) => join(controlDir(ops), "allow.json");

/** Heavy jobs of this session or project may run through quiet mode: a standing allow, or "Allow until" from a card. */
export function exempt(ops: string, c: Control, who: { project: string; session: string }, now = Date.now()): boolean {
  if (c.approvals.some((a) => a.action === "allow-heavy-in-quiet" && (a.project === "*" || a.project === who.project))) return true;
  const allow = readParsed(allowFile(ops), AllowSchema, {});
  return (allow[`session:${who.session}`] ?? 0) > now || (allow[`project:${who.project}`] ?? 0) > now;
}

/** Lets this session's (or project's) heavy jobs through quiet mode until `until`. */
export function allowUntil(ops: string, key: string, until: number, now = Date.now()): void {
  const allow = readParsed(allowFile(ops), AllowSchema, {});
  const kept = Object.fromEntries(Object.entries(allow).filter(([, t]) => t > now));
  writeAtomic(allowFile(ops), JSON.stringify({ ...kept, [key]: until }));
}

/**
 * Why a heavy job of `kind` must wait by the owner's rules, or null: quiet mode, a quiet window or a hold window for
 * this kind, unless the session or its project is exempt. The governor's machine gates (load, battery, heat, disk) come
 * on top of this.
 */
export function ruleHold(kind: Heavy, c: Control, o: { ops: string; project: string; session: string; now?: number }): string | null {
  const now = o.now ?? Date.now();
  const quiet = quietUntil(o.ops, now);
  const win = windowUntil(c.windows, kind, now);
  if (!quiet && !win) return null;
  if (exempt(o.ops, c, o, now)) return null;
  if (quiet) return `quiet mode is on until ${clock(quiet)}: the owner needs the machine`;
  return `the owner's house rules hold ${kind} jobs until ${clock(win)}`;
}

/** A Slack tool call that sends, edits or reacts: everything but searching, reading and writing a draft. */
const slackSends = (tool: string): boolean => /^mcp__.*slack/i.test(tool) && !/__slack_(search_|read_|send_message_draft$)/.test(tool);

/** The house rule a tool call breaks, or null. Applied to every connected session, Overhand's own and yours. */
export function houseRule(tool: string, c: Control): string | null {
  if (c.slackDraftsOnly && slackSends(tool))
    return "the owner's house rules: Slack drafts only. Write a draft (slack_send_message_draft) for the owner to send";
  return null;
}

/** A short fingerprint of the rules a session is handed, so a change is handed over again. */
export function rulesVersion(c: Control, protect: Config["governor"]["protect"]): string {
  return Bun.hash(JSON.stringify([c.windows, c.slackDraftsOnly, c.notes, protect])).toString(36);
}

/** The house rules as a session reads them, one line each. */
export function rulesText(c: Control, protect: Config["governor"]["protect"]): string {
  const lines = [
    ...c.windows.map((w) => `${w.kinds.length ? `no ${w.kinds.join(", ")} jobs` : "quiet: no heavy jobs"} from ${w.from} to ${w.to}`),
    ...(c.slackDraftsOnly ? ["Slack: drafts only, the owner sends"] : []),
    ...(protect.ports.length || protect.names.length || protect.containerPrefixes.length
      ? [
          `never stop or restart: ${[...protect.ports.map((p) => `port ${p}`), ...protect.names, ...protect.containerPrefixes.map((x) => `${x}*`)].join(", ")}`,
        ]
      : []),
    ...c.notes,
  ];
  return lines.length
    ? `House rules on this machine, from the owner (Overhand's guard enforces them; heavy jobs that must wait are held for you):\n${lines.map((l) => `- ${l}`).join("\n")}`
    : "";
}

// ---------- sessions: the hook's heartbeat ----------

const BeatSchema = z.object({
  id: z.string(),
  /** Its run (control.ts runOf): "" for a session you opened by hand; one named but not recorded is "unrecorded". */
  run: z.string().default(""),
  project: z.string().default(""),
  /** Its `claude` process, found once by walking up from the hook. */
  pid: z.number().default(0),
  cwd: z.string(),
  /** The repository it started in: a PR elsewhere is another project's. */
  home: z.string().default(""),
  transcript: z.string().default(""),
  startedAt: z.number().default(0),
  lastAt: z.number().default(0),
  lastTool: z.string().default(""),
  /** Files it edited lately, absolute. */
  files: z.array(z.object({ path: z.string(), at: z.number() })).default([]),
  /** The house rules version it was handed. */
  rulesSeen: z.string().default(""),
  /** A PR it opened in another repository than its own. */
  prs: z.array(z.object({ at: z.number(), repo: z.string(), dir: z.string(), branch: z.string() })).default([]),
});
export type Beat = z.infer<typeof BeatSchema>;

const beatsDir = (ops: string) => join(controlDir(ops), "sessions");
const safeId = (id: string): boolean => /^[\w-]{1,80}$/.test(id);

/** Every session's last heartbeat; ones whose process is gone are removed on the way. */
export function loadBeats(ops: string, isAlive: (pid: number) => boolean = alive): Beat[] {
  const dir = beatsDir(ops);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    if (!f.endsWith(".json")) return [];
    const b = readParsed(join(dir, f), BeatSchema.nullable(), null);
    if (!b) return [];
    if (b.pid && !isAlive(b.pid)) {
      rmSync(join(dir, f), { force: true });
      return [];
    }
    return [b];
  });
}

/** One session's heartbeat, or null. */
export const beatOf = (ops: string, id: string): Beat | null =>
  safeId(id) ? readParsed(join(beatsDir(ops), `${id}.json`), BeatSchema.nullable(), null) : null;

/** Saves a session's heartbeat. */
export function saveBeat(ops: string, b: Beat): void {
  if (safeId(b.id)) writeAtomic(join(beatsDir(ops), `${b.id}.json`), JSON.stringify(b));
}

/** The git repository folder holding `dir` (a worktree counts as its main checkout), or "". */
export function repoOf(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const git = join(d, ".git");
    if (existsSync(git)) {
      // a worktree's .git is a file naming .../<repo>/.git/worktrees/<name>
      const m = readText(git).match(/^gitdir:\s*(.+)$/m);
      const gd = m?.[1]?.trim();
      return gd && /\/\.git\/worktrees\/[^/]+$/.test(gd) ? dirname(dirname(dirname(resolve(d, gd)))) : d;
    }
    if (dirname(d) === d) return "";
  }
}

/** The branch checked out at `dir` (read from .git, no git process), "" when detached or not a repository. */
export function branchOf(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const git = join(d, ".git");
    if (existsSync(git)) {
      const gd = readText(git)
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      const head = readText(join(gd ? resolve(d, gd) : git, "HEAD"));
      return head.match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim() ?? "";
    }
    if (dirname(d) === d) return "";
  }
}

/** What the hook knows about one tool call. */
export interface ToolCall {
  session: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  transcript: string;
}

/** Where a `gh pr create` goes: its `--repo`, or the folder it runs in (after a leading `cd`). Null when it isn't one. */
function prTarget(cmd: string, cwd: string): { repo: string; dir: string } | null {
  if (!/\bgh\s+pr\s+create\b/.test(cmd)) return null;
  const repo = cmd.match(/\s(?:--repo|-R)[\s=]+(\S+)/)?.[1] ?? "";
  const cd = cmd.match(/^\s*cd\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*&&/);
  return { repo, dir: resolve(cwd, cd?.[1] ?? cd?.[2] ?? cd?.[3] ?? ".") };
}

/**
 * The heartbeat after one tool call: when, where, what it edited, and a PR opened in another repository than the one it
 * started in. `pid` finds the session's claude process (only asked when the beat has none yet).
 */
export function nextBeat(prev: Beat | null, call: ToolCall, env: { run: string; project: string }, pid: () => number, now: number): Beat {
  const b: Beat = prev ?? {
    id: call.session,
    run: env.run,
    project: env.project,
    pid: 0,
    cwd: call.cwd,
    home: repoOf(call.cwd) || call.cwd,
    transcript: call.transcript,
    startedAt: now,
    lastAt: now,
    lastTool: "",
    files: [],
    rulesSeen: "",
    prs: [],
  };
  const path = [call.input.file_path, call.input.notebook_path].find((p): p is string => typeof p === "string");
  const edited = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(call.tool) && path ? [{ path: resolve(call.cwd, path), at: now }] : [];
  const files = [...edited, ...b.files.filter((f) => f.path !== edited[0]?.path && now - f.at < FILES_FRESH_MS)].slice(0, 30);
  const cmd = call.tool === "Bash" && typeof call.input.command === "string" ? call.input.command : "";
  const pr = prTarget(cmd, call.cwd);
  const foreign =
    pr && ((pr.repo && !b.home.endsWith(`/${pr.repo.split("/").pop() ?? ""}`)) || (!pr.repo && repoOf(pr.dir) !== b.home))
      ? [{ at: now, repo: pr.repo || basename(repoOf(pr.dir) || pr.dir), dir: pr.dir, branch: branchOf(pr.dir) }]
      : [];
  return {
    ...b,
    run: env.run,
    project: env.project || b.project,
    // found once (a few `ps` calls); again only if that process is gone
    pid: !prev || (b.pid && !alive(b.pid)) ? pid() : b.pid,
    cwd: call.cwd,
    transcript: call.transcript || b.transcript,
    lastAt: now,
    lastTool: call.tool,
    files,
    prs: [...foreign, ...b.prs.filter((p) => now - p.at < DAY)].slice(0, 10),
  };
}

/** The `claude` process above this hook (the hook runs under a shell it started), or 0. */
export function claudePid(start = process.ppid): number {
  let pid = start;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const r = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const m = r.stdout
      .toString()
      .trim()
      .match(/^(\d+)\s+(.*)$/);
    if (!m) return 0;
    if ((m[2] ?? "").split("/").pop() === "claude") return pid;
    pid = Number(m[1]);
  }
  return 0;
}

// ---------- runs: who each process tree Overhand started is ----------

/** What the guard judges a run as: its id (OVERHAND_RUN's value), its project's autonomy, its project. */
export const RunWhoSchema = z.object({
  run: z.string(),
  autonomy: z.string(),
  project: z.string(),
  /** It runs under the OS sandbox (sandbox.ts): its guard writes to its outbox, not control/. */
  sandboxed: z.boolean().optional(),
  /** Its project is set to run without the OS sandbox while it's on (sandbox.ts projectSandbox): the guard only. */
  guardOnly: z.boolean().optional(),
});
export type RunWho = z.infer<typeof RunWhoSchema>;
/** Each run by pid, with when its process started (`ps` lstart), so a pid the system hands out again isn't taken for it. */
const RunsSchema = z.record(
  z.string(),
  // keyHash: the SHA-256 of the run's own key (runKey), which lets it call the few routes a run may (server.ts RUN_ROUTES)
  // cwd: the folder it was started in, which its outbox heartbeats are held to (ingestOutboxes)
  RunWhoSchema.extend({ at: z.number(), start: z.string().default(""), keyHash: z.string().optional(), cwd: z.string().optional() }),
);
const runsFile = (ops: string) => join(controlDir(ops), "runs.json");

/** When a process started, as `ps` says it (lstart); "" when there's no such process. */
export function startOf(pid: number): string {
  // macOS: libproc, which works inside the OS sandbox where ps can't run (platform.ts procInfo); the same text as ps's
  const info = procInfo(pid);
  if (info) return lstart(info.startSec);
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return r.stdout.toString().trim();
  } catch {
    return ""; // ps can't run here: no start time, so no record matches
  }
}

/**
 * Deletes a stale lock, never moving it: only while it still holds the text seen (`seen`, its holder's token) and is
 * older than `staleMs`; the caller then takes the lock like a fresh one, by exclusive create. True when it was deleted.
 * ponytail: between this last check and the delete another holder can take the lock and lose it; a lock file can't close
 * that without a kernel lock (flock), and the daemon and a CLI touch it seconds apart, so the window is microseconds.
 */
export function clearStale(lock: string, seen: string, staleMs: number, now = Date.now()): boolean {
  try {
    if (readText(lock) !== seen || now - statSync(lock).mtimeMs <= staleMs) return false;
  } catch {
    return false; // gone already
  }
  rmSync(lock, { force: true });
  return true;
}

/**
 * Runs `f` holding `file`'s lock (a `.lock` beside it, created exclusively), so the daemon and a CLI changing the same
 * file one after the other never drop each other's change. A lock older than `staleMs` was left by a writer that died
 * and is taken over; throws when the lock can't be had within `waitMs`.
 */
export function withLock<T>(file: string, f: () => T, staleMs = 10_000, waitMs = 3000): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  // each holder writes its own token, so it removes only a lock that's still its own
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const mine = (): boolean => readText(lock) === token;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, token);
      closeSync(fd);
      break;
    } catch {
      try {
        // a stale lock is cleared away (never written over), then taken like a fresh one on the next try
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs && clearStale(lock, readText(lock), staleMs)) continue;
      } catch {
        // gone already: try again
      }
      if (Date.now() > until) throw new Error(`${lock} is held`);
      Bun.sleepSync(5);
    }
  }
  try {
    return f();
  } finally {
    if (mine()) rmSync(lock, { force: true });
  }
}

/**
 * Records a process Overhand just started as an agent run, by pid and start time, in control/ (which no agent may
 * write), dropping ones whose process is gone. The guard takes a run's identity from here, never from the environment
 * the agent can set.
 */
export function recordRun(
  ops: string,
  pid: number,
  who: RunWho,
  isAlive: (pid: number) => boolean = alive,
  now = Date.now(),
  start = startOf(pid),
): void {
  withLock(runsFile(ops), () => {
    const kept = Object.entries(readParsed(runsFile(ops), RunsSchema, {})).filter(([p]) => isAlive(Number(p)));
    writeAtomic(runsFile(ops), JSON.stringify(Object.fromEntries([...kept, [String(pid), { ...who, at: now, start }]])));
  });
}

/** Drops every run whose process is gone or whose pid now belongs to a process that started at another time. */
export function pruneRuns(ops: string, started: (pid: number) => string = startOf): void {
  withLock(runsFile(ops), () => {
    const runs = Object.entries(readParsed(runsFile(ops), RunsSchema, {}));
    writeAtomic(runsFile(ops), JSON.stringify(Object.fromEntries(runs.filter(([p, r]) => r.start && started(Number(p)) === r.start))));
  });
}

/**
 * Records an agent run Overhand just spawned, with the identity its runtime put in the environment it was given
 * (guardEnv), and forgets it once the process ends.
 */
export function recordSpawn(
  ops: string,
  proc: { pid: number; exited: Promise<unknown> },
  env: Record<string, string>,
  sandboxed = false,
  cwd = "",
  guardOnly = false,
): void {
  try {
    const key = env[RUN_KEY_ENV];
    recordRun(ops, proc.pid, {
      run: env.OVERHAND_RUN ?? "",
      autonomy: env.OVERHAND_AUTONOMY ?? "act",
      project: env.OVERHAND_PROJECT ?? "",
      ...(sandboxed ? { sandboxed } : {}),
      ...(guardOnly ? { guardOnly } : {}),
      ...(key ? { keyHash: sha(key) } : {}),
      ...(cwd ? { cwd } : {}),
    });
    void proc.exited.then(() => forgetRun(ops, proc.pid)).catch(() => {});
  } catch {
    // a full disk or a held lock: the run goes ahead unrecorded, and its guard judges it on watch (trustIdentity)
  }
}

/** Forgets a run whose process ended. */
export function forgetRun(ops: string, pid: number): void {
  withLock(runsFile(ops), () => {
    const { [String(pid)]: _, ...rest } = readParsed(runsFile(ops), RunsSchema, {});
    writeAtomic(runsFile(ops), JSON.stringify(rest));
  });
}

/**
 * The run a process belongs to: the first of its ancestors (`chain`, nearest first) Overhand recorded whose process
 * still started when the record says (a reused pid is someone else); null for none.
 */
export function runOf(ops: string, chain: readonly number[], started: (pid: number) => string = startOf): RunWho | null {
  const runs = readParsed(runsFile(ops), RunsSchema, {});
  for (const pid of chain) {
    const r = runs[String(pid)];
    if (r?.start && started(pid) === r.start)
      return { run: r.run, autonomy: r.autonomy, project: r.project, ...(r.sandboxed ? { sandboxed: true } : {}) };
  }
  return null;
}

/** The environment variable a run's own key comes in (runKey). */
export const RUN_KEY_ENV = "OVERHAND_RUN_KEY";
/** The header Overhand's CLI sends a run's own key in, when it runs inside a run. */
export const RUN_KEY_HEADER = "x-overhand-run-key";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * A fresh key for one run, put in its environment at spawn (recordSpawn keeps its hash). It opens only the few dashboard
 * routes a run may call (`overhand ask`, `ack`, `answer`), as that run, while its process lives: the install's local key
 * stays hidden from it.
 */
export const runKey = (): string => randomBytes(32).toString("base64url");

/** The live run a run key belongs to, or null (unknown key, or its process ended or isn't the one recorded). */
export function runByKey(ops: string, key: string, started: (pid: number) => string = startOf): RunWho | null {
  if (!key) return null;
  const h = Buffer.from(sha(key));
  for (const [pid, r] of Object.entries(readParsed(runsFile(ops), RunsSchema, {}))) {
    const k = Buffer.from(r.keyHash ?? "");
    if (k.length === h.length && timingSafeEqual(k, h) && r.start && started(Number(pid)) === r.start)
      return { run: r.run, autonomy: r.autonomy, project: r.project };
  }
  return null;
}

/** A run's outbox: a sandboxed run's guard writes its heartbeats and blocks there, and the daemon takes them in. */
export const outboxDir = (ops: string, run: string): string => join(ops, "from-runs", run.replace(/[^\w-]/g, "_") || "run");

/**
 * This process's ancestors, nearest first (its parent, its parent's parent…): on macOS from libproc (it works inside
 * the OS sandbox, where ps can't run), else from one `ps` call; [] when neither can tell.
 */
export function ancestors(start = process.ppid): number[] {
  if (procInfo(start)) {
    const out: number[] = [];
    for (let pid = start; pid > 1 && out.length < 64 && !out.includes(pid); pid = procInfo(pid)?.ppid ?? 0) out.push(pid);
    return out;
  }
  let listed = "";
  try {
    listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  } catch {
    return []; // ps can't run here: no recorded ancestor, so the call is judged with the most care (guard trustIdentity)
  }
  const parent = new Map<number, number>();
  for (const line of listed.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) parent.set(pid, ppid);
  }
  const out: number[] = [];
  for (let pid = start; pid > 1 && out.length < 64 && !out.includes(pid); pid = parent.get(pid) ?? 0) out.push(pid);
  return out;
}

/**
 * Whether this process runs inside a run Overhand started: one of its ancestors is a recorded run, or its environment
 * names one (a run that left its tree is still a run).
 */
export const insideRun = (ops: string, env: Record<string, string | undefined> = process.env, chain = ancestors()): boolean =>
  !!env.OVERHAND_RUN || runOf(ops, chain) !== null;

// ---------- holds: a session the owner paused ----------

const HoldsSchema = z.record(z.string(), z.object({ reason: z.string(), at: z.number() }));
const holdsFile = (ops: string) => join(controlDir(ops), "holds.json");

/** Paused sessions by id, with why. */
export const loadHolds = (ops: string): z.infer<typeof HoldsSchema> => readParsed(holdsFile(ops), HoldsSchema, {});

/** Pauses a session (every tool call it makes is held with `reason`), or lifts the pause with an empty reason. */
export function setHold(ops: string, session: string, reason: string, now = Date.now()): void {
  const { [session]: _, ...rest } = loadHolds(ops);
  writeAtomic(holdsFile(ops), JSON.stringify(reason ? { ...rest, [session]: { reason, at: now } } : rest));
}

// ---------- more time for a silent job ----------

const extendFile = (ops: string) => join(controlDir(ops), "extend.json");

/** Gives a heavy job (by its process group) until `until` before it's taken as hung. */
export function extend(ops: string, pgid: number, until: number, now = Date.now()): void {
  const all = readParsed(extendFile(ops), AllowSchema, {});
  const kept = Object.fromEntries(Object.entries(all).filter(([, t]) => t > now));
  writeAtomic(extendFile(ops), JSON.stringify({ ...kept, [String(pgid)]: until }));
}

/** The owner gave this job more time and it hasn't run out. */
export const extended = (ops: string, pgid: number, now = Date.now()): boolean =>
  (readParsed(extendFile(ops), AllowSchema, {})[String(pgid)] ?? 0) > now;

// ---------- typed requests ----------

const requestsFile = (ops: string) => join(controlDir(ops), "requests.json");

/** Every request, oldest first. */
export const loadRequests = (ops: string): SessionRequest[] => readParsed(requestsFile(ops), z.array(RequestSchema), []);

/**
 * Changes the request list in one read-modify-write; the last 200 are kept. ponytail: two writers at the same instant
 * can lose one change (the daemon and an `ack` from a session); a lock file if that ever bites.
 */
export function editRequests(ops: string, f: (rs: SessionRequest[]) => SessionRequest[]): SessionRequest[] {
  const next = f(loadRequests(ops)).slice(-200);
  writeAtomic(requestsFile(ops), JSON.stringify(next));
  return next;
}

/** Files a request to session `to`. */
export function addRequest(
  ops: string,
  r: { from: string; to: string; toLabel: string; text: string; by: number },
  now = Date.now(),
): SessionRequest {
  const req: SessionRequest = {
    id: Math.random().toString(36).slice(2, 8),
    ...r,
    state: "sent",
    at: now,
    deliveredAt: 0,
    changedAt: now,
    note: "",
  };
  editRequests(ops, (rs) => [...rs, req]);
  return req;
}

/** Moves a request on (acknowledged, done, refused, dropped), or sends it again (`sent`). Null when there's no such request. */
export function moveRequest(ops: string, id: string, state: SessionRequest["state"], note = "", now = Date.now()): SessionRequest | null {
  let out: SessionRequest | null = null;
  editRequests(ops, (rs) =>
    rs.map((r) => {
      if (r.id !== id) return r;
      out = { ...r, state, note: note || r.note, changedAt: now, ...(state === "sent" ? { deliveredAt: 0 } : {}) };
      return out;
    }),
  );
  return out;
}

/** Requests to hand `session` now: sent, and never handed over or not acknowledged for a while. */
export const dueFor = (rs: readonly SessionRequest[], session: string, now: number): SessionRequest[] =>
  rs.filter((r) => r.to === session && r.state === "sent" && (!r.deliveredAt || now - r.deliveredAt > REMIND_MS));

/** A request as the target session reads it: what, from whom, by when, and how to answer. */
export function requestText(r: SessionRequest, self: string): string {
  const by = r.by ? ` (by ${clock(r.by)})` : "";
  return `Request ${r.id} from ${r.from}${by}: ${r.text}\nAnswer it: ${self} ack ${r.id}  (then: ${self} ack ${r.id} done, or ${self} ack ${r.id} refuse "why")`;
}

// ---------- connecting a project ----------

const SettingsSchema = z.record(z.string(), z.unknown());
const HookEntrySchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(z.object({ command: z.string().optional() }).loose()) })
  .loose();

/** The hand hook's settings entry: every tool call goes through Overhand's guard in hand mode. */
const handEntry = (command: string) => ({ matcher: "*", hooks: [{ type: "command", command }] });

/** True for a settings hook entry that runs Overhand's guard in hand mode. */
const ours = (e: unknown): boolean => {
  const r = HookEntrySchema.safeParse(e);
  return r.success && r.data.hooks.some((h) => / guard hand\b/.test(h.command ?? ""));
};

/** The settings file a connect writes: the project's own local settings (not committed), or `~/.claude/settings.json`. */
export const settingsFile = (root: string, global = false): string =>
  global ? join(root, ".claude", "settings.json") : join(root, ".claude", "settings.local.json");

/** A settings file's content after connecting (`on`) or disconnecting; `changed` is false when it already was. */
export function withHook(file: string, command: string, on: boolean): { changed: boolean; before: string; after: string } {
  const before = readText(file);
  let cfg: Record<string, unknown> = {};
  if (before.trim()) {
    const parsed = SettingsSchema.safeParse(JSON.parse(before));
    if (!parsed.success) throw new Error(`${file} isn't a JSON object`);
    cfg = parsed.data;
  }
  const parsedHooks = SettingsSchema.safeParse(cfg.hooks);
  const hooks = parsedHooks.success ? parsedHooks.data : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const kept = pre.filter((e) => !ours(e));
  const present = kept.length !== pre.length;
  if (on === present && (!on || pre.some((e) => JSON.stringify(e) === JSON.stringify(handEntry(command)))))
    return { changed: false, before, after: before };
  const nextPre = on ? [...kept, handEntry(command)] : kept;
  const { PreToolUse: _, ...otherHooks } = hooks;
  const nextHooks = nextPre.length ? { ...otherHooks, PreToolUse: nextPre } : otherHooks;
  const { hooks: __, ...rest } = cfg;
  const next = Object.keys(nextHooks).length ? { ...rest, hooks: nextHooks } : rest;
  return { changed: true, before, after: Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : "" };
}

/** Connects or disconnects: writes the settings file (removed when nothing else is left in it). Returns what changed. */
export function applyHook(file: string, command: string, on: boolean): { changed: boolean; after: string } {
  const r = withHook(file, command, on);
  if (!r.changed) return r;
  if (r.after) writeAtomic(file, r.after);
  else rmSync(file, { force: true });
  return r;
}

// ---------- sandboxed runs' outboxes ----------

/** At most this much of an outbox is read: a run can't make the daemon read or hold more. */
const BOX_FILE_MAX = 1_000_000;
const BOX_ENTRIES_MAX = 200;

/** `p` is a real folder, not a symlink to one (each folder of an outbox is checked so, from the top down). */
function realDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory() && realpathSync(p) === join(realpathSync(dirname(p)), basename(p));
  } catch {
    return false;
  }
}

/**
 * A regular file's text in an outbox, never through a symlink (O_NOFOLLOW) and at most BOX_FILE_MAX bytes; null for
 * anything else. Removed once read, only if it's still that same regular file.
 */
function takeBoxFile(p: string): string | null {
  let fd = -1;
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > BOX_FILE_MAX) return null;
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const text = readFileSync(fd, "utf8");
    if (fstatSync(fd).ino === st.ino) unlinkSync(p);
    return text;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Each JSON line of `text` that parses with `schema`. Never throws. */
function jsonLinesOf<T>(text: string | null, schema: z.ZodType<T>): T[] {
  return (text ?? "").split("\n").flatMap((l) => {
    try {
      const r = schema.safeParse(JSON.parse(l));
      return r.success ? [r.data] : [];
    } catch {
      return [];
    }
  });
}

const DeliveredSchema = z.object({ session: z.string(), ids: z.array(z.string()) });

/** `p` is `root` or inside it, as given. */
const inside = (p: string, root: string): boolean => resolve(p) === resolve(root) || resolve(p).startsWith(`${resolve(root)}/`);

/**
 * Takes in what sandboxed runs' guards wrote to their outboxes (outboxDir), as untrusted claims: a heartbeat only for a
 * session of that same run (never one another run or you own), held to the process and folder Overhand recorded for
 * it; a block line only as that run; a request marked handed over only when it was for one of that run's sessions.
 * Only real folders and regular files inside the box are read or removed, never what a symlink points at.
 */
export function ingestOutboxes(ops: string, guardLog: string): void {
  const root = join(ops, "from-runs");
  if (!realDir(root)) return;
  const runs = Object.entries(readParsed(runsFile(ops), RunsSchema, {}));
  for (const name of readdirSync(root).slice(0, BOX_ENTRIES_MAX)) {
    const box = join(root, name);
    if (!realDir(box)) continue;
    const ours = (run: string) => run !== "" && outboxDir(ops, run) === box;
    const recorded = runs.find(([, r]) => ours(r.run));
    const sessions = join(box, "control", "sessions");
    const mine = new Set<string>();
    const files = realDir(join(box, "control")) && realDir(sessions) ? readdirSync(sessions).slice(0, BOX_ENTRIES_MAX) : [];
    for (const f of files) {
      const text = takeBoxFile(join(sessions, f));
      let raw: unknown = null;
      try {
        raw = text === null ? null : JSON.parse(text);
      } catch {
        continue;
      }
      const parsed = BeatSchema.safeParse(raw);
      if (!parsed.success || !ours(parsed.data.run) || !safeId(parsed.data.id)) continue;
      const had = beatOf(ops, parsed.data.id);
      if (had && had.run !== parsed.data.run) continue;
      // its process and folder are the ones Overhand started it with, whatever the claim says
      const pid = recorded ? Number(recorded[0]) : 0;
      const cwd = recorded?.[1].cwd ?? "";
      const b = { ...parsed.data, pid, ...(cwd && !inside(parsed.data.cwd, cwd) ? { cwd } : {}) };
      saveBeat(ops, b);
      mine.add(b.id);
    }
    const rows = jsonLinesOf(takeBoxFile(join(box, "guardrails.jsonl")), GuardBlockSchema).filter((r) => ours(r.run));
    if (rows.length) appendFileSync(guardLog, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    const handed = jsonLinesOf(takeBoxFile(join(box, "delivered.jsonl")), DeliveredSchema).filter((d) => {
      const b = beatOf(ops, d.session);
      return mine.has(d.session) || (b !== null && ours(b.run));
    });
    const ids = new Map(handed.flatMap((d) => d.ids.map((id) => [id, d.session] as const)));
    const now = Date.now();
    if (ids.size) editRequests(ops, (rs) => rs.map((r) => (ids.get(r.id) === r.to ? { ...r, deliveredAt: now } : r)));
  }
}
