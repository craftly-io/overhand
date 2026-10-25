import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CFG, MIN, OPS, today } from "../src/env";
import { blankLead, type Godmode, leadAccount, limitBack, recordLeadExit } from "../src/leads";
import { backAt, bench, benched, benchedUntil, markSignedOut, outOfUsage, resetAt, signedOut, signedOutAccounts } from "../src/limits";

const lead = (key: string, account = "acct"): Godmode => ({
  key,
  label: `Lead ${key}`,
  name: "",
  dir: key,
  project: "Acme",
  goal: "",
  prompt: "",
  supervised: false,
  onDemand: false,
  account,
  fallbackToAll: false,
  lockFile: "",
  lockStaleMin: 45,
  inboxFile: "",
  restartAfterMin: 5,
  maxCrashesPerHour: 3,
  answerWaitHours: 4,
  pushBranches: [],
});

// the CLIs' own words, as they ended real runs
const CURSOR = "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.";
const SESSION = "You've hit your session limit · resets 3am (Europe/Helsinki)";
const WEEKLY = "You've hit your weekly limit · resets Oct 27 at 4am";

/** Books a finished run of `g` whose log ends with `tail`, exiting 1 on `account`. */
function exit(g: Godmode, tail: string, st = blankLead(), account = "acct") {
  const dir = join(OPS, "logs", "limit-test");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${Date.now()}-${Math.random()}.log`);
  writeFileSync(log, `working…\n${tail}\n`);
  Object.assign(st, { account, log, startedAt: Date.now() - 1000 });
  recordLeadExit(g, st, null, 1, "1");
  return st;
}

test("each CLI's limit wording is a limit; other failures aren't", () => {
  // a fixed clock: some messages carry their own reset time, which a real clock would one day pass
  const now = Date.UTC(2026, 9, 23, 23, 0);
  const cooldown = now + CFG.limits.cooldownMin * MIN;
  expect(outOfUsage(CURSOR, null, now)).toBe(cooldown); // no reset time given: the cooldown
  expect(outOfUsage(SESSION, null, now)).toBeGreaterThan(now);
  expect(outOfUsage(WEEKLY, null, now)).toBeGreaterThan(now);
  for (const said of [
    "Claude AI usage limit reached|1792803600",
    "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 3:45 PM.",
    "stream error: exceeded retry limit, last status: 429 Too Many Requests",
    "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'",
    "[API Error: RESOURCE_EXHAUSTED]",
    "AI_APICallError: Rate limit exceeded",
    "litellm.RateLimitError: insufficient_quota",
  ])
    expect(outOfUsage(said, null, now)).toBeGreaterThan(now);
  expect(outOfUsage("TypeError: cannot read properties of undefined", null, now)).toBe(0);
  expect(outOfUsage("fixed issue #4290 in 12 files", null, now)).toBe(0);
  // a project's own rate limiting, as an agent's last words about its failing tests: not the CLI's limit
  for (const said of [
    "Stopped: the rate limit test still fails (expected 429)",
    "rateLimit middleware should return 429 Too Many Requests",
    "The quota check in billing.ts is wrong; the API is overloaded with calls",
  ])
    expect(outOfUsage(said, null, now)).toBe(0);
  // Claude Code's rate_limit_event saying rejected is a limit whatever the text
  const rejected = { fiveHour: -1, fiveHourResetsAt: 0, sevenDay: -1, sevenDayResetsAt: 0, status: "rejected", at: now };
  expect(outOfUsage("", rejected, now)).toBe(cooldown);
});

test("each CLI's expired sign-in is a sign-in to renew, kept across restarts until it's signed in again", () => {
  for (const said of [
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}} · Please run /login',
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Your access token could not be refreshed. Please log out and sign in again.",
    "Authentication required. Please run 'cursor-agent login' first",
    "API key not valid. Please pass a valid API key.",
    "invalid x-api-key",
  ])
    expect(signedOut(said)).toBe(true);
  expect(signedOut("Stopped: the login test still fails (expected 401)")).toBe(false);
  expect(signedOut("You've hit your session limit · resets 3am")).toBe(false);
  markSignedOut("acct", true);
  expect(signedOutAccounts().acct).toBeGreaterThan(0);
  markSignedOut("acct", false);
  expect(signedOutAccounts().acct).toBeUndefined();
});

test("the reset a message gives is when the account is back, in its time zone", () => {
  // 02:00 in Helsinki (EEST, UTC+3) on Oct 24
  const now = Date.UTC(2026, 9, 23, 23, 0);
  expect(resetAt(SESSION, now)).toBe(Date.UTC(2026, 9, 24, 0, 0)); // 03:00 the same night
  // past 3am already: the next 3am
  expect(resetAt(SESSION, Date.UTC(2026, 9, 24, 1, 0))).toBe(Date.UTC(2026, 9, 25, 1, 0)); // Oct 25 03:00 EET (UTC+2)
  // across the DST change: Oct 27 04:00 is EET, UTC+2
  expect(resetAt("You've hit your weekly limit · resets Oct 27 at 4am (Europe/Helsinki)", now)).toBe(Date.UTC(2026, 9, 27, 2, 0));
  expect(resetAt("resets 5:30pm (America/New_York)", now)).toBe(Date.UTC(2026, 9, 24, 21, 30));
  // no zone: this computer's
  expect(resetAt(WEEKLY, now)).toBe(new Date(2026, 9, 27, 4, 0).getTime());
  // a date already gone this year is next year's
  expect(resetAt("resets Jan 2 at 4am (UTC)", now)).toBe(Date.UTC(2027, 0, 2, 4, 0));
  expect(resetAt("try again at Oct 27th, 2026 4:00 AM (UTC)", now)).toBe(Date.UTC(2026, 9, 27, 4, 0));
  expect(resetAt("Claude AI usage limit reached|1792803600", now)).toBe(1792803600000);
  // an unknown zone reads as this computer's; no time at all is no reset
  expect(resetAt("resets 3am (Mars/Olympus)", now)).toBeGreaterThan(now);
  expect(resetAt(CURSOR, now)).toBe(0);
  expect(resetAt("resets in a while", now)).toBe(0);
});

test("a usage-limit exit benches the account for every lead, says when it's back, and never counts as a crash", () => {
  const one = lead("limit-one", "acme-max");
  const two = lead("limit-two", "acme-max");
  expect(leadAccount(two)).toBe("acme-max");
  let st = blankLead();
  for (let i = 0; i < 3; i++) st = exit(one, CURSOR, st, "acme-max");
  expect(st.crashes).toHaveLength(0);
  expect(st.stopped).toBe(false);
  const until = benchedUntil("acme-max");
  expect(until).toBeGreaterThan(Date.now());
  // the other lead on the same account waits too, and says which account is back first
  expect(leadAccount(two)).toBe("");
  expect(limitBack({ "acme-max": until })).toEqual({ limitAccount: "acme-max", limitBack: until });
  expect(readLog()).toContain(`⏸ Lead limit-one hit the usage limit on acme-max (back at ${backAt(until)})`);
  bench("acme-max", 0);
  expect(leadAccount(two)).toBe("acme-max");
});

test("a lead whose sign-in expired waits for it without a crash; a 429 in its own work is an ordinary crash", () => {
  const g = lead("signed-out", "acme-auth");
  const st = exit(g, "Failed to authenticate. API Error: 401 · Please run /login", blankLead(), "acme-auth");
  expect(st.crashes).toHaveLength(0);
  expect(benchedUntil("acme-auth")).toBe(0);
  expect(leadAccount(g)).toBe(""); // passed over until it's signed in again
  markSignedOut("acme-auth", false);
  expect(leadAccount(g)).toBe("acme-auth");
  const tests = exit(g, "Stopped: the rate limit test still fails (expected 429)", blankLead(), "acme-auth");
  expect(tests.crashes).toHaveLength(1);
  expect(benchedUntil("acme-auth")).toBe(0);
});

test("a Claude limit's reset time is the bench", () => {
  exit(lead("limit-three", "acme-pro"), SESSION, blankLead(), "acme-pro");
  expect(benchedUntil("acme-pro")).toBe(resetAt(SESSION));
  bench("acme-pro", 0);
});

test("the bench survives a restart and clears itself at the reset", () => {
  bench("acme-team", Date.now() + 60 * MIN);
  bench("acme-gone", Date.now() - 1);
  // a fresh process (a restarted daemon) reads the same bench
  const script = `console.log(JSON.stringify((await import("${join(import.meta.dir, "../src/limits")}")).benched()))`;
  const fresh = Bun.spawnSync(["bun", "-e", script], { env: process.env });
  const after = JSON.parse(fresh.stdout.toString()) as Record<string, number>;
  expect(after["acme-team"]).toBe(benchedUntil("acme-team"));
  expect(after["acme-gone"]).toBeUndefined();
  expect(benched(OPS, benchedUntil("acme-team") + 1)["acme-team"]).toBeUndefined();
  bench("acme-team", 0);
});

test("a real failure still counts, and three in an hour stop the lead", () => {
  let st = blankLead();
  for (let i = 0; i < 3; i++) st = exit(lead("limit-four", "acme-dev"), "TypeError: cannot read properties of undefined", st, "acme-dev");
  expect(st.crashes).toHaveLength(3);
  expect(st.stopped).toBe(true);
  expect(benchedUntil("acme-dev")).toBe(0);
});

test("limitBack names the account back first only when every one is benched", () => {
  const now = 1_000_000;
  expect(limitBack({ a: now + 5000, b: now + 2000 }, now)).toEqual({ limitAccount: "b", limitBack: now + 2000 });
  expect(limitBack({ a: now + 5000, b: now - 1 }, now)).toEqual({});
  expect(limitBack({}, now)).toEqual({});
  // an account waiting for its sign-in has no time it's back: never named as back first, never "back at Infinity"
  expect(limitBack({ a: Number.POSITIVE_INFINITY, b: now + 2000 }, now)).toEqual({ limitAccount: "b", limitBack: now + 2000 });
  expect(limitBack({ a: Number.POSITIVE_INFINITY }, now)).toEqual({});
});

/** Today's report lines so far (what the daemon log shows). */
const readLog = (): string => readFileSync(join(OPS, "reports", `${today()}.md`), "utf8");
