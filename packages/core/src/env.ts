/** Paths, live config and the small shell/HTTP helpers every other module uses. This module owns the live config. */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LOCAL_PORT } from "@overhand/contract";
import { blankConfig, type Client, type Config, type Provider, type Runtime, startConfig } from "./config";
import { effectiveClients } from "./groups";
import { readSecret, SECRET_STORE } from "./platform";
import { claudeCodeEnv } from "./runtimes/claude-code";
import { gitEnv, gitPointersOk, isGit, safeCmd } from "./runtimes/runtime";

export const HOME = homedir();
// where the agents' own installers put them (Claude Code's, Codex's): on PATH even when the service started without it,
// so an agent installed from setup is found and runs without a restart
const LOCAL_BIN = join(HOME, ".local", "bin");
if (!(process.env.PATH ?? "").split(":").includes(LOCAL_BIN)) process.env.PATH = [LOCAL_BIN, process.env.PATH].filter(Boolean).join(":");
/** Running as the installed single binary (`bun build --compile`) rather than from a checkout. */
export const BUNDLED = import.meta.dir.startsWith("/$bunfs");
/** ops' own files: the checkout's root, or the folder holding the installed binary (and its `web/`). */
export const SRC = BUNDLED ? dirname(process.execPath) : resolve(import.meta.dir, "..", "..", "..");
/** How this copy was installed; `overhand update`, the login service and the release alert each go that way. */
export type InstallKind = "checkout" | "curl" | "brew" | "npx";

/**
 * How the binary at `exec` was installed: Homebrew keeps it in <prefix>/Cellar/overhand/<version>/libexec (or reaches
 * it through <prefix>/opt/overhand), the npx launcher in ~/.overhand/npm/<version>, the curl installer in
 * ~/.overhand/app (a link to ~/.overhand/releases/<id>). A binary anywhere else updates like the curl one.
 */
export function installKind(exec = process.execPath, bundled = BUNDLED, home = homedir()): InstallKind {
  if (!bundled) return "checkout";
  if (/\/(Cellar\/overhand\/[^/]+|opt\/overhand)\/libexec\/overhand$/.test(exec)) return "brew";
  return exec.startsWith(`${join(home, ".overhand", "npm")}/`) ? "npx" : "curl";
}

/**
 * The path that keeps leading to the current binary across updates, for the login service and the agents' guard hook:
 * Homebrew's opt link rather than a versioned Cellar folder (`brew cleanup` deletes those), the launcher's npm/current
 * link rather than npm/<version>, the curl installer's app link rather than releases/<id> (Linux resolves the path a
 * binary started from).
 */
export function stableExec(exec = process.execPath, home = homedir()): string {
  const prefix = exec.match(/^(.*)\/Cellar\/overhand\/[^/]+\/libexec\/overhand$/)?.[1];
  if (prefix !== undefined) return join(prefix, "opt", "overhand", "libexec", "overhand");
  const npm = join(home, ".overhand", "npm");
  if (exec.startsWith(`${join(home, ".overhand", "releases")}/`)) return join(home, ".overhand", "app", "overhand");
  return exec.startsWith(`${npm}/`) ? join(npm, "current", "overhand") : exec;
}

/** Moves `from` to `to` once (not when `to` exists); copies when it can't rename (another disk, a folder it can't write). */
export function moveOnce(from: string, to: string): void {
  if (existsSync(to) || !existsSync(from)) return;
  try {
    renameSync(from, to);
  } catch {
    try {
      copyFileSync(from, to);
    } catch {} // left where it was; Settings → Integrations names where it belongs
  }
}

/** What runs this copy again: its stable path, unless that doesn't exist (a launcher from before npm/current). */
export const SELF_EXEC = BUNDLED && existsSync(stableExec()) ? stableExec() : process.execPath;
/** The built dashboard: the installed binary ships it beside it in web/; a checkout builds it in apps/web/dist. */
export const WEB_DIST = BUNDLED ? join(SRC, "web") : join(SRC, "apps", "web", "dist");
/** How the running copy was installed. */
export const INSTALL = installKind();
/**
 * A printed `overhand <sub>` as it runs for this copy: a checkout's from source, the npx launcher's through npx or bunx
 * (`overhand` itself isn't on PATH there), else the installed `overhand`.
 */
export function cli(sub: string, kind: InstallKind = INSTALL, src = SRC, npx = Bun.which("npx") !== null): string {
  if (kind === "checkout") return `cd ${src} && bun run.ts ${sub}`;
  return `${kind === "npx" ? (npx ? "npx " : "bunx ") : ""}overhand ${sub}`;
}
/** Config and state: the checkout itself, or ~/.overhand for the binary. Tests and CI point OVERHAND_HOME at a scratch folder. */
export const OPS = process.env.OVERHAND_HOME ?? (BUNDLED ? join(homedir(), ".overhand") : SRC);
mkdirSync(OPS, { recursive: true });
// config, state, logs and transcripts live here: only this user may enter it, whatever mode each file got. Only when it
// isn't so already: `overhand ask` inside a sandboxed run loads this too, and the sandbox refuses any chmod of OPS
if ((statSync(OPS).mode & 0o777) !== 0o700) chmodSync(OPS, 0o700);
/** The MCP servers the Slack inbox reads through, kept with the config (beside the binary, an update would lose it). */
export const SLACK_MCP = join(OPS, "slack-mcp.json");
// it used to sit beside the binary: move it over once
if (BUNDLED) moveOnce(join(SRC, "slack-mcp.json"), SLACK_MCP);
const CONFIG_FILE = join(OPS, "overhand.config.json");
/**
 * Onboarding's Start hasn't been pressed: the dashboard runs its setup wizard and no agent starts. A Settings save
 * before then (Extra origins, a pairing) writes the config but leaves setup open.
 */
export const needsSetup = (ops = OPS): boolean => !existsSync(join(ops, ".setup-done"));
/** Marks setup finished: what onboarding's Start does once it has saved the first config. */
export const markSetupDone = (ops = OPS): void => writeFileSync(join(ops, ".setup-done"), "");
/**
 * Installs from before the marker finished setup when their config has an account (onboarding and `bun run setup`
 * always write one; a Settings save before setup doesn't), so they count as set up without seeing onboarding again.
 * ponytail: runs at every start, so an account added in Settings before setup, then a restart, also counts as done.
 */
export function migrateSetupDone(ops: string, c: Config, saved = existsSync(join(ops, "overhand.config.json"))): void {
  if (saved && c.accounts.length && needsSetup(ops)) markSetupDone(ops);
}
/** The folder that holds every project: config codeRoot, else the checkout's parent (ops sits beside the projects) or ~/Code. */
const codeRootOf = (c: Config): string => c.codeRoot || process.env.OVERHAND_CODE || (BUNDLED ? join(HOME, "Code") : dirname(SRC));
export let CODE = ""; // set by applyConfig
/** Where picked and pasted repos are cloned: config projectsDir, else the code root (a checkout) or ~/Overhand/projects. */
const projectsDirOf = (c: Config): string => c.projectsDir || (INSTALL === "checkout" ? codeRootOf(c) : join(HOME, "Overhand", "projects"));
export let PROJECTS = ""; // set by applyConfig
/** Today's local date as YYYY-MM-DD. */
export const today = (): string => new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD

// Live config: the dashboard's Settings saves overhand.config.json and calls applyConfig, so no restart is needed. A file
// that won't load starts Overhand on the last one that did (startConfig), and Needs you says so
const START = existsSync(CONFIG_FILE)
  ? startConfig(OPS, userInfo().username)
  : { config: blankConfig(userInfo().username), broken: "", ignored: [] };
export let CFG: Config = START.config;
migrateSetupDone(OPS, CFG);
export let CLIENTS: Client[] = [];
export let ACCOUNTS: string[] = [];
export let LABEL: Config["labels"] = CFG.labels;
export let OWNER = "";
export let SLACK: Config["slack"] = [];
/**
 * What's wrong with overhand.config.json, for Needs you: why it didn't load ("" when it did) and the settings in it
 * Overhand doesn't know. A config made live (applyConfig) was just saved or loaded whole, so it clears both.
 */
export let CONFIG_NOTE: { broken: string; ignored: string[] } = { broken: "", ignored: [] };
/** Makes a (re)loaded config live for every module. */
export function applyConfig(c: Config): void {
  CONFIG_NOTE = { broken: "", ignored: [] };
  CFG = c;
  CODE = codeRootOf(c);
  PROJECTS = projectsDirOf(c);
  CLIENTS = effectiveClients(c);
  ACCOUNTS = c.accounts;
  LABEL = c.labels;
  OWNER = c.owner.name;
  SLACK = c.slack;
}
applyConfig(CFG);
CONFIG_NOTE = { broken: START.broken, ignored: START.ignored };

/**
 * While overhand.config.json won't load: reads it again, and makes it live once you've fixed it. True when it did.
 * Cheap enough to call every few seconds: it does nothing while the file loads.
 */
export function reloadIfFixed(ops = OPS): boolean {
  if (!CONFIG_NOTE.broken) return false;
  const r = startConfig(ops, userInfo().username);
  if (r.broken) return false;
  applyConfig(r.config);
  CONFIG_NOTE = { broken: "", ignored: r.ignored };
  return true;
}

export const MIN = 60_000;

/** A secret store item's value; throws when it's missing. */
export function secret(service: string, account = CFG.owner.keychainAccount): string {
  const v = readSecret(service, account);
  if (v === null) throw new Error(`${service} missing from ${SECRET_STORE}`);
  return v;
}

/**
 * Tokens for a status source: each project's own (its items belong to that project) then the shared ones
 * (`client` empty: match items to projects by name and aliases). Missing Keychain items are skipped.
 */
export function statusTokens(key: "vercelSecrets" | "sentrySecrets"): { token: string; client: string }[] {
  const named = [
    ...CFG.clients.flatMap((c) => c.status[key].map((s) => ({ s, client: c.name }))),
    ...CFG.status[key].map((s) => ({ s, client: "" })),
  ];
  return named.flatMap(({ s, client }) => {
    try {
      return [{ token: secret(s), client }];
    } catch {
      return [];
    }
  });
}

/** An account's model backend; accounts without one run on Claude, signed in to Claude Code on their own. */
export const providerOf = (account: string): Provider => CFG.providers[account] ?? { kind: "claude", auth: "login" };

/** An account's agent CLI; accounts without one run Claude Code. */
export const runtimeOf = (account: string): Runtime => CFG.runtimes[account] ?? { kind: "claude-code", model: "" };

/** The environment to run `claude` with for an account, per its provider (see claudeCodeEnv). */
export function claudeEnv(account: string, p = providerOf(account), read = readSecret): Record<string, string> {
  return claudeCodeEnv(account, p, read);
}

export { safeCmd };

/**
 * Whether the daemon runs no git in `cwd`: a run changed git's pointers there (sandbox.ts flagRepo, until you clear
 * control/git-tampered.json), they don't point where a checkout's own files say now (gitPointersOk, checked before
 * every daemon git call), or that list can't be read (fails closed).
 */
export function gitRefused(cwd: string, file = join(OPS, "control", "git-tampered.json")): boolean {
  if (!gitPointersOk(cwd)) return true;
  if (!existsSync(file)) return false;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(v)) return true;
    const paths = [resolve(cwd), realpathOr(resolve(cwd))];
    return v.some((d) => typeof d !== "string" || paths.some((at) => at === d || at.startsWith(`${d}/`)));
  } catch {
    return true;
  }
}
const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const REFUSED =
  "git here doesn't point where this checkout's own files say (a run may have redirected it); Overhand runs no git here until you look (control/git-tampered.json)";

/** Runs a command synchronously; never throws. */
export function sh(cmd: string[], cwd = SRC, timeoutMs = 10 * 60_000): { ok: boolean; out: string; err: string } {
  // env: so PATH set at runtime (tests' fake gh) picks the binary. A timeout, because one hung gh or git call held the
  // work pass (and its .lock) for five hours on 2026-10-18 and no ticket ran meanwhile.
  if (isGit(cmd) && gitRefused(cwd)) return { ok: false, out: "", err: REFUSED };
  let r: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    r = Bun.spawnSync(safeCmd(cmd), { cwd, env: isGit(cmd) ? gitEnv() : process.env, timeout: timeoutMs });
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) }; // not installed (gh on a fresh machine)
  }
  const err = r.exitedDueToTimeout ? `timed out after ${timeoutMs / 1000} s: ${cmd.slice(0, 3).join(" ")}` : r.stderr.toString().trim();
  return { ok: r.exitCode === 0 && !r.exitedDueToTimeout, out: r.stdout.toString().trim(), err };
}

/**
 * What a process printed on each of `streams`, and its exit code: read until it exits, then for `graceMs` more. A
 * process it started and left running (a dev server, an MCP server's helper) keeps the pipes open, and reading to
 * their end then never finished: a first win's agent was done in 36 s and its pull request never opened. `onText` hears
 * the first stream as it arrives (a run's progress).
 */
export async function untilExit(
  exited: Promise<number>,
  streams: ReadableStream<Uint8Array>[],
  graceMs = 2000,
  onText?: (chunk: string) => void,
): Promise<{ texts: string[]; code: number }> {
  const readers = streams.map((s) => s.getReader());
  const texts = readers.map(async (r, i) => {
    const dec = new TextDecoder();
    let text = "";
    try {
      for (let c = await r.read(); !c.done; c = await r.read()) {
        const chunk = dec.decode(c.value, { stream: true });
        text += chunk;
        if (i === 0) onText?.(chunk);
      }
    } catch {} // cancelled after the grace: what came before stays
    return text + dec.decode();
  });
  const code = await exited;
  const grace = setTimeout(() => {
    for (const r of readers) void r.cancel().catch(() => {});
  }, graceMs);
  const done = await Promise.all(texts);
  clearTimeout(grace);
  return { texts: done, code };
}

/** `sh` without blocking the daemon while the command runs: for work on a timer, where a sync `gh` or `git` call froze every request. */
export async function shAsync(cmd: string[], cwd = SRC, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  if (isGit(cmd) && gitRefused(cwd)) return { ok: false, out: "", err: REFUSED };
  let p: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    p = Bun.spawn(safeCmd(cmd), { cwd, env: isGit(cmd) ? gitEnv() : process.env, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) }; // not installed
  }
  const {
    texts: [out = "", err = ""],
    code,
  } = await untilExit(p.exited, [p.stdout, p.stderr]);
  const timedOut = p.signalCode !== null && code !== 0;
  return {
    ok: code === 0,
    out: out.trim(),
    err: timedOut ? `timed out after ${timeoutMs / 1000} s: ${cmd.slice(0, 3).join(" ")}` : err.trim(),
  };
}

/** An HTTP Basic auth header value. */
export function basic(email: string, token: string): string {
  return `Basic ${Buffer.from([email, token].join(":")).toString("base64")}`;
}

/** Fetches and parses JSON; throws with the status and body on a non-2xx answer. */
export async function http<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) }); // trackers can hang
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** The client whose ticket prefix the key carries. */
export function clientOf(key: string): Client | undefined {
  return CLIENTS.find((c) => key.startsWith(`${c.prefix}-`));
}

export const UI_PORT = Number(process.env.OVERHAND_PORT ?? LOCAL_PORT);
/** The dashboard on this computer, as its own CLI and helpers reach it. */
export const DASHBOARD = `http://127.0.0.1:${UI_PORT}`;

/** Display client for a GitHub org login: a tracked client by alias, then config.otherOrgs, else the login itself. */
export const clientOfOrg = (login: string): string =>
  CLIENTS.find((c) => c.aliases.includes(login.toLowerCase()))?.name ?? CFG.otherOrgs[login.toLowerCase()] ?? login;
/** When a repo was cloned onto this computer: the time of its reflog's first entry when that's the clone, else 0. */
export function clonedAt(repo: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(join(repo, ".git", "logs", "HEAD"), "r");
    const head = Buffer.alloc(1024);
    const first = head.toString("utf8", 0, readSync(fd, head)).split("\n")[0] ?? "";
    const m = first.match(/> (\d+) [+-]\d{4}\tclone: /);
    return m ? Number(m[1]) * 1000 : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a repo counts as active: a commit within limits.dormantDays, or cloned here within them. A repo you just
 * added is active however old its last commit, so its first win and check-up see it.
 */
export const repoActive = (repo: string, lastCommitMs: number, now = Date.now()): boolean =>
  now - Math.max(lastCommitMs, clonedAt(repo)) < CFG.limits.dormantDays * 24 * 60 * MIN;
/** First tracked client whose name or an alias appears in the text; "Other" when none does. */
export const clientByText = (s: string): string => {
  const t = s.toLowerCase();
  return CLIENTS.find((c) => [c.name, ...c.aliases].some((a) => t.includes(a.toLowerCase())))?.name ?? "Other";
};
