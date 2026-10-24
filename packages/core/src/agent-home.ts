/**
 * The agent config home (CLAUDE_CONFIG_DIR for Claude Code runs): Overhand's agent instructions and the settings that
 * hook every tool call through its guard. Both are embedded in the code and written out at startup and before every run,
 * so an installed binary has them and an update reaches them. Anything else in the folder (the CLI's own state, your
 * extra files) is left alone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import INSTRUCTIONS from "./agent-instructions.txt";
import type { Config, RuntimeId } from "./config";
import { BUNDLED, CFG, HOME, OPS, SELF_EXEC, SRC } from "./env";
import type { Dialect } from "./guard-dialects";
import { subscriptionTokensAllowed } from "./legacy-token";

/** Each agent CLI's config home lives under agent-home/<cli>; Claude Code is the one Overhand gives its own. */
export const AGENT_HOMES = join(OPS, "agent-home");
export const AGENT_HOME = join(AGENT_HOMES, "claude-code");

/** The agent instructions file in the config home; other CLIs get it by flag or config (see each runtime). */
export const INSTRUCTIONS_FILE = join(AGENT_HOME, "CLAUDE.md");

/** A path quoted for the shell Claude Code runs hook commands in. */
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The config folder of a Claude account on Claude Code's own sign-in (`auth: "login"`), "" for any other account. The
 * account signs in here through Claude Code itself (`claudeLoginCommand`) and every run of it uses this folder as
 * CLAUDE_CONFIG_DIR, so Claude Code keeps the credential (a macOS Keychain item keyed to the folder, or .credentials.json
 * in it) and Overhand never sees it.
 */
export function ownSignInHome(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG, root = AGENT_HOMES): string {
  const p = c.providers[account] ?? { kind: "claude", auth: "login" };
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  // another CLI whose login can move (Codex): always the account's own folder, never your ~/.codex
  if (runtime !== "claude-code") return runtime in LOGIN_HOME_VAR ? signInHome(account, root) : "";
  // the legacy token opt-in keeps runs in the folders they used before accounts had their own (legacy-token.ts); an
  // account once on the sign-in you already had (`existing`) moved to its own folder too (runHome)
  const own = p.kind === "claude" && p.auth === "login" && runtime === "claude-code" && !subscriptionTokensAllowed();
  return own ? signInHome(account, root) : "";
}

/**
 * The config folder an account's runs and leads use: one of Overhand's (the account's own sign-in folder, else the
 * shared agent home), so no run can change the MCP servers, settings or hooks your own sessions start with (owner,
 * 2026-10-23). An account still waiting to move (`pendingMove`) stays on the config it had (your ~/.claude, "" for
 * Claude Code's default, or your ~/.codex: "") until its own folder has a sign-in, so nothing breaks; under the enforced
 * sandbox its runs wait instead (sandbox.ts sandboxSpawn). "" also for a CLI whose login can't move (Cursor Agent,
 * OpenCode: one per computer) or that runs on a key in a home of its own (Gemini CLI, Aider).
 */
export function runHome(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG, root = AGENT_HOMES): string {
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  if (pendingMove(account, c)) return runtime === "codex" ? "" : (existingHome(account, c) ?? "");
  return ownSignInHome(account, c, root) || (runtime === "claude-code" ? join(root, "claude-code") : "");
}

/** The Slack inbox's folder: the account's (runHome), or your own config until Slack is signed in in its own folder too. */
export function inboxHome(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG, root = AGENT_HOMES): string {
  const p = c.providers[account];
  const existing = existingHome(account, c);
  return existing !== undefined && p?.kind === "claude" && !p.slackMoved ? existing : runHome(account, c, root);
}

/** The account still runs on your own config: Claude Code's sign-in you already had, or Codex's login in ~/.codex. */
export function pendingMove(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG): boolean {
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  if (runtime === "codex") return !c.runtimes[account]?.ownLogin && c.providers[account]?.kind !== "gateway";
  const p = c.providers[account];
  return existingHome(account, c) !== undefined && p?.kind === "claude" && p.movedAt === undefined;
}

/** Every account still waiting to move (pendingMove). */
export const pendingMoves = (c: Pick<Config, "accounts" | "providers" | "runtimes"> = CFG): string[] =>
  c.accounts.filter((a) => pendingMove(a, c));

/**
 * The config with `account` moved to its own folder, once that folder has a valid sign-in (Claude Code: movedAt;
 * Codex: ownLogin). `existing` is kept, so the Slack inbox can stay on it until Slack is signed in there too.
 */
export function finishMove(c: Config, account: string, now = Date.now()): Config {
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  if (runtime === "codex") {
    const rt = c.runtimes[account] ?? { kind: "codex" as const, model: "" };
    return { ...c, runtimes: { ...c.runtimes, [account]: { ...rt, ownLogin: true } } };
  }
  const p = c.providers[account];
  if (p?.kind !== "claude") return c;
  return { ...c, providers: { ...c.providers, [account]: { ...p, movedAt: now } } };
}

/**
 * The config folder of a Claude account set to the Claude Code sign-in you already had (`existing`): your
 * CLAUDE_CONFIG_DIR, or "" for Claude Code's default; undefined for any other account. Runs use it only until the
 * account has moved to its own folder (runHome), the Slack inbox until Slack moved too (inboxHome).
 */
export function existingHome(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG): string | undefined {
  const p = c.providers[account];
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  return p?.kind === "claude" && p.auth === "login" && runtime === "claude-code" ? p.existing : undefined;
}

/** Where an account's own Claude Code sign-in lives: agent-home/accounts/<account>. */
export const signInHome = (account: string, root = AGENT_HOMES): string => join(root, "accounts", account);

/** The shell command that signs an account in through Claude Code's own flow, in that account's config folder. */
export const claudeLoginCommand = (home: string): string => `CLAUDE_CONFIG_DIR=${quote(home)} claude auth login`;
/** Claude Code where the Slack inbox reads Slack, with only its Slack servers: `/mcp` in it signs them in again. */
export const slackLoginCommand = (home: string, mcp: string): string =>
  `CLAUDE_CONFIG_DIR=${quote(home)} claude --mcp-config ${quote(mcp)} --strict-mcp-config`;

/**
 * The variable that moves each CLI's login to another folder, for the CLIs where it really moves: Claude Code
 * (CLAUDE_CONFIG_DIR; its Keychain item is keyed to the folder) and Codex (CODEX_HOME holds auth.json, per its auth docs).
 * Cursor Agent keeps its login in Keychain items named without the folder whatever CURSOR_CONFIG_DIR says, and OpenCode's
 * sits in its data folder with everything else, so each of those has one login per computer.
 */
export const LOGIN_HOME_VAR: Partial<Record<RuntimeId, string>> = { "claude-code": "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

/** Each CLI's own sign-in command, for the CLIs that have one Overhand can open (Gemini CLI and Aider run on keys). */
const LOGIN: Partial<Record<RuntimeId, string>> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  cursor: "cursor-agent login",
  opencode: "opencode auth login",
};

/**
 * How an account signs in through its CLI's own flow: the command and the variable that keeps the login in the account's
 * own folder when it has one (else this computer's login). Null for an account that signs in some other way (a key, a
 * cloud, a gateway, or the Claude Code sign-in you already had).
 */
export function accountLogin(
  account: string,
  c: Pick<Config, "providers" | "runtimes"> = CFG,
  root = AGENT_HOMES,
): { argv: string[]; env: Record<string, string>; home: string } | null {
  const runtime = c.runtimes[account]?.kind ?? "claude-code";
  const login = LOGIN[runtime];
  const home = ownSignInHome(account, c, root);
  if (!login || (runtime === "claude-code" && !home)) return null;
  const v = LOGIN_HOME_VAR[runtime];
  return { argv: login.split(" "), env: home && v ? { [v]: home } : {}, home };
}

/** `accountLogin` as one shell command, for a terminal; "" when the account doesn't sign in with a login. */
export function accountLoginCommand(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG, root = AGENT_HOMES): string {
  const l = accountLogin(account, c, root);
  return l ? [...Object.entries(l.env).map(([k, v]) => `${k}=${quote(v)}`), ...l.argv].join(" ") : "";
}

/**
 * The command that runs the guard: the binary itself when bundled (by the path that follows its updates, so a
 * `brew cleanup` can't leave it pointing at nothing), else run.ts with the bun running this. No bun needed installed.
 * It fails closed: if the guard can't even start (a broken install, say), the shell turns that into a block,
 * because Claude Code lets a tool call through on any exit code but 2.
 */
export function hookCommand(bundled = BUNDLED, exec = SELF_EXEC, src = SRC, dialect: Dialect = "claude", home = OPS): string {
  const run = bundled ? [quote(exec), "guard"] : [quote(exec), quote(join(src, "run.ts")), "guard"];
  // Claude Code's hook, in settings Overhand writes, names Overhand's folder itself: an agent that runs a nested agent
  // with another OVERHAND_HOME can't point the guard at a folder of its own (the shell's prefix wins over the env)
  const pinned = dialect === "claude" ? [`OVERHAND_HOME=${quote(home)}`] : [];
  return [...pinned, ...run, ...(dialect === "claude" ? [] : [dialect]), "|| exit 2"].join(" ");
}

/** Another agent CLI's guard hook command: the same guard, told which CLI's events it reads. */
export const dialectHook = (dialect: Dialect): string => hookCommand(BUNDLED, SELF_EXEC, SRC, dialect);

/**
 * The guard in hand mode, for a project you connected (`overhand connect`): your own Claude Code sessions there report
 * to the control room and follow the house rules. Unlike an agent's, it fails open: with Overhand uninstalled (its
 * binary or checkout gone) the hook lets every call through instead of locking your sessions out.
 */
export function handHookCommand(bundled = BUNDLED, exec = SELF_EXEC, src = SRC): string {
  const entry = bundled ? exec : join(src, "run.ts");
  const run = bundled ? [quote(exec)] : [quote(exec), quote(entry)];
  return [`test -e ${quote(entry)} || exit 0;`, ...run, "guard", "hand"].join(" ");
}

/** The guard as a hooks block for a settings file or `--settings`: every tool call goes through it first. */
export const guardHooks = (command = hookCommand()) => ({
  PreToolUse: [{ matcher: "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|mcp__.*", hooks: [{ type: "command", command }] }],
});

/** Overhand's part of the config home's settings.json. */
export function agentSettings(command = hookCommand()): Record<string, unknown> {
  return {
    enableAllProjectMcpServers: true,
    hooks: guardHooks(command),
    theme: "dark",
  };
}

// ---------- the MCP servers your agent CLIs are set up with ----------

const readJson = (file: string): unknown => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};
/** A JSON object as a record, or {} for anything else; `key` picks one of its fields first. */
const obj = (x: unknown, key?: string): Record<string, unknown> => {
  const rec = typeof x === "object" && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x)) : {};
  return key === undefined ? rec : obj(rec[key]);
};

/**
 * Your Claude Code MCP servers for a run in `repo` (its main checkout): user scope (`mcpServers` in ~/.claude.json) and
 * local scope (`projects[<repo>].mcpServers`, where `claude mcp add` puts them by default). Project scope (`.mcp.json`)
 * travels with the repo already. Runs use Overhand's own config home, where Claude Code would see none of these.
 */
export function claudeMcpServers(repo: string, home = HOME): Record<string, unknown> {
  const j = readJson(join(home, ".claude.json"));
  return { ...obj(j, "mcpServers"), ...(repo ? obj(obj(obj(j, "projects"), repo), "mcpServers") : {}) };
}

/** An MCP server one of your agent CLIs is set up with: the CLI, the server's name, and its URL or command (for matching only). */
export interface AgentMcpServer {
  cli: string;
  name: string;
  where: string;
}

/**
 * Every MCP server your agent CLIs are set up with, from their own config files: Claude Code (~/.claude.json, user and
 * local scope), Codex (~/.codex/config.toml `mcp_servers`), Gemini CLI (~/.gemini/settings.json) and Cursor Agent
 * (~/.cursor/mcp.json) `mcpServers`, and OpenCode (~/.config/opencode/opencode.json `mcp`). Only names and endpoints are
 * read out; their env and headers (where secrets live) never leave this function.
 */
export function agentMcpServers(home = HOME): AgentMcpServer[] {
  const claude = readJson(join(home, ".claude.json"));
  let codex: unknown = null;
  try {
    const f = join(home, ".codex", "config.toml");
    codex = existsSync(f) ? Bun.TOML.parse(readFileSync(f, "utf8")) : null;
  } catch {
    // an unreadable config has no servers we can use
  }
  const sources: [string, Record<string, unknown>][] = [
    ["Claude Code", obj(claude, "mcpServers")],
    ...Object.values(obj(claude, "projects")).map((p): [string, Record<string, unknown>] => ["Claude Code", obj(p, "mcpServers")]),
    ["Codex", obj(codex, "mcp_servers")],
    ["Gemini CLI", obj(readJson(join(home, ".gemini", "settings.json")), "mcpServers")],
    ["Cursor Agent", obj(readJson(join(home, ".cursor", "mcp.json")), "mcpServers")],
    ["OpenCode", obj(readJson(join(home, ".config", "opencode", "opencode.json")), "mcp")],
  ];
  const seen = new Set<string>();
  return sources.flatMap(([cli, servers]) =>
    Object.entries(servers).flatMap(([name, def]) => {
      const d = obj(def);
      const words = ["url", "httpUrl", "serverUrl", "command"].map((k) => d[k]);
      const args = Array.isArray(d.args) ? d.args : Array.isArray(d.command) ? d.command : [];
      const where = [...words, ...args].filter((x) => typeof x === "string").join(" ");
      const key = `${cli}/${name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ cli, name, where }];
    }),
  );
}

/**
 * Writes the settings and, with `instructions` on, the agent instructions into `dir`; settings keys of your own stay,
 * Overhand's are replaced. An account's own sign-in folder gets no instructions file: leads run there too, and ticket
 * runs get the instructions by flag.
 */
export function writeAgentHome(dir = AGENT_HOME, command = hookCommand(), instructions = true): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  let mine: Record<string, unknown> = {};
  try {
    if (existsSync(file)) mine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // unreadable settings: ours replace them
  }
  writeFileSync(file, `${JSON.stringify({ ...mine, ...agentSettings(command) }, null, 2)}\n`);
  if (instructions) writeFileSync(join(dir, "CLAUDE.md"), INSTRUCTIONS);
  // Overhand's own agent home: the other CLIs' guard configs come with it
  if (dir === AGENT_HOME) writeGuardConfigs();
}

// ---------- the guard for the other agent CLIs ----------

/**
 * Where Overhand keeps each other CLI's guard config, all inside the agent home (Overhand's own files, which no agent may
 * change): a Gemini CLI home (GEMINI_CLI_HOME; its user settings carry the hook, and your own ~/.gemini stays yours:
 * Gemini CLI 0.65 skips a system settings or defaults file whose folder isn't owned by root, so those layers can't carry
 * it), a Cursor plugin (`--plugin-dir`) that carries hooks, and an OpenCode config folder
 * (OPENCODE_CONFIG_DIR) whose plugins/ it loads. Codex takes its hook by `-c` instead (runtimes/codex.ts).
 */
export const GUARD_CONFIG = {
  gemini: join(AGENT_HOMES, "gemini"),
  cursor: join(AGENT_HOMES, "cursor-guard"),
  opencode: join(AGENT_HOMES, "opencode"),
  aider: join(AGENT_HOMES, "aider", "aiderignore"),
  /** An empty Aider config (`--config`), so no .aider.conf.yml in the repo or your home can turn its shell back on. */
  aiderConfig: join(AGENT_HOMES, "aider", "aider.conf.yml"),
} as const;

/**
 * The secret files Aider must never see, as an .aiderignore (gitignore patterns): the in-repo side of the guard's file
 * rules (guard.ts PATH_RULES; a test holds each one to them). Aider can't open a file outside its repo, nor one ignored.
 */
export const AIDER_IGNORE = [
  // gitignore patterns match case for case; the guard's rule for these doesn't (/password/i)
  ".env.prod*",
  "*password*",
  "*Password*",
  "*PASSWORD*",
  "env.local.docx",
  ".ssh/",
  ".aws/credentials",
  ".npmrc",
];

/**
 * Gemini CLI's settings with the guard as a BeforeTool hook on every tool (matcher "*"), in Overhand's Gemini home.
 * save_memory is left out: it writes a GEMINI.md there that every later run would read as instructions.
 */
export const geminiSettings = (command = dialectHook("gemini")) => ({
  hooksConfig: { enabled: true },
  tools: { exclude: ["save_memory"] },
  hooks: { BeforeTool: [{ matcher: "*", hooks: [{ type: "command", name: "overhand-guard", command, timeout: 60_000 }] }] },
});

/**
 * Cursor's hooks file for the plugin: shell commands, file reads, MCP calls and every other tool (edits) go through the
 * guard, failing closed (Cursor lets a call through when a hook crashes or times out unless `failClosed` says otherwise).
 */
export const cursorHooks = (command = dialectHook("cursor")) => {
  const hook = [{ command, failClosed: true }];
  return { version: 1, hooks: { beforeShellExecution: hook, beforeReadFile: hook, beforeMCPExecution: hook, preToolUse: hook } };
};

/**
 * OpenCode's plugin: every tool call goes through the guard first, and a block (or a guard that can't run) throws, which
 * rejects the call before it runs (opencode.ai/docs/plugins).
 */
export const opencodePlugin = (command = dialectHook("opencode")): string =>
  [
    "// Written by Overhand: every tool call goes through Overhand's guard first. Changes here are overwritten.",
    'import { spawnSync } from "node:child_process";',
    `const COMMAND = ${JSON.stringify(command)};`,
    "export const OverhandGuard = async ({ directory }) => ({",
    '  "tool.execute.before": async (input, output) => {',
    "    const event = { tool_name: input.tool, tool_input: output.args ?? {}, cwd: directory, session_id: input.sessionID };",
    '    const r = spawnSync("sh", ["-c", COMMAND], { input: JSON.stringify(event), encoding: "utf8", env: process.env });',
    '    if (r.status !== 0) throw new Error((r.stderr || "").trim() || "Blocked by the guard");',
    "  },",
    "});",
    "",
  ].join("\n");

/** Writes every other CLI's guard config (GUARD_CONFIG) under `root`, so an update's guard reaches the next run. */
export function writeGuardConfigs(root = AGENT_HOMES): void {
  const at = (p: string) => join(root, p.slice(AGENT_HOMES.length + 1));
  // whole or not at all (a run starting meanwhile never reads half a file), and only when it changed
  const write = (file: string, text: string) => {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  };
  // a memory a Gemini run saved anyway is dropped: no run takes instructions from an earlier one
  rmSync(join(at(GUARD_CONFIG.gemini), ".gemini", "GEMINI.md"), { force: true });
  write(join(at(GUARD_CONFIG.gemini), ".gemini", "settings.json"), `${JSON.stringify(geminiSettings(), null, 2)}\n`);
  write(
    join(at(GUARD_CONFIG.cursor), ".cursor-plugin", "plugin.json"),
    `${JSON.stringify({ name: "overhand-guard", hooks: "./hooks.json" })}\n`,
  );
  write(join(at(GUARD_CONFIG.cursor), "hooks.json"), `${JSON.stringify(cursorHooks(), null, 2)}\n`);
  write(join(at(GUARD_CONFIG.opencode), "plugins", "overhand-guard.js"), opencodePlugin());
  write(at(GUARD_CONFIG.aider), `${AIDER_IGNORE.join("\n")}\n`);
  write(at(GUARD_CONFIG.aiderConfig), "{}\n");
}

/** Where each CLI keeps its config and login when Overhand doesn't move it (its own default). */
const CLI_HOME: Record<RuntimeId, string> = {
  "claude-code": "~/.claude",
  codex: "~/.codex",
  gemini: "~/.gemini",
  cursor: "~/.cursor",
  opencode: "~/.config/opencode",
  aider: "~/.aider.conf.yml",
};

/**
 * The config folder an account's runs use, for Settings to show (read-only): your own sign-in's folder, the account's
 * own sign-in folder, Overhand's agent home for Claude Code, or the CLI's default.
 */
export function configHome(account: string, c: Pick<Config, "providers" | "runtimes"> = CFG): string {
  const kind = c.runtimes[account]?.kind ?? "claude-code";
  const existing = existingHome(account, c);
  if (existing !== undefined) return existing || CLI_HOME["claude-code"];
  return ownSignInHome(account, c) || (kind === "claude-code" ? AGENT_HOME : CLI_HOME[kind]);
}
