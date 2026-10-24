import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUARD_BLOCKS_CLAIM,
  GUARD_CONFIRMED,
  GUARD_COVERAGE,
  GUARD_REACH,
  GUARD_UNCONFIRMED,
  guardLine,
  NO_MERGE_CLAIM,
  NO_SHELL_CONFIRMED,
  QUIET_CLAIM,
  RUNTIME_NAMES,
} from "@overhand/contract";
import { AIDER_IGNORE, GUARD_CONFIG, writeGuardConfigs } from "../src/agent-home";
import { unwrapHeavy } from "../src/governor";
import { check } from "../src/guard";
import { CASES, conformance, HOOKED } from "../src/guard-conformance";
import { eventOf, patchEdits } from "../src/guard-dialects";
import { RUNTIMES } from "../src/runtimes";
import type { RunInput } from "../src/runtimes/runtime";

const scratch = (): string => mkdtempSync(join(tmpdir(), "overhand-parity-"));

/** An Overhand home with the governor off, so a full test run is ordinary work here (the governor has its own tests). */
function home(): string {
  const dir = scratch();
  const governor = { enabled: false };
  writeFileSync(
    join(dir, "overhand.config.json"),
    JSON.stringify({ owner: { name: "t", keychainAccount: "t" }, accounts: [], clients: [], governor }),
  );
  return dir;
}

test("every hook-capable CLI's generated guard blocks merges, force pushes, deploys, keys and protected files, and lets ordinary work through", async () => {
  const dir = home();
  const rows = await conformance(dir);
  expect(rows.length).toBe(HOOKED.length * CASES.length);
  for (const r of rows) expect([r.dialect, r.case, r.pass, r.result]).toEqual([r.dialect, r.case, true, r.result]);
  expect(readFileSync(join(dir, "guardrails.jsonl"), "utf8")).toContain('"run":"HONEY-1"');
}, 60_000);

const input = (over: Partial<RunInput> = {}): RunInput => ({
  account: "a",
  cwd: "",
  prompt: "Fix it",
  schema: "",
  schemaFile: "",
  alias: "",
  provider: { kind: "claude", auth: "login" },
  model: "",
  attribution: false,
  args: [],
  configDir: "",
  instructions: "",
  read: () => null,
  run: "HONEY-1",
  project: "Honeycrust",
  ...over,
});

test("each runtime's run carries its guard and the environment the guard reads, on act and on watch", () => {
  for (const autonomy of ["act", "watch"] as const) {
    const r = input({ autonomy });
    const codex = RUNTIMES.codex.task(r);
    expect(codex.argv).toContain("--dangerously-bypass-hook-trust");
    expect(codex.argv.some((a) => a.startsWith("hooks.PreToolUse=") && a.includes(" guard codex || exit 2"))).toBe(true);
    expect(RUNTIMES.gemini.task({ ...r, read: () => "gk" }).env.GEMINI_CLI_HOME).toBe(GUARD_CONFIG.gemini);
    expect(() => RUNTIMES.gemini.task(r)).toThrow("no Gemini API key");
    const cursor = RUNTIMES.cursor.task(r).argv;
    expect(cursor[cursor.indexOf("--plugin-dir") + 1]).toBe(GUARD_CONFIG.cursor);
    expect(RUNTIMES.opencode.task(r).env.OPENCODE_CONFIG_DIR).toBe(GUARD_CONFIG.opencode);
    const aider = RUNTIMES.aider.task(r).argv;
    for (const flag of ["--no-suggest-shell-commands", "--no-auto-test", "--no-auto-lint"]) expect(aider).toContain(flag);
    expect(aider[aider.indexOf("--config") + 1]).toBe(GUARD_CONFIG.aiderConfig);
    expect(aider[aider.indexOf("--env-file") + 1]).toBe("/dev/null");
    expect(aider[aider.indexOf("--aiderignore") + 1]).toBe(GUARD_CONFIG.aider);
    for (const rt of Object.values(RUNTIMES))
      expect([
        rt.id,
        rt.task({ ...r, read: () => "k" }).env.OVERHAND_AUTONOMY,
        rt.task({ ...r, read: () => "k" }).env.OVERHAND_RUN,
      ]).toEqual([rt.id, autonomy, "HONEY-1"]);
  }
});

test("the guard configs are written where the runs look for them, Cursor's failing closed", () => {
  const root = scratch();
  writeGuardConfigs(root);
  const at = (p: string) => join(root, p.slice(GUARD_CONFIG.gemini.indexOf("agent-home/") + "agent-home/".length));
  expect(JSON.parse(readFileSync(join(at(GUARD_CONFIG.gemini), ".gemini", "settings.json"), "utf8")).hooks.BeforeTool[0].matcher).toBe("*");
  const manifest = JSON.parse(readFileSync(join(at(GUARD_CONFIG.cursor), ".cursor-plugin", "plugin.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(at(GUARD_CONFIG.cursor), manifest.hooks), "utf8"));
  expect(Object.values(hooks.hooks).every((h) => (h as { failClosed: boolean }[])[0]?.failClosed === true)).toBe(true);
  expect(readFileSync(join(at(GUARD_CONFIG.opencode), "plugins", "overhand-guard.js"), "utf8")).toContain("tool.execute.before");
  expect(readFileSync(at(GUARD_CONFIG.aider), "utf8").trim().split("\n")).toEqual(AIDER_IGNORE);
});

test("Aider's ignore list covers files the guard's own rules block", () => {
  const samples: Record<string, string> = {
    ".env.prod*": "/repo/web/.env.production",
    "*password*": "/repo/docs/passwords.txt",
    "*Password*": "/repo/Admin Password.xlsx",
    "*PASSWORD*": "/repo/PASSWORDS.csv",
    "env.local.docx": "/repo/env.local.docx",
    ".ssh/": "/Users/sam/.ssh/id_rsa",
    ".aws/credentials": "/Users/sam/.aws/credentials",
    ".npmrc": "/Users/sam/.npmrc",
  };
  expect(Object.keys(samples)).toEqual(AIDER_IGNORE);
  for (const p of Object.values(samples)) expect([p, check("Read", { file_path: p }, [])]).toEqual([p, expect.any(String)]);
  // gitignore matches case for case: each spelling the guard blocks has its own pattern
  for (const [pattern, p] of Object.entries(samples))
    if (pattern.includes("*")) expect([pattern, new Bun.Glob(pattern).match(p.split("/").at(-1) ?? "")]).toEqual([pattern, true]);
});

test("a patch's files are each an edit; an MCP call keeps its server; Gemini's and Cursor's names become the guard's", () => {
  expect(patchEdits("*** Add File: a.ts\n*** Update File: b/c.ts\n*** Move to: d.ts\n", "/r").map((c) => c.input.file_path)).toEqual([
    "/r/a.ts",
    "/r/b/c.ts",
    "/r/d.ts",
  ]);
  expect(patchEdits("nothing", "/r")).toEqual([{ tool: "Edit", input: {} }]);
  expect(
    eventOf("gemini", { tool_name: "x", tool_input: {}, mcp_context: { server_name: "slack", tool_name: "slack_send_message" } }).calls[0]
      ?.tool,
  ).toBe("mcp__slack__slack_send_message");
  expect(
    eventOf("cursor", { hook_event_name: "beforeMCPExecution", mcp_server_name: "slack", tool_name: "slack_send_message" }).calls[0]?.tool,
  ).toBe("mcp__slack__slack_send_message");
  // Cursor sends an MCP call's arguments as a JSON string
  const mcp = { hook_event_name: "beforeMCPExecution", mcp_server_name: "slack", tool_name: "slack_send_message" };
  expect(eventOf("cursor", { ...mcp, tool_input: '{"channel_id":"C1"}' }).calls[0]?.input).toEqual({ channel_id: "C1" });
  expect(() => eventOf("cursor", { ...mcp, tool_input: "not json" })).toThrow();
  expect(eventOf("opencode", { tool_name: "slack_slack_send_message", tool_input: {} }).calls[0]?.tool).toBe(
    "mcp__opencode__slack_send_message",
  );
  expect(eventOf("gemini", { tool_name: "grep_search", tool_input: { dir_path: "/Users/sam/.ssh" } }).calls[0]).toEqual({
    tool: "Grep",
    input: { path: "/Users/sam/.ssh", glob: "" },
  });
  // Slack stays read-only for every agent
  expect(check("mcp__opencode__slack_send_message", {}, [])).not.toBeNull();
});

test("a CLI that can't take the governor's rewrite runs the wrap itself: the guard checks what's inside, not Overhand's path", () => {
  const self = ["/opt/bun", "/src/run.ts"];
  const wrap = "'/opt/bun' '/src/run.ts' heavy suite -- 'bun test'";
  expect(unwrapHeavy(wrap, self)).toBe("bun test");
  expect(unwrapHeavy("'/opt/bun' '/src/run.ts' heavy build --session ab-1 -- 'echo '\\''hi'\\'''", self)).toBe("echo 'hi'");
  expect(unwrapHeavy(`${wrap} && rm -rf ~`, self)).toBeNull();
  expect(unwrapHeavy("bun test", self)).toBeNull();
});

test("the coverage table says how the guard reaches every runtime; the claims widen only with confirmed rows", () => {
  expect(Object.keys(GUARD_COVERAGE).sort()).toEqual(Object.keys(RUNTIMES).sort());
  expect(guardLine("claude-code")).toMatch(
    /^Overhand blocks merges, deploys and secret files for this agent: .*Confirmed in a real run \(/,
  );
  expect(guardLine("aider")).toMatch(/^Overhand runs this agent with no shell commands: /);
  for (const id of GUARD_UNCONFIRMED) expect(guardLine(id)).toMatch(/^Overhand's guard is set up for this agent, not yet confirmed: /);
  const name = (id: string) => RUNTIME_NAMES[id] ?? id;
  // the firm part names exactly the CLIs whose hook a real run saw block; no-shell and unconfirmed ones are said apart
  const [firm = "", rest = ""] = NO_MERGE_CLAIM.split("once the required checks pass.");
  for (const id of [...GUARD_UNCONFIRMED, ...NO_SHELL_CONFIRMED]) {
    expect([id, firm.includes(name(id))]).toEqual([id, false]);
    expect([id, rest.includes(name(id))]).toEqual([id, true]);
  }
  for (const id of GUARD_CONFIRMED) expect(firm).toContain(name(id));
  expect(NO_SHELL_CONFIRMED).toEqual(["aider"]);
  expect(GUARD_REACH.split(". ")[0]).not.toContain("Aider");
  for (const claim of [GUARD_BLOCKS_CLAIM, QUIET_CLAIM]) for (const id of GUARD_UNCONFIRMED) expect(claim).not.toContain(name(id));
  // the README and SECURITY say where the guard stands in the table's own words
  const flat = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "..", f), "utf8").replace(/\s+/g, " ");
  for (const f of ["README.md", "SECURITY.md"]) expect([f, flat(f).includes(GUARD_REACH)]).toEqual([f, true]);
});
