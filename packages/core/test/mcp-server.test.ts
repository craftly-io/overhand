import { afterAll, beforeAll, expect, test } from "bun:test";
import { overhandMcpServer, runMcpServers } from "../src/agent-home";
import { parseConfig } from "../src/config";
import { forgetRun, RUN_KEY_ENV, recordSpawn, runKey } from "../src/control";
import { CFG, OPS, UI_PORT } from "../src/env";
import { PROTOCOLS, reply } from "../src/mcp-server";
import { mcpConfig } from "../src/runtimes/claude-code";
import { handle } from "../src/server";

const LOCAL = `http://127.0.0.1:${UI_PORT}`;
// a stand-in daemon on a free port, answering through the real routes: the owner's daemon (4317) is never touched
let server: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const headers = new Headers(req.headers);
      headers.delete("host");
      const body = req.method === "GET" ? undefined : await req.text();
      return handle(new Request(`${LOCAL}${new URL(req.url).pathname}`, { method: req.method, headers, body }));
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const rpc = (method: string, params: object = {}, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const owner: Record<string, string | undefined> = {};
const textOf = (r: unknown): { text: string; isError: boolean } => {
  const res = (r as { result?: { content: { text: string }[]; isError: boolean } }).result;
  return { text: res?.content[0]?.text ?? "", isError: res?.isError ?? true };
};

test("initialize, tools/list and a tools/call speak MCP over JSON-RPC 2.0", async () => {
  const init = await reply(rpc("initialize", { protocolVersion: "2025-06-18" }), owner, base);
  expect(init).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  // a version it doesn't know gets the newest it speaks
  expect(await reply(rpc("initialize", { protocolVersion: "1999-01-01" }), owner, base)).toMatchObject({
    result: { protocolVersion: PROTOCOLS[0] },
  });
  expect(await reply(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), owner, base)).toBeNull();
  expect(await reply("{nope", owner, base)).toMatchObject({ id: null, error: { code: -32700 } });
  expect(await reply(rpc("resources/list"), owner, base)).toMatchObject({ error: { code: -32601 } });

  const list = (await reply(rpc("tools/list"), owner, base)) as {
    result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
  };
  expect(list.result.tools.map((t) => t.name)).toEqual(["status", "answer_lead", "ask_session", "ack_request"]);
  // a field with a default isn't required of the caller
  expect(list.result.tools.find((t) => t.name === "answer_lead")?.inputSchema.required).toEqual(["lead"]);

  // what's running and what needs you, from the daemon's own state
  const status = textOf(await reply(rpc("tools/call", { name: "status", arguments: {} }), owner, base));
  expect(status.isError).toBe(false);
  expect(status.text).toContain("At work:");
  expect(status.text).toContain("Needs you:");
  // a bad argument is the caller's error; the daemon's refusal is the tool's
  expect(await reply(rpc("tools/call", { name: "ack_request", arguments: {} }), owner, base)).toMatchObject({ error: { code: -32602 } });
  const ack = textOf(await reply(rpc("tools/call", { name: "ack_request", arguments: { id: "r-none", state: "done" } }), owner, base));
  expect(ack).toEqual({ text: "no request r-none", isError: true });
});

test("inside a run, its own key: no status, and answers only what the run may", async () => {
  const key = runKey();
  recordSpawn(OPS, { pid: process.pid, exited: new Promise(() => {}) }, { OVERHAND_RUN: "T-9", [RUN_KEY_ENV]: key });
  const leadApp = parseConfig({ ...CFG, godmode: [{ key: "app", label: "App", dir: "app" }] }).godmode;
  CFG.godmode = [...CFG.godmode, ...leadApp];
  process.env[RUN_KEY_ENV] = key;
  const run = { [RUN_KEY_ENV]: key };
  try {
    const list = (await reply(rpc("tools/list"), run, base)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["answer_lead", "ask_session", "ack_request"]);
    expect(await reply(rpc("tools/call", { name: "status", arguments: {} }), run, base)).toMatchObject({ error: { code: -32602 } });
    // a ticket run can't answer a lead's question as you
    const answer = textOf(await reply(rpc("tools/call", { name: "answer_lead", arguments: { lead: "app", text: "yes" } }), run, base));
    expect(answer).toEqual({ text: "Not answered: a run answers only its own lead's question", isError: true });
    const ack = textOf(await reply(rpc("tools/call", { name: "ack_request", arguments: { id: "r-none", state: "done" } }), run, base));
    expect(ack).toEqual({ text: "no request r-none", isError: true });
  } finally {
    delete process.env[RUN_KEY_ENV];
    CFG.godmode = CFG.godmode.filter((g) => g.key !== "app");
    forgetRun(OPS, process.pid);
  }
});

test("every run gets Overhand's server, a run on watch only that one", () => {
  expect(overhandMcpServer(true, "/bin/overhand")).toEqual({ command: "/bin/overhand", args: ["mcp"] });
  expect(overhandMcpServer(false, "/bin/bun", "/src")).toEqual({ command: "/bin/bun", args: ["/src/run.ts", "mcp"] });
  const servers = runMcpServers("/nowhere", "/nowhere");
  expect(Object.keys(servers)).toEqual(["overhand"]);
  const files: Record<string, string> = {};
  const base = { account: "a", cwd: "", prompt: "", schema: "", schemaFile: "", alias: "", model: "", configDir: "", instructions: "" };
  const r = { ...base, provider: { kind: "claude" as const, auth: "login" as const }, attribution: false, args: [], read: () => null };
  const file = mcpConfig({ ...r, autonomy: "watch", mcpServers: { ...servers, mine: { command: "x" } } }, files, OPS).at(-1) ?? "";
  expect(Object.keys(JSON.parse(files[file] ?? "{}").mcpServers)).toEqual(["overhand"]);
});
