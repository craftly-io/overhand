import { useModel } from "@/app/data";
import { Switch } from "@/components/ui/switch";
import { getAt } from "@/lib/json";
import { Field, useForm } from "./SettingsFields";

/**
 * What each agent CLI takes, per field (packages/core/src/runtimes/tune.ts turns them into flags, each checked against
 * the CLI's --help and docs). A field a CLI doesn't take isn't shown for it.
 */
type Tunable = "fallbackModel" | "maxRunUsd" | "blockedTools" | "skills" | "mcpServers" | "sandbox";
const TUNABLE: Record<string, readonly Tunable[]> = {
  "claude-code": ["fallbackModel", "maxRunUsd", "blockedTools", "skills"],
  codex: [],
  gemini: ["mcpServers", "sandbox"],
  cursor: ["sandbox"],
  opencode: [],
  aider: [],
};

/** Effort levels each CLI accepts; a string for a free-form value (OpenCode's provider-specific variant); absent = none. */
const EFFORT: Record<string, readonly string[] | string> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"], // claude --help: --effort <level>
  codex: ["low", "medium", "high", "xhigh"], // config reference: model_reasoning_effort
  cursor: ["low", "medium", "high"], // cursor-agent --help: model[effort=…]
  aider: ["low", "medium", "high"], // aider --reasoning-effort
  opencode: "Model variant (--variant, e.g. high or max; empty = default)",
};

/** The sandbox flag each CLI has, for the switch's label. */
const SANDBOX: Record<string, string> = { gemini: "--sandbox", cursor: "--sandbox enabled" };

/** On unless set to false: a switch whose absent value means on. */
function OnByDefault({ label, path }: { label: string; path: string }) {
  const f = useForm();
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Switch aria-label={label} checked={getAt(f.draft, path) !== false} onCheckedChange={(on) => f.set(path, on ? undefined : false)} />
    </div>
  );
}

/**
 * One account's agent settings, inside its card: effort in view (the model sits with the provider fields above), the
 * rest under Advanced. Only what this account's CLI takes is shown.
 */
export function AgentTuning({ account, runtime, home }: { account: string; runtime: string; home: string }) {
  const m = useModel();
  const at = `runtimes.${account}`;
  const has = (t: Tunable) => (TUNABLE[runtime] ?? []).includes(t);
  const effort = EFFORT[runtime];
  // the instruction files this CLI reads, per project, from what Overhand found in each repo
  const files = (m?.s.instructions ?? []).map((p) => ({
    project: p.project,
    paths: p.files.filter((x) => x.readers.includes(runtime)).map((x) => x.path),
  }));
  return (
    <>
      {Array.isArray(effort) ? (
        <Field
          label={runtime === "cursor" ? "Effort (with a model set)" : "Effort"}
          path={`${at}.effort`}
          kind={{ options: ["", ...effort], labels: { "": "Default" } }}
        />
      ) : typeof effort === "string" ? (
        <Field label={effort} path={`${at}.effort`} />
      ) : null}
      <details className="group sm:col-span-2">
        <summary className="flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground select-none">Advanced</summary>
        <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
          {has("fallbackModel") ? <Field label="Fallback model (when the model is busy)" path={`${at}.fallbackModel`} /> : null}
          {has("maxRunUsd") ? <Field label="Cost cap per task run (USD, empty = none)" path={`${at}.maxRunUsd`} kind="num" /> : null}
          <Field label="Timeout per run (min, empty = Schedule & limits)" path={`${at}.timeoutMin`} kind="num" />
          {has("blockedTools") ? <Field label="Blocked tools (e.g. WebFetch, mcp__slack)" path={`${at}.blockedTools`} kind="csv" /> : null}
          {has("mcpServers") ? <Field label="Only these MCP servers (empty = all)" path={`${at}.mcpServers`} kind="csv" /> : null}
          {has("skills") ? <OnByDefault label="Skills and slash commands" path={`${at}.skills`} /> : null}
          {has("sandbox") ? (
            <Field label={`Run in its own sandbox (${SANDBOX[runtime] ?? ""})`} path={`${at}.sandbox`} kind="bool" />
          ) : null}
          <Field label="Extra flags, one argument per comma (any that loosen the guard are refused)" path={`${at}.extraArgs`} kind="csv" />
          <div className="grid gap-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">Config folder (read-only)</span>
            <code className="font-mono break-all">{home || "—"}</code>
          </div>
          {files.length ? (
            <div className="grid gap-1 text-xs sm:col-span-2">
              <span className="text-muted-foreground">Instruction files it reads</span>
              <ul className="grid gap-0.5">
                {files.map((p) => (
                  <li key={p.project}>
                    <b className="font-medium">{p.project}</b>: {p.paths.length ? p.paths.join(", ") : "none"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
    </>
  );
}
