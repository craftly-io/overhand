import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig, type Config } from "../src/config";
import {
  addRequest,
  applyHook,
  type Beat,
  claimHome,
  dueFor,
  editRequests,
  forgetRun,
  houseRule,
  loadRequests,
  moveRequest,
  nextBeat,
  recordRun,
  ruleHold,
  settingsFile,
  survivingRuns,
  windowUntil,
  withHook,
} from "../src/control";
import { type Heavy, type Lock, type Proc, setQuiet } from "../src/governor";
import {
  type ActEnv,
  act,
  buildRegistry,
  type CardContext,
  detectCards,
  planStop,
  type RegistryInput,
  type Row,
  resolveTarget,
} from "../src/room";

const scratch = (): string => mkdtempSync(join(tmpdir(), "overhand-room-"));
const NOW = new Date(2026, 9, 20, 16, 0).getTime();
const MIN = 60_000;
const CFG: Config = blankConfig("t");

// ---------- fixtures: one machine with three sessions ----------

/** ps: an agent (100), your orchard session (200) running a browser lane and a dev server, and an unconnected one (300). */
const TABLE: Proc[] = [
  { pid: 100, ppid: 1, pgid: 100, cmd: "claude -p" },
  { pid: 101, ppid: 100, pgid: 101, cmd: "/bin/zsh -c overhand heavy suite -- bun test" },
  { pid: 102, ppid: 101, pgid: 102, cmd: "bun test" },
  { pid: 200, ppid: 50, pgid: 200, cmd: "claude" },
  { pid: 201, ppid: 200, pgid: 201, cmd: "/bin/zsh -c bunx playwright test" },
  { pid: 202, ppid: 201, pgid: 201, cmd: "node playwright test" },
  { pid: 203, ppid: 202, pgid: 201, cmd: "/ms-playwright/chromium/chrome --headless" },
  { pid: 204, ppid: 203, pgid: 201, cmd: "/ms-playwright/chromium/chrome --type=renderer --headless" },
  { pid: 205, ppid: 202, pgid: 201, cmd: "/ms-playwright/chromium/chrome --headless" },
  { pid: 210, ppid: 200, pgid: 210, cmd: "/bin/zsh -c bun run dev" },
  { pid: 211, ppid: 210, pgid: 210, cmd: "vite" },
  { pid: 300, ppid: 50, pgid: 300, cmd: "claude" },
  { pid: 301, ppid: 300, pgid: 301, cmd: "/ms-playwright/chromium/chrome --headless" },
];

const beat = (over: Partial<Beat>): Beat => ({
  id: "s-orch",
  run: "",
  project: "orchard",
  pid: 200,
  cwd: "/code/orchard",
  home: "/code/orchard",
  transcript: "/home/.claude/projects/-code-orchard/s-orch.jsonl",
  startedAt: NOW - 60 * MIN,
  lastAt: NOW - MIN,
  lastTool: "Bash",
  files: [],
  rulesSeen: "v1",
  prs: [],
  ...over,
});

const lock = (over: Partial<Lock> & { kind: Heavy }): Lock & { kind: Heavy } => ({
  pid: 101,
  pgid: 102,
  run: "HC-1",
  cmd: "bun test",
  since: NOW - 5 * MIN,
  session: "",
  lastOut: NOW - MIN,
  ...over,
});

const input = (over: Partial<RegistryInput> = {}): RegistryInput => ({
  live: [
    { pid: 100, kind: "agent", label: "HC-1 on max", name: "", client: "Honey", cwd: "~/code/honey-wt", active: true },
    { pid: 200, kind: "you", label: "Your session", name: "", client: "Other", cwd: "~/code/orchard", active: true },
    { pid: 300, kind: "you", label: "Your session", name: "", client: "Other", cwd: "~/code/side", active: false },
  ],
  beats: [beat({})],
  table: TABLE,
  ports: new Map([[211, [5173]]]),
  locks: [lock({ kind: "suite" })],
  holds: {},
  rulesVersion: "v1",
  home: "/home",
  git: (cwd) => ({ repo: cwd.replace("/home", ""), branch: "main" }),
  now: NOW,
  ...over,
});

test("registry: every session from ps and the hook's heartbeats, with its tree, ports, browsers, heavy jobs and rules", () => {
  const [agent, hero, side] = buildRegistry(input());
  expect(agent).toMatchObject({
    kind: "agent",
    registered: true,
    connected: false,
    heavy: [{ kind: "suite", cmd: "bun test" }],
    roots: [101],
  });
  // your session, connected through the hook: keyed by its session id, two browsers (renderers don't count), the dev server's port
  expect(hero).toMatchObject({
    key: "s-orch",
    kind: "you",
    label: "orchard",
    project: "orchard",
    cwd: "/home/code/orchard",
    repo: "/code/orchard",
    branch: "main",
    connected: true,
    registered: true,
    browsers: 2,
    ports: [5173],
    procs: 8,
    rulesAck: true,
    paused: "",
    roots: [201],
  });
  // a session you opened by hand in a project that isn't connected: listed, but Overhand may not act on it
  expect(side).toMatchObject({ key: "pid:300", connected: false, registered: false, browsers: 1, rulesAck: false });
  // a heartbeat for a session whose process is gone is left out; a stale rules version shows as not acknowledged
  const rows = buildRegistry(
    input({ beats: [beat({}), beat({ id: "gone", pid: 999 })], rulesVersion: "v2", holds: { "s-orch": { reason: "x" } } }),
  );
  expect(rows.map((r) => r.key)).toEqual(["pid:100", "s-orch", "pid:300"]);
  expect(rows[1]).toMatchObject({ rulesAck: false, paused: "x" });
});

test("the hook's heartbeat: where it works, what it edited, and a PR it opened in another project's repo", () => {
  const dir = scratch();
  const own = join(dir, "orchard");
  const other = join(dir, "honey");
  for (const r of [own, other]) {
    mkdirSync(join(r, ".git"), { recursive: true });
    writeFileSync(join(r, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
  }
  const call = (tool: string, inp: Record<string, unknown>) => ({ session: "s1", tool, input: inp, cwd: own, transcript: "/t/s1.jsonl" });
  let b = nextBeat(null, call("Edit", { file_path: "src/a.ts" }), { run: "", project: "orchard" }, () => process.pid, NOW);
  expect(b).toMatchObject({
    id: "s1",
    pid: process.pid,
    home: own,
    transcript: "/t/s1.jsonl",
    files: [{ path: join(own, "src/a.ts"), at: NOW }],
  });
  b = nextBeat(b, call("Bash", { command: "gh pr create --fill" }), { run: "", project: "orchard" }, () => 1, NOW + MIN);
  expect(b.prs).toEqual([]); // its own repo
  b = nextBeat(b, call("Bash", { command: `cd ${other} && gh pr create --fill` }), { run: "", project: "orchard" }, () => 1, NOW + 2 * MIN);
  expect(b.prs).toEqual([{ at: NOW + 2 * MIN, repo: "honey", dir: other, branch: "feat/x" }]);
  expect(b.pid).toBe(process.pid); // found once, kept while alive
  expect(b.files).toHaveLength(1);
});

// ---------- connecting a project ----------

test("connect and disconnect write and remove the hook idempotently, leaving your other settings as they were", () => {
  const repo = scratch();
  const file = settingsFile(repo);
  expect(file).toBe(join(repo, ".claude", "settings.local.json"));
  const cmd = "test -e '/x/run.ts' || exit 0; '/bun' '/x/run.ts' guard hand";
  // a file you had: a permission and another hook of yours
  const mine = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-lint" }] }] },
  };
  mkdirSync(join(repo, ".claude"));
  writeFileSync(file, JSON.stringify(mine));
  const preview = withHook(file, cmd, true);
  expect(preview.changed).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(JSON.stringify(mine)); // a preview writes nothing
  expect(applyHook(file, cmd, true).changed).toBe(true);
  expect(applyHook(file, cmd, true).changed).toBe(false); // twice: still one entry
  const on = JSON.parse(readFileSync(file, "utf8"));
  expect(on.permissions).toEqual(mine.permissions);
  expect(on.hooks.PreToolUse).toEqual([...mine.hooks.PreToolUse, { matcher: "*", hooks: [{ type: "command", command: cmd }] }]);
  // a moved install: the old entry is replaced, not doubled
  applyHook(file, cmd.replace("/x/", "/y/"), true);
  expect(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse).toHaveLength(2);
  expect(applyHook(file, cmd, false).changed).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(mine);
  expect(applyHook(file, cmd, false).changed).toBe(false);
  // a file that held only the hook goes away with it
  const fresh = settingsFile(scratch());
  applyHook(fresh, cmd, true);
  expect(existsSync(fresh)).toBe(true);
  applyHook(fresh, cmd, false);
  expect(existsSync(fresh)).toBe(false);
  // something that isn't a settings object is never overwritten
  const bad = settingsFile(scratch());
  mkdirSync(join(bad, ".."), { recursive: true });
  writeFileSync(bad, "[1]");
  expect(() => applyHook(bad, cmd, true)).toThrow(/isn't a JSON object/);
  expect(settingsFile("/home/me", true)).toBe("/home/me/.claude/settings.json");
});

// ---------- house rules ----------

test("house rules: hold windows (overnight too), quiet mode, Slack drafts only, and who's exempt", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 20, h, m).getTime();
  const windows: Config["control"]["windows"] = [
    { from: "00:00", to: "19:07", kinds: ["browser"] },
    { from: "22:00", to: "07:00", kinds: [] },
  ];
  expect(windowUntil(windows, "browser", at(16))).toBe(at(19, 7));
  expect(windowUntil(windows, "build", at(16))).toBe(0);
  expect(windowUntil(windows, "build", at(23))).toBe(at(7) + 24 * 60 * MIN); // past midnight
  expect(windowUntil(windows, null, at(3))).toBe(at(7));
  const ops = scratch();
  const c = { ...CFG.control, windows };
  const who = { ops, project: "orchard", session: "s1", now: at(16) };
  expect(ruleHold("browser", c, who)).toMatch(/house rules hold browser jobs until 19:07/);
  expect(ruleHold("suite", c, who)).toBeNull();
  setQuiet(ops, 1, at(16));
  expect(ruleHold("suite", c, who)).toMatch(/quiet mode is on until 17:00/);
  // "Always allow for this project" exempts it from quiet mode and hold windows
  const allowed = { ...c, approvals: [{ action: "allow-heavy-in-quiet" as const, project: "orchard", at: 0 }] };
  expect(ruleHold("suite", allowed, who)).toBeNull();
  expect(ruleHold("suite", allowed, { ...who, project: "honey" })).toMatch(/quiet mode/);
  expect(houseRule("mcp__claude_ai_Slack__slack_send_message", c)).toMatch(/Slack drafts only/);
  expect(houseRule("mcp__claude_ai_Slack__slack_send_message_draft", c)).toBeNull();
  expect(houseRule("mcp__claude_ai_Slack__slack_send_message", { ...c, slackDraftsOnly: false })).toBeNull();
});

test("a hand session: reports itself, gets the house rules once, is held by them, and receives requests", () => {
  const ops = scratch();
  const config = {
    owner: { name: "t", keychainAccount: "t" },
    accounts: [],
    clients: [],
    governor: { maxLoadPerCore: 1000, minBatteryPct: 0, thermal: false, pauseHeavyBelowGb: 0 },
    // all day: an end before or at the start wraps past midnight (to 23:59 left one minute a day open, and failed then)
    control: { windows: [{ from: "00:00", to: "00:00", kinds: ["browser"] }], notes: ["no PRs to other projects' repos"] },
  };
  writeFileSync(join(ops, "overhand.config.json"), JSON.stringify(config));
  const repo = scratch();
  const hook = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, OVERHAND_HOME: ops, ...extra };
    delete env.OVERHAND_RUN;
    delete env.OVERHAND_PROJECT;
    // an Overhand run is one it recorded (this test is the hook's ancestor), not one its environment names
    if (extra.OVERHAND_RUN) recordRun(ops, process.pid, { run: extra.OVERHAND_RUN, autonomy: "act", project: "" });
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard", "hand"], {
      env,
      stdin: Buffer.from(
        JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: repo, session_id: "hand-1", permission_mode: "default" }),
      ),
    });
    forgetRun(ops, process.pid);
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const ctx = (out: string): string => (out ? (JSON.parse(out).hookSpecificOutput.additionalContext ?? "") : "");
  // first call: the rules are handed over; it's now in the registry's heartbeats
  const first = hook("Read", { file_path: join(repo, "a.ts") });
  expect(first.code).toBe(0);
  expect(ctx(first.out)).toMatch(
    /House rules on this machine[\s\S]*no browser jobs from 00:00 to 00:00[\s\S]*no PRs to other projects' repos/,
  );
  expect(readdirSync(join(ops, "control", "sessions"))).toEqual(["hand-1.json"]);
  expect(hook("Read", { file_path: join(repo, "a.ts") })).toEqual({ code: 0, out: "", err: "" }); // only once
  // the house rules hold its browser lanes; a send in Slack is blocked; Overhand's agent-only rules don't apply
  const held = hook("Bash", { command: "bunx playwright test" });
  expect(held.code).toBe(2);
  expect(held.err).toMatch(/house rules hold browser jobs/);
  expect(hook("mcp__claude_ai_Slack__slack_send_message", {}).code).toBe(2);
  expect(hook("Bash", { command: "git push origin main" }).code).toBe(0);
  // nor may it change Overhand's config (the house rules) or its own hook
  expect(hook("Edit", { file_path: join(ops, "overhand.config.json") }).code).toBe(2);
  expect(hook("Edit", { file_path: join(repo, ".claude", "settings.local.json") }).code).toBe(2);
  // a heavy job it may run is wrapped in a slot naming the session, and you still approve it
  const build = JSON.parse(hook("Bash", { command: "bun run build" }).out).hookSpecificOutput;
  expect(build.permissionDecision).toBe("ask");
  expect(build.updatedInput.command).toMatch(/ heavy build --session hand-1 -- 'bun run build'$/);
  // a request for it arrives with its next call, once
  addRequest(ops, { from: "owner", to: "hand-1", toLabel: "orchard", text: "stop the browser lanes", by: 0 });
  expect(ctx(hook("Read", { file_path: join(repo, "a.ts") }).out)).toMatch(/Request \w+ from owner: stop the browser lanes[\s\S]*ack/);
  expect(hook("Read", { file_path: join(repo, "a.ts") }).out).toBe("");
  // a Overhand run in a connected project is left to its own guard
  expect(hook("mcp__claude_ai_Slack__slack_send_message", {}, { OVERHAND_RUN: "HC-1" })).toEqual({ code: 0, out: "", err: "" });
}, 30_000);

// ---------- action cards ----------

const rowsNow = (over: Partial<RegistryInput> = {}): Row[] => buildRegistry(input(over));
const ctxFor = (rows: Row[], over: Partial<CardContext> = {}): CardContext => ({
  rows,
  quietUntil: 0,
  load1: 25,
  loadPerCore: 2.5,
  maxLoadPerCore: 1.5,
  silentMin: 10,
  requests: [],
  approvals: [],
  snoozed: {},
  exempt: () => false,
  extended: () => false,
  now: NOW,
  ...over,
});

test("action cards: browsers in quiet mode, an unconnected session, competing jobs, a foreign PR, shared files, silence, overdue", () => {
  const quiet = detectCards(ctxFor(rowsNow(), { quietUntil: NOW + 3 * 60 * MIN }));
  const hero = quiet.find((c) => c.id === "quiet-heavy:s-orch");
  expect(hero).toMatchObject({ kind: "quiet-heavy", project: "orchard", buttons: ["stop", "allow-until", "always-allow"], targets: [201] });
  expect(hero?.facts).toMatchObject({ who: "orchard", browsers: 2, load: 25, until: "19:00" });
  expect(quiet.find((c) => c.id === "unmanaged-heavy:pid:300")?.buttons).toEqual(["connect", "keep"]);
  // the agent's suite: quiet-heavy too, unless its project is exempt
  expect(quiet.some((c) => c.id === "quiet-heavy:pid:100")).toBe(true);
  expect(
    detectCards(ctxFor(rowsNow(), { quietUntil: NOW + MIN, exempt: (r) => r.kind === "agent" })).some(
      (c) => c.id === "quiet-heavy:pid:100",
    ),
  ).toBe(false);
  // not quiet and not busy: no quiet or unmanaged cards
  expect(detectCards(ctxFor(rowsNow(), { loadPerCore: 0.5 })).filter((c) => /heavy/.test(c.kind))).toEqual([]);
  // three jobs at once (the suite, the browser lane, ...) competes; the oldest slot keeps going
  const extra = rowsNow({ beats: [beat({}), beat({ id: "s-other", pid: 300, project: "side" })] });
  const competing = detectCards(ctxFor(extra)).find((c) => c.kind === "competing");
  expect(competing).toMatchObject({ facts: { n: 3 }, targets: [201, 301] });
  // a PR in another project's repo
  const pr = rowsNow({ beats: [beat({ prs: [{ at: NOW, repo: "honey", dir: "/code/honey", branch: "fix/y" }] })] });
  expect(detectCards(ctxFor(pr)).find((c) => c.kind === "foreign-pr")).toMatchObject({
    facts: { who: "orchard", repo: "honey", branch: "fix/y" },
    buttons: ["close-pr", "keep"],
    pr: { repo: "honey", dir: "/code/honey", branch: "fix/y" },
  });
  // two sessions editing the same file on one branch: the later one is the one to pause
  const files = [{ path: "/code/orchard/src/a.ts", at: NOW - MIN }];
  const two = rowsNow({
    live: [
      { pid: 200, kind: "you", label: "", name: "", client: "Other", cwd: "/code/orchard", active: true },
      { pid: 300, kind: "you", label: "", name: "lane 2", client: "Other", cwd: "/code/orchard", active: true },
    ],
    beats: [beat({ files }), beat({ id: "s-two", pid: 300, startedAt: NOW - 10 * MIN, files })],
  });
  expect(detectCards(ctxFor(two)).find((c) => c.kind === "same-files")).toMatchObject({
    facts: { who: "lane 2", other: "orchard", files: 1, branch: "main", file: "a.ts" },
    buttons: ["pause", "show"],
    session: "s-two",
  });
  // a test that printed nothing for half the silence limit; not once it was given more time
  const silent = rowsNow({ locks: [lock({ kind: "suite", lastOut: NOW - 6 * MIN })] });
  expect(detectCards(ctxFor(silent)).find((c) => c.kind === "silent")).toMatchObject({
    facts: { min: 6 },
    buttons: ["stop", "more-time"],
    targets: [102],
  });
  expect(detectCards(ctxFor(silent, { extended: () => true })).some((c) => c.kind === "silent")).toBe(false);
  // an overdue request; a snoozed card is left out
  const req = {
    id: "r1",
    from: "owner",
    to: "s-orch",
    toLabel: "orchard",
    text: "stop",
    by: NOW - MIN,
    state: "sent" as const,
    at: 0,
    deliveredAt: 0,
    changedAt: 0,
    note: "",
  };
  expect(detectCards(ctxFor(rowsNow(), { requests: [req] })).find((c) => c.kind === "overdue")).toMatchObject({
    project: "orchard",
    request: "r1",
    buttons: ["resend", "drop"],
  });
  expect(detectCards(ctxFor(rowsNow(), { requests: [{ ...req, state: "done" }] })).some((c) => c.kind === "overdue")).toBe(false);
  expect(detectCards(ctxFor(rowsNow(), { requests: [req], snoozed: { "overdue:r1": NOW + MIN } })).some((c) => c.kind === "overdue")).toBe(
    false,
  );
});

// ---------- stopping ----------

test("stop: only the named process tree, never a whole session, an unregistered one, Overhand itself or a protected process", () => {
  const rows = rowsNow();
  const none = () => null;
  expect(planStop(201, TABLE, rows, none)).toEqual({ pids: [201, 202, 203, 204, 205] }); // the lane, not the dev server
  expect(planStop(210, TABLE, rows, none)).toEqual({ pids: [210, 211] });
  expect(planStop(200, TABLE, rows, none)).toEqual({ refuse: expect.stringMatching(/whole session/) });
  expect(planStop(301, TABLE, rows, none)).toEqual({
    refuse: expect.stringMatching(/isn't part of a session Overhand started or one you connected/),
  });
  expect(planStop(4317, TABLE, rows, none)).toEqual({ refuse: expect.stringMatching(/isn't part of a session/) });
  expect(planStop(201, TABLE, rows, none, 203)).toEqual({ refuse: "that would stop Overhand itself" });
  const vite = (pid: number) => (pid === 211 ? "process 211 listens on protected port 5173" : null);
  expect(planStop(210, TABLE, rows, vite)).toEqual({ refuse: "process 211 listens on protected port 5173" });
});

/** A button's world: kills and commands recorded, config saved in memory. */
function fakeEnv(ops: string, cfg = CFG): ActEnv & { killed: number[]; saved: Config[]; ran: string[][] } {
  const e = {
    ops,
    cfg,
    killed: [] as number[],
    saved: [] as Config[],
    ran: [] as string[][],
    save: (c: Config) => e.saved.push(c),
    table: () => TABLE,
    isProtected: () => null,
    kill: async (root: number) => e.killed.push(root),
    run: (cmd: string[]) => {
      e.ran.push(cmd);
      return { ok: true, out: "", err: "" };
    },
    now: NOW,
  };
  return e;
}

test("buttons: Stop takes down only the card's trees; Allow until, Always allow, Run one at a time, Pause, More time, Close", async () => {
  const ops = scratch();
  const rows = rowsNow();
  const [quiet] = detectCards(ctxFor(rows, { quietUntil: NOW + 3 * 60 * MIN })).filter((c) => c.id === "quiet-heavy:s-orch");
  if (!quiet) throw new Error("no card");
  const e = fakeEnv(ops);
  expect(await act(quiet, "stop", rows, e)).toMatchObject({ ok: true, result: "orchard: stopped 1 job(s) (pid 201)" });
  expect(e.killed).toEqual([201]);
  expect(await act(quiet, "close-pr", rows, e)).toMatchObject({ ok: false }); // not one of its buttons
  await act(quiet, "allow-until", rows, e);
  expect(JSON.parse(readFileSync(join(ops, "control", "allow.json"), "utf8"))).toEqual({ "session:s-orch": NOW + 3 * 60 * MIN });
  expect(ruleHold("browser", CFG.control, { ops, project: "orchard", session: "s-orch", now: NOW })).toBeNull();
  await act(quiet, "always-allow", rows, e);
  expect(e.saved.at(-1)?.control.approvals).toEqual([{ action: "allow-heavy-in-quiet", project: "orchard", at: NOW }]);
  // a card for an unregistered session's process is refused, whatever it lists
  const bad = { ...quiet, targets: [301] };
  expect(await act(bad, "stop", rows, e)).toMatchObject({ ok: false, result: expect.stringMatching(/isn't part of a session/) });
  expect(e.killed).toEqual([201]);
  const extra = rowsNow({ beats: [beat({}), beat({ id: "s-other", pid: 300 })] });
  const competing = detectCards(ctxFor(extra)).find((c) => c.kind === "competing");
  if (!competing) throw new Error("no card");
  await act(competing, "one-at-a-time", extra, e);
  expect(e.saved.at(-1)?.governor.slots).toEqual({ browser: 1, simulator: 1, suite: 1, build: 1, devserver: 1 });
  expect(e.killed).toEqual([201, 201, 301]);
  const pr = rowsNow({ beats: [beat({ prs: [{ at: NOW, repo: "acme/honey", dir: "/code/honey", branch: "fix/y" }] })] });
  const prCard = detectCards(ctxFor(pr)).find((c) => c.kind === "foreign-pr");
  if (!prCard) throw new Error("no card");
  expect((await act(prCard, "close-pr", pr, e)).ok).toBe(true);
  expect(e.ran.at(-1)?.slice(0, 6)).toEqual(["gh", "pr", "close", "fix/y", "--repo", "acme/honey"]);
  // the log keeps every one, with who pressed (you) or a standing approval (auto)
  const log = readFileSync(join(ops, "control", "actions.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(log.length).toBe(7);
});

test("standing approvals: a covered card is marked auto and acted on as reported, per project and class", async () => {
  const ops = scratch();
  const rows = rowsNow();
  const approvals: Config["control"]["approvals"] = [{ action: "stop-heavy-in-quiet", project: "orchard", at: 0 }];
  const cards = detectCards(ctxFor(rows, { quietUntil: NOW + MIN, approvals }));
  expect(cards.find((c) => c.id === "quiet-heavy:s-orch")?.auto).toBe(true);
  expect(cards.find((c) => c.id === "quiet-heavy:pid:100")?.auto).toBe(false); // another project
  expect(
    detectCards(
      ctxFor(rows, { quietUntil: NOW + MIN, approvals: [{ ...approvals[0], project: "*" } as (typeof approvals)[number]] }),
    ).every((c) => c.kind !== "quiet-heavy" || c.auto),
  ).toBe(true);
  const card = cards.find((c) => c.auto);
  if (!card) throw new Error("no card");
  const e = fakeEnv(ops);
  expect(await act(card, "stop", rows, e, true)).toMatchObject({ auto: true, ok: true });
  expect(e.killed).toEqual([201]);
  expect(readFileSync(join(ops, "control", "actions.jsonl"), "utf8")).toMatch(/"auto":true/);
});

// ---------- typed requests ----------

test("requests: sent, handed over at the next tool call, acknowledged, done; overdue ones become cards and can be resent or dropped", async () => {
  const ops = scratch();
  const r = addRequest(
    ops,
    { from: "lead-honey", to: "s-orch", toLabel: "orchard", text: "stop the browser lanes", by: NOW + 20 * MIN },
    NOW,
  );
  expect(r).toMatchObject({ state: "sent", deliveredAt: 0 });
  expect(dueFor(loadRequests(ops), "s-orch", NOW).map((x) => x.id)).toEqual([r.id]);
  expect(dueFor(loadRequests(ops), "someone-else", NOW)).toEqual([]);
  editRequests(ops, (rs) => rs.map((x) => ({ ...x, deliveredAt: NOW })));
  expect(dueFor(loadRequests(ops), "s-orch", NOW + MIN)).toEqual([]); // handed over
  expect(dueFor(loadRequests(ops), "s-orch", NOW + 11 * MIN)).toHaveLength(1); // not acknowledged: reminded
  expect(moveRequest(ops, r.id, "acknowledged", "", NOW + 2 * MIN)?.state).toBe("acknowledged");
  expect(dueFor(loadRequests(ops), "s-orch", NOW + 30 * MIN)).toEqual([]);
  // past its deadline and not done: an action card
  const late = NOW + 25 * MIN;
  const rows = rowsNow();
  const [card] = detectCards(ctxFor(rows, { requests: loadRequests(ops), now: late, loadPerCore: 0 })).filter((c) => c.kind === "overdue");
  if (!card) throw new Error("no card");
  expect(card.facts).toMatchObject({ who: "orchard", text: "stop the browser lanes", by: "16:20", state: "acknowledged" });
  const e = { ...fakeEnv(ops), now: late };
  await act(card, "resend", rows, e);
  expect(loadRequests(ops)[0]).toMatchObject({ state: "sent", deliveredAt: 0 });
  await act(card, "drop", rows, e);
  expect(loadRequests(ops)[0]?.state).toBe("dropped");
  expect(moveRequest(ops, "nope", "done")).toBeNull();
  const done = addRequest(ops, { from: "owner", to: "s-orch", toLabel: "orchard", text: "x", by: NOW - MIN }, NOW);
  moveRequest(ops, done.id, "done", "stopped all six", NOW);
  expect(detectCards(ctxFor(rows, { requests: loadRequests(ops) })).some((c) => c.kind === "overdue")).toBe(false);
});

test("a request's target: a connected session by id, pid, name or project; never an unconnected one", () => {
  const rows = rowsNow();
  const one = resolveTarget("orchard", rows);
  expect(typeof one === "string" ? one : one.id).toBe("s-orch");
  expect(typeof resolveTarget("200", rows) === "string").toBe(false);
  expect(resolveTarget("side", rows)).toMatch(/isn't connected.*overhand connect/);
  expect(resolveTarget("nobody", rows)).toMatch(/no connected session/);
  const two = rowsNow({ beats: [beat({}), beat({ id: "s-orch-2", pid: 300 })] });
  expect(resolveTarget("orchard", two)).toMatch(/matches 2 sessions/);
});

test("a lead's row goes by the lead's one name (your rename first), not its label or a second name", () => {
  const live = [
    { pid: 400, kind: "lead" as const, label: "Honey lead", name: "old chat name", client: "Honey", cwd: "~/code/honey", active: true },
  ];
  const [lead] = buildRegistry(input({ live, beats: [], leadName: (l) => (l === "Honey lead" ? "Night watch" : l) }));
  expect(lead?.label).toBe("Night watch");
  expect(buildRegistry(input({ live, beats: [] }))[0]?.label).toBe("Honey lead");
});

test("runs a stopped Overhand left running are found by pid and start time; leads and reused pids aren't", () => {
  const ops = scratch();
  const live = (pid: number) => pid < 300;
  recordRun(ops, 101, { run: "HONEY-1", autonomy: "act", project: "Honeycrust" }, live, NOW, "Mon 1");
  recordRun(ops, 102, { run: "lead-core", autonomy: "act", project: "Honeycrust" }, live, NOW, "Mon 2");
  recordRun(ops, 103, { run: "HONEY-2-fix", autonomy: "act", project: "Honeycrust" }, live, NOW, "Mon 3");
  // 103's pid now belongs to a process that started at another time: someone else's
  const started = (pid: number) => ({ 101: "Mon 1", 102: "Mon 2", 103: "Tue 9" })[pid] ?? "";
  expect(survivingRuns(ops, started)).toEqual([{ pid: 101, run: "HONEY-1", project: "Honeycrust" }]);
});

test("one daemon per state folder: a second sees the first while it lives, and takes over once it's gone", () => {
  const ops = scratch();
  const starts: Record<number, string> = { 1: "Mon 1", 2: "Mon 2" };
  const started = (pid: number) => starts[pid] ?? "";
  expect(claimHome(ops, 4317, 1, started)).toBeNull();
  expect(claimHome(ops, 4318, 2, started)).toEqual({ pid: 1, port: 4317 });
  expect(claimHome(ops, 4317, 1, started)).toBeNull(); // its own claim again, after a restart in place
  starts[1] = "Wed 5"; // gone: its pid went to another process
  expect(claimHome(ops, 4318, 2, started)).toBeNull();
  // another state folder is another Overhand's (a checkout's and a worktree's daemons side by side)
  expect(claimHome(scratch(), 4319, 3, started)).toBeNull();
});
