/**
 * An account's own tuning (Settings → Agents) as flags for its CLI: only what that CLI takes, each flag checked
 * against its `--help` and docs (see each runtime's header). Nothing here can loosen the guard: the fields only pick a
 * model's effort, narrow tools, add a sandbox, or cap a run; extra flags that would loosen it are dropped.
 */
import { agentMcpServers } from "../agent-home";
import { deniedFlags, type Runtime, type RuntimeId } from "../config";
import { HOME } from "../env";

/** The account's extra flags, or none at all when any of them is denied (the config check refuses those on save too). */
const extra = (id: RuntimeId, t: Partial<Runtime>): string[] => {
  const args = t.extraArgs ?? [];
  return deniedFlags(id, args).length ? [] : args;
};

/**
 * The flags an account's tuning adds to one run of CLI `id`; `task` is a one-shot ticket run (a per-run cost cap only
 * applies there: a lead runs for hours). Cursor's effort goes on its model instead (`cursorModel`).
 */
export function tuneArgs(id: RuntimeId, t: Partial<Runtime> | undefined, task: boolean): string[] {
  if (!t) return [];
  const a: string[] = [];
  const effort = t.effort?.trim() ?? "";
  if (id === "claude-code") {
    if (effort) a.push("--effort", effort);
    if (t.fallbackModel) a.push("--fallback-model", t.fallbackModel);
    if (task && t.maxRunUsd) a.push("--max-budget-usd", String(t.maxRunUsd));
    // one comma-joined value: the flag is variadic and would swallow a bare argument after it
    if (t.blockedTools?.length) a.push(`--disallowedTools=${t.blockedTools.join(",")}`);
    if (t.skills === false) a.push("--disable-slash-commands");
  } else if (id === "codex") {
    if (effort) a.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  } else if (id === "gemini") {
    if (t.mcpServers?.length) a.push(`--allowed-mcp-server-names=${t.mcpServers.join(",")}`);
    if (t.sandbox) a.push("--sandbox");
  } else if (id === "cursor") {
    if (t.sandbox) a.push("--sandbox", "enabled");
  } else if (id === "opencode") {
    if (effort) a.push("--variant", effort);
  } else if (effort) a.push("--reasoning-effort", effort);
  return [...a, ...extra(id, t)];
}

/**
 * Cursor's model with the account's effort as its bracket override (`cursor-agent --help`: "Parameterized models accept
 * quoted bracket overrides, e.g. 'claude-opus-4-8[context=1m,effort=high,fast=false]'"); a model that already has
 * brackets, or no model, is left as it is.
 */
export const cursorModel = (model: string, effort = ""): string =>
  model && effort.trim() && !model.includes("[") ? `${model}[effort=${effort.trim()}]` : model;

/**
 * The servers set up in `cli`'s own config ("Codex", "OpenCode": the ones that read it, not Overhand's flags) that the
 * account's allowlist leaves out, for the run to switch off; none when the account has no allowlist. A name Codex's `-c`
 * can't carry (it splits keys at dots) throws: a run never starts with a server it was told to leave out.
 */
export function unlistedMcp(cli: "Codex" | "OpenCode", allowed: readonly string[] = [], home = HOME): string[] {
  if (!allowed.length) return [];
  const names = [
    ...new Set(
      agentMcpServers(home)
        .filter((s) => s.cli === cli)
        .map((s) => s.name),
    ),
  ];
  const left = names.filter((n) => !allowed.includes(n));
  const odd = cli === "Codex" ? left.filter((n) => !/^[A-Za-z0-9_-]+$/.test(n)) : [];
  if (odd.length) throw new Error(`can't leave out the MCP server ${odd.join(", ")} for ${cli}: rename it to letters, digits, - and _`);
  return left;
}
