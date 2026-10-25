import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTRUCTIONS_FILE } from "../src/agent-home";
import { awakeFor, claude, failureOf, stopRun, testAccount } from "../src/claude";
import { parseConfig } from "../src/config";
import { applyConfig, CFG } from "../src/env";
import { processTable } from "../src/governor";
import { bench, benched, markSignedOut, signedOutAccounts } from "../src/limits";
import { currentRuns, loadState } from "../src/state";

// a fake Claude Code on PATH, ending each run the way the real one did in the failure audit (2026-10-25)
const bin = mkdtempSync(join(tmpdir(), "overhand-fake-claude-"));
const modeFile = join(bin, "mode");
const CHILD = "4317.25"; // seconds the fake CLI's child sleeps: its name in the process table
// the runs work in a folder shaped like the worktree Overhand makes for a task, as a ticket's run does
const wt = join(bin, "repo", ".claude", "worktrees", "audit");
mkdirSync(wt, { recursive: true });
const FAKE = `#!/usr/bin/env bun
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "auth" || argv[0] === "--version") { console.log('{"loggedIn":true}'); process.exit(0); }
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: "fake" });
if (mode === "auth")
  out({ type: "result", subtype: "success", is_error: true, total_cost_usd: 0,
    result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login' });
if (mode === "limit") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
  out({ type: "result", subtype: "success", is_error: true, total_cost_usd: 0.1, result: "You've hit your session limit · resets 7pm (Europe/Helsinki)" });
}
if (mode === "ratelimitword") {
  out({ type: "user", message: { content: [{ type: "tool_result", content: "FAIL rateLimit middleware: expected 429 Too Many Requests, rate limit exceeded" }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Tests failed: rateLimit middleware should return 429 Too Many Requests" }] } });
  out({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.3, result: "Stopped: the rate limit test still fails (expected 429)" });
}
if (mode === "ok") out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, result: "{}", structured_output: { ok: true } });
// a dev server the agent detached and left behind, or a run that hangs with a child of its own: told apart by how long
// they sleep (CHILD), as a pid seen inside the Linux sandbox's own pid namespace means nothing outside it
const cp = require("node:child_process");
if (mode === "orphan") {
  cp.spawn("sleep", [${JSON.stringify(CHILD)}], { stdio: "ignore", detached: true }).unref();
  out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, result: "{}", structured_output: { ok: true } });
}
if (mode === "hang") {
  cp.spawn("sleep", [${JSON.stringify(CHILD)}], { stdio: "ignore" });
  cp.execFileSync("sleep", ["300"]);
}
`;
const before = CFG;
const path = process.env.PATH;

beforeAll(() => {
  // a sandbox test earlier in the run (Linux) can leave the read-only stand-in bubblewrap mounts for a missing file:
  // these runs write the real instructions there first, as a daemon does before any run
  rmSync(INSTRUCTIONS_FILE, { force: true });
  writeFileSync(join(bin, "claude"), FAKE);
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = [bin, path].join(":");
  applyConfig(parseConfig({ owner: { name: "someone", keychainAccount: "someone" }, accounts: ["work"], clients: [] }));
});
afterAll(() => {
  process.env.PATH = path;
  applyConfig(before);
  markSignedOut("work", false);
  bench("work", 0); // a past reset: back for the tests after these
  rmSync(bin, { recursive: true, force: true });
});

/** One run of the fake CLI in `mode`, and whether it said its account hit a limit. */
async function run(mode: string) {
  writeFileSync(modeFile, mode);
  let limited = false;
  const r = await claude(loadState(), "p", wt, '{"type":"object"}', `audit-${mode}`, {
    onLimit: () => {
      limited = true;
    },
  });
  return { r, limited };
}

test("an expired sign-in marks the account signed out and passes it over, and isn't a failed run", async () => {
  const { r, limited } = await run("auth");
  expect(r).toBeNull(); // no capacity: the task waits instead of using up an attempt
  expect(limited).toBe(false);
  expect(Object.keys(signedOutAccounts())).toEqual(["work"]);
  expect(benched().work).toBeUndefined();
  // signed out, the account isn't tried at all; a test call that answers signs it back in
  writeFileSync(modeFile, "ok");
  expect(await claude(loadState(), "p", bin, '{"type":"object"}', "audit-skip")).toBeNull();
  expect((await testAccount("work")).ok).toBe(true);
  expect(signedOutAccounts()).toEqual({});
});

test("a project's own test printing 429 or rate limit benches nothing: the run is an ordinary failure", async () => {
  const { r, limited } = await run("ratelimitword");
  expect(limited).toBe(false);
  expect(r?.out).toMatchObject({ status: "failed" });
  expect(benched().work).toBeUndefined();
});

test("a real limit, from the CLI's own result and rate_limit_event, benches the account until the reset it names", async () => {
  const { r, limited } = await run("limit");
  expect(r).toBeNull();
  expect(limited).toBe(true);
  expect(benched().work).toBeGreaterThan(Date.now());
});

const failed = (over: { text?: string; stderr?: string; code?: number; timedOut?: boolean }) => ({
  out: { ok: false, text: over.text ?? "", structured: undefined, cost: 0, usage: null },
  stderr: over.stderr ?? "",
  code: over.code ?? 0,
  timedOut: over.timedOut ?? false,
});

test("a run with no answer says why: timed out, signed out, crashed, or output Overhand can't read", () => {
  expect(failureOf(failed({ timedOut: true, code: 143 }))).toBe("timeout");
  expect(failureOf(failed({ text: "OAuth token has expired. Please run /login", code: 1 }))).toBe("signed-out");
  expect(failureOf(failed({ stderr: "TypeError: x is undefined", code: 1 }))).toBe("crashed");
  // exit 0 and no result Overhand recognises: the CLI changed how it reports
  expect(failureOf(failed({ text: '{"type":"brand-new-event"}' }))).toBe("unreadable");
  expect(failureOf({ ...failed({ code: 143 }), stopped: true })).toBe("stopped");
});

/** Whether the fake CLI's child (`sleep CHILD`) is still running a moment after its run. */
async function childLives(): Promise<boolean> {
  await Bun.sleep(300);
  return processTable().some((p) => p.cmd.trim() === `sleep ${CHILD}`);
}

test("nothing a run started outlives it: a child it detached and left running ends with the run", async () => {
  bench("work", 0); // the limit test above benched it
  const { r } = await run("orphan");
  expect(r?.failure).toBeUndefined();
  expect(await childLives()).toBe(false);
});

test("a run past its time limit stops with its children and says it timed out", async () => {
  bench("work", 0);
  const limit = CFG.limits.taskTimeoutMin;
  CFG.limits.taskTimeoutMin = 0.02; // 1.2 s
  try {
    const { r } = await run("hang");
    expect(r?.failure).toBe("timeout");
    expect(await childLives()).toBe(false);
  } finally {
    CFG.limits.taskTimeoutMin = limit;
  }
});

test("Stop ends a running agent and everything it started, and reads as stopped, not as a crash", async () => {
  bench("work", 0);
  const going = run("hang");
  while (!currentRuns().some((x) => x.name === "audit-hang")) await Bun.sleep(50);
  expect(await stopRun("audit-hang")).toBe(true);
  const { r } = await going;
  expect(r?.failure).toBe("stopped");
  expect(await childLives()).toBe(false);
  expect(await stopRun("audit-hang")).toBe(false); // already over
});

test("the time limit counts the time a run was awake: a laptop asleep past it isn't a timeout on wake", () => {
  expect(awakeFor(15_000, 15_000)).toBe(15_000);
  expect(awakeFor(40_000, 15_000)).toBe(40_000); // a slow tick still counts
  expect(awakeFor(3 * 3_600_000, 15_000)).toBe(15_000); // three hours asleep count as one tick
});
