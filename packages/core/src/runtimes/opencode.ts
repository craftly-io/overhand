/**
 * OpenCode (`opencode run`). Flags from `opencode run --help` (1.19.3) and opencode.ai/docs (cli, providers):
 * `--format json` prints JSONL events ({ type, part }: text, tool_use, step_finish with cost and tokens, error), `--auto`
 * approves permissions not explicitly denied, `-m provider/model` picks the model, OPENCODE_CONFIG_CONTENT takes inline
 * config. A gateway account becomes an `@ai-sdk/openai-compatible` provider at <baseUrl>/v1, which is where Ollama,
 * LiteLLM and OpenRouter serve their OpenAI-compatible API. No schema enforcement: ops asks for JSON in the prompt.
 * Overhand's agent instructions go in the same inline config as `instructions: [file]` (opencode.ai/docs/rules). Its
 * guard is a plugin (`tool.execute.before`, opencode.ai/docs/plugins) in OPENCODE_CONFIG_DIR, whose plugins/ OpenCode
 * loads on top of your own config.
 */

import { GUARD_CONFIG } from "../agent-home";
import { SECRET_STORE } from "../platform";
import { repoRefusal } from "./repo-config";
import { type AgentRuntime, at, baseEnv, guardEnv, jsonLines, promptFor, type RunInput, readOnly } from "./runtime";
import { tuneArgs, unlistedMcp } from "./tune";

function spawn(r: RunInput) {
  const refused = repoRefusal("opencode", r.cwd);
  if (refused) throw new Error(refused);
  // Overhand's guard as a plugin in a config folder of its own (agent-home.ts writes it), which OpenCode loads on top of
  // your global and project config: every tool call goes through it
  const env = guardEnv(r, baseEnv());
  env.OPENCODE_CONFIG_DIR = GUARD_CONFIG.opencode;
  const config: Record<string, unknown> = {};
  if (r.instructions) config.instructions = [r.instructions];
  let model = r.model;
  const p = r.provider;
  if (p.kind === "gateway" && p.model) {
    const token = p.secret ? r.read(p.secret) : "overhand";
    if (token === null) throw new Error(`gateway token ${p.secret} for ${r.account} missing from ${SECRET_STORE}`);
    const options = { baseURL: `${p.baseUrl.replace(/\/$/, "")}/v1`, apiKey: token };
    const provider = { npm: "@ai-sdk/openai-compatible", name: "Overhand gateway", options, models: { [p.model]: {} } };
    config.provider = { overhand: provider };
    model = `overhand/${p.model}`;
  }
  const off = unlistedMcp("OpenCode", r.tune?.mcpServers);
  if (off.length) config.mcp = Object.fromEntries(off.map((n) => [n, { enabled: false }]));
  // on watch, edits and every shell command are denied outright, which `--auto` never approves; reads still run
  if (readOnly(r)) config.permission = { edit: "deny", bash: "deny" };
  if (Object.keys(config).length) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  const argv = ["opencode", "run", "--format", "json", "--auto"];
  if (model) argv.push("-m", model);
  argv.push(...tuneArgs("opencode", r.tune, true));
  return { argv: [...argv, promptFor(opencode, r)], env, files: {} };
}

/** One OpenCode JSONL event as a line a person reads: what it said, the tool it ran and on what, or its error. */
function step(e: Record<string, unknown>): string {
  if (e.type === "text") return String(at(e, "part", "text") ?? "").trim();
  if (e.type === "error") return `✗ ended with an error: ${String(at(e, "error", "data", "message") ?? at(e, "error", "message") ?? "")}`;
  if (e.type !== "tool_use") return "";
  const input = at(e, "part", "state", "input");
  const what = ["command", "filePath", "description", "pattern", "url"].map((k) => at(input, k)).find((v) => typeof v === "string");
  return `→ ${String(at(e, "part", "tool") ?? "tool")}${typeof what === "string" ? `: ${what.slice(0, 140)}` : ""}`;
}

export const opencode: AgentRuntime = {
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  status: "verified",
  caps: { jsonSchema: false, autoMode: true, subagents: true, usage: false, transcripts: false },
  models: "A gateway provider's model (Ollama, LiteLLM, OpenRouter, ...), else `-m provider/model` from the account's runtime model.",
  task: spawn,
  lead: spawn,
  parse(stdout, stderr, code) {
    const events = jsonLines(stdout);
    const error = events.find((e) => e.type === "error");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => at(e, "part", "text"))
      .filter((t) => typeof t === "string")
      .join("");
    const cost = events.filter((e) => e.type === "step_finish").reduce((s, e) => s + (Number(at(e, "part", "cost")) || 0), 0);
    const why = at(error, "error", "message") ?? at(error, "error", "data", "message");
    if (error || code !== 0)
      return {
        ok: false,
        text: typeof why === "string" ? why : [text, stderr].join("\n").slice(-500),
        structured: undefined,
        cost,
        usage: null,
      };
    return { ok: true, text, structured: undefined, cost, usage: null };
  },
  readable: (raw, maxLines) =>
    jsonLines(raw)
      .map(step)
      .filter((l) => l.trim())
      .slice(-maxLines)
      .join("\n"),
};
