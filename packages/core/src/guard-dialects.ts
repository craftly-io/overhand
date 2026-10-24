/**
 * Every agent CLI's pre-tool hook speaks its own dialect: its own tool names, argument names and way of saying "block".
 * This turns each one's event into the calls the guard already knows (Claude Code's names: Bash, Read, Edit, Glob, Grep,
 * mcp__<server>__<tool>), so one set of rules (guard.ts) decides for every agent. Names and fields come from each CLI's
 * hook docs and source (see the runtime files' headers).
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** The CLIs whose hooks call `overhand guard <dialect>`; Claude Code's own (plain `overhand guard`) needs no translation. */
export const DIALECTS = ["codex", "gemini", "cursor", "opencode"] as const;
export type Dialect = "claude" | (typeof DIALECTS)[number];

/** A dialect named on the command line, or Claude Code's for anything else. */
export const dialectOf = (arg: string): Dialect => DIALECTS.find((d) => d === arg) ?? "claude";

/** One tool call as the guard reads it. */
export interface Call {
  tool: string;
  input: Record<string, unknown>;
}

/** A hook event, read once: the calls to check, and where and in which session they run. */
export interface Event {
  calls: Call[];
  cwd: string;
  session: string;
  transcript: string;
  mode: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "");
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
/** The first string among `keys` of `input`. */
const pick = (input: Record<string, unknown>, ...keys: string[]): string | undefined =>
  keys.map((k) => input[k]).find((v): v is string => typeof v === "string");

/**
 * The files a patch touches (Codex's apply_patch, OpenCode's patch: `*** Add File: path`, `*** Update File:`, `*** Delete
 * File:`, `*** Move to:`), each as an edit; one path-less edit when it names none, so watch still stops it.
 */
export function patchEdits(patch: string, cwd: string): Call[] {
  const paths = [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => (m[1] ?? "").trim());
  return paths.length ? paths.map((p) => ({ tool: "Edit", input: { file_path: resolve(cwd, p) } })) : [{ tool: "Edit", input: {} }];
}

/** The most files one read_many_files call may name, and how long the guard looks; past either it's blocked whole. */
const MANY_MAX = 5000;
const MANY_MS = 5000;

/** The call the guard refuses when a read names more than it can check (guard.ts). */
export const TOO_WIDE: Call = { tool: "ReadTooWide", input: {} };
/** An edit, write or delete whose file the guard can't tell (a tool input shaped another way): refused, never let through. */
export const UNKNOWN_FILE: Call = { tool: "EditUnknownFile", input: {} };

/**
 * Gemini CLI's read_many_files: each pattern, then every file it matches under `cwd` (dotfiles too), each a Read the
 * guard checks. A wildcard that reaches outside `cwd` (absolute, from ~, or through ..) or matches more than MANY_MAX
 * files can't be checked file by file, so it's refused whole; a plain path outside is one Read.
 */
function manyReads(input: Record<string, unknown>, cwd: string): Call[] {
  const patterns = (Array.isArray(input.include) ? input.include : [input.include]).map(str).filter(Boolean);
  const calls: Call[] = patterns.map((p) => ({ tool: "Glob", input: { pattern: p } }));
  const until = Date.now() + MANY_MS;
  for (const given of patterns) {
    // a folder named plainly means everything under it
    const path = resolve(cwd, given.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const p = !/[*?[{]/.test(given) && existsSync(path) && statSync(path).isDirectory() ? `${given.replace(/\/+$/, "")}/**/*` : given;
    const wild = /[*?[{]/.test(p);
    const outside = /^[/~]/.test(p) || p.split("/").includes("..");
    if (outside && wild) return [TOO_WIDE];
    if (!wild) {
      calls.push({ tool: "Read", input: { file_path: resolve(cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) } });
      continue;
    }
    for (const f of new Bun.Glob(p).scanSync({ cwd, dot: true, absolute: true, onlyFiles: true })) {
      if (calls.length > MANY_MAX || Date.now() > until) return [TOO_WIDE];
      calls.push({ tool: "Read", input: { file_path: f } });
    }
  }
  return calls;
}

/** A Slack MCP tool under another CLI's naming (`slack_send_message` inside `mcp_slack_slack_send_message`), in Claude's. */
const slackTool = (name: string, dialect: Dialect): string | null => {
  const at = name.lastIndexOf("slack_");
  return at === 0 || (at > 0 && name[at - 1] === "_") ? `mcp__${dialect}__${name.slice(at)}` : null;
};

/** An edit, a read, a search or a shell command under one of the CLIs' own tool names, as the guard's. */
function byName(dialect: Dialect, name: string, input: Record<string, unknown>, cwd: string): Call[] {
  const n = name.toLowerCase();
  const file = pick(input, "file_path", "filePath", "path", "target_file", "targetFile", "absolute_path");
  const dir = pick(input, "dir_path", "path", "directory", "target_directory");
  if (/^(bash|shell|run_shell_command|exec_command|local_shell|terminal)$/.test(n))
    return [{ tool: "Bash", input: { command: str(input.command ?? input.cmd) } }];
  if (/^(apply_patch|patch)$/.test(n)) return patchEdits(str(input.command ?? input.patchText ?? input.patch ?? input.input), cwd);
  // Cursor Agent's preToolUse names its edits Write and Delete (cursor.com/docs/hooks); every CLI's edit names its file
  if (/^(write|write_file|edit|replace|multiedit|edit_file|search_replace|str_replace|delete|delete_file)$/.test(n))
    return [file ? { tool: "Edit", input: { file_path: resolve(cwd, file) } } : UNKNOWN_FILE];
  if (/^(read|read_file|view)$/.test(n)) return [{ tool: "Read", input: file ? { file_path: resolve(cwd, file) } : {} }];
  if (n === "read_many_files") return manyReads(input, cwd);
  if (/^(glob|list|ls|list_directory|list_dir)$/.test(n))
    return [{ tool: "Glob", input: { ...(dir ? { path: resolve(cwd, dir) } : {}), pattern: str(input.pattern) } }];
  if (/^(grep|grep_search|search_file_content)$/.test(n))
    return [
      {
        tool: "Grep",
        input: { ...(dir ? { path: resolve(cwd, dir) } : {}), glob: str(input.include_pattern ?? input.include ?? input.glob) },
      },
    ];
  const slack = slackTool(name, dialect);
  return [{ tool: slack ?? name, input }];
}

/**
 * The calls in one hook event of `dialect`. Claude Code's and Codex's events are the same shape (tool_name, tool_input);
 * Gemini CLI's names its tools its own way and tells MCP calls by `mcp_context`; Cursor's has one event per kind
 * (beforeShellExecution, beforeReadFile, beforeMCPExecution, preToolUse); OpenCode's comes from Overhand's own plugin
 * (agent-home.ts), which sends the tool and its args as tool_name and tool_input.
 */
export function eventOf(dialect: Dialect, raw: unknown): Event {
  const e = rec(raw);
  const roots = Array.isArray(e.workspace_roots) ? e.workspace_roots : [];
  const cwd = str(e.cwd) || str(roots[0]) || process.cwd();
  const base = { cwd, session: str(e.session_id ?? e.conversation_id), transcript: str(e.transcript_path), mode: str(e.permission_mode) };
  const tool = str(e.tool_name);
  // Cursor's beforeMCPExecution sends the arguments as a JSON string (cursor.com/docs/agent/hooks); one that isn't JSON throws, and is blocked
  const input = rec(typeof e.tool_input === "string" ? JSON.parse(e.tool_input) : e.tool_input);
  if (dialect === "claude") return { ...base, calls: [{ tool, input }] };
  if (dialect === "cursor") {
    const kind = str(e.hook_event_name);
    if (kind === "beforeShellExecution") return { ...base, calls: [{ tool: "Bash", input: { command: str(e.command) } }] };
    if (kind === "beforeReadFile") return { ...base, calls: [{ tool: "Read", input: { file_path: resolve(cwd, str(e.file_path)) } }] };
    if (kind === "beforeMCPExecution") return { ...base, calls: [{ tool: `mcp__${str(e.mcp_server_name)}__${tool}`, input }] };
  }
  if (dialect === "gemini") {
    const mcp = rec(e.mcp_context);
    if (typeof mcp.server_name === "string")
      return { ...base, calls: [{ tool: `mcp__${mcp.server_name}__${str(mcp.tool_name) || tool}`, input }] };
  }
  if (tool.startsWith("mcp__")) return { ...base, calls: [{ tool, input }] };
  return { ...base, calls: byName(dialect, tool, input, cwd) };
}
