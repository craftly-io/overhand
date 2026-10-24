/**
 * `overhand mcp`: Overhand's own MCP server over stdio (JSON-RPC 2.0, one message per line), so any agent can ask what's
 * running and what needs you, answer a lead's open question and hand or answer requests. Every tool goes through the
 * daemon's HTTP API with the caller's own key (devices.ts localHeaders): inside a run that's the run's key, which reaches
 * only what a run may do (server.ts RUN_ROUTES), so the status tool isn't offered there; outside one it's this computer's
 * local key, the same as the `overhand` CLI. Hand-written: four tools don't need the SDK.
 */
import { DashboardStateSchema } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { z } from "zod";
import { computeAlerts } from "../../../apps/web/src/lib/alerts";
import { ago } from "../../../apps/web/src/lib/format";
import { parsePlan } from "../../../apps/web/src/lib/plan";
import { RUN_KEY_ENV } from "./control";
import { ackRequest, type Said, sendRequest } from "./control-api";
import { answerFromTerminal } from "./daemon";
import { localHeaders } from "./devices";
import { DASHBOARD } from "./env";
import { VERSION } from "./selfupdate";

/** The protocol versions this server speaks, newest first: a client asking for one gets it, any other the newest. */
export const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const NOT_RUNNING = "Overhand isn't running: overhand start";

/** What's running and what needs you, from the daemon's own state; the Needs you list is the dashboard's (computeAlerts). */
export async function statusText(base = DASHBOARD, now = Date.now()): Promise<Said> {
  const res = await fetch(`${base}/api/state`, { headers: localHeaders(DASHBOARD), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return { ok: false, message: NOT_RUNNING };
  const s = DashboardStateSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !s.success) return { ok: false, message: `Overhand didn't give its status (${res.status}).` };
  const st = s.data;
  const work = [
    ...st.running.map((r) => `- ${r.name} on ${r.account}, started ${ago(r.startedAt, now)}`),
    ...st.godmode.filter((l) => l.running).map((l) => `- lead ${l.label} (${l.project}), key ${l.key}`),
  ];
  const needs = computeAlerts(st, parsePlan(st.plan), w, now).map(
    (a) => `- ${a.title}${a.sub ? `: ${a.sub}` : ""}${a.target.kind === "lead" ? ` (answer with lead key ${a.target.key})` : ""}`,
  );
  return {
    ok: true,
    message: [
      `${w.mcpAtWork}:`,
      ...(work.length ? work : [`- ${w.mcpNoneAtWork}`]),
      "",
      `${w.paneAlerts}:`,
      ...(needs.length ? needs : [`- ${w.calm}`]),
    ].join("\n"),
  };
}

const Answer = z.object({
  lead: z.string().min(1).describe("The lead's key or label"),
  text: z.string().default("").describe("Your answer; leave it out with use_default"),
  use_default: z.boolean().default(false).describe("Go with the default the lead gave instead"),
});
const Ask = z.object({
  session: z.string().min(1).describe("The session or run to hand it to, as Overhand's Crew names it"),
  text: z.string().min(1).describe("The request"),
  by: z.string().default("").describe("A deadline as HH:MM, optional"),
});
const Ack = z.object({
  id: z.string().min(1).describe("The request's id"),
  state: z.enum(["acknowledged", "done", "refused"]).describe("Seen it, done it, or won't do it"),
  note: z.string().default("").describe("Why, or what was done"),
});

/** One tool: its description, its arguments, what it does, and whether a run's key may use it at all. */
interface Tool {
  description: string;
  input: z.ZodType;
  run: (args: unknown, base: string) => Promise<Said>;
  inRuns: boolean;
}

/** Every tool, each mapped to what the `overhand` CLI already does through the daemon. */
export const TOOLS: Record<string, Tool> = {
  status: {
    description: "What Overhand's agents and leads are doing now, and what needs you (the dashboard's Needs you list).",
    input: z.object({}),
    run: (_args, base) => statusText(base),
    inRuns: false,
  },
  answer_lead: {
    description:
      "Answer a lead's open question, as `overhand answer` does. Outside a run it answers as you; inside a run, only that run's own lead.",
    input: Answer,
    run: (args, base) => {
      const a = Answer.parse(args);
      return answerFromTerminal([a.lead, ...(a.use_default ? ["--default"] : [a.text])], base);
    },
    inRuns: true,
  },
  ask_session: {
    description:
      "Hand a typed request to a session, which gets it at its next tool call, as `overhand ask` does. From a run, a request to one of your own sessions goes to you first.",
    input: Ask,
    run: (args, base) => {
      const a = Ask.parse(args);
      return sendRequest(a.session, a.text, a.by, base);
    },
    inRuns: true,
  },
  ack_request: {
    description: "Answer a request handed to this session, as `overhand ack` does. A run answers only requests sent to it.",
    input: Ack,
    run: (args, base) => {
      const a = Ack.parse(args);
      return ackRequest(a.id, a.state, a.note, base);
    },
    inRuns: true,
  },
};

/** The tools this process offers: inside a run (its key in the environment), only those a run's key may use. */
export const toolsFor = (env: Record<string, string | undefined> = process.env): [string, Tool][] =>
  Object.entries(TOOLS).filter(([, t]) => t.inRuns || !env[RUN_KEY_ENV]);

const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** One JSON-RPC message in, its reply out (null for a notification). */
export async function reply(line: string, env = process.env, base = DASHBOARD): Promise<object | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }
  const m = Message.safeParse(raw);
  if (!m.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  const { id, method, params } = m.data;
  if (id === undefined) return null;
  const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const tools = toolsFor(env);
  if (method === "initialize") {
    const asked = String(params.protocolVersion ?? "");
    return ok({
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "overhand", version: VERSION },
    });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list")
    return ok({
      tools: tools.map(([name, t]) => ({ name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) })),
    });
  if (method === "tools/call") {
    const tool = tools.find(([name]) => name === params.name)?.[1];
    if (!tool) return fail(-32602, `no tool ${String(params.name)}`);
    try {
      const r = await tool.run(params.arguments ?? {}, base);
      return ok({ content: [{ type: "text", text: r.message }], isError: !r.ok });
    } catch (e) {
      if (e instanceof z.ZodError) return fail(-32602, z.prettifyError(e));
      throw e;
    }
  }
  return fail(-32601, `no method ${method}`);
}

/** Serves MCP on stdin and stdout until stdin closes. Nothing else may write to stdout. */
export async function serveMcp(): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const out = await reply(line);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  }
}
