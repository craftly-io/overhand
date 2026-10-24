import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CLEANUP_CATEGORIES, type CleanupItem, LEAD_TEMPLATES, LEAD_WORK, WAY_OF_WORKING } from "@overhand/contract";
import {
  autoDue,
  committedState,
  diskGuard,
  dockerBytes,
  dropVoiceModel,
  freeGb,
  inUse,
  newest,
  olderVersions,
  oldRuntimes,
  personalRepo,
  planCleanup,
  pool,
  refusePath,
  remoteKey,
  runAsync,
  runCleanup,
  type Scope,
  scan,
  scanRunCaches,
} from "../src/cleanup";
import { RUN_CACHES, runCacheKey, SOURCES, sourcesTable } from "../src/cleanup-sources";
import { blankConfig, type Client, type Config, loadConfig, saveConfig } from "../src/config";
import { OPS, SRC } from "../src/env";
import {
  accountsFor,
  adfToText,
  armAll,
  comment,
  createTicket,
  demandBrief,
  editPlan,
  eventsToday,
  leadAccount,
  leadDir,
  leadInbox,
  leadPrompt,
  loadLocalCode,
  lockHolder,
  needsSignIn,
  parseNewTickets,
  parsePlan,
  planFile,
  prChanges,
  readableLog,
  recordLeadExit,
  restartDelayMin,
  setLabels,
  tickets,
  upsertPlanItem,
} from "../src/index";
import { subscriptionTokensAllowed } from "../src/legacy-token";
import { gitEnv } from "../src/runtimes/runtime";
import { spendOn } from "../src/usage";

test("eventsToday expands recurring meetings and honours exceptions", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:a",
    "SUMMARY:Standup",
    "DTSTART;TZID=Europe/Helsinki:20260105T093000",
    "DTEND;TZID=Europe/Helsinki:20260105T094500",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:b",
    "SUMMARY:Skipped weekly",
    "DTSTART:20260104T120000Z",
    "DTEND:20260104T130000Z",
    "RRULE:FREQ=WEEKLY",
    "EXDATE:20261018T120000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:c",
    "SUMMARY:Ended series",
    "DTSTART:20260101T080000Z",
    "DTEND:20260101T090000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:d",
    "SUMMARY:Client call\\, Fernway",
    "DTSTART:20261019T130000Z",
    "DTEND:20261019T140000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:e",
    "SUMMARY:Cancelled",
    "STATUS:CANCELLED",
    "DTSTART:20261019T150000Z",
    "DTEND:20261019T160000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const monday = eventsToday(ics, new Date(2026, 9, 19));
  expect(monday.map((e) => e.title)).toEqual(["Standup", "Client call, Fernway"]);
  expect(new Date(monday[0]?.start ?? 0).toISOString()).toBe("2026-10-19T06:30:00.000Z"); // 09:30 Helsinki (EEST)
  const sunday = eventsToday(ics, new Date(2026, 9, 18));
  expect(sunday.map((e) => e.title)).toEqual([]); // weekly "b" falls on Sunday but is excluded; standup is weekdays only
});

test("needsSignIn names the Slack servers a run couldn't use", () => {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    mcp_servers: [
      { name: "slack_hero24", status: "connected" },
      { name: "slack_dized", status: "needs-auth" },
    ],
  });
  expect(needsSignIn([init, '{"type":"result"}'].join("\n"))).toEqual(["slack_dized"]);
  expect(needsSignIn("not json")).toEqual([]);
});

test("parseNewTickets returns only checked Slack work items", () => {
  const md = ["## Inbox 10:30", "- [x] new-a1b2c3 Fernway: Fix receipt email", "- [ ] new-zzzzzz Bluekite: vetoed", "- ↩ Pat: reply"].join(
    "\n",
  );
  expect(parseNewTickets(md)).toEqual(["new-a1b2c3"]);
});

test("parsePlan returns only checked items under Agent headings", () => {
  const md = [
    "# Plan",
    "## Top 3 for you",
    "1. HONEY-1 review",
    "## Honeycrust",
    "### Agent",
    "- [x] HONEY-1693 Fix invite — clear (~30m)",
    "- [ ] HONEY-1692 Vetoed",
    "- [X] HONEY-1700 Upper-case check",
    "### You",
    "- [x] HONEY-1 not an agent item",
    "## Bluekite",
    "### Agent",
    "- [x] KITE-2040 Indexer",
    "- nothing suitable today",
  ].join("\n");
  expect(parsePlan(md)).toEqual(["HONEY-1693", "HONEY-1700", "KITE-2040"]);
});

test("adfToText flattens Jira documents", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
    ],
  };
  expect(adfToText(doc).trim()).toBe("Hello world\na");
  expect(adfToText(null)).toBe("");
});

test("upsertPlanItem lists tracker tickets unarmed and arms on request", () => {
  const md = [
    "# Plan",
    "",
    "## Honeycrust",
    "### Agent",
    "- nothing suitable today",
    "### You",
    "1. x",
    "",
    "## Fernway",
    "### Agent",
    "- [ ] FERN-1 a",
  ].join("\n");
  const listed = upsertPlanItem(md, "Honeycrust", "HONEY-9", "Fix it", null);
  expect(listed).toContain("### Agent\n- [ ] HONEY-9 Fix it\n### You");
  expect(listed).not.toContain("nothing suitable");
  expect(parsePlan(listed)).toEqual([]);
  expect(parsePlan(upsertPlanItem(listed, "Honeycrust", "HONEY-9", "Fix it", true))).toEqual(["HONEY-9"]);
  expect(upsertPlanItem(upsertPlanItem(listed, "Honeycrust", "HONEY-9", "", true), "Honeycrust", "HONEY-9", "", null)).toContain(
    "- [x] HONEY-9",
  );
  expect(parsePlan(upsertPlanItem(md, "Fernway", "FERN-1", "a", true))).toEqual(["FERN-1"]);
  expect(parsePlan(upsertPlanItem(md, "Bluekite", "KITE-3", "new", true))).toEqual(["KITE-3"]);
  expect(parsePlan(upsertPlanItem("", "Bluekite", "KITE-3", "new", true))).toEqual(["KITE-3"]);
});

test("editPlan applies each edit to the file as it is now, so concurrent writers keep each other's changes", () => {
  editPlan((md) => md);
  expect(existsSync(planFile())).toBe(false);
  // the work pass lists a tracker ticket, the dashboard arms another before the pass's next write, then the pass lists a third
  editPlan((md) => upsertPlanItem(md, "Honeycrust", "HONEY-1", "a", null));
  editPlan((md) => upsertPlanItem(md, "Honeycrust", "HONEY-2", "b", true));
  editPlan((md) => upsertPlanItem(md, "Honeycrust", "HONEY-3", "c", null));
  editPlan((md) => upsertPlanItem(md, "Honeycrust", "HONEY-2", "b", null));
  const md = readFileSync(planFile(), "utf8");
  expect(parsePlan(md)).toEqual(["HONEY-2"]);
  expect(md).toContain("- [ ] HONEY-1 a");
  expect(md).toContain("- [ ] HONEY-3 c");
});

test("armAll arms only unchecked tickets under Agent headings", () => {
  const md = ["## A", "### Agent", "- [ ] HONEY-1 a", "- [x] HONEY-2 b", "- nothing", "### You", "- [ ] HONEY-3 mine"].join("\n");
  const r = armAll(md);
  expect(r.armed).toBe(1);
  expect(parsePlan(r.md)).toEqual(["HONEY-1", "HONEY-2"]);
  expect(r.md).toContain("- [ ] HONEY-3 mine");
});

test("lockHolder trusts only a live pid with a fresh heartbeat; leadInbox reads the questions file", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join, relative } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(SRC, ".test-lead-"));
  const rel = (f: string) => relative(dirname(SRC), join(dir, f));
  const g = {
    key: "t",
    label: "T",
    name: "",
    dir: "",
    project: "",
    goal: "",
    prompt: "",
    supervised: true,
    onDemand: false,
    account: "",
    fallbackToAll: true,
    lockFile: rel("lead.lock"),
    lockStaleMin: 45,
    inboxFile: rel("inbox.md"),
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
    pushBranches: [],
  };
  expect(lockHolder(g)).toBe(0);
  writeFileSync(join(dir, "lead.lock"), JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
  expect(lockHolder(g)).toBe(process.pid);
  writeFileSync(join(dir, "lead.lock"), JSON.stringify({ pid: process.pid, heartbeat: Date.now() - 46 * 60_000 }));
  expect(lockHolder(g)).toBe(0);
  writeFileSync(join(dir, "lead.lock"), JSON.stringify({ pid: 999_999, heartbeat: Date.now() }));
  expect(lockHolder(g)).toBe(0);
  writeFileSync(join(dir, "lead.lock"), "not json");
  expect(lockHolder(g)).toBe(0);
  expect(leadInbox(g)).toBeNull();
  writeFileSync(join(dir, "inbox.md"), "# Owner inbox\n\nPick a payment provider?\n");
  expect(leadInbox(g)?.text).toContain("payment provider");
  expect(leadInbox(g)?.open).toBe(true);
  writeFileSync(join(dir, "inbox.md"), "## Q1 Pick a payment provider?\n\n## Answer from Sam (2026-10-18 04:59)\n\nStripe\n");
  expect(leadInbox(g)?.open).toBe(false);
  writeFileSync(join(dir, "inbox.md"), "## Q1 Provider?\n\n## Answer from Sam (2026-10-18 04:59)\n\nStripe\n\n## Q2 Currency?\n");
  expect(leadInbox(g)?.open).toBe(true);
  require("node:fs").rmSync(dir, { recursive: true });
});

test("leadAccount prefers the entry's account, skips limited ones, and is empty when all are limited", () => {
  const { loadConfig } = require("../src/config") as typeof import("../src/config");
  const accounts = loadConfig(OPS).accounts;
  const g = {
    key: "t",
    label: "T",
    name: "",
    dir: "",
    project: "",
    goal: "",
    prompt: "",
    supervised: true,
    onDemand: false,
    account: "",
    fallbackToAll: true,
    lockFile: "",
    lockStaleMin: 45,
    inboxFile: "",
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
    pushBranches: [],
  };
  const { bench } = require("../src/limits") as typeof import("../src/limits");
  const later = Date.now() + 60 * 60_000;
  for (const a of accounts) bench(a, later);
  expect(leadAccount(g)).toBe("");
  const last = accounts.at(-1) ?? "";
  bench(last, 0);
  const picked = leadAccount({ ...g, account: last });
  expect([last, ""]).toContain(picked); // "" only if `last` has a used-up week or budget
  for (const a of accounts) bench(a, 0);
  const first = accounts[0] ?? "";
  bench(first, later);
  if (accounts.length > 1) expect(leadAccount(g)).not.toBe(first);
  bench(first, 0);
});

test("accountsFor keeps a run on one account; only local code's order changes that", () => {
  const all = ["a", "b", "c"];
  expect(accountsFor(all, [], true, 1, null)).toEqual(["a"]);
  expect(accountsFor(all, ["c"], true, 0, null)).toEqual(["c"]);
  expect(accountsFor([], [], true, 0, null)).toEqual([]);
  const reversed = (xs: string[]) => [...xs].reverse();
  expect(accountsFor(all, [], true, 1, reversed)).toEqual(["c", "b", "a"]);
});

test("loadLocalCode: local code in the config folder supplies the account order; none leaves one account per run", async () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-local-code-"));
  const dir = join(ops, "local-code");
  mkdirSync(dir);
  expect(await loadLocalCode(join(ops, "missing"))).toBeNull();
  writeFileSync(join(dir, "a-other.ts"), "export const unrelated = 1;\n");
  expect(await loadLocalCode(ops)).toBeNull();
  expect(accountsFor(["a", "b"], [], true, 0)).toEqual(["a"]);
  writeFileSync(join(dir, "b-order.ts"), "export const accountOrder = (all: string[]) => [...all].reverse();\n");
  expect(await loadLocalCode(ops)).toBe("b-order.ts");
  expect(accountsFor(["a", "b"], [], true, 0)).toEqual(["b", "a"]);
  // stored subscription tokens stay off unless local code opts in
  expect(subscriptionTokensAllowed()).toBe(false);
  writeFileSync(join(dir, "c-tokens.ts"), "export const subscriptionTokens = true;\n");
  expect(await loadLocalCode(ops)).toBe("b-order.ts");
  expect(subscriptionTokensAllowed()).toBe(true);
  rmSync(ops, { recursive: true });
  expect(await loadLocalCode(ops)).toBeNull(); // gone again: back to one account per run
  expect(accountsFor(["a", "b"], [], true, 0)).toEqual(["a"]);
  expect(subscriptionTokensAllowed()).toBe(false);
});

test("loadLocalCode never imports or moves anything under plugins/: an agent's file there can't reach the daemon", async () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-local-code-"));
  const plugins = join(ops, "plugins");
  mkdirSync(join(plugins, "some-plugin.ts"), { recursive: true });
  const ran = (flag: string) => `(globalThis as Record<string, unknown>).${flag} = true;\n`;
  const order = "export const accountOrder = (all: string[]) => [...all].reverse();\n";
  writeFileSync(join(plugins, "dropped.ts"), [ran("ranDroppedPlugin"), order].join(""));
  writeFileSync(join(plugins, "some-plugin.ts", "index.ts"), [ran("ranSandboxedPlugin"), order].join(""));
  expect(await loadLocalCode(ops)).toBeNull();
  expect(await loadLocalCode(ops)).toBeNull();
  // left where it is, never copied into local-code/, never imported
  expect(existsSync(join(plugins, "dropped.ts"))).toBe(true);
  expect(existsSync(join(ops, "local-code", "dropped.ts"))).toBe(false);
  expect(Reflect.get(globalThis, "ranDroppedPlugin")).toBeUndefined();
  expect(Reflect.get(globalThis, "ranSandboxedPlugin")).toBeUndefined();
  expect(accountsFor(["a", "b"], [], true, 0)).toEqual(["a"]);
  rmSync(ops, { recursive: true });
});

test("parseStream reads usage and the result; exhaustedUntil blocks only full windows that haven't reset", () => {
  const { parseStream, exhaustedUntil } = require("../src/usage") as typeof import("../src/usage");
  const now = Date.now();
  const resets = Math.floor(now / 1000) + 3600;
  const out = [
    JSON.stringify({ type: "system" }),
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: resets }, seven_day: { utilization: 0.32, resetsAt: resets + 86400 } },
      },
    }),
    '{"type":"result","structured_output":{"ok":true},"total_cost_usd":0.01',
    JSON.stringify({ type: "result", structured_output: { ok: true }, total_cost_usd: 0.01 }),
  ].join("\n");
  const { usage, result } = parseStream(out);
  expect(usage?.fiveHour).toBe(1);
  expect(usage?.sevenDay).toBe(0.32);
  expect(usage?.status).toBe("rejected");
  expect((result?.structured_output as { ok: boolean } | undefined)?.ok).toBe(true);
  expect(exhaustedUntil(usage ?? undefined, now)).toBe(resets * 1000);
  expect(exhaustedUntil({ ...(usage as NonNullable<typeof usage>), fiveHour: 0.5 }, now)).toBe(0);
  expect(exhaustedUntil({ ...(usage as NonNullable<typeof usage>), fiveHourResetsAt: now - 1 }, now)).toBe(0);
});

test("readableLog shows what a lead said, the tools it ran and how it ended", () => {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Starting lane m4-b." },
          { type: "tool_use", name: "Bash", input: { command: "git   status" } },
        ],
      },
    }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "clean" }] } }),
    JSON.stringify({ type: "result", is_error: false, result: "Merged m4-b." }),
    '{"type":"assistant","message":{"con',
  ].join("\n");
  expect(readableLog(raw)).toBe("Starting lane m4-b.\n→ Bash: git status\n✓ finished: Merged m4-b.");
});

test("GitHub tracker reads, labels, comments on and files issues through gh", async () => {
  // a fake gh on PATH: logs its arguments, answers like the real one, and fails for issue 404
  const bin = mkdtempSync(join(tmpdir(), "overhand-gh-"));
  const log = join(bin, "calls.jsonl");
  const issue = {
    number: 7,
    title: "Fix it",
    url: "https://github.com/o/r/issues/7",
    body: "b",
    state: "OPEN",
    labels: [{ name: "agent" }],
    comments: [{ author: null, body: "hi" }],
  };
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bun",
      "const a = process.argv.slice(2);",
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");`,
      `if (a.includes("404")) { console.error("not found"); process.exit(1); }`,
      `const cmd = a.slice(0, 2).join(" ");`,
      `if (cmd === "issue view") console.log(${JSON.stringify(JSON.stringify(issue))});`,
      `if (cmd === "issue list") console.log(${JSON.stringify(JSON.stringify([issue]))});`,
      `if (cmd === "issue create") console.log("https://github.com/o/r/issues/9");`,
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = [bin, process.env.PATH].join(":"); // put back after the test (test-home.ts)
  const c: Client = {
    name: "Honeycrust",
    dir: "honeycrust",
    prefix: "AC",
    host: "github",
    tracker: { kind: "github", repo: "o/r" },
    aliases: [],
    accounts: [],
    fallbackToAll: true,
    autonomy: "act",
    assignedAutonomy: "act",
    status: { vercelSecrets: [], sentrySecrets: [] },
  };
  const [tk] = await tickets(c, { key: "AC-7" });
  expect(tk).toMatchObject({ key: "AC-7", id: "7", labels: ["agent"], comments: ["someone: hi"], statusType: "started" });
  expect((await tickets(c, { label: "agent" })).map((t) => t.key)).toEqual(["AC-7"]);
  if (!tk) throw new Error("no ticket");

  await setLabels(tk, ["agent-working", "agent"], ["agent", "missing"]);
  expect(tk.labels).toEqual(["agent-working"]);
  await comment(tk, "done, see PR");
  expect(await createTicket(c, "New", "d\n\nFrom Ana on Slack: https://slack/x", "from-slack")).toBe("AC-9");

  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  expect(calls.every((a) => a.slice(-2).join(" ") === "-R o/r")).toBe(true);
  expect(calls).toContainEqual(["label", "create", "agent-working", "--color", "D97757", "--force", "-R", "o/r"]);
  expect(calls).toContainEqual(["issue", "edit", "7", "--add-label", "agent-working", "--remove-label", "agent", "-R", "o/r"]);
  expect(calls).toContainEqual(["issue", "comment", "7", "--body", "done, see PR\n\n<!-- overhand -->", "-R", "o/r"]); // marked: never read back as your feedback
  expect(calls.find((a) => a[0] === "issue" && a[1] === "create")).toContain("d\n\nFrom Ana on Slack: https://slack/x");

  await expect(comment({ ...tk, id: "404" }, "x")).rejects.toThrow("gh issue comment AC-7: not found");
});

test("spendOn sums a day's run costs, billed only for billed accounts, and tolerates junk lines", () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-"));
  mkdirSync(join(ops, "runs"));
  writeFileSync(
    join(ops, "runs", "2026-01-02.jsonl"),
    `{"cost":1.5,"account":"sam"}\n\n{"cost":0.25,"account":"aws"}\n{"name":"x"}\n{broken`,
  );
  const billing = (a: string) => (a === "aws" ? "cloud" : "plan");
  expect(spendOn(ops, "2026-01-02", billing)).toEqual({ billed: 0.25, apiPrice: 1.75 });
  expect(spendOn(ops, "2026-01-03", billing)).toEqual({ billed: 0, apiPrice: 0 });
});

test("leadPrompt uses the repo's own instruction, else ops' generic lead with notes and questions in ops", () => {
  const g = {
    key: "honeycrust",
    label: "Honeycrust lead",
    name: "",
    dir: "honeycrust/app",
    project: "Honeycrust",
    goal: "ship v2 checkout",
    prompt: "",
    supervised: true,
    onDemand: false,
    account: "",
    fallbackToAll: true,
    lockFile: "",
    lockStaleMin: 45,
    inboxFile: "",
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
    pushBranches: [],
  };
  expect(leadPrompt({ ...g, prompt: "godmode" })).toStartWith("godmode\n\n");
  expect(leadPrompt({ ...g, prompt: "godmode" })).toContain("<!-- overhand -->"); // what it posts is marked, never learned as yours
  const generic = leadPrompt(g);
  expect(generic).toContain("lead for Honeycrust");
  expect(generic).toContain("Goal: ship v2 checkout");
  expect(generic).toContain("leads/honeycrust/notes.md");
  expect(generic).toContain("leads/honeycrust/questions.md");
  expect(generic).toContain("Never push to protected branches");
  // ops' own lead works in a worktree, never the checkout the daemon runs from
  const ops = SRC;
  const self = { ...g, key: "ops", dir: ops.split("/").pop() ?? "" };
  expect(leadDir(self)).toBe(join(ops, ".claude", "worktrees", "lead-ops"));
  expect(leadPrompt(self)).toContain(`working in ${join(ops, ".claude", "worktrees", "lead-ops")}`);
  expect(leadDir(g)).toBe(join(ops, "..", "honeycrust", "app"));
  // one way of working, written once: every ready-made lead, the generic one and a repo's own lead get it exactly once
  const leads = [
    g,
    { ...g, prompt: "godmode" },
    ...LEAD_WORK.map((k) => ({ ...g, key: `honeycrust-${k}`, goal: LEAD_TEMPLATES[k].goal, onDemand: true, watch: [k] })),
  ];
  for (const x of leads) expect(leadPrompt(x, "- Red build on web main").split(WAY_OF_WORKING), x.key).toHaveLength(2);
  for (const k of LEAD_WORK) expect(LEAD_TEMPLATES[k].goal).not.toContain("How to work");
});

test("OVERHAND_HOME: run.ts loads its config from there, not from the code folder", () => {
  const home = mkdtempSync(join(tmpdir(), "overhand-home-"));
  copyFileSync(join(SRC, "overhand.config.example.json"), join(home, "overhand.config.json"));
  const r = Bun.spawnSync(["bun", "run.ts", "version"], { cwd: SRC, env: { ...process.env, OVERHAND_HOME: home } });
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
});

test("a broken config is one plain line at daemon start and at setup, never a stack trace", () => {
  const home = mkdtempSync(join(tmpdir(), "overhand-home-"));
  writeFileSync(join(home, "overhand.config.json"), "{ broken");
  for (const cmd of [["run.ts", "daemon"], ["packages/core/src/setup-cli.ts"]]) {
    const r = Bun.spawnSync(["bun", ...cmd], { cwd: SRC, env: { ...process.env, OVERHAND_HOME: home } });
    const err = r.stderr.toString().trimEnd();
    expect([cmd[0], r.exitCode, err.split("\n").length]).toEqual([cmd[0], 1, 1]);
    expect(err).toStartWith("overhand.config.json is invalid: ");
  }
});

test("pool visits every item once and never runs more than the limit at a time", async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(n % 3);
    seen.push(n);
    running--;
  });
  expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(peak).toBe(3);
  await pool([], 3, async () => {}); // no items, no hang
});

test("demandBrief lists red builds, new errors, review feedback and armed tickets for one project only", () => {
  const ci = (client: string, state: "pass" | "fail") => ({ client, repo: "app", branch: "main", state, failing: ["build"], url: "u" });
  const st = {
    ci: [ci("Honeycrust", "fail"), ci("Honeycrust", "pass"), ci("Fernway", "fail")],
    myPrs: [
      {
        client: "Honeycrust",
        repo: "app",
        number: 4,
        title: "t",
        url: "u",
        draft: false,
        review: "CHANGES_REQUESTED",
        checks: "",
        updated: "",
      },
    ],
    sentry: [{ client: "Honeycrust", id: "1", title: "boom", count: 1, users: 1, isNew: true, level: "error", url: "u" }],
  };
  const tix = [
    { key: "A-1", title: "x", status: "", priority: "", labels: ["agent"], url: "u" },
    { key: "A-2", title: "y", status: "", priority: "", labels: [], url: "u" },
  ];
  const brief = demandBrief("Honeycrust", st, tix, "agent");
  expect(brief.split("\n")).toHaveLength(4);
  expect(brief).toContain("A-1");
  expect(brief).not.toContain("A-2");
  expect(demandBrief("Nobody", st, [], "agent")).toBe("");
  // failing checks on an open PR and a failed production deploy wake it too; previews don't
  const more = demandBrief(
    "Honeycrust",
    {
      ci: [],
      sentry: [],
      myPrs: [
        { client: "Honeycrust", repo: "app", number: 5, title: "t", url: "u", draft: false, review: "", checks: "FAILURE", updated: "" },
      ],
      deploys: [
        { client: "Honeycrust", project: "web", state: "ERROR", target: "production", url: "d1", created: 0 },
        { client: "Honeycrust", project: "web", state: "ERROR", target: "preview", url: "d2", created: 0 },
      ],
    },
    [],
    "agent",
  );
  expect(more.split("\n")).toEqual(["- Failing checks on app#5: t u", "- Failed production deploy of web: d1"]);
  // a ready-made lead wakes only for its own kind of work
  expect(demandBrief("Honeycrust", st, tix, "agent", ["reviews"])).toBe("- Review feedback on app#4: t u");
  expect(demandBrief("Honeycrust", st, tix, "agent", ["backlog", "errors"]).split("\n")).toEqual([
    "- New error: boom u",
    "- Armed ticket A-1: x u",
  ]);
});

test("recordLeadExit stops a lead after maxCrashesPerHour failed exits, but not for clean exits or restarts", () => {
  const g = {
    key: "t",
    label: "T",
    name: "",
    dir: "",
    project: "",
    goal: "",
    prompt: "",
    supervised: true,
    onDemand: false,
    account: "",
    fallbackToAll: true,
    lockFile: "",
    lockStaleMin: 45,
    inboxFile: "",
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
    pushBranches: [],
  };
  const st = { stopped: false, reason: "", pid: 0, startedAt: Date.now(), lastExit: 0, crashes: [] as number[], inboxAt: 0 };
  recordLeadExit(g, st, null, 0, "code 0");
  recordLeadExit(g, st, null, null, "Overhand restart");
  expect(st.crashes).toHaveLength(0);
  recordLeadExit(g, st, null, 1, "code 1");
  recordLeadExit(g, st, null, 1, "code 1");
  expect(st.stopped).toBe(false);
  st.crashes[0] = Date.now() - 61 * 60_000; // an old crash ages out of the hour window
  recordLeadExit(g, st, null, 1, "code 1");
  expect(st.crashes).toHaveLength(2);
  expect(st.stopped).toBe(false);
  recordLeadExit(g, st, null, 1, "code 1");
  expect(st.stopped).toBe(true);
  expect(st.reason).toContain("crashed 3 times");
});

test("a lead that keeps finding nothing to do rests longer each time, and a real run resets the pace", () => {
  const g = {
    key: "t",
    label: "T",
    name: "",
    dir: "",
    project: "",
    goal: "",
    prompt: "",
    supervised: true,
    onDemand: false,
    account: "",
    fallbackToAll: true,
    lockFile: "",
    lockStaleMin: 45,
    inboxFile: "",
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
    pushBranches: [],
  };
  const st = { stopped: false, reason: "", pid: 0, startedAt: Date.now(), lastExit: 0, crashes: [] as number[], inboxAt: 0, idle: 0 };
  expect(restartDelayMin(g, st)).toBe(5);
  for (const want of [10, 20, 40, 80, 160, 240, 240]) {
    st.startedAt = Date.now() - 60_000; // a one-minute run
    recordLeadExit(g, st, null, 0, "code 0");
    expect(restartDelayMin(g, st)).toBe(want);
  }
  recordLeadExit(g, st, null, null, "Overhand restart"); // unknown outcome: keeps the pace
  expect(restartDelayMin(g, st)).toBe(240);
  st.startedAt = Date.now() - 30 * 60_000; // a half-hour run did real work
  recordLeadExit(g, st, null, 0, "code 0");
  expect(restartDelayMin(g, st)).toBe(5);
  // the cap bounds the doubling only: a weekly lead rests its week, idle or not
  expect(restartDelayMin({ restartAfterMin: 10_080 }, { idle: 0 })).toBe(10_080);
  expect(restartDelayMin({ restartAfterMin: 10_080 }, { idle: 3 })).toBe(10_080);
});

test("prChanges tells what happened to your open pull requests between two refreshes", () => {
  const pr = (n: number, over: Partial<Parameters<typeof prChanges>[0][number]> = {}) => ({
    client: "Honeycrust",
    repo: "honeycrust/app",
    number: n,
    title: `t${n}`,
    url: `https://github.com/honeycrust/app/pull/${n}`,
    draft: false,
    review: "",
    checks: "SUCCESS",
    updated: "",
    ...over,
  });
  const { lines, gone } = prChanges([pr(1), pr(2), pr(3)], [pr(1, { checks: "FAILURE" }), pr(2, { review: "CHANGES_REQUESTED" }), pr(4)]);
  expect(lines).toEqual([
    "🔴 Honeycrust: app#1 checks failing: t1",
    "✍ Honeycrust: app#2 changes requested: t2",
    "🆕 Honeycrust: app#4 opened: t4",
  ]);
  expect(gone.map((p) => p.number)).toEqual([3]);
  expect(prChanges([pr(1, { checks: "FAILURE" })], [pr(1, { checks: "FAILURE" })]).lines).toEqual([]); // still red: said once
});

test("the old top-level Jenkins moves into its project's status sources, and a wrong project is still refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-cfg-"));
  const example = JSON.parse(readFileSync(join(SRC, "overhand.config.example.json"), "utf8"));
  const jenkins = { url: "https://ci", user: "u", secret: "overhand-jenkins", orgFolder: "org", jobFolders: ["apps"] };
  writeFileSync(join(dir, "overhand.config.json"), JSON.stringify({ ...example, jenkins: { ...jenkins, client: "Fernway" } }));
  const c = loadConfig(dir);
  expect(c.clients.find((x) => x.name === "Fernway")?.status.jenkins).toEqual(jenkins);
  expect(c.clients.find((x) => x.name === "Honeycrust")?.status).toEqual({ vercelSecrets: [], sentrySecrets: [] });
  expect("jenkins" in c).toBe(false);
  expect(() => saveConfig(dir, { ...example, jenkins: { ...jenkins, client: "Nobody" } })).toThrow("unknown project Nobody");
});

// ---------- disk cleanup ----------
// Every test works in scratch folders: a fake home, Code root and Overhand folder. Nothing touches the real home.
const DAY = 86_400_000;
const scratch = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `overhand-${name}-`))); // git reports /private/var on macOS
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
/**
 * The git-backed cleanup tests run real git: about 60 processes each, one after another. Idle that's ~1 s, but each
 * spawn slows several-fold when other builds share the machine, so they get this much room instead of bun's 5 s.
 */
const GIT_HEAVY_MS = 20_000;
const old = (p: string, days: number) => utimesSync(p, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

/** A config with only the example's projects, every category's defaults, and no caches or commands from the real home. */
function cfgWith(edit: (c: Config["cleanup"]) => void = () => {}): Config {
  const base = loadConfig(OPS);
  const cfg = { ...blankConfig("t"), clients: base.clients };
  cfg.cleanup.categories.caches.paths = [];
  cfg.cleanup.categories.caches.commands = [];
  edit(cfg.cleanup);
  return cfg;
}
/** A scope over scratch folders; `which` finds no tools, so no docker, simulator or brew command runs. */
function scopeOf(root: string, cfg: Config, extra: Partial<Scope> = {}): Scope {
  for (const d of ["home", "code", "ops", "src"]) mkdirSync(join(root, d), { recursive: true });
  return {
    cfg,
    home: join(root, "home"),
    code: join(root, "code"),
    ops: join(root, "ops"),
    src: join(root, "src"),
    busy: [],
    cwds: [],
    now: Date.now(),
    which: () => null,
    ...extra,
  };
}

test("a project's agent-run caches go when it's gone, idle 14 days or too big, unattended; never while it has a live run", () => {
  const s = scopeOf(scratch("run-caches"), cfgWith());
  const project = runCacheKey(s.cfg.clients[0]?.name ?? "");
  const cache = (key: string, ageDays = 0) => {
    const p = join(s.ops, RUN_CACHES, key);
    mkdirSync(join(p, "bun"), { recursive: true });
    writeFileSync(join(p, "bun", "pkg"), "x".repeat(4096));
    if (ageDays) for (const f of [join(p, "bun", "pkg"), join(p, "bun"), p]) old(f, ageDays);
    return p;
  };
  const fresh = cache(project);
  const gone = cache("no-such-project");
  const busy = cache("busy-project");
  const why = (items: ReturnType<typeof scanRunCaches>) => Object.fromEntries(items.map((i) => [basename(i.path), i.why]));
  let items = scanRunCaches(s, new Set(["busy-project"]));
  expect(Object.keys(why(items))).toEqual(["no-such-project"]); // the fresh one stays; the live one is never offered
  expect(items.every((i) => i.auto && i.category === "caches")).toBe(true);
  expect(why(items)["no-such-project"]).toContain("no longer one of Overhand's");
  old(join(fresh, "bun", "pkg"), 15);
  old(join(fresh, "bun"), 15);
  old(fresh, 15);
  items = scanRunCaches(s, new Set());
  expect(why(items)[project]).toMatch(/no run in 1[45] days/);
  expect(Object.keys(why(items)).sort()).toEqual(["busy-project", "no-such-project", project].sort());
  // the size cap, on a fresh cache
  const big = cache(project);
  expect(why(scanRunCaches(s, new Set(), 1))[basename(big)]).toContain("over 5 GB");
  expect([gone, busy].every((p) => refusePath(p, s) === null)).toBe(true);
});

test("refusePath: symlinks, paths outside home and the Code root, protected folders and git repos are refused", () => {
  const root = scratch("refuse");
  const s = scopeOf(root, cfgWith());
  const ok = join(s.home, "cache");
  mkdirSync(ok);
  expect(refusePath(ok, s)).toBeNull();
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  expect(refusePath(outside, s)).toMatch(/outside/);
  expect(refusePath(s.home, s)).toMatch(/outside/); // the root itself, never
  symlinkSync(outside, join(s.home, "link"));
  expect(refusePath(join(s.home, "link"), s)).toMatch(/symlink/);
  mkdirSync(join(outside, "inner"));
  expect(refusePath(join(s.home, "link", "inner"), s)).toMatch(/outside/); // a parent symlink that escapes
  mkdirSync(join(s.home, ".ollama", "models"), { recursive: true });
  expect(refusePath(join(s.home, ".ollama", "models"), s)).toMatch(/protected/);
  mkdirSync(join(s.home, "Documents"));
  expect(refusePath(join(s.home, "Documents"), s)).toMatch(/protected/);
  const repo = join(s.code, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  expect(refusePath(repo, s)).toMatch(/git repository/);
  expect(refusePath(repo, s, true)).toBeNull(); // worktrees go through git, which refuses dirty ones itself
  expect(refusePath(join(s.home, "gone"), s)).toBeNull();
});

test("inUse: folders an agent or lead works in, around or under, and folders a process sits in, are in use", () => {
  const s = { busy: ["/c/honeycrust/app"], cwds: ["/h/cache/sub", "/h"] };
  expect(inUse("/c/honeycrust/app/node_modules", s)).toMatch(/agent/); // inside the agent's folder
  expect(inUse("/c/honeycrust", s)).toMatch(/agent/); // contains it
  expect(inUse("/h/cache", s)).toMatch(/program/);
  expect(inUse("/h/other", s)).toBeNull(); // a shell sitting in home doesn't lock everything under it
});

test(
  "Worktrees: only clean, pushed, idle ones are proposed; removal keeps the branch; a run re-checks each one",
  async () => {
    const root = scratch("sweep");
    const s = scopeOf(root, cfgWith(), { now: Date.now() + 2 * DAY });
    const repo = join(s.code, "honeycrust", "app"); // the example config's Honeycrust client lives in honeycrust/
    git(s.code, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(s.code, "clone", "-q", join(s.code, "origin.git"), repo);
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const wt = (name: string) => {
      git(repo, "worktree", "add", "-q", "-b", name, join(s.code, name), "origin/main");
      return join(s.code, name);
    };
    const merged = wt("merged");
    const later = wt("later");
    writeFileSync(join(wt("untracked"), "wip.txt"), "new file");
    writeFileSync(join(wt("modified"), "a.txt"), "changed");
    const ahead = wt("ahead");
    writeFileSync(join(ahead, "a.txt"), "2");
    git(ahead, "commit", "-qam", "unpushed");
    const busy = wt("busy");
    const cwd = wt("cwd");
    const scope = { ...s, busy: [busy], cwds: [join(cwd)] };

    const items = (await planCleanup(scope)).filter((i) => i.category === "worktrees");
    expect(items.map((i) => i.path).sort()).toEqual([later, merged]);
    expect(items.every((i) => i.checked && i.auto)).toBe(true);

    // touched in the last day: an agent may have just started there (the worktree scan alone: no fetch, no sizes)
    expect(scan("worktrees", { ...scope, now: Date.now() })).toEqual([]);

    // between the plan and the run, new work lands in one of them: it's left alone
    writeFileSync(join(later, "new.txt"), "x");
    const r = runCleanup(items, scope);
    expect(r.removed).toBe(1);
    expect(r.skipped).toEqual([{ path: later, why: "changed since the scan (new work, in use, or gone)" }]);
    expect(existsSync(merged)).toBe(false);
    expect(existsSync(join(later, "new.txt"))).toBe(true);
    expect(git(repo, "rev-parse", "-q", "--verify", "merged")).not.toBe(""); // the branch stays
  },
  GIT_HEAVY_MS,
);

test(
  "Your own checkout, linked instead of cloned: never cleaned unattended, even idle; a manual clean needs the confirm naming it",
  async () => {
    const root = scratch("mine");
    const s0 = scopeOf(
      root,
      cfgWith((c) => (c.categories.builds.enabled = true)),
      { now: Date.now() + 90 * DAY },
    );
    const s = { ...s0, projects: join(s0.home, "Overhand", "projects") };
    // Sam's checkout in ~/Code, idle for months, with ignored node_modules and a merged agent worktree in .claude/worktrees
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    const mine = join(s.home, "Code", "honeycrust", "web");
    git(root, "clone", "-q", join(root, "origin.git"), mine);
    writeFileSync(join(mine, ".gitignore"), "node_modules\n.claude/\n");
    git(mine, "add", ".");
    git(mine, "commit", "-qm", "one");
    git(mine, "push", "-q", "origin", "HEAD:main");
    mkdirSync(join(mine, "node_modules", "x"), { recursive: true });
    const wt = join(mine, ".claude", "worktrees", "hc-1");
    git(mine, "worktree", "add", "-q", "-b", "agent/hc-1", wt, "origin/main");
    // Overhand linked it into the Honeycrust project (the example config's honeycrust/) instead of cloning it twice
    mkdirSync(join(s.code, "honeycrust"), { recursive: true });
    symlinkSync(mine, join(s.code, "honeycrust", "web"));
    expect(personalRepo(join(s.code, "honeycrust", "web"), s)).toBe(true);

    const items = await planCleanup(s);
    const inMine = items.filter((i) => realpathSync(i.path).startsWith(`${mine}/`));
    expect(inMine.map((i) => i.path)).toEqual([wt]); // its worktree is listed for review; its node_modules isn't even listed
    expect(inMine.every((i) => i.personal && !i.checked && !i.auto)).toBe(true);

    // the unattended pass: personal items are dropped, and even ticked and forced through, they're refused
    expect(items.filter((i) => !i.personal).some((i) => i.path === wt)).toBe(false);
    const forced = items.map((i) => ({ ...i, checked: true, auto: true }));
    const auto = runCleanup(
      forced,
      s,
      () => s,
      () => {},
      true,
    );
    expect(auto.skipped).toContainEqual({ path: wt, why: "it's in your own checkout, which is never cleaned unattended" });
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(mine, "node_modules", "x"))).toBe(true);

    // by hand: ticked alone isn't enough; the confirmation naming its path is
    const ticked = runCleanup(forced, s);
    expect(ticked.skipped).toContainEqual({ path: wt, why: "it's in your own checkout and you didn't confirm removing it" });
    expect(existsSync(wt)).toBe(true);
    const confirmed = runCleanup(
      forced.map((i) => (i.path === wt ? { ...i, confirmed: wt } : i)),
      s,
    );
    expect(confirmed.skipped.some((x) => x.path === wt)).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(mine, "node_modules", "x"))).toBe(true); // never proposed, never touched
    expect(git(mine, "status", "--porcelain")).toBe(""); // and the checkout itself is as it was
  },
  GIT_HEAVY_MS,
);

// Playwright keeps its browsers in a per-OS cache: a known source, so the plan only offers its older builds
const PLAYWRIGHT = process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright";

test("Plan over fixture folders: old agent CLI versions but not the one in use, caches, old logs, ignored build output", async () => {
  const root = scratch("plan");
  const s0 = scopeOf(root, cfgWith());
  const versions = join(s0.home, ".local", "share", "claude", "versions");
  for (const v of ["1.0.1", "1.0.2", "1.0.3", "1.0.10"]) mkdirSync(join(versions, v), { recursive: true });
  mkdirSync(join(s0.home, ".local", "bin"), { recursive: true });
  symlinkSync(join(versions, "1.0.1"), join(s0.home, ".local", "bin", "claude")); // pinned to an old one: never touched
  for (const c of ["cache", PLAYWRIGHT, "empty"]) mkdirSync(join(s0.home, c), { recursive: true });
  writeFileSync(join(s0.home, "cache", "blob"), "x");
  writeFileSync(join(s0.home, PLAYWRIGHT, "chromium"), "x");
  const outsideCache = join(root, "outside-cache");
  mkdirSync(outsideCache);
  writeFileSync(join(outsideCache, "keep"), "x");
  symlinkSync(outsideCache, join(s0.home, "linked-cache"));
  mkdirSync(join(s0.home, ".ollama", "models"), { recursive: true });
  writeFileSync(join(s0.home, ".ollama", "models", "llama"), "x");
  mkdirSync(join(s0.ops, "logs"));
  writeFileSync(join(s0.ops, "logs", "old.log"), "x");
  writeFileSync(join(s0.ops, "logs", "new.log"), "x");
  old(join(s0.ops, "logs", "old.log"), 200);
  // a project idle for months: node_modules is ignored output, dist/ is committed source
  const proj = join(s0.code, "side");
  mkdirSync(join(proj, "node_modules", "x"), { recursive: true });
  mkdirSync(join(proj, "dist"), { recursive: true });
  writeFileSync(join(proj, ".gitignore"), "node_modules\n");
  writeFileSync(join(proj, "dist", "index.js"), "1");
  git(proj, "init", "-q");
  git(proj, "add", ".");
  git(proj, "commit", "-qm", "one");
  // a repo with no commit yet can't be called idle; the project inside it is its own repo and judged on its own
  const fresh = join(s0.code, "fresh");
  mkdirSync(join(fresh, "node_modules"), { recursive: true });
  writeFileSync(join(fresh, ".gitignore"), "node_modules\nnested/\n");
  git(fresh, "init", "-q");
  mkdirSync(join(fresh, "nested", "node_modules"), { recursive: true });
  git(join(fresh, "nested"), "init", "-q");
  // the Overhand checkout is never cleaned, even when it looks the same
  const helm = join(s0.code, "overhand");
  mkdirSync(join(helm, "node_modules"), { recursive: true });
  writeFileSync(join(helm, ".gitignore"), "node_modules\n");
  git(helm, "init", "-q");
  git(helm, "add", ".");
  git(helm, "commit", "-qm", "one");

  const cfg = cfgWith((c) => {
    c.categories.caches.paths = ["~/cache", `~/${PLAYWRIGHT}`, "~/empty", "~/linked-cache", "~/.ollama/models", "~/missing"];
    c.categories.logs.days = 100;
  });
  const s = { ...s0, cfg, src: helm, now: Date.now() + 90 * DAY };
  const items = await planCleanup(s);
  const by = (c: string) => items.filter((i) => i.category === c).map((i) => [i.path.replace(root, ""), i.checked]);
  expect(by("versions")).toEqual([["/home/.local/share/claude/versions/1.0.2", true]]);
  expect(by("caches")).toEqual([
    ["/home/cache", true],
    // ms-playwright is a known source now: only older browser builds go, and "chromium" here is none
  ]);
  expect(by("logs")).toEqual([["/ops/logs/old.log", true]]);
  expect(by("builds")).toEqual([["/code/side/node_modules", true]]); // listed even while the category is off
  expect(items.find((i) => i.category === "builds")?.kb).toBeGreaterThanOrEqual(0);
  expect(items.some((i) => i.category === "docker" || i.category === "simulators")).toBe(false); // no tools found

  // the run: builds is off, so its item is skipped even when ticked; caches go by contents only
  const r = runCleanup(items, s);
  expect(r.skipped).toEqual([{ path: join(proj, "node_modules"), why: "its category is switched off" }]);
  expect(existsSync(join(proj, "node_modules"))).toBe(true);
  expect(existsSync(join(s.home, "cache"))).toBe(true);
  expect(existsSync(join(s.home, "cache", "blob"))).toBe(false);
  expect(existsSync(join(s.home, PLAYWRIGHT, "chromium"))).toBe(true); // unticked
  expect(existsSync(join(versions, "1.0.2"))).toBe(false);
  expect(existsSync(join(versions, "1.0.1"))).toBe(true);
  expect(existsSync(join(s.ops, "logs", "new.log"))).toBe(true);
  expect(existsSync(join(outsideCache, "keep"))).toBe(true);
  expect(existsSync(join(s.home, ".ollama", "models", "llama"))).toBe(true);
});

test("A run re-derives every item: a tampered plan, a path swapped for a symlink, or an agent starting there is skipped", () => {
  const root = scratch("verify");
  const cfg = cfgWith((c) => {
    c.categories.caches.paths = ["~/cache", "~/cache2"];
    c.categories.builds.enabled = true;
  });
  const s = scopeOf(root, cfg);
  for (const c of ["cache", "cache2"]) {
    mkdirSync(join(s.home, c));
    writeFileSync(join(s.home, c, "f"), "x");
  }
  const src = join(s.code, "proj", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.ts"), "precious");
  const item = (category: "caches" | "logs", kind: "contents" | "dir", path: string) => ({
    id: `${category}:${path}`,
    category,
    kind,
    path,
    why: "",
    kb: 0,
    checked: true,
    auto: true,
    personal: false,
    confirmed: "",
  });
  // a plan file edited by hand to delete source as if it were a log
  const tampered = item("logs", "dir", src);
  // swapped for a symlink to somewhere else after the plan
  const swapped = item("caches", "contents", join(s.home, "cache"));
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "f"), "x");
  Bun.spawnSync(["rm", "-rf", join(s.home, "cache")]);
  symlinkSync(elsewhere, join(s.home, "cache"));
  // an agent starts working there
  const taken = item("caches", "contents", join(s.home, "cache2"));
  const r = runCleanup([tampered, swapped, taken], s, () => ({ busy: [join(s.home, "cache2")], cwds: [] }));
  expect(r.removed).toBe(0);
  expect(r.skipped.map((x) => x.why)).toEqual([
    "it's a symlink",
    "an agent or lead is working there",
    "changed since the scan (new work, in use, or gone)",
  ]);
  expect(existsSync(join(src, "main.ts"))).toBe(true);
  expect(existsSync(join(elsewhere, "f"))).toBe(true);
  expect(existsSync(join(s.home, "cache2", "f"))).toBe(true);
});

/** A fake tool: a script in the scratch folder that prints `out` for any arguments (its first line) and exits 0. */
function fakeTool(root: string, name: string, script: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return join(bin, name);
}

test("a folder's access time never counts as use: listing it (this scan too, on Linux) moves it; a file's does", () => {
  const root = scratch("atime");
  const dir = join(root, "model");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "weights"), "x");
  old(join(dir, "weights"), 120);
  const then = new Date(Date.now() - 120 * DAY);
  utimesSync(dir, new Date(), then); // listed just now
  expect(Date.now() - newest(dir, 1, true)).toBeGreaterThan(100 * DAY);
  utimesSync(join(dir, "weights"), new Date(), then); // the model itself opened just now
  expect(Date.now() - newest(dir, 1, true)).toBeLessThan(DAY);
});

test("Models: Ollama from its manifests (size = blobs only it uses), LM Studio and Hugging Face folders; unused 90 days, yours, never ticked or unattended", async () => {
  const root = scratch("models");
  const s0 = scopeOf(root, cfgWith());
  const o = join(s0.home, ".ollama", "models");
  const manifest = (name: string, layers: [string, number][]) => {
    const [model, tag] = name.split(":");
    const dir = join(o, "manifests", "registry.ollama.ai", "library", model ?? "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, tag ?? ""), JSON.stringify({ layers: layers.map(([digest, size]) => ({ digest, size })) }));
    mkdirSync(join(o, "blobs"), { recursive: true });
    for (const [digest] of layers) writeFileSync(join(o, "blobs", digest.replace(":", "-")), "x");
    return join(dir, tag ?? "");
  };
  const oldM = manifest("llama3:8b", [
    ["sha256:aaa", 4 * 1024 ** 3],
    ["sha256:shared", 1024 ** 2],
  ]);
  manifest("qwen3:1.7b", [["sha256:shared", 1024 ** 2]]); // used today: not offered, and it keeps the shared blob
  for (const f of [oldM, join(o, "blobs", "sha256-aaa"), join(o, "blobs", "sha256-shared")]) old(f, 200);
  const lm = join(s0.home, ".lmstudio", "models", "pub", "tiny-gguf");
  const hf = join(s0.home, ".cache", "huggingface", "hub", "models--org--whisper");
  for (const d of [lm, hf, join(s0.home, ".cache", "huggingface", "hub", "blobs")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(lm, "model.gguf"), "x");
  writeFileSync(join(hf, "blob"), "x");
  for (const p of [join(lm, "model.gguf"), lm, join(hf, "blob"), hf]) old(p, 120);

  const s = { ...s0, which: (b: string) => (b === "ollama" ? "/fake/ollama" : null) };
  const items = (await planCleanup(s)).filter((i) => i.category === "models");
  expect(items.map((i) => i.path.replace(root, "")).sort()).toEqual([
    "/home/.cache/huggingface/hub/models--org--whisper",
    "/home/.lmstudio/models/pub/tiny-gguf",
    "ollama rm llama3:8b",
  ]);
  expect(items.every((i) => i.personal && !i.checked && !i.auto)).toBe(true);
  expect(items.find((i) => i.kind === "command")?.kb).toBe(4 * 1024 ** 2); // the shared blob stays for qwen3
  expect(items.find((i) => i.path === hf)?.why).toMatch(/hf download org\/whisper/);
  // the model folders themselves stay protected; one model inside them may go
  expect(refusePath(join(s.home, ".cache", "huggingface", "hub"), s, false, { models: true })).toMatch(/protected/);
  expect(refusePath(hf, s, false, { models: true })).toBeNull();
  // unattended never; by hand only confirmed
  expect(
    runCleanup(
      items,
      s,
      () => s,
      () => {},
      true,
    ).removed,
  ).toBe(0);
  expect(existsSync(lm)).toBe(true);
  expect(
    runCleanup(
      items.map((i) => (i.path === lm ? { ...i, checked: true, confirmed: lm } : i)),
      s,
    ).removed,
  ).toBe(1);
  expect(existsSync(lm)).toBe(false);
  expect(existsSync(hf)).toBe(true);
});

test("History: an agent's transcripts unused 90 days are offered unticked and only go when you confirm them, never unattended", () => {
  const root = scratch("history");
  const s = scopeOf(root, cfgWith());
  const projects = join(s.home, ".claude", "projects");
  const stale = join(projects, "-code-old");
  const live = join(projects, "-code-live");
  for (const d of [stale, live]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "session.jsonl"), "{}");
  }
  old(join(stale, "session.jsonl"), 120);
  old(stale, 120);
  const items = scan("history", s);
  expect(items.map((i) => i.path)).toEqual([stale]);
  expect(items[0]).toMatchObject({ personal: true, checked: false, auto: false, source: "claude-transcripts" });
  expect(items[0]?.why).toMatch(/unused 1[12][09] days; lost for good/);
  const ticked = items.map((i) => ({ ...i, checked: true, auto: true }));
  expect(
    runCleanup(
      ticked,
      s,
      () => s,
      () => {},
      true,
    ).skipped[0]?.why,
  ).toBe("it's yours (history, a model, a tool or uncommitted work), which is never cleaned unattended");
  expect(runCleanup(ticked, s).skipped[0]?.why).toMatch(/you didn't confirm/);
  expect(existsSync(stale)).toBe(true);
  expect(runCleanup([{ ...(ticked[0] as CleanupItem), confirmed: stale }], s).removed).toBe(1);
  expect(existsSync(live)).toBe(true);
});

test("Temp: Overhand's day-old scratch folders and known tools' caches (contents only) go unattended; nothing off the list is touched", () => {
  const root = scratch("temp");
  const s = { ...scopeOf(root, cfgWith()), tmp: join(root, "tmp") };
  const made = (name: string, days: number) => {
    const p = join(s.tmp, name);
    mkdirSync(join(p, "inner"), { recursive: true });
    writeFileSync(join(p, "inner", "f"), "x");
    for (const x of [join(p, "inner", "f"), join(p, "inner"), p]) old(x, days);
    return p;
  };
  const scratchOld = made("overhand-sweep-abc", 2);
  git(scratchOld, "init", "-q"); // tests make repos there; still a scratch folder
  old(scratchOld, 2);
  old(join(scratchOld, ".git"), 2);
  const fresh = made("overhand-running-def", 0);
  const jest = made("jest_rs", 3);
  const busy = made("bunx-501-mcp@1.0.0", 3);
  const other = made("someones-files", 30);
  const items = scan("temp", { ...s, procs: [`bun ${busy}/node_modules/mcp/index.js`] });
  expect(items.map((i) => [i.path, i.kind, i.auto]).sort()).toEqual([
    [jest, "contents", true],
    [scratchOld, "dir", true],
  ]);
  const r = runCleanup(
    items,
    s,
    () => s,
    () => {},
    true,
  );
  expect(r.removed).toBe(2);
  expect(existsSync(scratchOld)).toBe(false);
  expect(existsSync(jest)).toBe(true);
  expect(existsSync(join(jest, "inner"))).toBe(false);
  for (const p of [fresh, busy, other]) expect(existsSync(join(p, "inner", "f"))).toBe(true);
  // a temp item can't reach outside the temp folder, even from a tampered plan
  expect(refusePath(other, { ...s, home: join(root, "home") })).toMatch(/outside/);
});

test("Agent CLIs: a global install no account runs and unused 90 days is offered for its package manager's uninstall; one an account runs isn't", () => {
  const root = scratch("tools");
  const npmRoot = join(root, "npm-global");
  mkdirSync(join(npmRoot, "@openai", "codex"), { recursive: true });
  writeFileSync(join(npmRoot, "@openai", "codex", "package.json"), "{}");
  const npm = fakeTool(root, "npm", `echo ${npmRoot}`);
  const s0 = scopeOf(root, cfgWith(), { which: (b) => (b === "npm" ? npm : null) });
  mkdirSync(join(s0.home, ".codex"));
  writeFileSync(join(s0.home, ".codex", "config.toml"), "");
  for (const p of [join(s0.home, ".codex", "config.toml"), join(s0.home, ".codex"), join(npmRoot, "@openai", "codex")]) old(p, 100);
  const items = scan("tools", s0);
  expect(items.map((i) => i.path)).toEqual(["npm uninstall -g @openai/codex"]);
  expect(items[0]).toMatchObject({ kind: "command", personal: true, checked: false, auto: false });
  expect(items[0]?.kb).toBeGreaterThan(0);
  expect(items[0]?.why).toMatch(/^Codex: .*no use in (99|100) days/);
  const used = { ...s0.cfg, accounts: ["work"], runtimes: { work: { kind: "codex" as const, model: "" } } };
  expect(scan("tools", { ...s0, cfg: used })).toEqual([]);
});

test("Docker sizes are what each prune frees: stopped containers' layers and unused dangling images' unique size; build cache unknown", () => {
  const root = scratch("docker");
  const df = {
    Images: [
      { Repository: "<none>", Tag: "<none>", Containers: "0", UniqueSize: "1.5GB", Size: "3GB" },
      { Repository: "<none>", Tag: "<none>", Containers: "1", UniqueSize: "700MB" }, // a container uses it: prune keeps it
      { Repository: "app", Tag: "latest", Containers: "0", UniqueSize: "2GB" }, // tagged: kept
    ],
    Containers: [
      { State: "exited", Size: "2MB (virtual 1GB)" },
      { State: "running", Size: "5MB" },
    ],
  };
  writeFileSync(join(root, "df.json"), JSON.stringify(df));
  const docker = fakeTool(root, "docker", `[ "$1" = system ] && cat ${join(root, "df.json")}; exit 0`);
  const s = scopeOf(root, cfgWith(), { which: (b) => (b === "docker" ? docker : null) });
  const kb = Object.fromEntries(scan("docker", s).map((i) => [i.path, i.kb]));
  expect(kb).toEqual({
    "docker container prune -f": Math.round(2e6 / 1024),
    "docker image prune -f": Math.round(1.5e9 / 1024),
    "docker builder prune -f": 0,
  });
});

test(
  "Orphan worktree folders: matched against every commit first; pushed goes (unattended a week on), unpushed says so, uncommitted needs your confirm",
  () => {
    const root = scratch("orphans");
    const s = scopeOf(root, cfgWith());
    const repo = join(s.code, "honeycrust", "app");
    git(s.code, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(s.code, "clone", "-q", join(s.code, "origin.git"), repo);
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const wts = join(repo, ".claude", "worktrees");
    const copy = (name: string, a: string) => {
      const d = join(wts, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, ".gitignore"), ".claude/\n");
      writeFileSync(join(d, "a.txt"), a);
      return d;
    };
    const pushed = copy("pushed", "1");
    writeFileSync(join(pushed, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "gone")}\n`); // points at nothing
    for (const p of [join(pushed, "a.txt"), join(pushed, ".gitignore"), join(pushed, ".git"), pushed]) old(p, 10);
    const local = copy("local", "2");
    writeFileSync(join(repo, "a.txt"), "2");
    git(repo, "commit", "-qam", "two, not pushed");
    const dirty = copy("dirty", "3");
    // a real worktree git knows is never an orphan
    git(repo, "worktree", "add", "-q", "-b", "real", join(wts, "real"), "origin/main");

    const items = scan("worktrees", s).filter((i) => i.source === "orphan-worktrees");
    const by = Object.fromEntries(items.map((i) => [i.path, i]));
    expect(Object.keys(by).sort()).toEqual([dirty, local, pushed].sort());
    expect(by[pushed]).toMatchObject({ checked: true, auto: true, personal: false });
    expect(by[pushed]?.why).toMatch(/match a pushed commit/);
    expect(by[local]).toMatchObject({ checked: false, auto: false });
    expect(by[local]?.why).toMatch(/not pushed yet/);
    expect(by[dirty]).toMatchObject({ checked: false, auto: false, personal: true });
    expect(by[dirty]?.why).toMatch(/changes in no commit/);

    // between the plan and the run, someone edits the pushed one: it no longer matches, so it isn't taken unattended
    writeFileSync(join(pushed, "a.txt"), "edited");
    const r = runCleanup(
      items,
      s,
      () => s,
      () => {},
      true,
    );
    expect(r.removed).toBe(0);
    expect(existsSync(join(pushed, "a.txt"))).toBe(true);
    expect(existsSync(join(dirty, "a.txt"))).toBe(true);
  },
  GIT_HEAVY_MS,
);

test(
  "Git-ignored files that don't regrow (.env.local, a dev database) make a worktree yours to confirm; node_modules alone doesn't; an empty folder is never 'pushed'",
  () => {
    const root = scratch("ignored");
    const s = scopeOf(root, cfgWith(), { now: Date.now() + 2 * DAY });
    const repo = join(s.code, "honeycrust", "app");
    git(s.code, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(s.code, "clone", "-q", join(s.code, "origin.git"), repo);
    writeFileSync(join(repo, ".gitignore"), ".claude/\n.env.local\nnode_modules/\n*.db\n");
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "commit", "-q", "--allow-empty", "-m", "empty tree on a branch");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const wts = join(repo, ".claude", "worktrees");
    const orphan = (name: string, extra: Record<string, string>) => {
      const d = join(wts, name);
      mkdirSync(join(d, "node_modules", "x"), { recursive: true });
      for (const [f, body] of Object.entries({ ".gitignore": ".claude/\n.env.local\nnode_modules/\n*.db\n", "a.txt": "1", ...extra }))
        writeFileSync(join(d, f), body);
      for (const p of [join(d, "a.txt"), join(d, ".gitignore"), join(d, "node_modules"), d]) old(p, 10);
      return d;
    };
    const keys = orphan("keys", { ".env.local": "SECRET=1", "dev.db": "x" });
    const deps = orphan("deps", {});
    const empty = join(wts, "empty");
    mkdirSync(empty, { recursive: true });
    expect(committedState(repo, empty).state).toBe("uncommitted");
    expect(committedState(repo, keys)).toEqual({ state: "ignored-files", kept: [".env.local", "dev.db"] });

    const by = Object.fromEntries(scan("worktrees", s).map((i) => [i.path, i]));
    expect(by[keys]).toMatchObject({ checked: false, auto: false, personal: true });
    expect(by[keys]?.why).toMatch(/git-ignored files such as \.env\.local, dev\.db/);
    expect(by[deps]).toMatchObject({ checked: true, auto: true, personal: false }); // node_modules regrows
    const forced = Object.values(by).map((i) => ({ ...i, checked: true, auto: true, personal: false })); // a tampered plan
    expect(
      runCleanup(
        forced,
        s,
        () => s,
        () => {},
        true,
      ).skipped.some((x) => x.path === keys),
    ).toBe(true);
    expect(existsSync(join(keys, ".env.local"))).toBe(true);

    // a registered worktree, merged, whose only extra is an ignored .env.local: no longer unattended
    const wt = join(wts, "merged");
    git(repo, "worktree", "add", "-q", "-b", "merged", wt, "origin/main");
    writeFileSync(join(wt, ".env.local"), "SECRET=2");
    old(wt, 3);
    const it = scan("worktrees", s).find((i) => i.path === wt);
    expect(it).toMatchObject({ kind: "worktree", checked: false, auto: false, personal: true });
    expect(it?.why).toMatch(/such as \.env\.local/);
  },
  GIT_HEAVY_MS,
);

test("Names from disk never become flags or escape: an Ollama model named like a flag and '.'/'..' in an editor's .obsolete are refused", () => {
  const root = scratch("names");
  const s0 = scopeOf(root, cfgWith());
  const m = join(s0.home, ".ollama", "models", "manifests", "registry.ollama.ai", "library", "-rf");
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "latest"), JSON.stringify({ layers: [] }));
  old(join(m, "latest"), 200);
  const ext = join(s0.home, ".vscode", "extensions");
  mkdirSync(join(ext, "pub.tool-1.0.0"), { recursive: true });
  writeFileSync(join(ext, ".obsolete"), JSON.stringify({ ".": true, "..": true, "pub.tool-1.0.0": true, "../x": true }));
  const s = { ...s0, which: (b: string) => (b === "ollama" ? "/fake/ollama" : null) };
  expect(scan("models", s)).toEqual([]);
  expect(scan("versions", s).map((i) => i.path)).toEqual([join(ext, "pub.tool-1.0.0")]);
});

test("a scan's command that never returns is killed after its time, and the daemon's git never waits for a password", async () => {
  const t = Date.now();
  expect(await runAsync(["sleep", "30"], undefined, 200)).toEqual({ ok: false, out: "" });
  expect(Date.now() - t).toBeLessThan(5_000);
  expect(gitEnv({}).GIT_TERMINAL_PROMPT).toBe("0");
});

test("Plan keeps an older Playwright build that a still-installed Playwright pins, and offers one nothing pins", async () => {
  const root = scratch("pins");
  const s = scopeOf(root, cfgWith());
  const cache = join(s.home, PLAYWRIGHT);
  for (const b of ["chromium-1187", "chromium-1243", "chromium_headless_shell-1243", "chromium_headless_shell-1248"])
    mkdirSync(join(cache, b), { recursive: true });
  const install = join(root, "app", "node_modules", "playwright-core");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: "1243" }] }));
  mkdirSync(join(cache, ".links"));
  writeFileSync(join(cache, ".links", "a"), `${install}\n`);
  writeFileSync(join(cache, ".links", "gone"), join(root, "removed", "playwright-core")); // an install deleted since
  const offered = (await planCleanup({ ...s, now: Date.now() + DAY })).filter((i) => i.path.startsWith(cache)).map((i) => basename(i.path));
  expect(offered).toEqual(["chromium-1187"]);
});

test("olderVersions keeps the newest build of each name; dockerBytes reads Docker's decimal units", () => {
  expect(olderVersions(["chromium-1187", "chromium-1243", "ffmpeg-1011", "chromium_headless_shell-1243", "b"])).toEqual(["chromium-1187"]);
  expect(olderVersions(["mac_arm-131.0.6778.85", "mac_arm-140.0.1", "linux-1.0"])).toEqual(["mac_arm-131.0.6778.85"]);
  expect(dockerBytes("1.5GB")).toBe(1.5e9);
  expect(dockerBytes("2MB (virtual 1GB)")).toBe(2e6);
  expect(dockerBytes("0B")).toBe(0);
});

test("docs/cleanup-sources.md is printed from the sources: every rule has its row and every row a rule", () => {
  expect(readFileSync(join(SRC, "docs", "cleanup-sources.md"), "utf8")).toBe(sourcesTable());
  const ids = SOURCES.map((x) => x.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(SOURCES.every((x) => x.ref.startsWith("https://"))).toBe(true);
  // every category's rules come from here
  for (const c of CLEANUP_CATEGORIES) expect(SOURCES.some((x) => x.category === c)).toBe(true);
});

test("autoDue: never off or busy, at most every six hours, early below the free-space threshold, else on schedule", () => {
  const now = 100 * DAY;
  const weekly = { schedule: "weekly" as const, belowFreeGb: 20 };
  const o = { freeGb: 50, lastAt: now - 8 * DAY, now, idle: true };
  expect(autoDue({ ...weekly, schedule: "off" }, { ...o, freeGb: 1 })).toBeNull();
  expect(autoDue(weekly, { ...o, idle: false })).toBeNull();
  expect(autoDue(weekly, o)).toBe("the weekly cleanup");
  expect(autoDue(weekly, { ...o, lastAt: now - 3 * DAY })).toBeNull();
  expect(autoDue({ ...weekly, schedule: "daily" }, { ...o, lastAt: now - 2 * DAY })).toBe("the daily cleanup");
  expect(autoDue(weekly, { ...o, lastAt: now - 3 * DAY, freeGb: 12.34 })).toBe("free space is down to 12.3 GB");
  expect(autoDue(weekly, { ...o, lastAt: now - 3_600_000, freeGb: 1 })).toBeNull(); // just ran: don't loop
});

test("freeGb: a folder that doesn't exist yet reads its nearest existing parent's volume", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-free-"));
  // the same volume; other writers move free space a little between the two reads
  expect(Math.abs(freeGb(join(dir, "Code", "not", "made")) - freeGb(dir))).toBeLessThan(1);
  rmSync(dir, { recursive: true, force: true });
});

test("diskGuard: new agents wait below the floor", () => {
  expect(diskGuard(2.5, 3)).toBe("only 2.5 GB free (the floor is 3 GB)");
  expect(diskGuard(3, 3)).toBeNull();
  expect(diskGuard(80, 3)).toBeNull();
});

test("An older flat cleanup config moves into categories, and its docker and simulator commands become opt-in categories", () => {
  const raw = {
    owner: { name: "t", keychainAccount: "t" },
    accounts: [],
    clients: [],
    cleanup: {
      staleWorktreeDays: 9,
      keepClaudeVersions: 4,
      caches: ["~/my-cache"],
      commands: ["brew cleanup -s", "docker system prune -f", "xcrun simctl delete unavailable", "my-tool gc"],
      opsLogDays: 3,
    },
  };
  const dir = scratch("legacy");
  writeFileSync(join(dir, "overhand.config.json"), JSON.stringify(raw));
  const c = loadConfig(dir).cleanup;
  expect(c.categories.worktrees.staleDays).toBe(9);
  expect(c.categories.versions.keep).toBe(4);
  expect(c.categories.logs.days).toBe(3);
  expect(c.categories.caches.paths).toContain("~/my-cache");
  expect(c.categories.caches.commands).toEqual(["pnpm store prune", "brew cleanup -s", "my-tool gc"]);
  expect(c.categories.docker.enabled).toBe(false);
  expect(c.auto.schedule).toBe("off");
  expect(c.minFreeGb).toBe(3);
});

test(
  "Janitor: idle unmerged worktrees lose node_modules and test artifacts, not their work; a closed PR's worktree goes",
  async () => {
    const root = scratch("janitor");
    const s = scopeOf(root, cfgWith(), { now: Date.now() + 10 * DAY });
    const repo = join(s.code, "honeycrust", "app");
    git(s.code, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(s.code, "clone", "-q", join(s.code, "origin.git"), repo);
    writeFileSync(join(repo, ".gitignore"), "node_modules\ntest-results\n");
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const wt = (name: string) => {
      git(repo, "worktree", "add", "-q", "-b", name, join(s.code, name), "origin/main");
      const at = join(s.code, name);
      writeFileSync(join(at, "a.txt"), name);
      git(at, "commit", "-qam", "unpushed work");
      mkdirSync(join(at, "node_modules", "react"), { recursive: true });
      mkdirSync(join(at, "test-results", "shots"), { recursive: true });
      return at;
    };
    const ahead = wt("ahead");
    const dirty = wt("dirty");
    writeFileSync(join(dirty, "wip.ts"), "uncommitted");
    const busy = wt("busy");
    const closed = wt("closed");
    const scope: Scope = { ...s, busy: [busy], prState: (_r, branch) => (branch === "closed" ? "CLOSED" : "") };

    const items = scan("worktrees", scope);
    const paths = items.map((i) => i.path.replace(`${s.code}/`, "")).sort();
    expect(paths).toEqual(["ahead/node_modules", "ahead/test-results", "closed", "dirty/node_modules", "dirty/test-results"]);
    expect(items.find((i) => i.path === closed)?.why).toMatch(/pull request was closed/);
    expect(items.every((i) => i.auto && i.checked && (i.usedAt ?? 0) > 0)).toBe(true);
    // freshly used worktrees keep everything
    expect(scan("worktrees", { ...scope, now: Date.now() + 2 * DAY }).filter((i) => i.kind === "dir")).toEqual([]);

    const r = runCleanup(items, scope);
    expect(r.failed).toEqual([]);
    expect(r.freedKb).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(ahead, "node_modules"))).toBe(false);
    expect(existsSync(join(dirty, "test-results"))).toBe(false);
    expect(readFileSync(join(dirty, "wip.ts"), "utf8")).toBe("uncommitted"); // the work stays
    expect(existsSync(ahead) && existsSync(dirty)).toBe(true);
    expect(existsSync(join(busy, "node_modules", "react"))).toBe(true); // an agent works there
    expect(existsSync(closed)).toBe(false);
    expect(git(repo, "rev-parse", "-q", "--verify", "closed")).not.toBe(""); // its branch stays
  },
  GIT_HEAVY_MS,
);

test(
  "Janitor: a second clean clone of a remote is listed for you to confirm; a dirty one and the project's own clone never",
  async () => {
    const root = scratch("clones");
    const s = scopeOf(root, cfgWith(), { now: Date.now() + DAY });
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    const clone = (at: string) => {
      git(root, "clone", "-q", join(root, "origin.git"), at);
      return at;
    };
    const seed = clone(join(root, "seed"));
    writeFileSync(join(seed, "a.txt"), "1");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "one");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const project = clone(join(s.code, "honeycrust", "app")); // the configured project's clone: kept
    const dup = clone(join(s.code, "copies", "app"));
    const dirty = clone(join(s.code, "copies", "app-wip"));
    writeFileSync(join(dirty, "wip.txt"), "x");
    const stashed = clone(join(s.code, "copies", "app-stash"));
    writeFileSync(join(stashed, "a.txt"), "changed");
    git(stashed, "stash", "-q");

    const items = scan("clones", s);
    expect(items.map((i) => i.path)).toEqual([dup]);
    expect(items[0]?.why).toContain(project);
    expect(items.every((i) => i.personal && !i.checked && !i.auto)).toBe(true);

    const ticked = items.map((i) => ({ ...i, checked: true }));
    const unattended = runCleanup(
      ticked,
      s,
      () => s,
      () => {},
      true,
    );
    expect(unattended.skipped.map((x) => x.why)).toEqual(["it's in your own checkout, which is never cleaned unattended"]);
    expect(runCleanup(ticked, s).skipped.map((x) => x.why)).toEqual(["it's in your own checkout and you didn't confirm removing it"]);
    expect(existsSync(dup)).toBe(true);
    expect(
      runCleanup(
        ticked.map((i) => ({ ...i, confirmed: i.path })),
        s,
      ).removed,
    ).toBe(1);
    expect(existsSync(dup)).toBe(false);
    expect([project, dirty, stashed].every((p) => existsSync(join(p, ".git")))).toBe(true);
  },
  GIT_HEAVY_MS,
);

test("dropVoiceModel: the old voice model folder goes once; a link named voice is left alone", () => {
  const ops = scratch("voice");
  mkdirSync(join(ops, "voice", "model"), { recursive: true });
  writeFileSync(join(ops, "voice", "model", "weights.onnx"), "x");
  expect(dropVoiceModel(ops)).toBe(true);
  expect(existsSync(join(ops, "voice"))).toBe(false);
  expect(dropVoiceModel(ops)).toBe(false);
  const elsewhere = scratch("voice-target");
  symlinkSync(elsewhere, join(ops, "voice"));
  expect(dropVoiceModel(ops)).toBe(false);
  expect(existsSync(elsewhere)).toBe(true);
});

test("remoteKey: one key per remote whatever the protocol; oldRuntimes: deletable runtimes beyond the newest per platform", () => {
  const keys = [
    "git@github.com:Acme/App.git",
    "https://github.com/acme/app",
    "ssh://git@github.com/acme/app.git",
    "https://u@github.com/acme/app/",
  ];
  expect(new Set(keys.map(remoteKey))).toEqual(new Set(["github.com/acme/app"]));
  expect(remoteKey("ssh://git@host:2222/a/b.git")).toBe("host:2222/a/b");
  const ios = "com.apple.platform.iphonesimulator";
  const json = JSON.stringify({
    a: {
      identifier: "A",
      version: "17.5",
      platformIdentifier: ios,
      sizeBytes: 7 * 1024 ** 3,
      deletable: true,
      lastUsedAt: "2026-01-02T00:00:00Z",
    },
    b: { identifier: "B", version: "18.2", platformIdentifier: ios, sizeBytes: 8 * 1024 ** 3, deletable: true },
    c: { identifier: "C", version: "17.0", platformIdentifier: ios, sizeBytes: 1024, deletable: false }, // bundled with Xcode
    d: { identifier: "D", version: "10.0", platformIdentifier: "com.apple.platform.watchsimulator", sizeBytes: 1024, deletable: true },
  });
  expect(oldRuntimes(json)).toEqual([
    { id: "A", name: "iphonesimulator 17.5", kb: 7 * 1024 ** 2, usedAt: Date.parse("2026-01-02T00:00:00Z") },
  ]);
  expect(oldRuntimes("not json")).toEqual([]);
});
