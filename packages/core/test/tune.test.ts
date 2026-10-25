import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickSettingSchema } from "@overhand/contract";
import { blankConfig, deniedFlags, loadConfig, saveConfig, withQuick } from "../src/config";
import { RUNTIMES } from "../src/runtimes";
import type { RunInput } from "../src/runtimes/runtime";
import { cursorModel, tuneArgs } from "../src/runtimes/tune";
import { exhaustedUntil } from "../src/usage";

const input = (over: Partial<RunInput> = {}): RunInput => ({
  account: "a",
  cwd: "",
  prompt: "Fix it",
  schema: "",
  schemaFile: "/tmp/s.json",
  alias: "",
  provider: { kind: "claude", auth: "login" },
  model: "",
  attribution: false,
  args: [],
  configDir: "",
  instructions: "",
  read: (s) => (s.startsWith("gemini-key-") ? "gk" : null),
  ...over,
});

/** The flag and the value after it, or undefined when the flag is missing. */
const after = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
};

test("Claude Code: effort, fallback model, a per-run cap (tasks only), blocked tools and no skills", () => {
  const tune = { effort: "high", fallbackModel: "sonnet", maxRunUsd: 2, blockedTools: ["WebFetch", "mcp__slack"], skills: false };
  const task = RUNTIMES["claude-code"].task(input({ tune })).argv;
  expect(after(task, "--effort")).toBe("high");
  expect(after(task, "--fallback-model")).toBe("sonnet");
  expect(after(task, "--max-budget-usd")).toBe("2");
  expect(task).toContain("--disallowedTools=WebFetch,mcp__slack");
  expect(task).toContain("--disable-slash-commands");
  expect(after(task, "--permission-mode")).toBe("auto"); // the guard's mode is untouched
  const lead = RUNTIMES["claude-code"].lead(input({ tune })).argv;
  expect(after(lead, "--effort")).toBe("high");
  expect(lead).not.toContain("--max-budget-usd"); // a lead runs for hours
});

test("no tuning adds nothing: today's argv is unchanged", () => {
  // each run's MCP list has a private folder of its own (mcpConfig): the same argv but for that folder's name
  const same = (argv: string[]) => argv.map((a) => a.replace(/overhand-mcp-[^/]+/, "overhand-mcp-*"));
  for (const rt of Object.values(RUNTIMES)) expect(same(rt.task(input({ tune: {} })).argv)).toEqual(same(rt.task(input()).argv));
});

test("Codex takes effort as model_reasoning_effort, before the prompt", () => {
  const argv = RUNTIMES.codex.task(input({ tune: { effort: "xhigh" } })).argv;
  expect(after(argv, "-c")).toBe("sandbox_workspace_write.network_access=true");
  expect(argv).toContain('model_reasoning_effort="xhigh"');
  expect(argv.at(-1)).toBe("Fix it");
});

test("Gemini CLI: allowed MCP servers and its sandbox; no effort flag exists, so none is passed", () => {
  const argv = RUNTIMES.gemini.task(input({ tune: { mcpServers: ["github", "linear"], sandbox: true, effort: "high" } })).argv;
  expect(argv).toContain("--allowed-mcp-server-names=github,linear");
  expect(argv).toContain("--sandbox");
  expect(argv.join(" ")).not.toContain("high");
});

test("Cursor: effort rides on the model's brackets; sandbox enabled", () => {
  const argv = RUNTIMES.cursor.task(input({ model: "gpt-5", tune: { effort: "high", sandbox: true } })).argv;
  expect(after(argv, "--model")).toBe("gpt-5[effort=high]");
  expect(after(argv, "--sandbox")).toBe("enabled");
  expect(cursorModel("", "high")).toBe("");
  expect(cursorModel("m[fast=true]", "high")).toBe("m[fast=true]");
});

test("OpenCode --variant and Aider --reasoning-effort; OpenCode's prompt stays last", () => {
  const oc = RUNTIMES.opencode.task(input({ tune: { effort: "max" } })).argv;
  expect(after(oc, "--variant")).toBe("max");
  expect(oc.at(-1)).toBe("Fix it");
  expect(after(RUNTIMES.aider.task(input({ tune: { effort: "low" } })).argv, "--reasoning-effort")).toBe("low");
});

test("extra flags pass through unless one would loosen the guard; then none of them does", () => {
  expect(tuneArgs("claude-code", { extraArgs: ["--verbose"] }, true)).toEqual(["--verbose"]);
  const bad: [Parameters<typeof deniedFlags>[0], string][] = [
    ["claude-code", "--dangerously-skip-permissions"],
    ["claude-code", "--permission-mode=bypassPermissions"],
    ["claude-code", "--settings"],
    ["claude-code", "--add-dir"],
    ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ["codex", "-c"],
    ["codex", "--sandbox"],
    ["gemini", "--yolo"],
    ["gemini", "--approval-mode"],
    ["cursor", "-f"],
    ["cursor", "--approve-mcps"],
    ["opencode", "--auto"],
    ["aider", "--yes-always"],
  ];
  for (const [kind, flag] of bad) {
    expect(deniedFlags(kind, [flag, "x"])).toEqual([flag]);
    expect(tuneArgs(kind, { extraArgs: [flag, "x"] }, true)).toEqual([]);
  }
});

test("saving a config with a denied extra flag is refused", () => {
  const c = { ...blankConfig("me"), accounts: ["a"], runtimes: { a: { kind: "codex" as const, model: "", extraArgs: ["--yolo"] } } };
  expect(() => saveConfig(mkdtempSync(join(tmpdir(), "overhand-tune-")), c)).toThrow(/--yolo/);
});

test("pacing holds an account ahead of an even weekly pace until the week catches up", () => {
  const now = Date.UTC(2026, 9, 20);
  const day = 86_400_000;
  // 3 days of 7 left, 60% used: 4 days passed is 57%, so ahead; even again when 60% of the week has passed
  const u = { fiveHour: 0.1, fiveHourResetsAt: now + 3_600_000, sevenDay: 0.6, sevenDayResetsAt: now + 3 * day, status: "", at: now };
  expect(exhaustedUntil(u, now)).toBe(0);
  expect(exhaustedUntil(u, now, true)).toBe(now + 3 * day - 0.4 * 7 * day);
  expect(exhaustedUntil({ ...u, sevenDay: 0.5 }, now, true)).toBe(0); // behind pace
  expect(exhaustedUntil({ ...u, sevenDay: -1 }, now, true)).toBe(0); // no weekly window reported
});

test("Quick settings change one thing each: the budget, pacing, the look, a project's autonomy", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-quick-"));
  copyFileSync(join(import.meta.dir, "..", "..", "..", "overhand.config.example.json"), join(dir, "overhand.config.json"));
  const c = loadConfig(dir);
  const name = c.clients[0]?.name ?? "";
  expect(withQuick(c, { budgetUsd: 25 }).limits.dailyBudgetUsd).toBe(25);
  expect(withQuick(c, { budgetUsd: 0 }).limits.dailyBudgetUsd).toBe(0);
  expect(withQuick(c, { paceWeekly: true }).limits.paceWeekly).toBe(true);
  expect(c.look).toBe("overhand");
  expect(saveConfig(dir, withQuick(c, { look: "koi" })).look).toBe("koi");
  expect(QuickSettingSchema.safeParse({ look: "../x" }).success).toBe(false);
  const watched = withQuick(c, { project: name, autonomy: "watch" });
  expect(watched.clients[0]?.autonomy).toBe("watch");
  expect(watched.clients.slice(1)).toEqual(c.clients.slice(1));
  expect(saveConfig(dir, watched).clients[0]?.autonomy).toBe("watch"); // still a valid config
  expect(() => withQuick(c, { project: "nope", autonomy: "act" })).toThrow(/no project/);
});
