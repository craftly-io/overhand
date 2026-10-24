/** Claude Code (`claude -p`), the reference runtime: schema-enforced answers, auto mode, subagents, usage windows. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Provider } from "../config";
import { subscriptionToken } from "../legacy-token";
import { SECRET_STORE } from "../platform";
import { parseStream } from "../usage";
import { type AgentRuntime, baseEnv, guardEnv, type RunInput, readOnly } from "./runtime";
import { tuneArgs } from "./tune";

// Every variable that picks Claude Code's backend, credential or model: cleared first so a stray one in the daemon's
// environment can't send an account's runs somewhere else. AWS_* stay: agents' own tools (the aws CLI) may need them.
const BACKEND_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

/** The daemon's environment without any variable that picks Claude Code's backend, credential or model. */
function cleanEnv(): Record<string, string> {
  const env = baseEnv();
  for (const v of BACKEND_VARS) delete env[v];
  return env;
}

/**
 * The environment to run `claude` with for an account, per its provider (names from code.claude.com/docs: amazon-bedrock,
 * google-vertex-ai, llm-gateway-connect). `claude` on `login`: no credential at all; the caller points CLAUDE_CONFIG_DIR at
 * the account's own sign-in folder (`ownSignInHome`) and Claude Code reads its own login there. `claude` on `key`: an
 * Anthropic API key (anthropic-key-<account>) as ANTHROPIC_API_KEY. `bedrock` / `vertex`: the cloud's credential chain on
 * this machine. `gateway`: ANTHROPIC_BASE_URL with a bearer token. A pinned model also pins the opus/sonnet/haiku aliases,
 * because ops passes `--model haiku` and `--model sonnet`, which a gateway's models don't answer to.
 */
export function claudeCodeEnv(account: string, p: Provider, read: RunInput["read"]): Record<string, string> {
  const env = cleanEnv();
  if (p.kind === "claude") {
    const legacy = subscriptionToken(account, read); // null unless local code opted in (legacy-token.ts)
    if (legacy !== null) env.CLAUDE_CODE_OAUTH_TOKEN = legacy;
    else if (p.auth === "key") {
      const key = read(`anthropic-key-${account}`);
      if (key === null) throw new Error(`no Anthropic API key for ${account} in ${SECRET_STORE} (anthropic-key-${account})`);
      env.ANTHROPIC_API_KEY = key;
    }
    return env;
  }
  if (p.kind === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    env.AWS_REGION = p.region;
    if (p.profile) env.AWS_PROFILE = p.profile;
  } else if (p.kind === "vertex") {
    env.CLAUDE_CODE_USE_VERTEX = "1";
    env.CLOUD_ML_REGION = p.region;
    env.ANTHROPIC_VERTEX_PROJECT_ID = p.project;
  } else {
    const token = p.secret ? read(p.secret) : "overhand"; // Claude Code refuses to start ("Not logged in") without one
    if (token === null) throw new Error(`gateway token ${p.secret} for ${account} missing from ${SECRET_STORE}`);
    env.ANTHROPIC_BASE_URL = p.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = token;
  }
  if (p.model) {
    env.ANTHROPIC_MODEL = p.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = p.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = p.model;
  }
  if (p.smallModel || p.model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.smallModel || p.model;
  return env;
}

/**
 * Whether Claude Code says it's signed in with `home` as its config folder ("" for its default, CLAUDE_CONFIG_DIR
 * unset): `claude auth status` exits 0 only then. The CLI looks in its own store (macOS: a Keychain item keyed to the
 * folder, or to "the variable is unset"; Linux: <home>/.credentials.json); Overhand only reads the exit code, never the
 * credential. Backend variables are cleared so an API key in the daemon's environment can't count as a sign-in.
 */
export async function claudeSignedIn(home: string, bin = "claude"): Promise<boolean> {
  const env = cleanEnv();
  if (home) env.CLAUDE_CONFIG_DIR = home;
  else delete env.CLAUDE_CONFIG_DIR;
  try {
    const p = Bun.spawn([bin, "auth", "status"], {
      env,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 15_000,
    });
    return (await p.exited) === 0;
  } catch {
    return false; // not installed
  }
}

/**
 * The Claude Code sign-in already on this computer, the one `claude` in your terminal uses: the CLAUDE_CONFIG_DIR it's in
 * ("" for Claude Code's default, ~/.claude), or null when Claude Code says it isn't signed in there or the folder is one
 * of Overhand's own (`overhand`, its agent homes). Asked of the CLI (`claudeSignedIn`); nothing in the folder is read.
 */
export async function existingClaudeSignIn(
  env: Record<string, string | undefined>,
  overhand: string,
  bin = "claude",
): Promise<string | null> {
  const dir = env.CLAUDE_CONFIG_DIR ?? "";
  if (dir === overhand || dir.startsWith(`${overhand}/`)) return null;
  return (await claudeSignedIn(dir, bin)) ? dir : null;
}

// clients see these commits and PRs: no tool attribution unless the config asks for it
/** `--settings` for the run: no AI attribution unless you want it, and any extra hooks (the guard, for leads). */
const noAttribution = (r: RunInput): string[] => {
  const settings = {
    ...(r.attribution ? {} : { attribution: { commit: "", pr: "", sessionUrl: "" } }),
    ...(r.hooks ? { hooks: r.hooks } : {}),
  };
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
};

/** `plan` (read-only: no edits, no commands that change anything) for a project on watch, else `auto`. */
const permissionMode = (r: RunInput): string => (readOnly(r) ? "plan" : "auto");

/** The CLI's environment for this account, with what the guard hook reads. */
const envFor = (r: RunInput): Record<string, string> => guardEnv(r, claudeCodeEnv(r.account, r.provider, r.read));

/**
 * The run's cost in dollars, counting only models Claude Code knows the price of. For a model it doesn't (a local
 * Ollama model, say) it reports `costBasis: "unknown"` with a made-up figure, which would eat the daily budget.
 */
export function knownCost(result: Record<string, unknown>): number {
  const total = Number(result.total_cost_usd ?? 0);
  const usage = result.modelUsage;
  if (typeof usage !== "object" || usage === null) return total;
  const models = Object.values(usage).filter((m): m is object => typeof m === "object" && m !== null);
  const unknown = models.filter((m) => "costBasis" in m && m.costBasis === "unknown");
  if (unknown.length && unknown.length === models.length) return 0;
  // fails safe: a priced model always counts, and only an unknown model's own reported figure is taken off
  const off = unknown.reduce((n, m) => n + ("costUSD" in m && typeof m.costUSD === "number" ? m.costUSD : 0), 0);
  return Math.max(0, total - off);
}

/**
 * Every run's MCP servers are exactly the ones Overhand hands it (your own, copied from ~/.claude.json, for this run
 * only, in a file added to `files` and removed when it ends), strictly: none that a run left in its config folder's
 * .claude.json or a project's .mcp.json starts. A run that names its own servers strictly (the inbox) keeps to those.
 */
export function mcpConfig(r: RunInput, files: Record<string, string>, tmp = tmpdir()): string[] {
  if (r.args.includes("--strict-mcp-config")) return [];
  // a folder of its own (0700, an unguessable name) holds the file, which carries your servers' tokens; the spawn writes
  // it exclusively (writeRunFiles) and removes both after the run
  const file = join(mkdtempSync(join(tmp, "overhand-mcp-")), "mcp.json");
  // a run on watch gets none of yours: only Overhand's own (agent-home.ts runMcpServers), whose key limits it anyway
  const { overhand } = r.mcpServers ?? {};
  files[file] = JSON.stringify({ mcpServers: readOnly(r) ? (overhand ? { overhand } : {}) : (r.mcpServers ?? {}) });
  return ["--strict-mcp-config", "--mcp-config", file];
}

/**
 * Writes a spawn's files (mcpConfig's among them, holding tokens) before it starts: exclusively (never through a link
 * or over a file someone left there), readable only by you. Returns what removes them, and their own folders, after.
 */
export function writeRunFiles(files: Record<string, string>): () => void {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text, { mode: 0o600, flag: "wx" });
  }
  return () => {
    for (const f of Object.keys(files)) {
      rmSync(f, { force: true });
      if (basename(dirname(f)).startsWith("overhand-mcp-")) rmSync(dirname(f), { recursive: true, force: true });
    }
  };
}

export const claudeCode: AgentRuntime = {
  id: "claude-code",
  label: "Claude Code",
  bin: "claude",
  status: "verified",
  caps: { jsonSchema: true, autoMode: true, subagents: true, usage: true, transcripts: true },
  models: "The account's provider (Claude, Bedrock, Vertex or a gateway) and its pinned model; ops' haiku/sonnet aliases otherwise.",
  task(r) {
    // stream-json (not json) so each run also reports the account's 5-hour and weekly usage
    const argv = ["claude", "-p", r.prompt, "--output-format", "stream-json", "--verbose", "--json-schema", r.schema, ...r.args];
    if (!r.args.includes("--permission-mode")) argv.push("--permission-mode", permissionMode(r));
    argv.push(...noAttribution(r), ...tuneArgs("claude-code", r.tune, true));
    if (r.alias) argv.push("--model", r.alias);
    const env = envFor(r);
    const files: Record<string, string> = {};
    // an account's own sign-in folder holds no instructions file (its leads run there too), nor does your own Claude Code
    // config (configDir "": Claude Code's default): they come in by flag
    if (r.instructions && dirname(r.instructions) !== r.configDir) argv.push("--append-system-prompt-file", r.instructions);
    if (r.configDir) env.CLAUDE_CONFIG_DIR = r.configDir;
    argv.push(...mcpConfig(r, files));
    return { argv, env, files };
  },
  lead(r) {
    // stream-json so the dashboard can show what the lead is doing while it works, and its account usage
    const argv = [
      "claude",
      "-p",
      r.prompt,
      "--permission-mode",
      permissionMode(r),
      "--output-format",
      "stream-json",
      "--verbose",
      ...noAttribution(r),
      ...tuneArgs("claude-code", r.tune, false),
    ];
    const env = envFor(r);
    const files: Record<string, string> = {};
    if (r.configDir) env.CLAUDE_CONFIG_DIR = r.configDir; // a config folder of Overhand's once the account moved (runHome)
    argv.push(...mcpConfig(r, files));
    return { argv, env, files };
  },
  parse(stdout, stderr) {
    const { usage, result } = parseStream(stdout);
    if (!result) return { ok: false, text: [stdout, stderr].join("\n").slice(-500), structured: undefined, cost: 0, usage };
    const text = typeof result.result === "string" ? result.result : "";
    const cost = knownCost(result);
    return { ok: result.is_error !== true, text, structured: result.structured_output ?? undefined, cost, usage };
  },
};
