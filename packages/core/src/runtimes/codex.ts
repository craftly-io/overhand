/**
 * OpenAI Codex CLI (`codex exec`). Flags from `codex exec --help` (codex-cli 0.163.0), the non-interactive docs
 * (learn.chatgpt.com/docs/non-interactive-mode) and the config reference (learn.chatgpt.com/docs/config-file/config-reference):
 * `--json` prints JSONL events, `--output-schema <file>` makes the final message match a JSON Schema, `--sandbox
 * workspace-write` lets it edit (the default sandbox is read-only) and `-c sandbox_workspace_write.network_access=true`
 * lets it reach the network from there (off by default, which fails `git push` and `gh`), `-m` picks the model,
 * CODEX_API_KEY authenticates (else its own `codex login`). A gateway account runs `--oss --local-provider ollama` against
 * the gateway's URL (CODEX_OSS_BASE_URL) with the gateway's model. Overhand's agent instructions go in as
 * `-c developer_instructions=…` (config_toml.rs: "Developer instructions inserted as a `developer` role message"), which
 * keeps the repo's own AGENTS.md and the built-in instructions (`instructions` / `model_instructions_file` would replace them).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dialectHook, unlistedMcp } from "../agent-home";
import { OPS } from "../env";
import { SECRET_STORE } from "../platform";
import {
  type AgentRuntime,
  at,
  baseEnv,
  extractJson,
  gitCommonDir,
  guardEnv,
  jsonAsk,
  jsonLines,
  keyFrom,
  type RunInput,
  readOnly,
} from "./runtime";
import { tuneArgs } from "./tune";

/** The model to ask for: a gateway account's own model, else the account's runtime model. */
const modelOf = (r: RunInput): string => (r.provider.kind === "gateway" && r.provider.model) || r.model;

/**
 * Through `--oss`, Ollama applies `--output-schema` to every model call, so the model can't call a tool and never edits
 * (seen with qwen3:1.7b: it answered "done" without creating the file). Local runs are asked for JSON in the prompt
 * instead, and `checked` validates it.
 */
const enforced = (r: RunInput): boolean => Boolean(r.schema) && r.provider.kind !== "gateway";

/**
 * Overhand's guard as a PreToolUse hook on every tool (no matcher: shell, apply_patch and MCP calls; learn.chatgpt.com/
 * docs/hooks), set for this run only by `-c` so your own ~/.codex stays yours. Hooks are on by default; `features.hooks`
 * keeps a `hooks = false` of your own from turning it off. Codex skips a hook nobody has trusted in its /hooks review,
 * and `--dangerously-bypass-hook-trust` is its documented switch for automation that vets its hooks itself: this one is
 * Overhand's own, written here.
 */
export const guardArgs = (command = dialectHook("codex")): string[] => [
  "--dangerously-bypass-hook-trust",
  "-c",
  "features.hooks=true",
  "-c",
  `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=60}]}]`,
];

function argv(r: RunInput, schema: boolean): string[] {
  // network on: workspace-write blocks it by default, which fails `git push` and `gh` (the config reference's
  // sandbox_workspace_write.network_access). The git folder writable: workspace-write keeps `.git` read-only (a sandboxed
  // `git commit` fails on .git/index.lock), and a ticket worktree's objects and refs live in its main repo's `.git` besides.
  // A project on watch runs in the read-only sandbox: no file writes and no network, so no commit, push or PR.
  // Under Overhand's OS sandbox, Codex's own is off (it can't nest): Overhand's holds the files, watch included.
  const a = r.osSandbox
    ? ["codex", "exec", "--json", "--sandbox", "danger-full-access"]
    : readOnly(r)
      ? ["codex", "exec", "--json", "--sandbox", "read-only"]
      : ["codex", "exec", "--json", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
  // and Overhand's heavy-job slots, where `overhand heavy` (the governor's wrap) records what it holds
  const writable = readOnly(r) || r.osSandbox ? [] : [gitCommonDir(r.cwd), join(OPS, "slots")].filter(Boolean);
  if (writable.length) a.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writable)}`);
  a.push(...guardArgs());
  if (r.instructions) a.push("-c", `developer_instructions=${JSON.stringify(readFileSync(r.instructions, "utf8"))}`);
  if (r.provider.kind === "gateway") a.push("--oss", "--local-provider", "ollama");
  if (schema) a.push("--output-schema", r.schemaFile);
  const model = modelOf(r);
  if (model) a.push("-m", model);
  a.push(...tuneArgs("codex", r.tune, true));
  // an account's own CODEX_HOME holds no servers of yours, so there is nothing of yours to leave out there
  if (!r.configDir) for (const n of unlistedMcp("Codex", r.tune?.mcpServers)) a.push("-c", `mcp_servers.${n}.enabled=false`);
  return [...a, r.schema && !schema ? [r.prompt, jsonAsk(r.schema)].join("") : r.prompt];
}

function env(r: RunInput): Record<string, string> {
  const e = guardEnv(r, keyFrom(baseEnv(), "CODEX_API_KEY", `codex-key-${r.account}`, r.read));
  if (r.configDir) e.CODEX_HOME = r.configDir; // an account with a login of its own (ownSignInHome)
  const p = r.provider;
  if (p.kind !== "gateway") return e;
  if (p.secret && r.read(p.secret) === null) throw new Error(`gateway token ${p.secret} for ${r.account} missing from ${SECRET_STORE}`);
  e.CODEX_OSS_BASE_URL = `${p.baseUrl.replace(/\/$/, "")}/v1`;
  return e;
}

/**
 * A JSON Schema in the form OpenAI's strict structured outputs take (what `--output-schema` sends to OpenAI models): every
 * object closed (`additionalProperties: false`) and listing every property in `required`, with the ones that were
 * optional made nullable. `checked` turns those nulls back into missing fields before validating against the original.
 */
export function strictSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const s: Record<string, unknown> = { ...schema };
  if (s.items !== undefined) s.items = strictSchema(s.items);
  const props = at(s, "properties");
  if (typeof props !== "object" || props === null) return s;
  const required = Array.isArray(s.required) ? s.required : [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = required.includes(k) ? strictSchema(v) : nullable(strictSchema(v));
  return { ...s, properties: out, required: Object.keys(out), additionalProperties: false };
}

/** The same schema that also accepts null. */
function nullable(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  const s: Record<string, unknown> = { ...schema };
  if (typeof s.type === "string") s.type = [s.type, "null"];
  else return { anyOf: [s, { type: "null" }] };
  if (Array.isArray(s.enum)) s.enum = [...s.enum, null];
  return s;
}

/** One Codex JSONL event as a line a person reads: what it said, the command it ran, the files it changed, how it ended. */
function step(e: Record<string, unknown>): string {
  const item = at(e, "item");
  const kind = at(item, "type");
  if (e.type === "item.started" && kind === "command_execution") return `→ Bash: ${String(at(item, "command") ?? "")}`;
  if (e.type !== "item.completed") {
    if (e.type === "turn.failed" || e.type === "error")
      return `✗ ended with an error: ${String(at(e, "error", "message") ?? at(e, "message") ?? "")}`;
    return e.type === "turn.completed" ? "✓ finished" : "";
  }
  if (kind === "agent_message") return String(at(item, "text") ?? "");
  if (kind === "file_change") {
    const changes = at(item, "changes");
    const paths = Array.isArray(changes) ? changes.map((c) => String(at(c, "path") ?? "")).join(", ") : "";
    return `→ Edit: ${paths}`;
  }
  if (kind === "mcp_tool_call") return `→ ${String(at(item, "tool") ?? "tool")}`;
  if (kind === "web_search") return `→ WebSearch: ${String(at(item, "query") ?? "")}`;
  return "";
}

export const codex: AgentRuntime = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  status: "verified",
  caps: { jsonSchema: true, autoMode: true, subagents: false, usage: false, transcripts: false },
  models:
    "`-m <model>` from the account's runtime model; its own config default otherwise. A gateway account runs `--oss` (Ollama) with the gateway's model.",
  task: (r) => ({
    argv: argv(r, enforced(r)),
    env: env(r),
    files: enforced(r) ? { [r.schemaFile]: JSON.stringify(strictSchema(JSON.parse(r.schema))) } : {},
  }),
  lead: (r) => ({ argv: argv(r, false), env: env(r), files: {} }),
  parse(stdout, stderr, code) {
    const events = jsonLines(stdout);
    const said = events.filter((e) => e.type === "item.completed" && at(e, "item", "type") === "agent_message");
    const completed = events.some((e) => e.type === "turn.completed");
    // a top-level error before turn.completed can be a retry it recovered from ("Reconnecting... 1/5"); only a failed
    // turn, or an error with no completed turn, fails the run
    const failed = events.find((e) => e.type === "turn.failed") ?? (completed ? undefined : events.findLast((e) => e.type === "error"));
    const last = at(said.at(-1), "item", "text");
    const text = failed
      ? String(at(failed, "error", "message") ?? at(failed, "message") ?? "failed")
      : typeof last === "string"
        ? last
        : "";
    const ok = code === 0 && !failed && completed;
    // with --output-schema the final message is the JSON answer
    return { ok, text: text || stderr.slice(-500), structured: ok ? extractJson(text) : undefined, cost: 0, usage: null };
  },
  readable: (raw, maxLines) =>
    jsonLines(raw)
      .map(step)
      .filter((l) => l.trim())
      .slice(-maxLines)
      .join("\n"),
};

/** Whether Codex says it's signed in with its home at `home` (`codex login status`; the credential is never read). */
export async function codexSignedIn(home: string, bin = "codex"): Promise<boolean> {
  try {
    const p = Bun.spawn([bin, "login", "status"], {
      env: { ...process.env, CODEX_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return code === 0 && /logged in/i.test([out, err].join("\n"));
  } catch {
    return false;
  }
}
