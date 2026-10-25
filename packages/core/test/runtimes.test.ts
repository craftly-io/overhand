import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_SCHEMA } from "../src/agent";
import { GUARD_CONFIG } from "../src/agent-home";
import { checked } from "../src/claude";
import { blankConfig, type Config } from "../src/config";
import { OPS } from "../src/env";
import { RUNTIMES } from "../src/runtimes";
import { knownCost } from "../src/runtimes/claude-code";
import { guardArgs, strictSchema } from "../src/runtimes/codex";
import { extractJson, type RunInput, stepOf, stepReader } from "../src/runtimes/runtime";
import { checks } from "../src/setup";

/** Real CLI output recorded through Overhand's own runs (logs/<name>: stdout, then "--- stderr ---" and stderr). */
const FIXTURES = join(import.meta.dir, "fixtures", "runtimes");
const stdoutOf = (name: string): string => readFileSync(join(FIXTURES, name), "utf8").split("\n--- stderr ---\n")[0] ?? "";

const SCHEMA = JSON.stringify({
  type: "object",
  properties: { status: { type: "string", enum: ["done", "failed"] }, message: { type: "string" } },
  required: ["status", "message"],
});

const input = (over: Partial<RunInput> = {}): RunInput => ({
  account: "a",
  cwd: "",
  prompt: "Fix it",
  schema: SCHEMA,
  schemaFile: "/tmp/s.json",
  alias: "",
  provider: { kind: "claude", auth: "login" },
  model: "",
  attribution: false,
  args: [],
  configDir: "",
  instructions: "",
  read: (s) => ({ "claude-token-a": "oat", "codex-key-a": "sk-cx", "gemini-key-a": "gk", gw: "sk-gw" })[s] ?? null,
  ...over,
});

test("Claude Code keeps today's argv: stream-json, the schema, auto mode, no attribution, the alias", () => {
  const s = RUNTIMES["claude-code"].task(input({ alias: "haiku", configDir: "/ops/agent-home/claude-code" }));
  expect(s.argv).toEqual([
    "claude",
    "-p",
    "Fix it",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    SCHEMA,
    "--permission-mode",
    "auto",
    "--settings",
    JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: "" } }),
    "--model",
    "haiku",
    // its MCP servers come only from Overhand, strictly (mcpConfig)
    "--strict-mcp-config",
    "--mcp-config",
    expect.stringContaining("overhand-mcp-"),
  ]);
  expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // a stored subscription token is never picked up
  expect(s.env.CLAUDE_CONFIG_DIR).toBe("/ops/agent-home/claude-code");
  // the inbox's own permission mode wins
  expect(
    RUNTIMES["claude-code"].task(input({ args: ["--permission-mode", "dontAsk"] })).argv.filter((x) => x === "--permission-mode"),
  ).toHaveLength(1);
  const lead = RUNTIMES["claude-code"].lead(input({ attribution: true }));
  expect(lead.argv).toEqual([
    ...["claude", "-p", "Fix it", "--permission-mode", "auto", "--output-format", "stream-json", "--verbose"],
    ...["--strict-mcp-config", "--mcp-config", expect.stringContaining("overhand-mcp-")],
  ]);
});

test("an account on its own sign-in runs in its own config folder, with the instructions by flag and no credential", () => {
  const home = "/ops/agent-home/accounts/a";
  const s = RUNTIMES["claude-code"].task(input({ configDir: home, instructions: "/ops/agent-home/claude-code/CLAUDE.md" }));
  expect(s.env.CLAUDE_CONFIG_DIR).toBe(home);
  expect(s.argv.join(" ")).toContain("--append-system-prompt-file /ops/agent-home/claude-code/CLAUDE.md");
  for (const v of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(s.env[v]).toBeUndefined();
  // the shared home already holds the instructions: no flag there
  const shared = RUNTIMES["claude-code"].task(input({ configDir: "/h", instructions: "/h/CLAUDE.md" }));
  expect(shared.argv).not.toContain("--append-system-prompt-file");
  expect(RUNTIMES["claude-code"].lead(input({ configDir: home })).env.CLAUDE_CONFIG_DIR).toBe(home);
});

test("Claude Code parses its stream: result, structured output, cost, usage", () => {
  const stream = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","utilization":0.4,"resetsAt":1760000000}}',
    '{"type":"result","is_error":false,"result":"done","structured_output":{"status":"done","message":"ok"},"total_cost_usd":0.12}',
  ].join("\n");
  const out = RUNTIMES["claude-code"].parse(stream, "", 0);
  expect(out).toMatchObject({ ok: true, text: "done", structured: { status: "done", message: "ok" }, cost: 0.12 });
  expect(RUNTIMES["claude-code"].parse("boom", "Not logged in", 1)).toMatchObject({ ok: false, text: "boom\nNot logged in" });
});

test("Codex: exec --json in a workspace-write sandbox with network, the strict schema as a file, -m, CODEX_API_KEY; parses its JSONL", () => {
  const s = RUNTIMES.codex.task(input({ model: "gpt-5.5" }));
  expect(s.argv).toEqual([
    "codex",
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([join(OPS, "slots")])}`,
    ...guardArgs(),
    "--output-schema",
    "/tmp/s.json",
    "-m",
    "gpt-5.5",
    "Fix it",
  ]);
  expect(JSON.parse(s.files["/tmp/s.json"] ?? "")).toEqual({ ...JSON.parse(SCHEMA), additionalProperties: false });
  expect(s.env.CODEX_API_KEY).toBe("sk-cx");
  // the event shapes from the non-interactive docs
  const jsonl = [
    '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"{\\"status\\":\\"done\\",\\"message\\":\\"fixed\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}',
  ].join("\n");
  expect(RUNTIMES.codex.parse(jsonl, "", 0)).toMatchObject({ ok: true, structured: { status: "done", message: "fixed" } });
  const failed = '{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"stream disconnected"}}';
  expect(RUNTIMES.codex.parse(failed, "", 1)).toMatchObject({ ok: false, text: "stream disconnected" });
});

test("Codex makes the repo's git folder writable in its sandbox, so it can commit", () => {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.toString().trim();
  const argv = RUNTIMES.codex.task(input({ cwd: process.cwd() })).argv;
  expect(argv).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([git, join(OPS, "slots")])}`);
});

test("Codex strict schema: closed objects, every property required, optional ones nullable; nulls dropped again before checking", () => {
  expect(strictSchema(JSON.parse(RESULT_SCHEMA))).toMatchObject({
    additionalProperties: false,
    required: ["status", "pr_title", "pr_body", "message", "verified", "parts"],
    properties: {
      status: { type: "string", enum: ["done", "question", "failed"] },
      parts: {
        type: ["array", "null"],
        items: { type: "object", required: ["title", "scope"], additionalProperties: false },
      },
    },
  });
  const out = { ok: true, text: "", cost: 0, usage: null };
  const answer = { status: "done", pr_title: "t", pr_body: "b", message: "m", verified: null, parts: null };
  expect(checked(RUNTIMES.codex, RESULT_SCHEMA, { ...out, structured: answer })).toEqual({
    value: { status: "done", pr_title: "t", pr_body: "b", message: "m" },
    problem: "",
  });
  // a structured answer that breaks the schema (a local model's) is caught, not trusted
  expect(checked(RUNTIMES.codex, RESULT_SCHEMA, { ...out, structured: { status: "maybe" } }).value).toBeUndefined();
});

test("Codex on a gateway account: --oss through Ollama with the gateway's model, the JSON asked in the prompt (no --output-schema)", () => {
  const gw = { kind: "gateway" as const, baseUrl: "http://localhost:11434/", secret: "", model: "qwen3:1.7b", smallModel: "" };
  const s = RUNTIMES.codex.task(input({ provider: gw }));
  expect(s.argv.slice(9 + guardArgs().length, 14 + guardArgs().length)).toEqual([
    "--oss",
    "--local-provider",
    "ollama",
    "-m",
    "qwen3:1.7b",
  ]);
  expect(s.argv).not.toContain("--output-schema");
  expect(s.argv.at(-1)).toContain("matches this JSON Schema");
  expect(s.files).toEqual({});
  expect(s.env.CODEX_OSS_BASE_URL).toBe("http://localhost:11434/v1");
});

test("Codex real runs (codex-cli 0.163.0, --oss, qwen3:1.7b): the edit, a recovered reconnect, the live line", () => {
  // the hello.txt edit through Overhand's claude(): it ran `echo 'hi' > hello.txt`, then answered
  const edit = RUNTIMES.codex.parse(stdoutOf("codex-edit.jsonl"), "", 0);
  expect(edit.ok).toBe(true);
  expect(checked(RUNTIMES.codex, RESULT_SCHEMA, edit).value).toMatchObject({ status: "done", pr_title: "Add hello.txt" });
  expect(RUNTIMES.codex.readable?.(stdoutOf("codex-edit.jsonl"), 3).split("\n")).toEqual([
    "→ Bash: /bin/zsh -lc \"echo 'hi' > hello.txt\"",
    expect.stringContaining('{"status":"done"'),
    "✓ finished",
  ]);
  // an {"type":"error","message":"Reconnecting... 1/5 ..."} it recovered from doesn't fail a completed turn
  const reconnect = RUNTIMES.codex.parse(stdoutOf("codex-reconnect.jsonl"), "", 0);
  expect(reconnect.ok).toBe(true);
  expect(checked(RUNTIMES.codex, RESULT_SCHEMA, reconnect).value).toMatchObject({ status: "done" });
});

test("Gemini CLI: -p with the JSON ask, -o json, yolo approvals, -m; parses { response, stats, error }", () => {
  const s = RUNTIMES.gemini.task(input({ model: "gemini-2.5-pro" }));
  expect(s.argv.slice(0, 2)).toEqual(["gemini", "-p"]);
  expect(s.argv[2]).toContain("matches this JSON Schema");
  expect(s.argv.slice(3)).toEqual(["-o", "json", "--approval-mode", "yolo", "--skip-trust", "-m", "gemini-2.5-pro"]);
  expect(RUNTIMES.gemini.parse('{"response":"hi","stats":{"models":{}}}', "", 0)).toMatchObject({ ok: true, text: "hi" });
  expect(RUNTIMES.gemini.parse('{"error":{"type":"ApiError","message":"quota exceeded"}}', "", 1)).toMatchObject({
    ok: false,
    text: "quota exceeded",
  });
});

test("Cursor Agent: -p, --output-format json, -f, --model; parses its result and its signed-out error", () => {
  const s = RUNTIMES.cursor.lead(input({ model: "sonnet-4", schema: "" }));
  expect(s.argv).toEqual([
    "cursor-agent",
    "-p",
    "Fix it",
    "--output-format",
    "json",
    "--trust",
    "-f",
    "--model",
    "sonnet-4",
    "--plugin-dir",
    GUARD_CONFIG.cursor,
  ]);
  const ok =
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"duration_api_ms":1234,"result":"OK","session_id":"x"}';
  expect(RUNTIMES.cursor.parse(ok, "", 0)).toMatchObject({ ok: true, text: "OK" });
  // recorded from cursor-agent 2026.01.23 on this machine, signed out
  const signedOut = "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";
  expect(RUNTIMES.cursor.parse(signedOut, "", 1)).toMatchObject({ ok: false, text: signedOut });
});

test("Cursor Agent real runs (2026.01.23, model auto): the hello.txt edit's answer; a free plan refusing a named model", () => {
  const edit = RUNTIMES.cursor.parse(stdoutOf("cursor-edit.jsonl"), "", 0);
  expect(edit.ok).toBe(true);
  // prose before the JSON ("Creating `hello.txt`, then returning the requested JSON only.{...}")
  expect(checked(RUNTIMES.cursor, RESULT_SCHEMA, edit).value).toMatchObject({ status: "done", pr_title: "Add hello.txt" });
  const [stdout = "", stderr = ""] = readFileSync(join(FIXTURES, "cursor-free.txt"), "utf8").split("\n--- stderr ---\n");
  expect(RUNTIMES.cursor.parse(stdout, stderr, 1)).toMatchObject({
    ok: false,
    text: expect.stringContaining("Free plans can only use Auto"),
  });
});

test("OpenCode real run (1.19.3, Ollama qwen3:1.7b): the write tool made hello.txt; its answer and live line", () => {
  const raw = stdoutOf("opencode-edit.jsonl");
  const out = RUNTIMES.opencode.parse(raw, "", 0);
  expect(out.ok).toBe(true);
  expect(checked(RUNTIMES.opencode, RESULT_SCHEMA, out).value).toMatchObject({ status: "done", pr_title: "Add hello.txt" });
  expect(RUNTIMES.opencode.readable?.(raw, 10)).toContain("→ write: hello.txt");
});

test("OpenCode: run --format json --auto; a gateway account becomes an openai-compatible provider; parses text, cost, errors", () => {
  const plain = RUNTIMES.opencode.task(input({ model: "anthropic/claude-sonnet-4-5", schema: "" }));
  expect(plain.argv).toEqual(["opencode", "run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-4-5", "Fix it"]);
  const gw = RUNTIMES.opencode.task(
    input({
      schema: "",
      provider: { kind: "gateway", baseUrl: "http://localhost:11434/", secret: "", model: "qwen3:1.7b", smallModel: "" },
    }),
  );
  expect(gw.argv).toContain("overhand/qwen3:1.7b");
  expect(JSON.parse(gw.env.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
    provider: {
      overhand: {
        npm: "@ai-sdk/openai-compatible",
        name: "Overhand gateway",
        options: { baseURL: "http://localhost:11434/v1", apiKey: "overhand" },
        models: { "qwen3:1.7b": {} },
      },
    },
  });
  // event shapes from packages/cli/src/run/noninteractive.ts
  const jsonl = [
    '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"Hello "}}',
    '{"type":"text","timestamp":3,"sessionID":"s","part":{"type":"text","text":"there"}}',
    '{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"type":"step-finish","cost":0.002,"tokens":{"input":10,"output":2}}}',
  ].join("\n");
  expect(RUNTIMES.opencode.parse(jsonl, "", 0)).toMatchObject({ ok: true, text: "Hello there", cost: 0.002 });
  expect(RUNTIMES.opencode.parse('{"type":"error","error":{"name":"APIError","data":{"message":"no model"}}}', "", 1)).toMatchObject({
    ok: false,
    text: "no model",
  });
});

test("Aider: --message with the JSON ask, --yes-always, --model; Ollama through OLLAMA_API_BASE", () => {
  const s = RUNTIMES.aider.task(
    input({
      model: "ollama_chat/qwen3:1.7b",
      provider: { kind: "gateway", baseUrl: "http://127.0.0.1:11434", secret: "", model: "", smallModel: "" },
    }),
  );
  expect(s.argv[0]).toBe("aider");
  expect(s.argv[2]).toContain("Make your file changes first. Then end your reply with one JSON object");
  expect(s.argv.slice(3)).toEqual([
    "--yes-always",
    "--no-pretty",
    "--no-check-update",
    "--no-gitignore",
    "--input-history-file",
    "/dev/null",
    "--chat-history-file",
    "/dev/null",
    "--no-suggest-shell-commands",
    "--no-auto-test",
    "--no-auto-lint",
    "--aiderignore",
    GUARD_CONFIG.aider,
    "--config",
    GUARD_CONFIG.aiderConfig,
    "--env-file",
    "/dev/null",
    "--model",
    "ollama_chat/qwen3:1.7b",
  ]);
  expect(s.env.OLLAMA_API_BASE).toBe("http://127.0.0.1:11434");
  expect(RUNTIMES.aider.parse("Applied edit to a.ts\nCommit 1a2b3c fix", "", 0)).toMatchObject({ ok: true });
});

test("Aider through any other OpenAI-compatible gateway: openai/<model> at --openai-api-base, its token as OPENAI_API_KEY", () => {
  const gw = { kind: "gateway" as const, baseUrl: "https://openrouter.ai/api/", secret: "gw", model: "qwen/qwen3-coder", smallModel: "" };
  const s = RUNTIMES.aider.task(input({ provider: gw, schema: "" }));
  expect(s.argv.slice(-4)).toEqual(["--openai-api-base", "https://openrouter.ai/api/v1", "--model", "openai/qwen/qwen3-coder"]);
  expect(s.env.OPENAI_API_KEY).toBe("sk-gw");
  expect(s.env.OLLAMA_API_BASE).toBeUndefined();
});

test("Aider real runs (0.86.2, Ollama): the edit then the answer in one reply; an edit it couldn't apply fails the run", () => {
  // llama3.1:8b: a whole-file edit, the JSON, then "Applied edit to hello.txt"
  const edit = RUNTIMES.aider.parse(stdoutOf("aider-edit.txt"), "", 0);
  expect(edit.ok).toBe(true);
  expect(checked(RUNTIMES.aider, RESULT_SCHEMA, edit).value).toMatchObject({ status: "done", pr_title: "Add hello.txt" });
  expect(RUNTIMES.aider.readable?.(stdoutOf("aider-edit.txt"), 1)).toBe("Commit 6a1592d feat: Add hello.txt");
  // qwen2.5-coder:7b said "done" with a JSON answer, but Aider couldn't apply its edit: nothing changed, so not ok
  expect(RUNTIMES.aider.parse(stdoutOf("aider-nonconform.txt"), "", 0).ok).toBe(false);
});

test("the JSON answer is found after code with braces in it (Aider's edit blocks)", () => {
  expect(extractJson('function f() { return 1; }\n\n{"status":"done","message":"ok"}\nTokens: 9 sent')).toEqual({
    status: "done",
    message: "ok",
  });
});

test("without schema enforcement the answer is the JSON object in the reply, validated against the schema", () => {
  const out = (text: string) => ({ ok: true, text, structured: undefined, cost: 0, usage: null });
  const g = RUNTIMES.gemini;
  expect(checked(g, SCHEMA, out('Sure!\n```json\n{"status":"done","message":"ok"}\n```')).value).toEqual({ status: "done", message: "ok" });
  expect(checked(g, SCHEMA, out('{"status":"maybe","message":"ok"}')).value).toBeUndefined();
  expect(checked(g, SCHEMA, out("no json here")).problem).toBe("no JSON object in the reply");
  // a CLI that enforces the schema: its structured answer, still checked
  expect(checked(RUNTIMES["claude-code"], SCHEMA, { ...out(""), structured: { status: "done", message: "x" } }).value).toEqual({
    status: "done",
    message: "x",
  });
});

test("a model Claude Code can't price doesn't count against the budget", () => {
  const local = { total_cost_usd: 0.0856, modelUsage: { "qwen3:1.7b": { costUSD: 0.0856, costBasis: "unknown" } } };
  expect(knownCost(local)).toBe(0);
  const mixed = {
    total_cost_usd: 0.3,
    modelUsage: { "claude-haiku-5-5": { costUSD: 0.2 }, "qwen3:1.7b": { costUSD: 0.1, costBasis: "unknown" } },
  };
  expect(knownCost(mixed)).toBeCloseTo(0.2);
  expect(knownCost({ total_cost_usd: 1.5 })).toBe(1.5);
});

test("a Claude Code lead keeps your config and gets the guard through --settings, alongside no-attribution", () => {
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x guard || exit 2" }] }] };
  const { argv, env } = RUNTIMES["claude-code"].lead(input({ attribution: false, hooks }));
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}");
  expect(settings.hooks).toEqual(hooks);
  expect(settings.attribution.commit).toBe("");
  expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("doctor requires the agent CLIs the accounts run, claude only for a Claude Code account, and one before any account", async () => {
  const bin = mkdtempSync(join(tmpdir(), "overhand-path-"));
  const saved = { PATH: process.env.PATH, OVERHAND_SECRETS_FILE: process.env.OVERHAND_SECRETS_FILE };
  // an empty PATH (nothing installed, no gh to ask) and a secrets file, so the real Keychain is never read
  Object.assign(process.env, { PATH: bin, OVERHAND_SECRETS_FILE: join(bin, "secrets.json") });
  try {
    const what = async (over: Partial<Config>) => (await checks({ ...blankConfig("t"), ...over }, bin)).map((c) => c.what);
    const codexOnly = await what({ accounts: ["a"], runtimes: { a: { kind: "codex", model: "" } } });
    expect(codexOnly.some((w) => w.includes("(claude)"))).toBe(false);
    expect(codexOnly.some((w) => w.includes("(codex)"))).toBe(true);
    expect((await what({ accounts: ["a"] })).some((w) => w.includes("(claude)"))).toBe(true); // no runtime set: Claude Code
    const none = await what({});
    expect(none).toContain("a coding agent on PATH");
    expect(none.some((w) => w.includes("(claude)"))).toBe(false);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("a run's steps come from the tool calls in its own output, never from what a tool printed", () => {
  const tool = (name: string, input: object) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(stepOf(tool("Read", { file_path: "/w/package.json" }))).toBeNull();
  expect(stepOf(tool("Edit", { file_path: "/w/README.md" }))).toBe("change");
  expect(stepOf(tool("Bash", { command: "npm test" }))).toBe("checks");
  expect(stepOf(tool("Bash", { command: "bun run typecheck && bun run lint" }))).toBe("checks");
  expect(stepOf(tool("Bash", { command: "git commit -m 'docs: run steps'" }))).toBe("change");
  expect(stepOf(tool("Bash", { command: "cat test/split.test.js" }))).toBeNull();
  // Codex's events: a command (an argv) and a file change
  expect(stepOf(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: ["bash", "-lc", "pnpm test"] } }))).toBe(
    "checks",
  );
  expect(stepOf(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [] } }))).toBe("change");
  // a tool's result that mentions a test run is output, not a step
  expect(
    stepOf(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ran npm test: 3 pass" }] } })),
  ).toBeNull();
});

test("the step reader hears each later step once, across chunks cut mid-line, and never goes back", () => {
  const heard: string[] = [];
  const read = stepReader((s) => heard.push(s));
  const edit = JSON.stringify({ type: "tool_use", name: "Write", input: { file_path: "a" } });
  const check = JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "npm test" } });
  read(edit.slice(0, 10));
  read(`${edit.slice(10)}\n${edit}\n`);
  read(`${check}\n${edit}\n${check}\n`);
  expect(heard).toEqual(["change", "checks"]);
});
