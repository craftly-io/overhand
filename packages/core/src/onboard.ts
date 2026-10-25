/**
 * First-run setup: finds the git repositories under your code folder and proposes projects from them, so a new user
 * confirms a list instead of typing one in. GitHub repos become projects tracked with GitHub Issues, which needs no
 * login beyond `gh`; other hosts are listed for setting up by hand.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { type Connection, detectBilling, isBilled, SERVICE_IDS } from "@overhand/contract";
import { z } from "zod";
import { type AgentMcpServer, agentMcpServers } from "./agent-home";
import { type Config, FIRST_DAY_BUDGET_USD, RUNTIME_IDS, type RuntimeId } from "./config";
import { CFG, HOME, SLACK_MCP, sh, shAsync } from "./env";
import { connected, isMcpService, type McpService, SERVICES } from "./mcp";
import { readSecret } from "./platform";
import { RUNTIMES } from "./runtimes";
import { vercelCliToken } from "./status/vercel";

type ServiceId = Connection["id"];

export interface FoundRepo {
  /** Folder relative to the code root, e.g. "honeycrust/web". */
  path: string;
  host: "github" | "bitbucket" | "other";
  owner: string;
  name: string;
}

export interface ProposedProject {
  name: string;
  /** Folder under the code root that holds its repos. */
  dir: string;
  prefix: string;
  host: "github";
  /** The repo whose Issues are its tracker, owner/name. */
  trackerRepo: string;
  /** Every repo of that owner it found, owner/name: the choices for trackerRepo. */
  trackerRepos: string[];
  repos: string[];
}

/** Host, owner and name from a git remote URL (ssh or https); null for anything it can't read. */
export function parseRemote(url: string): Omit<FoundRepo, "path"> | null {
  const x = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!x?.[1] || !x[2] || !x[3]) return null;
  const host = x[1] === "github.com" ? "github" : x[1] === "bitbucket.org" ? "bitbucket" : "other";
  return { host, owner: x[2], name: x[3] };
}

/**
 * A ticket-key prefix from a name: the letters of its first word ("Bluekite-2 Labs" → INITE), else of the whole name,
 * 2–5 long and unused; a number is added when it's taken.
 */
export function prefixFor(name: string, taken: ReadonlySet<string>): string {
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
  const first = letters(name.split(/[^A-Za-z0-9]+/)[0] ?? "");
  const all = letters(name);
  const base = (first.length >= 2 ? first : all.length >= 2 ? all : `${all}PRJ`).slice(0, 5);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const p = `${base.slice(0, 4)}${n}`;
    if (!taken.has(p)) return p;
  }
}

/**
 * One project per GitHub owner: named after the owner (after the repo when it has just one), living in the folder most
 * of its repos sit under (a repo's parent folder, or the repo itself when it sits right in the code root), tracked with
 * the Issues of its first repo.
 * Owners on other hosts are left out; the wizard lists them. Prefixes in `taken` (projects you already have) aren't reused.
 */
export function proposeProjects(repos: readonly FoundRepo[], taken = new Set<string>()): ProposedProject[] {
  const byOwner = new Map<string, FoundRepo[]>();
  for (const r of repos) {
    if (r.host !== "github") continue;
    const k = r.owner.toLowerCase();
    byOwner.set(k, [...(byOwner.get(k) ?? []), r]);
  }
  return [...byOwner.values()]
    .sort((a, b) => b.length - a.length)
    .flatMap((rs) => {
      const [first] = rs;
      if (!first) return [];
      const tops = new Map<string, number>();
      for (const r of rs) {
        const top = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : r.path;
        tops.set(top, (tops.get(top) ?? 0) + 1);
      }
      const dir = [...tops].sort((a, b) => b[1] - a[1])[0]?.[0] ?? first.path;
      // one repo: the project is that repo ("Hello-World", not its owner "Octocat"); several: their owner
      const name = rs.length === 1 ? first.name : first.owner.charAt(0).toUpperCase() + first.owner.slice(1);
      const prefix = prefixFor(name, taken);
      taken.add(prefix);
      return [
        {
          name,
          dir,
          prefix,
          host: "github" as const,
          trackerRepo: `${first.owner}/${first.name}`,
          trackerRepos: rs.map((r) => `${r.owner}/${r.name}`),
          repos: rs.map((r) => r.path),
        },
      ];
    });
}

/** Git repositories in the code root and one level below it, with their origin; ops' own folder is skipped. */
export function scanRepos(codeRoot: string, skip: readonly string[] = []): FoundRepo[] {
  if (!existsSync(codeRoot)) return [];
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => join(p, d.name));
    } catch {
      return [];
    }
  };
  const isRepo = (p: string) => existsSync(join(p, ".git"));
  const found: string[] = [];
  for (const top of dirs(codeRoot)) {
    if (skip.includes(top)) continue;
    if (isRepo(top)) found.push(top);
    else for (const sub of dirs(top)) if (isRepo(sub)) found.push(sub);
    if (found.length >= 400) break; // a code folder that big is set up by hand
  }
  return found.flatMap((p) => {
    const r = sh(["git", "-C", p, "remote", "get-url", "origin"], p, 10_000);
    const remote = r.ok ? parseRemote(r.out) : null;
    if (!remote) return [];
    return [{ ...remote, path: relative(codeRoot, p).split(sep).join("/") }];
  });
}

/** Whether the GitHub CLI is installed and signed in, and as whom. */
export function githubLogin(): string {
  const r = sh(["gh", "api", "user", "-q", ".login"], undefined, 15_000);
  return r.ok ? r.out : "";
}

/** What identifies a service's MCP server in an agent CLI's config: its name, URL or command. */
const MCP_MATCH: Record<ServiceId, RegExp> = {
  github: /github/i,
  linear: /linear/i,
  jira: /atlassian|jira/i,
  slack: /slack/i,
  sentry: /sentry/i,
  vercel: /vercel/i,
};

/** The first of your agents' MCP servers that reaches a service. */
export const agentServerFor = (id: ServiceId, servers: readonly AgentMcpServer[]): AgentMcpServer | undefined =>
  servers.find((s) => MCP_MATCH[id].test(`${s.name} ${s.where}`));

const LABELS: Record<ServiceId, string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
  slack: "Slack",
  sentry: "Sentry",
  vercel: "Vercel",
};

/**
 * Each service and what already reaches it, so Setup and Settings ask for nothing that works: Overhand's own access
 * first (the `gh` and `vercel` logins, its MCP sign-in, a stored token, Slack's slack-mcp.json), else an MCP server your
 * agent CLIs are set up with. Nothing secret is returned.
 */
export async function connections(home = HOME): Promise<Connection[]> {
  const agents = agentMcpServers(home);
  const gh = await shAsync(["gh", "api", "user", "-q", ".login"], undefined, 15_000);
  const stored = (names: string[]) => names.some((n) => n && readSecret(n, CFG.owner.keychainAccount) !== null);
  const trackerSecrets = (kind: "linear" | "jira") =>
    CFG.clients.flatMap((c) => (c.tracker && c.tracker.kind === kind ? [c.tracker.secret] : []));
  const statusSecrets = (k: "vercelSecrets" | "sentrySecrets") => [...CFG.status[k], ...CFG.clients.flatMap((c) => c.status[k])];
  const mine = (s: McpService, secrets: string[]): Pick<Connection, "via" | "detail"> | null =>
    connected(s) ? { via: "mcp", detail: "" } : stored(secrets) ? { via: "token", detail: "" } : null;
  const own: Record<ServiceId, Pick<Connection, "via" | "detail"> | null> = {
    github: gh.ok && gh.out ? { via: "gh", detail: gh.out } : null,
    linear: mine("linear", trackerSecrets("linear")),
    jira: mine("jira", trackerSecrets("jira")),
    slack: existsSync(SLACK_MCP) ? { via: "inbox", detail: SLACK_MCP } : null,
    sentry: mine("sentry", statusSecrets("sentrySecrets")),
    vercel: vercelCliToken(home)
      ? { via: "cli", detail: "" }
      : stored(statusSecrets("vercelSecrets"))
        ? { via: "token", detail: "" }
        : null,
  };
  return SERVICE_IDS.map((id) => {
    const o = own[id];
    const a = o ? undefined : agentServerFor(id, agents);
    return {
      id,
      label: LABELS[id],
      state: o ? "connected" : a ? "agent" : "none",
      via: o?.via ?? (a ? "agent" : ""),
      detail: o?.detail ?? (a ? `${a.cli}: ${a.name}` : ""),
      connect: isMcpService(id) && SERVICES[id].dcr,
    };
  });
}

/** Your name from git (`git config user.name`); "" when it isn't set. */
export const gitUserName = (): string => sh(["git", "config", "--global", "user.name"], undefined, 5_000).out;

/**
 * Each agent CLI: installed, and whether its own login is there, from cheap checks only (a file it writes when you sign
 * in; Codex's `login status`; Cursor Agent's `status`), never a credential's contents. Every CLI but Claude Code runs on
 * your own login in its own config, so signed in here means runs can use it as is. Claude Code counts as signed in when
 * the first account already reaches Claude (`claudeReady`: signed in in its own folder, the Claude Code you're already
 * signed in to, or an API key stored).
 */
export function agentLogins(claudeReady: boolean): FoundAgent[] {
  const home = homedir();
  const signedIn: Record<RuntimeId, () => boolean> = {
    "claude-code": () => claudeReady,
    // auth.json, or the OS keyring when Codex stores it there (`codex login status` exits 0 when signed in)
    codex: () =>
      Boolean(process.env.OPENAI_API_KEY) ||
      existsSync(join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json")) ||
      sh(["codex", "login", "status"], undefined, 10_000).ok,
    // a Gemini API key, in the environment or stored by setup; never a Google account sign-in (agentForPlan)
    gemini: () => Boolean(process.env.GEMINI_API_KEY) || readSecret(geminiKeyItem(FIRST_ACCOUNT), CFG.owner.keychainAccount) !== null,
    cursor: () => Boolean(process.env.CURSOR_API_KEY) || /Logged in/i.test(sh(["cursor-agent", "status"], undefined, 10_000).out),
    // the providers you've signed in to with `opencode auth login` (GitHub Copilot, say), in its data folder
    opencode: () => existsSync(join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "auth.json")),
    aider: () => false, // it reads API keys from the environment per model; nothing to sign in to
  };
  return RUNTIME_IDS.map((id) => {
    const installed = Bun.which(RUNTIMES[id].bin, { PATH: process.env.PATH }) !== null; // today's PATH: Bun.which keeps the one it started with
    return { id, installed, signedIn: installed && signedIn[id]() };
  });
}

/**
 * Gemini CLI holds a cached Google account sign-in (oauth_creds.json in ~/.gemini, or GEMINI_CLI_HOME's .gemini; only
 * its presence is checked). Never counted as signed in: Gemini CLI stopped serving free and Google One sign-ins
 * (agentForPlan), so setup only says so and asks for a key.
 */
export const geminiGoogleLogin = (home = process.env.GEMINI_CLI_HOME ?? homedir()): boolean =>
  existsSync(join(home, ".gemini", "oauth_creds.json"));

/** The models a running Ollama has pulled; empty when none answers at OLLAMA_URL. */
export async function ollamaModels(): Promise<LocalModel[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1_500) });
    const body: unknown = await res.json();
    const models = typeof body === "object" && body !== null && "models" in body && Array.isArray(body.models) ? body.models : [];
    return models.flatMap((m: unknown) =>
      typeof m === "object" && m !== null && "name" in m && typeof m.name === "string"
        ? [{ name: m.name, size: "size" in m && typeof m.size === "number" ? m.size : 0 }]
        : [],
    );
  } catch {
    return [];
  }
}

/** True for a folder that exists; the wizard checks a typed code root with it. */
export const isFolder = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** A typed folder with a leading `~` (how most people write their home folder) as the real path. */
export const homePath = (p: string): string => p.replace(/^~(?=\/|$)/, HOME);

/** What the setup wizard submits: who you are, where your code is, the projects you kept and how agents reach Claude. */
export const SetupSchema = z.object({
  owner: z.string().trim().min(1),
  codeRoot: z.string().trim().min(1).transform(homePath),
  projects: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        dir: z.string().trim().min(1),
        prefix: z.string().regex(/^[A-Z][A-Z0-9]+$/),
        trackerRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      }),
    )
    // none is fine: the dashboard then shows how to add the first project
    .default([]),
  /**
   * How the first account reaches Claude: `login`, Claude Code's own sign-in in the account's folder (nothing is sent), or
   * `key`, an Anthropic API key (`value`; empty when one is already stored or unused).
   */
  credential: z.object({ kind: z.enum(["login", "key"]), value: z.string().trim() }),
  /** The agent CLI the first account runs. */
  agent: z.enum(RUNTIME_IDS).default("claude-code"),
  /** A Gemini API key for Gemini CLI (free from Google AI Studio); stored in the secret store, empty when unused. */
  geminiKey: z.string().trim().default(""),
  /** The model behind it: Claude (signed in as above), a local Ollama model, or any gateway URL with a model. */
  backend: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("claude") }),
      z.object({ kind: z.literal("ollama"), model: z.string().trim().min(1) }),
      z.object({ kind: z.literal("gateway"), baseUrl: z.url(), model: z.string().trim().min(1) }),
    ])
    .default({ kind: "claude" }),
});
export type Setup = z.infer<typeof SetupSchema>;

/** The account label a fresh install runs its agents on. */
export const FIRST_ACCOUNT = "main";

/** Where a local Ollama serves. */
const OLLAMA_URL = "http://localhost:11434";

/** An agent CLI as setup found it. */
export interface FoundAgent {
  id: RuntimeId;
  installed: boolean;
  /** Its own login (or, for Claude Code, a stored API key) is already there. */
  signedIn: boolean;
}

/** A model a local Ollama has pulled (its /api/tags). */
export interface LocalModel {
  name: string;
  /** Bytes on disk, about what it takes in memory. */
  size: number;
}

/** The agent CLI setup proposes: an installed one that's signed in, else any installed one, Claude Code first either way. */
export function pickAgent(found: readonly FoundAgent[]): RuntimeId {
  const order = (xs: readonly FoundAgent[]) => [...xs].sort((a, b) => RUNTIME_IDS.indexOf(a.id) - RUNTIME_IDS.indexOf(b.id));
  const installed = order(found.filter((a) => a.installed));
  return (installed.find((a) => a.signedIn) ?? installed[0])?.id ?? "claude-code";
}

/**
 * Model families that called tools reliably through the agent CLIs in our end-to-end runs, best first. qwen2.5-coder
 * is left out on purpose: it writes tool calls as text, so agents can't edit with it.
 */
const TOOL_CALLERS = [/qwen3/i, /devstral/i, /gpt-oss/i, /llama3\.[1-3]/i];

/**
 * The local model setup proposes: from the best family that can call tools, the largest that fits in `memory` (half
 * of it, so the machine keeps working); then any chat model that fits; the smallest when none fits. Embedding models
 * can't chat and are skipped.
 */
export function pickLocalModel(models: readonly LocalModel[], memory: number): string {
  const chat = models.filter((m) => !/embed/i.test(m.name));
  const fits = (xs: LocalModel[]) => xs.filter((m) => m.size <= memory / 2).sort((a, b) => b.size - a.size);
  const callers = TOOL_CALLERS.map((family) => fits(chat.filter((m) => family.test(m.name)))[0]).find(Boolean);
  const smallest = [...chat].sort((a, b) => a.size - b.size)[0];
  return (callers ?? fits(chat)[0] ?? smallest)?.name ?? "";
}

/**
 * The model backend setup proposes: Claude when you have it (signed in, or an API key stored), else a running Ollama's
 * best model, else Claude (and setup asks you to sign in or add a key).
 */
export function pickBackend(claude: boolean, ollama: readonly LocalModel[], memory: number): Setup["backend"] {
  const model = pickLocalModel(ollama, memory);
  return claude || !model ? { kind: "claude" } : { kind: "ollama", model };
}

/**
 * The config a finished wizard saves: its projects tracked with GitHub Issues, one account on its agent CLI and model,
 * every default. `existing`: the config folder of the Claude Code sign-in you already had ("" for Claude Code's
 * default), which a Claude Code account on `login` then uses instead of a folder of its own.
 */
export function configFromSetup(s: Setup, base: Config, existing?: string): unknown {
  const b = s.backend;
  const gateway = b.kind === "claude" ? null : { kind: "gateway", baseUrl: b.kind === "ollama" ? OLLAMA_URL : b.baseUrl, model: b.model };
  // Aider reaches Ollama best as ollama_chat/<model> (its docs); every other CLI takes the model from the gateway
  const model = s.agent === "aider" && b.kind === "ollama" ? `ollama_chat/${b.model}` : "";
  const provider = gateway
    ? gateway
    : s.agent === "claude-code" && s.credential.kind === "key"
      ? { kind: "claude", auth: "key" }
      : s.agent === "claude-code" && existing !== undefined
        ? { kind: "claude", auth: "login", existing }
        : undefined;
  // billed, or not known from the config (a sign-in may be a plan or per use): the budget then holds only what may be billed
  const first = detectBilling({ runtime: s.agent, provider, model });
  const billed = isBilled(first.billing) || !first.sure;
  return {
    ...base,
    owner: { name: s.owner, keychainAccount: base.owner.keychainAccount },
    codeRoot: s.codeRoot,
    accounts: [FIRST_ACCOUNT],
    providers: provider ? { [FIRST_ACCOUNT]: provider } : {},
    runtimes: s.agent === "claude-code" ? {} : { [FIRST_ACCOUNT]: { kind: s.agent, model } },
    // a new install starts careful: an account that is or may be billed gets a daily budget it can raise in Settings; a
    // local model isn't charged per run, so a budget would cap nothing
    limits: { ...base.limits, dailyBudgetUsd: base.limits.dailyBudgetUsd || (billed ? FIRST_DAY_BUDGET_USD : 0) },
    clients: s.projects.map((p) => ({
      name: p.name,
      dir: p.dir,
      prefix: p.prefix,
      host: "github",
      tracker: { kind: "github", repo: p.trackerRepo },
      // a new project starts careful: agents open draft PRs and a person marks them ready
      autonomy: "propose",
    })),
  };
}

/** The AI chat plans setup asks about: which one you already pay for. */
export const CHAT_PLANS = ["claude", "chatgpt", "gemini", "none"] as const;
export type ChatPlan = (typeof CHAT_PLANS)[number];

/**
 * The coding agent a chat plan already includes, and how agents reach a model with it. Claude Pro/Max includes Claude
 * Code (its own sign-in), ChatGPT Plus/Pro includes Codex; with none, Claude Code on an Anthropic API key. Overhand
 * never handles a plan's tokens: each CLI signs in by itself.
 *
 * Gemini is Gemini CLI on a Gemini API key, free from Google AI Studio, never a Google account sign-in: Google moved
 * free and Google One accounts from Gemini CLI to Antigravity CLI (June 2026). An Antigravity runtime is planned; until
 * then the key is what works for everyone.
 */
export function agentForPlan(plan: ChatPlan): { agent: RuntimeId; credential: "login" | "key" } {
  if (plan === "chatgpt") return { agent: "codex", credential: "login" };
  if (plan === "gemini") return { agent: "gemini", credential: "key" };
  return { agent: "claude-code", credential: plan === "none" ? "key" : "login" };
}

/** What install can use on this machine. */
export interface InstallHost {
  os: NodeJS.Platform;
  brew: boolean;
  npm: boolean;
}

/** Each installable agent's own install and sign-in docs, where the commands below come from. */
export const AGENT_DOCS: Partial<Record<RuntimeId, string>> = {
  "claude-code": "https://code.claude.com/docs/en/setup",
  codex: "https://github.com/openai/codex#quickstart",
  gemini: "https://github.com/google-gemini/gemini-cli#-installation",
};

/**
 * The vendor's official install command for an agent on this machine, or null when there's none to run safely here
 * (setup then links the docs). macOS and Linux only, as Overhand. Sources, checked 2026-10-20: Claude Code's native
 * installer (code.claude.com/docs/en/setup); Codex's install script (github.com/openai/codex README); Gemini CLI
 * through Homebrew, else npm (github.com/google-gemini/gemini-cli README; it has no install script).
 */
export function installCommand(agent: RuntimeId, host: InstallHost): string | null {
  if (host.os !== "darwin" && host.os !== "linux") return null;
  if (agent === "claude-code") return "curl -fsSL https://claude.ai/install.sh | bash";
  if (agent === "codex") return "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
  if (agent === "gemini") return host.brew ? "brew install gemini-cli" : host.npm ? "npm install -g @google/gemini-cli" : null;
  return null;
}

/**
 * The CLI's own sign-in command (Claude Code's is per account folder, so the server builds that one). Codex: `codex
 * login` opens the ChatGPT sign-in in the browser (learn.chatgpt.com/docs/auth). Gemini CLI has none here: it runs on
 * a Gemini API key setup stores (agentForPlan).
 */
export function signInCommand(agent: RuntimeId): string | null {
  return agent === "codex" ? "codex login" : null;
}

/** Where to get a free Gemini API key: Google AI Studio (geminicli.com/docs/get-started/authentication). */
export const GEMINI_KEY_URL = "https://aistudio.google.com/app/apikey";

/** The secret store item an account's Gemini API key lives in; the Gemini runtime passes it as GEMINI_API_KEY. */
export const geminiKeyItem = (account: string): string => `gemini-key-${account}`;

/**
 * The one command a terminal runs to get an agent going: install it when it's missing (with the installers' own bin
 * folder on PATH, so the sign-in that follows finds it), then its sign-in.
 */
export function connectCommand(install: string | null, signIn: string | null): string {
  if (!install) return signIn ?? "";
  return signIn ? `${install} && export PATH="$HOME/.local/bin:$PATH" && ${signIn}` : install;
}
