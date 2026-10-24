/**
 * The machine governor: heavy jobs Overhand's agents and leads start (headless browsers, full test suites, builds,
 * simulators, dev servers) take a slot shared by every run on this machine, and only while the machine has room (load,
 * battery, heat, disk, quiet mode). The guard hook classifies each shell command; a heavy one either waits (the agent is
 * told to do other work and retry) or runs under `overhand heavy`, which holds the slot, kills the job's whole process
 * tree when it hangs, and lets the slot go when it ends. Slots are lock files under OPS/slots, one per slot, holding the
 * holder's pid: a lock whose process is gone has expired.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config";
import { writeAtomic } from "./control";

/** Heavy job kinds, in the order a command is matched against them. */
export const HEAVY = ["browser", "simulator", "suite", "build", "devserver"] as const;
export type Heavy = (typeof HEAVY)[number];
/** True for a heavy job kind's name. */
export const isHeavy = (s: string): s is Heavy => (HEAVY as readonly string[]).includes(s);
export type Governor = Config["governor"];

const MIN = 60_000;

// ---------- what a command is ----------

/** A segment starting with one of these only reads, prints or signals: never heavy, whatever its arguments say. */
const NEVER =
  /^(git|gh|echo|printf|cat|grep|rg|sed|awk|ls|which|type|command|kill|pkill|killall|ps|pgrep|lsof|head|tail|less|curl|wget|man|find|jq|test|\[)$/;
/** Leading words that only change how the real command runs (`nice -n 10`, `FOO=1`, `timeout 60`). */
const PREFIX = /^(\w+=\S*|env|nice|time|timeout|caffeinate|exec|nohup|sudo|-n|-i|-?\d+[smh]?)$/;
/** Not running anything heavy: asking for a version or help, or installing the tool. */
const HARMLESS =
  /\s(--version|-v|--help|-h)\s*$|\bplaywright\s+install\b|\bsimctl\s+(list|help)\b|\bxcodebuild\s+-(version|showsdks|list)\b/;

const PM = "(?:npm|pnpm|yarn|bun|bunx|npx)";
const RULES: [Heavy, RegExp][] = [
  [
    "browser",
    /\b(playwright|puppeteer|lighthouse|pa11y|backstop|cypress\s+run|chrome-headless|headless_shell|axe-cli)\b|@axe-core\/cli\b|--headless\b|\baxe\s+https?:|\b(?:run\s+)?shots\b|\bshots\.ts\b|\bscreenshots?\b/i,
  ],
  [
    "simulator",
    /\b(xcodebuild|maestro\s+(test|record|studio)|detox\s+(test|build)|emulator\s+-avd|simctl\s+(boot|install|launch|io|spawn|openurl)|(?:expo|react-native)\s+run[:-](?:ios|android)|flutter\s+(?:run|drive)|gradlew?\s+connected\w*)\b/,
  ],
  [
    "build",
    new RegExp(
      String.raw`\b(${PM}\s+run\s+build(?::\S+)?|bun\s+build|(?:next|vite|nuxt|astro|remix|turbo(?:\s+run)?|nx(?:\s+run)?)\s+build|cargo\s+build|go\s+build|swift\s+build|gradlew?\s+(?:assemble|build)\w*|docker\s+(?:compose\s+)?build|tsc\s+(?:-b|--build))\b`,
    ),
  ],
  [
    "devserver",
    new RegExp(
      String.raw`\b(${PM}\s+(?:run\s+)?(?:dev|start|serve|storybook)|(?:next|nuxt|astro|remix|vite)\s+dev|expo\s+start|webpack\s+serve|storybook\s+dev|start-storybook|bun\s+--(?:hot|watch)|ng\s+serve|rails\s+s(?:erver)?|python3?\s+-m\s+http\.server|uvicorn|flask\s+run)\b`,
    ),
  ],
];

/** A test runner, and what follows it on the command line. */
const TEST_RUNNER = new RegExp(
  String.raw`\b(?:${PM}\s+(?:run\s+)?test(?::[\w:-]+)?|bun\s+test|jest|vitest(?:\s+run)?|pytest|cargo\s+test|go\s+test|mocha|turbo\s+(?:run\s+)?test|rspec|phpunit|mix\s+test)\b(.*)$`,
);
/** Arguments that narrow a test run to some files or names: a targeted run, not a suite. */
const TARGETED =
  /[\w./-]+\.(test|spec)\.[cm]?[jt]sx?\b|[\w./-]+_test\.go\b|\btest_\w+\.py\b|\w+_test\.py\b|::|\s(-t|-k|--testNamePattern|--test-name-pattern|--grep|-run|--filter|-g)\b/;

/** One shell command's segments, split on `&&`, `||`, `;`, `|` and newlines, each without its leading prefixes. */
function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map((seg) => {
      const words = seg
        .trim()
        .replace(/^[({\s]+/, "")
        .split(/\s+/);
      while (words.length > 1 && PREFIX.test(words[0] ?? "")) words.shift();
      return words.join(" ");
    })
    .filter(Boolean);
}

/**
 * What kind of heavy job a shell command starts, or null when it's light (edits, git, targeted tests, reads). A command
 * that starts several takes the first kind in HEAVY's order. `go test` on one package and a test run naming files or a
 * name filter are targeted, so light.
 */
export function classify(cmd: string): Heavy | null {
  for (const seg of segments(cmd)) {
    if (NEVER.test(seg.split(" ")[0] ?? "") || HARMLESS.test(seg)) continue;
    for (const [kind, re] of RULES) if (re.test(seg)) return kind;
    const test = seg.match(TEST_RUNNER);
    if (!test) continue;
    const args = ` ${test[1] ?? ""}`;
    const goPackage = /\bgo\s+test\b/.test(seg) && !/\.\.\./.test(args);
    if (!TARGETED.test(args) && !goPackage) return "suite";
  }
  return null;
}

// ---------- whether the machine has room ----------

/** What the gates read: load per core, the battery (null on a desktop), thermal throttling, free disk. */
export interface Machine {
  loadPerCore: number;
  battery: { pct: number; charging: boolean } | null;
  throttled: boolean;
  freeGb: number;
}

/** `pmset -g batt`: the charge, and whether it's on mains power. Null when there's no battery. */
export function parseBattery(out: string): Machine["battery"] {
  const pct = out.match(/(\d+)%/)?.[1];
  if (pct === undefined) return null;
  return { pct: Number(pct), charging: /AC Power/.test(out) || /;\s*(charging|charged|finishing charge)/.test(out) };
}

/** `pmset -g therm`: throttled when the CPU speed limit is below 100 or a thermal or performance warning is set. */
export function parseThermal(out: string): boolean {
  const limit = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];
  if (limit !== undefined && Number(limit) < 100) return true;
  return [...out.matchAll(/(?:thermal|performance) warning level\s*(?:=|is|set to|:)\s*(\d+)/gi)].some((m) => Number(m[1]) > 0);
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};
const sh = (cmd: string[]): string => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return r.stdout.toString();
  } catch {
    return "";
  }
};

/** Battery on Linux: the first BAT* power supply. */
function linuxBattery(): Machine["battery"] {
  const root = "/sys/class/power_supply";
  const bat = existsSync(root) ? readdirSync(root).find((d) => d.startsWith("BAT")) : undefined;
  if (!bat) return null;
  const pct = Number(read(join(root, bat, "capacity")));
  return Number.isFinite(pct) ? { pct, charging: read(join(root, bat, "status")) !== "Discharging" } : null;
}

/**
 * Reads this machine now. Battery and heat come from pmset on macOS; on Linux the battery from /sys and no heat reading.
 * ponytail: Linux thermal zones are skipped; read /sys/class/thermal trip points if hot Linux laptops need it.
 */
export function readMachine(freeGb: number): Machine {
  const mac = process.platform === "darwin";
  return {
    loadPerCore: (loadavg()[0] ?? 0) / Math.max(1, cpus().length),
    battery: mac ? parseBattery(sh(["pmset", "-g", "batt"])) : linuxBattery(),
    throttled: mac ? parseThermal(sh(["pmset", "-g", "therm"])) : false,
    freeGb,
  };
}

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** Why no heavy job may start right now, or null when the machine has room. Slots are counted separately. */
export function gate(g: Governor, m: Machine, quietUntil: number, now: number): string | null {
  if (quietUntil > now) return `quiet mode is on until ${clock(quietUntil)}: the owner needs the machine`;
  if (m.freeGb < g.pauseHeavyBelowGb) return `the disk is nearly full (${m.freeGb.toFixed(1)} GB free)`;
  if (m.loadPerCore > g.maxLoadPerCore)
    return `the machine is busy (load ${m.loadPerCore.toFixed(1)} per core, the limit is ${g.maxLoadPerCore})`;
  if (m.battery && !m.battery.charging && m.battery.pct < g.minBatteryPct) return `the laptop is on battery at ${m.battery.pct}%`;
  if (g.thermal && m.throttled) return "the machine is running hot and throttling";
  return null;
}

// ---------- quiet mode ----------

const quietFile = (ops: string) => join(ops, ".quiet");

/** When quiet mode ends (ms), or 0 when it's off. */
export function quietUntil(ops: string, now = Date.now()): number {
  const until = Number(read(quietFile(ops))) || 0;
  return until > now ? until : 0;
}

/** Turns quiet mode on for `hours` from now, or off with 0. Returns when it ends (0 = off). */
export function setQuiet(ops: string, hours: number, now = Date.now()): number {
  if (hours <= 0) {
    rmSync(quietFile(ops), { force: true });
    return 0;
  }
  const until = now + Math.round(hours * 60) * MIN;
  writeFileSync(quietFile(ops), String(until), { mode: 0o600 });
  return until;
}

/** `3h`, `90m`, `1.5`, `off`: hours, or null when it can't be read. */
export function parseHours(arg: string): number | null {
  if (/^(off|stop|end|0)$/i.test(arg)) return 0;
  const m = arg.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /^m/i.test(m[2] ?? "") ? n / 60 : n;
}

// ---------- slots ----------

const LockSchema = z.object({
  pid: z.number(),
  /** The job's process group, once started: reaped if the holder dies without cleaning up. */
  pgid: z.number().default(0),
  run: z.string().default(""),
  cmd: z.string().default(""),
  since: z.number().default(0),
  /** The Claude Code session that started it, when the guard knew it. */
  session: z.string().default(""),
  /** When the job last printed something (0 = not yet), for the control room's silent-job card. */
  lastOut: z.number().default(0),
});
export type Lock = z.infer<typeof LockSchema>;

/** True while a process with this pid exists (another user's counts too). */
export function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): Lock | null {
  try {
    const r = LockSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const slotDir = (ops: string, kind: Heavy) => join(ops, "slots", kind);

/** How long a lock may read as unreadable while it's being written; past that its writer was killed mid-write. */
const HALF_WRITTEN_MS = 5_000;
/** True when a lock that doesn't parse is a leftover, not one being written right now (or it's gone already). */
const halfWritten = (path: string, now = Date.now()): boolean => {
  try {
    return now - statSync(path).mtimeMs > HALF_WRITTEN_MS;
  } catch {
    return true;
  }
};

/**
 * Removes a dead holder's lock, killing what's left of its job first: its process group, only while a process in it
 * still carries OVERHAND_HEAVY (every job `runHeavy` starts does). A lock is only a file, and one an agent planted could
 * name any process group; it can't make Overhand kill one that isn't a heavy job's. ponytail: macOS hides a platform
 * binary's environment (/bin/sh, sleep) from `ps -E`, so a group left with only those isn't killed, just unlocked; the
 * job's own tools (bun, node, python) show theirs.
 */
function expire(path: string, lock: Lock | null, env: (pid: number) => string = envOf, table: () => Proc[] = processTable): void {
  const pgid = lock?.pgid ?? 0;
  if (pgid && pgid !== process.pid) {
    const members = table().filter((p) => p.pgid === pgid);
    if (members.some((p) => /\bOVERHAND_HEAVY=\S/.test(env(p.pid)))) signalGroup(pgid, "SIGKILL");
  }
  rmSync(path, { force: true });
}

/**
 * Takes a free `kind` slot for `lock.pid`, or returns null when all `max` are held by live processes. A slot whose
 * holder died is expired and taken. ponytail: two processes expiring the same dead lock at the same instant can both
 * win one slot (one extra job, never a lost lock); a lock daemon would close that if it ever matters.
 */
export function acquire(
  ops: string,
  kind: Heavy,
  max: number,
  lock: z.input<typeof LockSchema>,
  env: (pid: number) => string = envOf,
): number | null {
  const dir = slotDir(ops, kind);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < max; i++) {
    const path = join(dir, `${i}.lock`);
    for (let tries = 0; tries < 2; tries++) {
      try {
        const fd = openSync(path, "wx", 0o600); // O_EXCL: exactly one process creates it
        writeSync(fd, JSON.stringify(lock));
        closeSync(fd);
        return i;
      } catch {
        const held = readLock(path);
        // a lock being written right now reads empty: held, until it has read that way too long
        if (held ? alive(held.pid) : !halfWritten(path)) break;
        expire(path, held, env);
      }
    }
  }
  return null;
}

/** Updates a slot this process holds (e.g. with the job's process group once it started). */
function updateSlot(ops: string, kind: Heavy, slot: number, lock: z.input<typeof LockSchema>): void {
  const path = join(slotDir(ops, kind), `${slot}.lock`);
  if (readLock(path)?.pid === lock.pid) writeAtomic(path, JSON.stringify(lock));
}

/** Lets a slot go, only if `pid` still holds it. */
export function release(ops: string, kind: Heavy, slot: number, pid: number): void {
  const path = join(slotDir(ops, kind), `${slot}.lock`);
  if (readLock(path)?.pid === pid) rmSync(path, { force: true });
}

/** Every slot held by a live process; dead holders' locks are expired on the way (and their leftover jobs killed). */
export function holders(ops: string): (Lock & { kind: Heavy; slot: number })[] {
  return HEAVY.flatMap((kind) => {
    const dir = slotDir(ops, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((f) => {
      const m = f.match(/^(\d+)\.lock$/);
      if (!m) return [];
      const path = join(dir, f);
      const lock = readLock(path);
      if (lock && alive(lock.pid)) return [{ ...lock, kind, slot: Number(m[1]) }];
      if (lock || halfWritten(path)) expire(path, lock); // an unreadable one may be mid-write: left alone a moment
      return [];
    });
  });
}

// ---------- killing a process tree ----------

/** A process table row. */
export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  cmd: string;
}

/** This user's processes: pid, parent, group and command line. */
export function processTable(): Proc[] {
  return sh(["ps", "-A", "-o", "pid=,ppid=,pgid=,command="])
    .split("\n")
    .flatMap((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4] ?? "" }] : [];
    });
}

/** `root` and every process under it (children, theirs, ...), plus anything still in its process group. */
export function treeOf(root: number, table: Proc[]): number[] {
  const out = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table)
      if (!out.has(p.pid) && (out.has(p.ppid) || p.pgid === root)) {
        out.add(p.pid);
        grew = true;
      }
  }
  return [...out];
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // the group is gone
  }
}

/** Kills `root`'s whole tree: SIGTERM, then SIGKILL for whatever is still there after `graceMs`. */
export async function killTree(root: number, graceMs = 3000): Promise<number[]> {
  const pids = treeOf(root, processTable());
  const send = (sig: NodeJS.Signals) => {
    signalGroup(root, sig);
    for (const pid of pids)
      try {
        process.kill(pid, sig);
      } catch {}
  };
  send("SIGTERM");
  const end = Date.now() + graceMs;
  while (Date.now() < end && pids.some(alive)) await Bun.sleep(100);
  if (pids.some(alive)) send("SIGKILL");
  return pids;
}

// ---------- orphaned headless browsers ----------

/** A headless browser process (Chrome for Testing, chrome-headless-shell, a playwright or puppeteer Chromium). */
export const HEADLESS = /--headless|chrome-headless-shell|headless_shell|ms-playwright|\.cache\/puppeteer|Chrome for Testing/;

/** The environment of one of this user's processes, as text: /proc on Linux, `ps -E` on macOS. */
function envOf(pid: number): string {
  if (process.platform === "linux") return read(`/proc/${pid}/environ`).replace(/\0/g, " ");
  return sh(["ps", "-E", "-ww", "-o", "command=", "-p", String(pid)]);
}

/**
 * Headless browsers whose parent died (re-parented to pid 1) and that were started under one of Overhand's agent runs
 * (OVERHAND_RUN in their environment): never the owner's own browsers or apps. `envOf` is passed in for tests.
 */
export function orphanBrowsers(table: Proc[], env: (pid: number) => string = envOf): Proc[] {
  return table.filter((p) => p.ppid === 1 && HEADLESS.test(p.cmd) && /\bOVERHAND_RUN=\S/.test(env(p.pid)));
}

// ---------- the log ----------

/** One line per governor event (waited, killed, reaped) in the guardrail log's shape, so Health lists them too. */
export function logEvent(file: string, run: string, project: string, action: string, rule: string): void {
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), project, run, tool: "Bash", action: action.slice(0, 300), rule })}\n`, {
      mode: 0o600,
    });
  } catch {
    // a full disk: the job is handled either way
  }
}

// ---------- running one heavy job ----------

/** What `runHeavy` needs from outside: tests pass scratch folders, a fake machine and short limits. */
export interface HeavyEnv {
  ops: string;
  gov: Governor;
  machine: () => Machine;
  run: string;
  project: string;
  log: string;
  /** Watchdog tick; seconds in real use. */
  tickMs?: number;
  /** Where the job's output goes. */
  out?: (chunk: Buffer, err: boolean) => void;
  say?: (line: string) => void;
  /** The Claude Code session that asked for it, recorded on its slot. */
  session?: string;
  /** Replaces quiet mode's own check: the house rules (quiet mode, hold windows, allowances) for this job. */
  hold?: () => string | null;
  /** The owner gave this job (by its process group) more time from an action card. */
  extended?: (pgid: number) => boolean;
}

/** Exit code when a heavy job couldn't start yet (EX_TEMPFAIL: try again later). */
export const WAIT_EXIT = 75;
/** Exit code when the governor killed a hung job (as `timeout` does). */
export const KILLED_EXIT = 124;

/** The message an agent gets when its heavy job has to wait. */
function waitMessage(kind: Heavy, why: string): string {
  return `Overhand's governor is holding ${kind} jobs: ${why}. Don't wait on it: do other work now (edits, targeted tests on single files) and retry this command later.`;
}

/**
 * Runs one heavy shell command in a slot: waits (exit 75, with why) when the machine has no room or every slot is
 * held; otherwise runs it in its own process group, passes its output through, and kills its whole tree when it runs
 * past its kind's wall-clock limit or (not a dev server) prints nothing for `silentMin`. The slot goes when it ends.
 */
export async function runHeavy(kind: Heavy, cmd: string, e: HeavyEnv): Promise<number> {
  const say = e.say ?? ((l: string) => process.stderr.write(`${l}\n`));
  const why = (e.hold ? e.hold() : null) ?? gate(e.gov, e.machine(), e.hold ? 0 : quietUntil(e.ops), Date.now());
  const base = { pid: process.pid, run: e.run, cmd, since: Date.now(), session: e.session ?? "", lastOut: 0 };
  const slot = why ? null : acquire(e.ops, kind, e.gov.slots[kind], { ...base, pgid: 0 });
  if (why || slot === null) {
    const reason = why ?? `all ${e.gov.slots[kind]} ${kind} slot(s) are in use by other agents`;
    logEvent(e.log, e.run, e.project, cmd, `waited: ${reason}`);
    say(waitMessage(kind, reason));
    return WAIT_EXIT;
  }
  const child = spawn("sh", ["-c", cmd], {
    detached: true, // its own process group, so the whole tree can be killed
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, OVERHAND_HEAVY: kind },
  });
  const pgid = child.pid ?? 0;
  const lock = { ...base, pgid };
  updateSlot(e.ops, kind, slot, lock);
  const out = e.out ?? ((c: Buffer, err: boolean) => (err ? process.stderr : process.stdout).write(c));
  let lastOut = Date.now();
  child.stdout?.on("data", (c: Buffer) => {
    lastOut = Date.now();
    out(c, false);
  });
  child.stderr?.on("data", (c: Buffer) => {
    lastOut = Date.now();
    out(c, true);
  });
  const started = Date.now();
  let killed = "";
  const kill = (reason: string) => {
    if (killed || !pgid) return;
    killed = reason;
    void killTree(pgid);
  };
  const timer = setInterval(() => {
    if (Date.now() - started > e.gov.timeoutMin[kind] * MIN) kill(`ran past its ${e.gov.timeoutMin[kind]} min limit`);
    else if (kind !== "devserver" && Date.now() - lastOut > e.gov.silentMin * MIN && !e.extended?.(pgid))
      kill(`printed nothing for ${e.gov.silentMin} min`);
    // the control room reads when it last printed: one small write per tick, only when that changed
    else if (lastOut !== lock.lastOut) {
      lock.lastOut = lastOut;
      updateSlot(e.ops, kind, slot, lock);
    }
  }, e.tickMs ?? 5000);
  // the agent's tool call cancelled or timed out: take the job down with us
  const stop = () => kill("its tool call was stopped");
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const s of signals) process.on(s, stop);
  const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
  clearInterval(timer);
  for (const s of signals) process.off(s, stop);
  release(e.ops, kind, slot, process.pid);
  if (!killed) return code;
  logEvent(e.log, e.run, e.project, cmd, `killed: ${killed}`);
  say(
    `Overhand's governor killed this ${kind} job and its process tree: it ${killed}. Look for what hangs (a test waiting on a server, a browser left open) before running it again.`,
  );
  return KILLED_EXIT;
}

/** The guard's verdict on a light-or-heavy command: wait (block, with why), wrap it in `overhand heavy`, or leave it. */
export type Verdict = { wait: string } | { wrap: string } | { block: string } | null;

/** Package-manager script names that reach outward or destroy: never approved through the rewrite. */
const RISKY_SCRIPT = /^db:|(^|[:_-])(deploy|release|publish|migrate|migration|seed|prod|production|upload|sync)([:_-]|$)/i;
/** Package-manager subcommands that aren't scripts, for the bare form (`yarn deploy` runs a script, `bun install` doesn't). */
const PM_BUILTIN =
  /^(install|i|add|remove|rm|update|upgrade|ci|init|create|link|unlink|x|dlx|pm|why|outdated|audit|info|view|list|ls|login|logout|config|cache|help|version|-.*)$/;

/** The package scripts a command runs: `npm run x`, `bun run x`, `pnpm exec x`, and bare `yarn x` / `npm start`. */
export function scriptsRun(cmd: string): string[] {
  return segments(cmd).flatMap((seg) => {
    const m = seg.match(/^(npm|pnpm|yarn|bun)\s+(?:(run(?:-script)?|exec)\s+)?([\w:.@/-]+)/);
    if (!m) return [];
    const name = m[3] ?? "";
    if (!m[2] && (PM_BUILTIN.test(name) || (m[1] === "bun" && /^(test|build)$/.test(name)))) return [];
    return [name];
  });
}

/**
 * Why a command's package scripts must not be approved by the rewrite: a script whose name reaches outward or destroys
 * (deploy, release, publish, migrate, seed, prod, upload, sync, db:*), or whose body `rule` (the guard's hard rules) would
 * block. `scripts` is the package.json `scripts` where the command runs.
 */
export function riskyScript(cmd: string, scripts: Record<string, string>, rule: (body: string) => string | null): string | null {
  for (const name of scriptsRun(cmd)) {
    if (RISKY_SCRIPT.test(name)) return `the ${name} script reaches outside this machine or changes data; Overhand's agents don't run it`;
    const body = scripts[name];
    const why = body ? rule(body) : null;
    if (why) return `the ${name} script runs ${body}: ${why}`;
  }
  return null;
}

/** Segment starts the wrapper may run approved: moving around, printing, filtering output, and the dev tools themselves. */
const WRAPPABLE =
  /^(cd|pushd|popd|export|unset|true|sleep|echo|printf|head|tail|grep|rg|tee|cat|wc|sort|uniq|jq|bun|bunx|npm|npx|pnpm|yarn|tsc|biome|eslint|pytest|jest|vitest|playwright|cargo|go|swift|xcodebuild|xcrun|maestro|detox|expo|flutter|gradle|gradlew|\.\/gradlew|make|mix|rspec|turbo|nx|next|vite|astro|nuxt|remix|lighthouse|pa11y|docker)$/;

/**
 * Whether the guard may run this command wrapped. A wrapped command skips Claude Code's own approval (the hook has to
 * approve the rewrite), so only plain tool runs qualify: no command substitution, no inline scripts, and every segment
 * one of the dev tools above.
 */
export function wrappable(cmd: string): boolean {
  if (/\$\(|`|<\(|\s(-e|--eval|-c)\s/.test(cmd)) return false;
  return segments(cmd).every((seg) => WRAPPABLE.test(seg.split(" ")[0] ?? "") && !/^docker\s+(?!(compose\s+)?build\b)/.test(seg));
}

/** Quotes one argument for sh. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command inside a governor wrap (`<self> heavy <kind> [--session s] -- '<cmd>'`, exactly as `govern` writes it), or
 * null for any other command. CLIs whose hooks can't rewrite a command are told to run the wrap themselves; the guard
 * checks what it runs, not Overhand's own path in front of it.
 */
export function unwrapHeavy(cmd: string, self: string[]): string | null {
  const head = `${self.map(q).join(" ")} heavy `;
  if (!cmd.trim().startsWith(head)) return null;
  const m = cmd
    .trim()
    .slice(head.length)
    .match(/^(?:browser|simulator|suite|build|devserver)\s+(?:--session\s+[\w-]+\s+)?--\s+'((?:[^']|'\\'')*)'$/);
  return m ? (m[1] ?? "").replaceAll("'\\''", "'") : null;
}

/**
 * What the guard does with a shell command: null for a light one (or with the governor off); a heavy one waits when the
 * machine has no room or its slots are full (checked again by the wrapper, which holds the slot), else runs wrapped.
 * `self` is the argv that runs Overhand (`overhand`, or bun run.ts from a checkout).
 */
export function govern(
  cmd: string,
  g: Governor,
  o: {
    ops: string;
    machine: () => Machine;
    self: string[];
    now?: number;
    /** A read-only run (a project on watch, Claude Code in plan mode): gated, but never rewritten or approved. */
    readOnly?: boolean;
    /** Why a command must not be approved by the rewrite (a risky package script), or null. */
    vet?: (cmd: string) => string | null;
    /** The house rules for this kind (quiet mode, hold windows, allowances); replaces quiet mode's own check. */
    hold?: (kind: Heavy) => string | null;
    /** The Claude Code session asking, passed to the wrapper so its slot names it. */
    session?: string;
  },
): Verdict {
  if (!g.enabled || /\bheavy\s+(browser|simulator|suite|build|devserver)\s+(--session\s+\S+\s+)?--\s/.test(cmd)) return null;
  const kind = classify(cmd);
  if (!kind) return null;
  const why = (o.hold ? o.hold(kind) : null) ?? gate(g, o.machine(), o.hold ? 0 : quietUntil(o.ops), o.now ?? Date.now());
  if (why) return { wait: waitMessage(kind, why) };
  const held = holders(o.ops).filter((h) => h.kind === kind).length;
  if (held >= g.slots[kind]) return { wait: waitMessage(kind, `all ${g.slots[kind]} ${kind} slot(s) are in use by other agents`) };
  // plan mode decides read-only runs itself: approving a rewrite there would bypass it
  if (o.readOnly) return null;
  const risky = o.vet?.(cmd);
  if (risky) return { block: risky };
  if (!wrappable(cmd))
    return {
      wait: `Overhand runs ${kind} jobs on their own so it can share the machine and stop them if they hang. Run the ${kind} command by itself (cd and output filters like | tail are fine), with any other steps as separate commands`,
    };
  const session = o.session && /^[\w-]+$/.test(o.session) ? ["--session", o.session] : [];
  return { wrap: [...o.self.map(q), "heavy", kind, ...session, "--", q(cmd)].join(" ") };
}

// ---------- protected processes ----------

/** Commands that stop, kill or restart something. */
const STOPS =
  /\b(kill|pkill|killall|fuser\s+-k|xargs\s+kill|launchctl\s+(stop|kill|unload|bootout|remove)|systemctl\s+(--user\s+)?(stop|restart|kill|disable)|pm2\s+(stop|restart|delete|kill|reload)|brew\s+services\s+(stop|restart)|docker\s+(stop|kill|restart|rm|pause)|docker\s+compose\s+(down|stop|kill|restart|rm)|docker-compose\s+(down|stop|kill|restart|rm))\b/;

/** What `pgrep` would match for a pkill or killall in `cmd`, as pgrep's own arguments. */
function patternsOf(cmd: string): string[][] {
  const out: string[][] = [];
  for (const m of cmd.matchAll(/\bpkill\s+((?:-\w+\s+)*)(\S+)/g))
    out.push([
      ...(m[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter((f) => /^-[fix]+$/.test(f)),
      m[2] ?? "",
    ]);
  for (const m of cmd.matchAll(/\bkillall\s+(?:-\w+\s+)*(\S+)/g)) out.push(["-x", m[1] ?? ""]);
  return out.map((a) => a.map((s) => s.replace(/^['"]|['"]$/g, ""))).filter((a) => (a.at(-1) ?? "") !== "");
}

/** What a live process is, for the protected-process check: its command line and the TCP ports it listens on. */
interface ProcFacts {
  cmd: string;
  ports: number[];
}

/** A live process's command and listening ports, or null when it's gone. */
function factsOf(pid: number): ProcFacts | null {
  const cmd = sh(["ps", "-o", "command=", "-p", String(pid)]).trim();
  if (!cmd) return null;
  const ports = sh(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])
    .split("\n")
    .flatMap((l) => (l.startsWith("n") ? [Number(l.split(":").at(-1))] : []))
    .filter((n) => n > 0);
  return { cmd, ports };
}

const pgrep = (args: string[]): number[] =>
  sh(["pgrep", ...args])
    .split("\n")
    .map(Number)
    .filter((n) => n > 0);

/** What the protected-process check looks up live; tests pass fakes. */
export interface ProcLookup {
  facts: (pid: number) => ProcFacts | null;
  pgrep: (args: string[]) => number[];
}
const LIVE: ProcLookup = { facts: factsOf, pgrep };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why a command would stop, kill or restart something the owner protected (`governor.protect`), or null. It looks at
 * what the command names (ports, names, container prefixes) and at the processes a `kill <pid>`, `pkill` or `killall`
 * would hit right now.
 */
export function protectedHit(cmd: string, p: Governor["protect"], look: ProcLookup = LIVE): string | null {
  if (!STOPS.test(cmd)) return null;
  const port = p.ports.find((n) => new RegExp(`(?<![\\d.])${n}(?!\\d)`).test(cmd));
  if (port !== undefined) return `port ${port} is protected: Overhand's agents never stop what runs there`;
  const name = p.names.find((n) => new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, "i").test(cmd));
  if (name) return `${name} is protected: Overhand's agents never stop or restart it`;
  if (/\bdocker(-compose|\s+compose)?\b/.test(cmd) && p.containerPrefixes.length) {
    const hit = p.containerPrefixes.find((x) => new RegExp(`(?<![\\w-])${esc(x)}`).test(cmd));
    if (hit) return `containers named ${hit}* are protected`;
    // `docker stop $(docker ps -q)` or a compose project names no container: it may take a protected one down
    if (/\$\(|`|\s-q\b|compose\s+(down|stop|kill|restart|rm)|docker-compose/.test(cmd))
      return `this could stop protected containers (${p.containerPrefixes.join(", ")}*); name the containers you mean`;
  }
  const pids = [
    ...[...cmd.matchAll(/\bkill\s+((?:-\w+\s+)*)((?:\d+\s*)+)/g)].flatMap((m) => (m[2] ?? "").trim().split(/\s+/).map(Number)),
    ...patternsOf(cmd).flatMap(look.pgrep),
  ];
  for (const pid of pids) {
    const why = protectedProc(pid, p, look);
    if (why) return why;
  }
  return null;
}

/** Why one live process is protected (it listens on a protected port or runs a protected name), or null. */
export function protectedProc(pid: number, p: Governor["protect"], look: ProcLookup = LIVE): string | null {
  const f = look.facts(pid);
  if (!f) return null;
  const port = f.ports.find((n) => p.ports.includes(n));
  if (port !== undefined) return `process ${pid} listens on protected port ${port}`;
  const name = p.names.find((n) => f.cmd.toLowerCase().includes(n.toLowerCase()));
  return name ? `process ${pid} is ${name}, which is protected` : null;
}
