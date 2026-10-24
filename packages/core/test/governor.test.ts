import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig } from "../src/config";
import { forgetRun, recordRun } from "../src/control";
import {
  acquire,
  alive,
  classify,
  type Governor,
  gate,
  govern,
  holders,
  KILLED_EXIT,
  type Machine,
  orphanBrowsers,
  type Proc,
  parseBattery,
  parseHours,
  parseThermal,
  protectedHit,
  quietUntil,
  release,
  riskyScript,
  runHeavy,
  scriptsRun,
  setQuiet,
  treeOf,
  WAIT_EXIT,
  wrappable,
} from "../src/governor";

const scratch = (): string => mkdtempSync(join(tmpdir(), "overhand-gov-"));
const GOV: Governor = blankConfig("t").governor;
const ROOMY: Machine = { loadPerCore: 0.2, battery: null, throttled: false, freeGb: 200 };
const GOVERNOR = join(import.meta.dir, "..", "src", "governor.ts");

test("classify: heavy jobs by kind; edits, git, reads and targeted tests are light", () => {
  const cases: [string, string | null][] = [
    ["bun run shots", "browser"],
    ["cd apps/web && bunx playwright test", "browser"],
    ["npx playwright test e2e/login.spec.ts", "browser"],
    ["node scripts/screenshot-all.mjs", "browser"],
    ["npx @axe-core/cli http://localhost:3000", "browser"],
    ["lighthouse http://localhost:3000 --quiet", "browser"],
    ["xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' test", "simulator"],
    ["xcrun simctl boot 'iPhone 16'", "simulator"],
    ["maestro test flows/", "simulator"],
    ["npx expo run:ios", "simulator"],
    ["bun test", "suite"],
    ["nice -n 10 bun run test", "suite"],
    ["npm test", "suite"],
    ["pnpm vitest run", "suite"],
    ["go test ./...", "suite"],
    ["pytest", "suite"],
    ["bun run build", "build"],
    ["cd apps/web && bun run build 2>&1 | tail -20", "build"],
    ["next build", "build"],
    ["cargo build --release", "build"],
    ["docker build -t app .", "build"],
    ["bun run dev", "devserver"],
    ["pnpm dev --port 3001", "devserver"],
    ["npx expo start", "devserver"],
    // light
    ["bun test packages/core/test/guard.test.ts", null],
    ["nice -n 10 bun test ./overhand.test.ts -t 'cleanup'", null],
    ["npx vitest run src/a.test.ts", null],
    ["pytest tests/test_api.py", null],
    ["pytest -k login", null],
    ["go test ./internal/auth", null],
    ["bunx tsc --noEmit", null],
    ["git commit -m 'fix playwright screenshot test'", null],
    ["grep -r 'bun run build' docs", null],
    ["echo bun test", null],
    ["npx playwright install chromium", null],
    ["xcrun simctl list devices", null],
    ["playwright --version", null],
    ["biome check --write src", null],
  ];
  for (const [cmd, kind] of cases) expect([cmd, classify(cmd)]).toEqual([cmd, kind]);
});

test("gate: quiet mode, a nearly full disk, load per core, low battery and heat each hold heavy jobs", () => {
  const now = Date.now();
  expect(gate(GOV, ROOMY, 0, now)).toBeNull();
  expect(gate(GOV, ROOMY, now + 3_600_000, now)).toMatch(/quiet mode/);
  expect(gate(GOV, ROOMY, now - 1, now)).toBeNull(); // ended
  expect(gate(GOV, { ...ROOMY, freeGb: 6 }, 0, now)).toMatch(/disk is nearly full \(6\.0 GB/);
  expect(gate(GOV, { ...ROOMY, loadPerCore: 9.5 }, 0, now)).toMatch(/load 9\.5 per core/);
  expect(gate(GOV, { ...ROOMY, battery: { pct: 20, charging: false } }, 0, now)).toMatch(/battery at 20%/);
  expect(gate(GOV, { ...ROOMY, battery: { pct: 20, charging: true } }, 0, now)).toBeNull();
  expect(gate(GOV, { ...ROOMY, battery: { pct: 20, charging: false } }, 0, now)).not.toBeNull();
  expect(gate({ ...GOV, minBatteryPct: 0 }, { ...ROOMY, battery: { pct: 5, charging: false } }, 0, now)).toBeNull();
  expect(gate(GOV, { ...ROOMY, throttled: true }, 0, now)).toMatch(/hot/);
  expect(gate({ ...GOV, thermal: false }, { ...ROOMY, throttled: true }, 0, now)).toBeNull();
});

test("pmset readings: battery charge and power source, thermal throttling", () => {
  expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t24%; discharging; 2:10 remaining")).toEqual({
    pct: 24,
    charging: false,
  });
  expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging;")).toEqual({ pct: 80, charging: true });
  expect(parseBattery("Now drawing from 'AC Power'")).toBeNull(); // a desktop
  expect(parseThermal("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded")).toBe(
    false,
  );
  expect(parseThermal("CPU_Scheduler_Limit = 100\nCPU_Available_CPUs = 8\nCPU_Speed_Limit = 100")).toBe(false);
  expect(parseThermal("CPU_Speed_Limit = 62")).toBe(true);
  expect(parseThermal("Thermal warning level set to 2.")).toBe(true);
});

test("quiet mode: on for some hours, read back, off; `3h`, `90m`, `off`", () => {
  const ops = scratch();
  const now = Date.now();
  expect(quietUntil(ops, now)).toBe(0);
  const until = setQuiet(ops, 3, now);
  expect(until).toBe(now + 3 * 3_600_000);
  expect(quietUntil(ops, now)).toBe(until);
  expect(quietUntil(ops, until + 1)).toBe(0); // over by itself
  expect(govern("bun run shots", GOV, { ops, machine: () => ROOMY, self: ["overhand"], now })).toEqual({
    wait: expect.stringMatching(/quiet mode is on until/),
  });
  expect(govern("bun test a.test.ts", GOV, { ops, machine: () => ROOMY, self: ["overhand"], now })).toBeNull(); // targeted tests go on
  expect(setQuiet(ops, 0, now)).toBe(0);
  expect(quietUntil(ops, now)).toBe(0);
  expect([parseHours("3h"), parseHours("90m"), parseHours("1.5"), parseHours("off"), parseHours("soon")]).toEqual([3, 1.5, 1.5, 0, null]);
});

test("govern: heavy commands run wrapped in a slot; full slots and chained or scripted commands wait; light ones pass", () => {
  const ops = scratch();
  const o = { ops, machine: () => ROOMY, self: ["/opt/overhand"] };
  expect(govern("bun run build", GOV, o)).toEqual({ wrap: "'/opt/overhand' heavy build -- 'bun run build'" });
  expect(govern("cd 'my app' && bun run build", GOV, o)).toEqual({
    wrap: `'/opt/overhand' heavy build -- 'cd '\\''my app'\\'' && bun run build'`,
  });
  expect(govern("git status", GOV, o)).toBeNull();
  expect(govern("bun run build", { ...GOV, enabled: false }, o)).toBeNull();
  expect(govern("rm -rf dist && bun run build", GOV, o)).toEqual({ wait: expect.stringMatching(/on its own|by itself/) });
  expect(wrappable("bun run build && node -e 'x'")).toBe(false);
  expect(wrappable("bun run build $(cat flags)")).toBe(false);
  expect(wrappable("docker run --rm app")).toBe(false);
  expect(wrappable("docker build -t app . | tail -5")).toBe(true);
  // every browser slot taken by a live process
  expect(acquire(ops, "browser", GOV.slots.browser, { pid: process.pid, pgid: 0, run: "HC-1", cmd: "bun run shots", since: 1 })).toBe(0);
  expect(govern("bunx playwright test", GOV, o)).toEqual({ wait: expect.stringMatching(/all 1 browser slot\(s\) are in use/) });
  expect(govern("bun run build", GOV, o)).toEqual({ wrap: expect.any(String) }); // other kinds have their own
  release(ops, "browser", 0, process.pid);
  expect(govern("bunx playwright test", GOV, o)).toEqual({ wrap: expect.any(String) });
});

/** Starts `n` bun processes at once, each trying to take a `max`-slot kind and holding it `holdMs`; returns their exit codes. */
async function contend(ops: string, n: number, max: number, holdMs: number): Promise<number[]> {
  const script = `import { acquire } from ${JSON.stringify(GOVERNOR)};
const got = acquire(${JSON.stringify(ops)}, "suite", ${max}, { pid: process.pid, pgid: 0, run: "", cmd: "", since: Date.now() });
await Bun.sleep(${holdMs});
process.exit(got === null ? 1 : 0);`;
  const procs = Array.from({ length: n }, () => Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "inherit" }));
  return Promise.all(procs.map((p) => p.exited));
}

test("slots: separate processes share them, at most `max` at once; a dead holder's lock expires", async () => {
  const ops = scratch();
  const codes = await contend(ops, 5, 2, 1500);
  expect(codes.filter((c) => c === 0).length).toBe(2);
  // those holders exited without releasing: their locks are stale, so they count for nothing
  expect(readdirSync(join(ops, "slots", "suite")).length).toBe(2);
  expect(holders(ops)).toEqual([]);
  expect(readdirSync(join(ops, "slots", "suite"))).toEqual([]); // expired on the way
  const again = await contend(ops, 1, 1, 0);
  expect(again).toEqual([0]);
  // a stale lock is taken over directly by the next acquire too
  expect(acquire(ops, "suite", 1, { pid: process.pid, pgid: 0, run: "", cmd: "", since: 0 })).toBe(0);
  expect(acquire(ops, "suite", 1, { pid: process.pid, pgid: 0, run: "", cmd: "", since: 0 })).toBeNull();
}, 20_000);

test("a lock its writer left empty is held for a moment, then freed: the slot isn't lost for good", () => {
  const ops = scratch();
  const dir = join(ops, "slots", "build");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "0.lock");
  const me = { pid: process.pid, pgid: 0, run: "", cmd: "", since: 0 };
  writeFileSync(path, "");
  expect(acquire(ops, "build", 1, me)).toBeNull(); // maybe being written right now
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  expect(holders(ops)).toEqual([]);
  expect(existsSync(path)).toBe(false); // expired on the way
  writeFileSync(path, '{"pid": 1');
  utimesSync(path, past, past);
  expect(acquire(ops, "build", 1, me)).toBe(0); // taken over directly too
});

const fast = (o: Partial<Governor> = {}): Governor => ({ ...GOV, silentMin: 0.004, ...o }); // ~240 ms of silence

test("runHeavy: runs in a slot and passes its exit code and output through; waits when there's no room", async () => {
  const ops = scratch();
  const log = join(ops, "guard.jsonl");
  const out: string[] = [];
  const said: string[] = [];
  const e = {
    ops,
    gov: fast(),
    machine: () => ROOMY,
    run: "HC-7",
    project: "Honeycrust",
    log,
    tickMs: 20,
    out: (c: Buffer) => void out.push(c.toString()),
    say: (l: string) => void said.push(l),
  };
  expect(await runHeavy("build", "echo built; exit 3", e)).toBe(3);
  expect(out.join("")).toBe("built\n");
  expect(holders(ops)).toEqual([]); // the slot went with it
  expect(await runHeavy("build", "echo no", { ...e, machine: () => ({ ...ROOMY, loadPerCore: 30 }) })).toBe(WAIT_EXIT);
  expect(said.at(-1)).toMatch(/holding build jobs: the machine is busy .* do other work now/);
  expect(readFileSync(log, "utf8")).toMatch(/"run":"HC-7".*"rule":"waited: the machine is busy/);
});

test("runHeavy: a job that goes silent, or runs past its limit, is killed with its whole process tree", async () => {
  const ops = scratch();
  const log = join(ops, "guard.jsonl");
  const said: string[] = [];
  const e = {
    ops,
    gov: fast(),
    machine: () => ROOMY,
    run: "HC-8",
    project: "",
    log,
    tickMs: 20,
    out: () => {},
    say: (l: string) => void said.push(l),
  };
  // a hung test: a child and a grandchild that never print
  const pidFile = join(ops, "pids");
  const hung = `sh -c 'sleep 60 & echo $! > ${pidFile}; wait' & wait`;
  const started = Date.now();
  expect(await runHeavy("suite", hung, e)).toBe(KILLED_EXIT);
  expect(Date.now() - started).toBeLessThan(8000);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  await Bun.sleep(200);
  expect(alive(grandchild)).toBe(false);
  expect(said.at(-1)).toMatch(/killed this suite job and its process tree: it printed nothing/);
  expect(readFileSync(log, "utf8")).toMatch(/killed: printed nothing/);
  // talks all the time but never ends: the wall clock
  const chatty = { ...e, gov: fast({ timeoutMin: { ...GOV.timeoutMin, browser: 0.005 } }) };
  expect(await runHeavy("browser", "while true; do echo frame; sleep 0.05; done", chatty)).toBe(KILLED_EXIT);
  expect(said.at(-1)).toMatch(/ran past its 0.005 min limit/);
  // a dev server is quiet by nature: silence alone doesn't kill it
  const quietServer = await Promise.race([runHeavy("devserver", "sleep 0.6; exit 0", e), Bun.sleep(5000).then(() => -1)]);
  expect(quietServer).toBe(0);
  expect(holders(ops)).toEqual([]);
}, 20_000);

test("treeOf: a process, its descendants and its group, nothing else", () => {
  const table: Proc[] = [
    { pid: 10, ppid: 1, pgid: 10, cmd: "sh -c bun test" },
    { pid: 11, ppid: 10, pgid: 10, cmd: "bun test" },
    { pid: 12, ppid: 11, pgid: 12, cmd: "chrome --headless" }, // its own group, still a descendant
    { pid: 13, ppid: 12, pgid: 12, cmd: "chrome renderer" },
    { pid: 14, ppid: 1, pgid: 10, cmd: "orphan in the group" },
    { pid: 20, ppid: 1, pgid: 20, cmd: "your editor" },
  ];
  expect(treeOf(10, table).sort()).toEqual([10, 11, 12, 13, 14]);
});

test("orphaned headless browsers: only ones whose parent died and that an agent run started", () => {
  const table: Proc[] = [
    { pid: 30, ppid: 1, pgid: 30, cmd: "/Users/n/Library/Caches/ms-playwright/chromium-1/chrome --headless=new" },
    { pid: 31, ppid: 1, pgid: 31, cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless" }, // yours
    { pid: 32, ppid: 500, pgid: 32, cmd: "chrome-headless-shell --remote-debugging-pipe" }, // parent alive
    { pid: 33, ppid: 1, pgid: 33, cmd: "/Applications/Slack.app/Contents/MacOS/Slack" }, // not a browser
  ];
  const env = (pid: number) => (pid === 30 || pid === 32 || pid === 33 ? "PATH=/bin OVERHAND_RUN=HC-1" : "PATH=/bin");
  expect(orphanBrowsers(table, env).map((p) => p.pid)).toEqual([30]);
});

test("protected processes: stop, kill and restart commands that hit a protected port, name or container are blocked", () => {
  const p = { ports: [4317, 4100], names: ["demo-server"], containerPrefixes: ["stage-"] };
  const facts: Record<number, { cmd: string; ports: number[] }> = {
    501: { cmd: "node .next/standalone/server.js", ports: [4100] },
    502: { cmd: "/usr/bin/demo-server --port 9000", ports: [9000] },
    503: { cmd: "vite", ports: [5173] },
  };
  const look = {
    facts: (pid: number) => facts[pid] ?? null,
    pgrep: (args: string[]) => (args.at(-1) === "next" ? [501] : args.at(-1) === "vite" ? [503] : []),
  };
  const hit = (cmd: string) => protectedHit(cmd, p, look);
  expect(hit("lsof -ti:4100 | xargs kill -9")).toMatch(/port 4100/);
  expect(hit("kill $(lsof -t -i :4317)")).toMatch(/port 4317/);
  expect(hit("fuser -k 4100/tcp")).toMatch(/port 4100/);
  expect(hit("kill -9 501")).toMatch(/listens on protected port 4100/);
  expect(hit("kill 502")).toMatch(/demo-server/);
  expect(hit("pkill -f next")).toMatch(/process 501/);
  expect(hit("pkill demo-server")).toMatch(/demo-server is protected/);
  expect(hit("docker stop stage-web")).toMatch(/stage-/);
  expect(hit("docker restart stage-db-1")).toMatch(/stage-/);
  expect(hit("docker stop $(docker ps -q)")).toMatch(/name the containers/);
  expect(hit("docker compose down")).toMatch(/name the containers/);
  // allowed: stopping your own things, and commands that only mention a port
  expect(hit("pkill -f vite")).toBeNull();
  expect(hit("kill 503")).toBeNull();
  expect(hit("docker stop my-api")).toBeNull();
  expect(hit("curl localhost:4100/health")).toBeNull();
  expect(hit("bun run dev --port 41000")).toBeNull();
  expect(protectedHit("docker compose down", { ...p, containerPrefixes: [] }, look)).toBeNull();
});

test("govern: a read-only run is gated but never rewritten; risky package scripts are blocked, not rewritten", () => {
  const ops = scratch();
  const o = { ops, machine: () => ROOMY, self: ["overhand"] };
  expect(govern("bun run build", GOV, { ...o, readOnly: true })).toBeNull();
  expect(govern("bun run build", GOV, { ...o, readOnly: true, machine: () => ({ ...ROOMY, loadPerCore: 50 }) })).toEqual({
    wait: expect.stringMatching(/busy/),
  });
  const vet = (c: string) =>
    riskyScript(c, { build: "tsc && wrangler deploy", "build:web": "vite build" }, (b) => (/deploy/.test(b) ? "no deploys" : null));
  expect(govern("bun run build", GOV, { ...o, vet })).toEqual({ block: "the build script runs tsc && wrangler deploy: no deploys" });
  expect(govern("bun run build:web", GOV, { ...o, vet })).toEqual({ wrap: expect.any(String) });
  const names = (c: string) => riskyScript(c, {}, () => null);
  for (const c of [
    "npm run deploy",
    "pnpm run release:web",
    "yarn publish-docs",
    "bun run db:reset",
    "npm run migrate",
    "bun run seed",
    "npm run build:prod",
    "pnpm exec upload",
    "yarn sync",
  ])
    expect([c, names(c)]).toEqual([c, expect.stringMatching(/reaches outside/)]);
  for (const c of ["bun run build", "npm test", "bun install", "yarn add react", "bun test", "npm run dev", "bun run productivity"])
    expect([c, names(c)]).toEqual([c, null]);
  expect(scriptsRun("cd web && npm start | tail -5")).toEqual(["start"]);
});

test("the guard hook: wraps a heavy command in `heavy`, holds it in quiet mode, leaves light ones alone", () => {
  const ops = scratch();
  const governor = { maxLoadPerCore: 1000, minBatteryPct: 0, thermal: false, pauseHeavyBelowGb: 0 };
  writeFileSync(
    join(ops, "overhand.config.json"),
    JSON.stringify({ owner: { name: "t", keychainAccount: "t" }, accounts: [], clients: [], governor }),
  );
  // a project whose build script also deploys, and one whose scripts are ordinary
  const risky = join(ops, "risky");
  mkdirSync(risky);
  writeFileSync(join(risky, "package.json"), JSON.stringify({ scripts: { build: "next build && vercel deploy --prod" } }));
  const hook = (command: string, autonomy = "act", cwd = ops) => {
    recordRun(ops, process.pid, { run: "HC-1", autonomy, project: "" }); // who the run is: Overhand's record
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard"], {
      env: { ...process.env, OVERHAND_HOME: ops },
      stdin: Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command, description: "x" }, cwd })),
    });
    forgetRun(ops, process.pid);
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  // a watch run (plan mode) is never rewritten or approved: plan mode still decides
  expect(hook("bun run build", "watch")).toEqual({ code: 0, out: "", err: "" });
  // a script that deploys is blocked, not approved through the rewrite, even reached through cd
  const deploys = hook("bun run build", "act", risky);
  expect(deploys.code).toBe(2);
  expect(deploys.out).toBe("");
  expect(deploys.err).toMatch(/Blocked by Overhand's guard: the build script runs next build && vercel deploy --prod: no Vercel deploys/);
  expect(hook("cd risky && bun run build").code).toBe(2);
  const wrapped = hook("bun run build");
  expect(wrapped.code).toBe(0);
  const out = JSON.parse(wrapped.out) as { hookSpecificOutput: { permissionDecision: string; updatedInput: unknown } };
  expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(out.hookSpecificOutput.updatedInput).toEqual({
    command: expect.stringMatching(/ heavy build -- 'bun run build'$/),
    description: "x",
  });
  expect(hook("git status")).toEqual({ code: 0, out: "", err: "" });
  setQuiet(ops, 1);
  const held = hook("bun run build");
  expect(held.code).toBe(2);
  expect(held.err).toMatch(/holding build jobs: quiet mode is on/);
  expect(hook("bun run build", "watch").code).toBe(2); // a watch run is still gated
  expect(readFileSync(join(ops, "guardrails.jsonl"), "utf8")).toMatch(/"run":"HC-1".*waited/);
  expect(hook("kill $(lsof -t -i:4317)").code).toBe(2); // Overhand's own port is protected by default
}, 20_000);

test("nothing outside Overhand's own slots is touched: an unreadable lock and other files are left alone", () => {
  const ops = scratch();
  const dir = join(ops, "slots", "build");
  acquire(ops, "build", 1, { pid: process.pid, pgid: 0, run: "", cmd: "", since: 0 });
  writeFileSync(join(dir, "1.lock"), "{half-writ");
  writeFileSync(join(dir, "notes.txt"), "mine");
  expect(holders(ops).map((h) => h.slot)).toEqual([0]);
  expect(existsSync(join(dir, "1.lock"))).toBe(true);
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  release(ops, "build", 0, 999_999); // not the holder: no effect
  expect(existsSync(join(dir, "0.lock"))).toBe(true);
});
