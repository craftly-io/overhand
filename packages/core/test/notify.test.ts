import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blankConfig, parseConfig, saveConfig } from "../src/config";
import { OPS, today } from "../src/env";
import { report, reportDaily } from "../src/notify";
import { writeJsonAtomic } from "../src/state";

const mode = (p: string) => statSync(p).mode & 0o777;

/** `claude auth status --json` as a claude.ai subscription answers it: the evidence an account is a plan. */
const PLAN_STATUS = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" });

/** Runs `fn` with the sign-in probes swapped for `probes`, then puts the real ones back and forgets their answers. */
async function withProbes(
  probes: Partial<{ key: (i: string) => boolean; claude: (h: string) => string; codex: (h: string) => string }>,
  fn: () => Promise<void>,
) {
  const { billingProbes, forgetBilling } = await import("../src/billing");
  const real = { ...billingProbes };
  Object.assign(billingProbes, probes);
  forgetBilling();
  try {
    await fn();
  } finally {
    Object.assign(billingProbes, real);
    forgetBilling();
  }
}

test("the same line within 30 minutes goes into the day's report once", () => {
  const file = join(OPS, "reports", `${today()}.md`);
  const line = `↻ restarting test ${Math.random()}`;
  const t = Date.now();
  report(line, t);
  report(line, t + 60_000);
  report(line, t + 29 * 60_000);
  expect(readFileSync(file, "utf8").split(line).length - 1).toBe(1);
  report(line, t + 31 * 60_000);
  expect(readFileSync(file, "utf8").split(line).length - 1).toBe(2);
});

test("a warning, and a notice said at every start, go into the day's report once a day, even after a restart", () => {
  const file = join(OPS, "reports", `${today()}.md`);
  const count = (line: string) => readFileSync(file, "utf8").split(`${line}\n`).length - 1;
  const warning = `⚠ loop error: test ${Math.random()}`;
  const t = Date.now();
  report(warning, t);
  report(warning, t + 31 * 60_000);
  report(warning, t + 5 * 3_600_000);
  expect(count(warning)).toBe(1);
  // a line that only ends like it is another line
  report(`⚠ again: ${warning}`, t);
  expect(count(warning)).toBe(2);
  const notice = `🔐 Sign in once for test ${Math.random()}`;
  expect(reportDaily(notice, t)).toBe(true);
  expect(reportDaily(notice, t + 3_600_000)).toBe(false); // the map has forgotten it by then; the day's file hasn't
  expect(count(notice)).toBe(1);
});

test("Overhand's folder is private to this user, and so are the files it writes", () => {
  expect(mode(OPS)).toBe(0o700);
  report(`perm check ${Math.random()}`);
  expect(mode(join(OPS, "reports", `${today()}.md`))).toBe(0o600);
  const json = join(OPS, "perm-check.json");
  writeJsonAtomic(json, { a: 1 });
  expect(mode(json)).toBe(0o600);
  rmSync(json);
  const dir = join(OPS, "perm-config");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  saveConfig(dir, blankConfig("someone"));
  expect(mode(join(dir, "overhand.config.json"))).toBe(0o600);
  rmSync(dir, { recursive: true });
});

test("the daily budget counts only billed money: it stops billed accounts and never a plan account", () =>
  withProbes({ claude: () => PLAN_STATUS }, async () => {
    const { applyConfig, CFG } = await import("../src/env");
    const { budgetUntil, spendOnDay } = await import("../src/billing");
    const { enforceBudget } = await import("../src/notify");
    const { claude } = await import("../src/claude");
    const { leadFreeAt } = await import("../src/leads");
    const { loadState } = await import("../src/state");
    const before = CFG;
    const pause = join(OPS, "PAUSE");
    const runs = join(OPS, "runs", `${today()}.jsonl`);
    const day = join(OPS, "reports", `${today()}.md`);
    mkdirSync(join(OPS, "runs"), { recursive: true });
    rmSync(pause, { force: true });
    rmSync(runs, { force: true });
    try {
      const cfg = parseConfig({
        owner: { name: "someone", keychainAccount: "someone" },
        accounts: ["sam", "aws"],
        providers: { aws: { kind: "bedrock", region: "eu-west-1" } },
        clients: [],
        godmode: [{ key: "g", label: "G", dir: "g", account: "aws", fallbackToAll: false }],
        limits: { dailyBudgetUsd: 5 },
      });
      applyConfig(cfg);
      // a plan account's runs cost $50 at API prices: nobody is billed it, so nothing stops
      writeFileSync(runs, `${JSON.stringify({ name: "HONEY-1", account: "sam", cost: 50 })}\n`);
      expect(spendOnDay()).toEqual({ billed: 0, apiPrice: 50 });
      expect(budgetUntil("aws")).toBe(0);
      expect(budgetUntil("sam")).toBe(0);
      // the cloud account is billed $5.50: it waits until midnight, the plan account carries on
      appendFileSync(runs, `${JSON.stringify({ name: "HONEY-2", account: "aws", cost: 5.5 })}\n`);
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      expect(budgetUntil("aws")).toBe(midnight.getTime());
      expect(budgetUntil("sam")).toBe(0);
      const lead = cfg.godmode[0];
      expect(lead && leadFreeAt(lead).aws).toBe(midnight.getTime());
      // no pause: the budget holds the billed accounts only, and says so once
      enforceBudget();
      expect(existsSync(pause)).toBe(false);
      expect(readFileSync(day, "utf8")).toContain("Daily budget of $5 reached. Pay-per-use and cloud agents wait until tomorrow");
      // a run that may only use the benched account doesn't start
      applyConfig({ ...cfg, accounts: ["aws"] });
      expect(await claude(loadState(), "p", OPS, "{}", "HONEY-3")).toBeNull();
      // no cap, no hold
      applyConfig({ ...cfg, limits: { ...cfg.limits, dailyBudgetUsd: 0 } });
      expect(budgetUntil("aws")).toBe(0);
    } finally {
      applyConfig(before);
      rmSync(pause, { force: true });
      rmSync(runs, { force: true });
    }
  }));

test("a run keeps the billing it was written with: removing or re-typing its account never changes what it was billed", () =>
  withProbes({ claude: () => PLAN_STATUS }, async () => {
    const { applyConfig, CFG } = await import("../src/env");
    const { spendOnDay } = await import("../src/billing");
    const { identityOf, loadHistory } = await import("../src/history");
    const { recordedBilling } = await import("../src/billing");
    const before = CFG;
    const runs = join(OPS, "runs", `${today()}.jsonl`);
    mkdirSync(join(OPS, "runs"), { recursive: true });
    rmSync(runs, { force: true });
    try {
      applyConfig(
        parseConfig({
          owner: { name: "someone", keychainAccount: "someone" },
          accounts: ["sam", "aws"],
          providers: { aws: { kind: "bedrock", region: "eu-west-1" } },
          clients: [],
        }),
      );
      // the line as the run log writes it: the account's identity, and its billing type when that's known
      const line = (name: string, account: string, cost: number) =>
        JSON.stringify({ name, account, cost, ok: true, ...identityOf(account), billing: recordedBilling(account) });
      writeFileSync(runs, `${line("HONEY-1", "aws", 4)}\n${line("HONEY-2", "sam", 6)}\n`);
      // a line from before billing was recorded follows the account's type now
      appendFileSync(runs, `${JSON.stringify({ name: "HONEY-3", account: "aws", cost: 1, ok: true })}\n`);
      expect(spendOnDay()).toEqual({ billed: 5, apiPrice: 11 });
      // aws removed and sam moved to an API key: what was billed stays as it was; only the unrecorded line follows
      applyConfig(
        parseConfig({
          owner: { name: "someone", keychainAccount: "someone" },
          accounts: ["sam"],
          providers: { sam: { kind: "claude", auth: "key" } },
          clients: [],
        }),
      );
      expect(spendOnDay()).toEqual({ billed: 4, apiPrice: 11 });
      const h = loadHistory(OPS, 0, identityOf, () => "");
      expect(h.map((r) => [r.key || r.account, r.billing])).toEqual([
        ["HONEY-1", "cloud"],
        ["HONEY-2", "plan"],
        ["HONEY-3", "plan"],
      ]);
    } finally {
      applyConfig(before);
      rmSync(runs, { force: true });
    }
  }));

test("an account whose billing isn't known counts as billed for the budget; a stored key or a named plan makes it known", () =>
  withProbes(
    { key: (item) => item === "codex-key-ck", claude: (home) => (home.endsWith("/accounts/team") ? PLAN_STATUS : "{}") },
    async () => {
      const { applyConfig, CFG } = await import("../src/env");
      const { accountBilling, budgetSpend, budgetUntil, recordedBilling, spendOnDay } = await import("../src/billing");
      const before = CFG;
      const runs = join(OPS, "runs", `${today()}.jsonl`);
      mkdirSync(join(OPS, "runs"), { recursive: true });
      rmSync(runs, { force: true });
      try {
        const cfg = parseConfig({
          owner: { name: "someone", keychainAccount: "someone" },
          // ck: Codex on an API key stored before billing existed, no `billing` entry; cx: Codex's own sign-in, unread;
          // team: a Claude Code sign-in whose status names a subscription; console: one whose status names none
          accounts: ["ck", "cx", "team", "console"],
          runtimes: { ck: { kind: "codex" }, cx: { kind: "codex" } },
          clients: [],
          limits: { dailyBudgetUsd: 5 },
        });
        applyConfig(cfg);
        expect(accountBilling("ck")).toEqual({ billing: "pay-per-use", sure: true, from: "key" });
        expect(accountBilling("team")).toEqual({ billing: "plan", sure: true, from: "sign-in" });
        // not known: the guess stays for labels, but it isn't recorded on runs and it counts toward the budget
        expect(accountBilling("console")).toMatchObject({ billing: "plan", sure: false });
        expect(accountBilling("cx")).toMatchObject({ billing: "plan", sure: false });
        expect(recordedBilling("console")).toBeUndefined();
        writeFileSync(
          runs,
          [
            JSON.stringify({ name: "A-1", account: "ck", cost: 2 }),
            JSON.stringify({ name: "A-2", account: "console", cost: 3 }),
            JSON.stringify({ name: "A-3", account: "team", cost: 40 }),
          ].join("\n"),
        );
        expect(spendOnDay().billed).toBe(2); // the header's billed: the key only
        expect(budgetSpend()).toBe(5); // the budget's count: the key and the account not known yet, never the plan
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        expect(budgetUntil("ck")).toBe(midnight.getTime()); // the keyed Codex account is capped
        expect(budgetUntil("console")).toBe(midnight.getTime());
        expect(budgetUntil("cx")).toBe(midnight.getTime());
        expect(budgetUntil("team")).toBe(0); // a known plan is never held
        // once the person says, it's known
        applyConfig({ ...cfg, billing: { console: "plan" } });
        expect(budgetSpend()).toBe(2);
        expect(budgetUntil("console")).toBe(0);
      } finally {
        applyConfig(before);
        rmSync(runs, { force: true });
      }
    },
  ));

test("claude auth status is evidence of a plan only when it names a subscription", async () => {
  const { claudePlan } = await import("../src/billing");
  expect(claudePlan(PLAN_STATUS)).toBe(true);
  expect(claudePlan(JSON.stringify({ loggedIn: true, authMethod: "console", apiProvider: "firstParty" }))).toBe(false);
  expect(claudePlan(JSON.stringify({ loggedIn: false, subscriptionType: "max" }))).toBe(false);
  expect(claudePlan("")).toBe(false);
});

test("a fresh install's first day lasts until a run log from an earlier day exists", async () => {
  const { firstDay } = await import("../src/dashboard");
  const dir = join(OPS, "first-day-check");
  rmSync(dir, { recursive: true, force: true });
  expect(firstDay(dir, "2026-10-19")).toBe(true);
  mkdirSync(dir);
  writeFileSync(join(dir, "2026-10-19.jsonl"), "");
  writeFileSync(join(dir, "outcomes.jsonl"), "");
  expect(firstDay(dir, "2026-10-19")).toBe(true);
  writeFileSync(join(dir, "2026-10-18.jsonl"), "");
  expect(firstDay(dir, "2026-10-19")).toBe(false);
  rmSync(dir, { recursive: true });
});

test("a lead held by today's cap says so; one held by a usage limit says that", async () => {
  const { leadHeldWhy } = await import("../src/leads");
  const { plainWords } = await import("@overhand/themes");
  const midnight = 2_000;
  // both accounts are held until midnight by the cap, which is what frees them last
  expect(leadHeldWhy({ aws: midnight, key: midnight }, () => midnight)).toBe(plainWords.leadWaitingCap);
  // one is at its 5-hour limit past midnight: a usage limit holds it, not the cap
  expect(leadHeldWhy({ aws: midnight, sam: 3_000 }, (a) => (a === "aws" ? midnight : 0))).toBe(plainWords.leadHeldLimit);
  expect(leadHeldWhy({ sam: 3_000 }, () => 0)).toBe(plainWords.leadHeldLimit);
});

test("the budget's notice says plans carry on, unless an account is held because its billing isn't known yet", () =>
  withProbes({ claude: () => "{}" }, async () => {
    const { applyConfig, CFG } = await import("../src/env");
    const { enforceBudget } = await import("../src/notify");
    const { plainWords } = await import("@overhand/themes");
    const before = CFG;
    const runs = join(OPS, "runs", `${today()}.jsonl`);
    const day = join(OPS, "reports", `${today()}.md`);
    mkdirSync(join(OPS, "runs"), { recursive: true });
    rmSync(runs, { force: true });
    try {
      // "sam" is a Claude Code sign-in whose status names no subscription: not known, so it's held
      applyConfig(
        parseConfig({ owner: { name: "x", keychainAccount: "x" }, accounts: ["sam"], clients: [], limits: { dailyBudgetUsd: 3 } }),
      );
      writeFileSync(runs, `${JSON.stringify({ name: "A-1", account: "sam", cost: 4 })}\n`);
      enforceBudget();
      const said =
        readFileSync(day, "utf8")
          .split("\n")
          .findLast((l) => l.includes("Daily budget of $3 reached")) ?? "";
      expect(said).toContain(plainWords.budgetUnknown);
      expect(said).not.toContain(plainWords.alBudgetPlans);
    } finally {
      applyConfig(before);
      rmSync(runs, { force: true });
    }
  }));
