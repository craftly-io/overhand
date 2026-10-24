/** What every agent CLI ops can drive provides: how to start it headless, and how to read what it printed. */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Autonomy } from "@overhand/contract";
import type { Provider, Runtime, RuntimeId } from "../config";
import type { AccountUsage } from "../usage";

/** One run to start: a ticket, a plan, a lead. */
export interface RunInput {
  account: string;
  /** The folder the CLI runs in (a ticket's worktree, a lead's project folder). */
  cwd: string;
  prompt: string;
  /** JSON Schema text the final answer must match; empty for leads. */
  schema: string;
  /** A scratch path the runtime may write the schema to (Codex reads it from a file). */
  schemaFile: string;
  /** The model ops asks for, as a Claude alias (haiku, sonnet); only Claude Code understands these. */
  alias: string;
  /** The account's Claude Code backend (Claude Code and OpenCode use it). */
  provider: Provider;
  /** The account's model for this CLI (config `runtimes.<account>.model`). */
  model: string;
  /** Let the CLI sign commits and PRs as AI-made. */
  attribution: boolean;
  /** Extra Claude Code flags (the inbox's Slack MCP); other runtimes can't take them. */
  args: string[];
  /** Claude Code's config folder for one-shot runs; empty keeps the CLI's own. */
  configDir: string;
  /** Your own Claude Code MCP servers, carried into runs that use `configDir` (which would hide them otherwise). */
  mcpServers?: Record<string, unknown>;
  /** Extra hooks (a settings `hooks` block) for runs that keep the CLI's own config home, like leads. */
  hooks?: Record<string, unknown>;
  /** Overhand's agent instructions file, for CLIs that take it by flag or config; empty for none (leads). */
  instructions: string;
  /** Reads a secret store item; null when missing. */
  read: (service: string) => string | null;
  /** The project's autonomy level; absent = `act`. `watch` runs the CLI read-only wherever it has a switch for that. */
  autonomy?: Autonomy;
  /** The run's log name (`HONEY-1`, `lead-honeycrust-deps`) and project, for the guardrail log; absent = unknown. */
  run?: string;
  project?: string;
  /** The account's own tuning (effort, fallback model, blocked tools, extra flags...); runtimes/tune.ts turns it into flags. */
  tune?: Partial<Runtime>;
  /**
   * The run is held by Overhand's OS sandbox (sandbox.ts), which can't nest another inside it (macOS refuses a second
   * sandbox-exec): the CLI's own sandbox is off, and Overhand's does its job, read-only on watch included.
   */
  osSandbox?: boolean;
}

/** True when the run must not change anything: its project is on watch. */
export const readOnly = (r: RunInput): boolean => r.autonomy === "watch";

/** The process to spawn, and files to write before it starts. */
interface Spawn {
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
}

/** What a finished run said. */
export interface RunOutput {
  ok: boolean;
  /** The final answer, or the error. */
  text: string;
  /** The schema-shaped answer when the CLI enforces the schema itself; undefined otherwise. */
  structured: unknown;
  cost: number;
  /** Subscription windows (Claude Code only). */
  usage: AccountUsage | null;
}

export interface AgentRuntime {
  id: RuntimeId;
  label: string;
  bin: string;
  /** "verified": a real prompt ran end to end through ops' argv and parser; "flags verified": checked against --help and docs only. */
  status: "verified" | "flags verified";
  caps: {
    /** Enforces a JSON Schema on the final answer; without it ops asks for JSON in the prompt and validates it. */
    jsonSchema: boolean;
    /** Runs tools without asking (headless needs this to edit, test and push). */
    autoMode: boolean;
    subagents: boolean;
    /** Reports subscription usage windows. */
    usage: boolean;
    /** Writes transcripts ops reads for the live "what is it doing" line. */
    transcripts: boolean;
  };
  /** How this CLI picks its model. */
  models: string;
  /** A one-shot headless run. */
  task(r: RunInput): Spawn;
  /** A long-running lead; its output goes to a log. */
  lead(r: RunInput): Spawn;
  parse(stdout: string, stderr: string, code: number | null): RunOutput;
  /**
   * A lead's log (what the CLI printed) as the last lines a person reads: what it said, which tools it ran, how it ended.
   * Undefined for Claude Code (sessions.readableLog reads its stream-json).
   */
  readable?(raw: string, maxLines: number): string;
}

/**
 * An answer from a strict-schema CLI with its nulls for optional fields removed: OpenAI's strict outputs make every
 * optional property required-but-nullable (codex strictSchema), and the original schema doesn't accept null there.
 */
export function dropNulls(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => dropNulls(v, at(schema, "items")));
  if (typeof value !== "object" || value === null) return value;
  const required = at(schema, "required");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !(Array.isArray(required) && required.includes(k))) continue;
    out[k] = dropNulls(v, at(schema, "properties", k));
  }
  return out;
}

/**
 * Every git command the daemon runs, in a run's folder or any other: a repo's config (an agent's to write, or one it
 * pointed git at) can't start a program through the filesystem monitor or a hook. The one place it's said.
 */
export const SAFE_GIT = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];

/** Where `git` sits in a command: first, or after `env NAME=value …`; -1 when it isn't a git command. */
const gitAt = (cmd: string[]): number => {
  let i = cmd[0] === "env" ? 1 : 0;
  if (i) while (/^\w+=/.test(cmd[i] ?? "")) i++;
  return cmd[i] === "git" ? i : -1;
};

/** The command runs git (directly, or after `env NAME=value …`). */
export const isGit = (cmd: string[]): boolean => gitAt(cmd) >= 0;

/** `cmd` as the daemon runs it: a git command with SAFE_GIT. */
export function safeCmd(cmd: string[]): string[] {
  const i = gitAt(cmd);
  return i < 0 ? cmd : [...cmd.slice(0, i + 1), ...SAFE_GIT, ...cmd.slice(i + 1)];
}

/**
 * Your own global git config, by its real path (never a repo's): what the daemon's git reads besides the repo's own,
 * with the system's left out (GIT_CONFIG_NOSYSTEM), so nothing but your files and the repo's decides what git runs.
 */
export function ownGitConfig(home = homedir(), env: Record<string, string | undefined> = process.env): string {
  const xdg = join(env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config");
  return [join(home, ".gitconfig"), xdg].find((p) => existsSync(p)) ?? "/dev/null";
}

/** The environment the daemon's git runs with (ownGitConfig). */
export const gitEnv = (env: Record<string, string | undefined> = process.env): Record<string, string | undefined> => ({
  ...env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: ownGitConfig(homedir(), env),
  GIT_TERMINAL_PROMPT: "0", // nobody is there to type a password: fail instead of waiting
});

/**
 * A git folder that is its own repository: no `commondir`, or one that says "." (the sandbox's read-only stand-in on
 * Linux, sandbox.ts bwrapArgs), which means the same.
 */
function ownRepo(gitDir: string): boolean {
  const f = join(gitDir, "commondir");
  if (!existsSync(f)) return true;
  try {
    return realpathSync(resolve(gitDir, readFileSync(f, "utf8").trim())) === realpathSync(gitDir);
  } catch {
    return false;
  }
}

/**
 * Whether git, run in `cwd`, finds the repository where a checkout's own files say it is, without a run's redirect: a
 * main checkout's .git folder is its own repository (ownRepo); a worktree's .git file names `<repo>/.git/worktrees/<name>`,
 * whose `commondir` leads back to that `<repo>/.git` and whose `gitdir` names that same .git file; a submodule's names a
 * folder under `<repo>/.git/modules` that is its own. Outside git: true. Anything else: false, and the daemon runs no
 * git there (fails closed).
 */
export function gitPointersOk(cwd: string): boolean {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const dotGit = join(d, ".git");
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dotGit);
    } catch {
      if (dirname(d) === d) return true;
      continue;
    }
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) return ownRepo(dotGit);
    try {
      const named = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "";
      if (!named) return false;
      const wd = realpathSync(resolve(d, named));
      if (basename(dirname(dirname(wd))) === "modules" || wd.includes(`${sep}.git${sep}modules${sep}`)) return ownRepo(wd);
      const common = realpathSync(resolve(wd, readFileSync(join(wd, "commondir"), "utf8").trim()));
      const back = realpathSync(readFileSync(join(wd, "gitdir"), "utf8").trim());
      return (
        basename(dirname(wd)) === "worktrees" &&
        realpathSync(dirname(dirname(wd))) === common &&
        basename(common) === ".git" &&
        ownRepo(common) &&
        back === realpathSync(dotGit)
      );
    } catch {
      return false;
    }
  }
}
/** The repository's shared git folder (a worktree's main `.git`), when `cwd` is in one; "" otherwise. */
export function gitCommonDir(cwd: string): string {
  if (!cwd) return "";
  if (!gitPointersOk(cwd)) return "";
  const r = Bun.spawnSync(safeCmd(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]), {
    cwd,
    env: gitEnv(),
    stderr: "ignore",
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

/** The folders a CLI reads project config from: the run's folder and its checkout's top, when that differs. */
export function projectRoots(cwd: string): string[] {
  if (!cwd) return [];
  if (!gitPointersOk(cwd)) return [cwd];
  const r = Bun.spawnSync(safeCmd(["git", "rev-parse", "--show-toplevel"]), { cwd, env: gitEnv(), stderr: "ignore" });
  const top = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return [...new Set([cwd, top].filter(Boolean))];
}

/**
 * Why a CLI won't run in this repo: its own config for that CLI (the file `found`) could turn the guard off. Agents
 * can't write those files (guard.ts AGENT_CONFIG); this is for ones already in the repo. Null when there's none.
 */
export const refusalText = (label: string, found: string | null): string | null =>
  found
    ? `${found}: ${label} won't run here, because this repo's own ${label} config could turn Overhand's guard off. Remove it, or run this project on another agent`
    : null;

/** The last non-empty lines of a CLI's plain-text output (Aider prints no events). */
export const lastLines = (raw: string, maxLines: number): string =>
  raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-maxLines)
    .join("\n");

/** The daemon's environment as a plain record, for a child process. */
export const baseEnv = (): Record<string, string> => ({ ...(process.env as Record<string, string>) });

/**
 * What the guard hook reads, on the CLI's environment (every CLI hands its hooks its own environment): the autonomy level
 * (OVERHAND_AUTONOMY), and the run and project its guardrail log names (OVERHAND_RUN, OVERHAND_PROJECT).
 */
export function guardEnv(r: RunInput, env: Record<string, string>): Record<string, string> {
  env.OVERHAND_AUTONOMY = r.autonomy ?? "act";
  if (r.run) env.OVERHAND_RUN = r.run;
  if (r.project) env.OVERHAND_PROJECT = r.project;
  return env;
}

/** Sets `name` from a secret store item when it's stored; the CLI's own login is used otherwise. */
export function keyFrom(env: Record<string, string>, name: string, item: string, read: RunInput["read"]): Record<string, string> {
  const v = read(item);
  if (v !== null) env[name] = v;
  return env;
}

/** Each line of a JSONL stream that parses to an object; other lines (logs, banners) are skipped. */
export function jsonLines(raw: string): Record<string, unknown>[] {
  return raw.split("\n").flatMap((l) => {
    try {
      const x: unknown = JSON.parse(l);
      return typeof x === "object" && x !== null && !Array.isArray(x) ? [x as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** A field of an unknown JSON value, or undefined. */
export function at(x: unknown, ...path: string[]): unknown {
  let v = x;
  for (const k of path) v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

/**
 * The JSON object that ends a reply: the whole text, else the widest `{…}` ending at its last `}` that parses (prose, a
 * code fence or Aider's edit blocks, braces and all, before it).
 */
export function extractJson(text: string): unknown {
  const end = text.lastIndexOf("}") + 1;
  const starts = [...text.matchAll(/\{/g)].map((m) => m.index);
  // ponytail: one parse per `{`, quadratic on huge replies; fine for an agent's final message
  for (const s of [text.trim(), ...starts.map((i) => text.slice(i, end))]) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  return undefined;
}

/** What a runtime without schema enforcement is told, so its answer can still be parsed and validated. */
export const jsonAsk = (schema: string): string =>
  ["", "", "When you are done, reply with only one JSON object (no prose, no code fence) that matches this JSON Schema:", schema].join(
    "\n",
  );

/** The prompt with Overhand's agent instructions in front, for CLIs that can't load a file from outside the repo. */
export const withInstructions = (r: RunInput, prompt: string): string =>
  r.instructions ? [readFileSync(r.instructions, "utf8"), "---", prompt].join("\n\n") : prompt;

/** The prompt to send: as given, or with the JSON request appended when the CLI can't enforce the schema. */
export const promptFor = (rt: AgentRuntime, r: RunInput): string =>
  r.schema && !rt.caps.jsonSchema ? [r.prompt, jsonAsk(r.schema)].join("") : r.prompt;
