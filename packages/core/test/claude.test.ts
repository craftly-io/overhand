import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude, testAccount } from "../src/claude";
import { parseConfig } from "../src/config";
import { applyConfig, CFG } from "../src/env";
import { bench, benched, markSignedOut, signedOutAccounts } from "../src/limits";
import { loadState } from "../src/state";

// a fake Claude Code on PATH, ending each run the way the real one did in the failure audit (2026-10-25)
const bin = mkdtempSync(join(tmpdir(), "overhand-fake-claude-"));
const modeFile = join(bin, "mode");
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
`;
const before = CFG;
const path = process.env.PATH;

beforeAll(() => {
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
  const r = await claude(loadState(), "p", bin, '{"type":"object"}', `audit-${mode}`, {
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
