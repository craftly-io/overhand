/**
 * How Overhand's guard reaches each agent CLI it runs, and which of those a real run has confirmed: one source for
 * Settings (each agent account's line), the site's claims (site/site.ts) and the README and SECURITY lines (a test holds
 * them to it). The rules themselves live in one place (packages/core/src/guard.ts). A CLI's claims widen only when its
 * row is `verified`: set it after a real run of that CLI, built exactly as Overhand runs it, was blocked by the guard
 * (a "no-shell" CLI: ran nothing it was asked to run).
 */
import { RUNTIME_NAMES } from "./scorecard";

/** One CLI's guard coverage. */
export interface GuardCoverage {
  /** "hook": the guard sees each call; "no-shell": the CLI has no hook, so it runs with no shell commands at all. */
  kind: "hook" | "no-shell";
  /** How the guard gets in, in plain words. */
  how: string;
  /** The real run that confirmed it: the CLI's version and what it was asked to run; null until one has. */
  verified: { version: string; blocked: string } | null;
}

/** Each CLI by its runtime id (config `runtimes.<account>.kind`). */
export const GUARD_COVERAGE: Record<string, GuardCoverage> = {
  "claude-code": {
    kind: "hook",
    how: "a hook on every tool call",
    verified: { version: "2.1.309", blocked: "gh pr merge 1 --squash" },
  },
  codex: {
    kind: "hook",
    how: "a hook on every shell command, file edit and MCP call, inside its workspace sandbox",
    verified: { version: "codex-cli 0.163.0 (local qwen3:1.7b)", blocked: "gh pr merge 1" },
  },
  gemini: {
    kind: "hook",
    how: "a hook on every tool call, from a Gemini home of Overhand's own (it runs on an API key)",
    verified: null,
  },
  cursor: {
    kind: "hook",
    how: "a plugin whose hooks see every shell command, file read, edit and MCP call",
    verified: null,
  },
  opencode: {
    kind: "hook",
    how: "a plugin that sees every tool call",
    verified: { version: "1.19.4 (local qwen3:1.7b)", blocked: "gh pr merge 1" },
  },
  aider: {
    kind: "no-shell",
    how: "it has no hook for the guard, and secret files are kept out of its reach",
    verified: { version: "aider 0.86.2 (local qwen3:1.7b)", blocked: "gh pr merge 1" },
  },
};

/**
 * What no pre-tool hook stops, in any CLI: a program the agent writes and runs can do what that program does, and an
 * agent set on getting past the guard can write what you can, Overhand's own files included. Said once, here.
 */
export const GUARD_LIMIT =
  "A hook sees the command an agent asks for, not what a script or program it runs does next; a determined agent can hide a step there. An agent that deliberately builds paths to slip past the guard's checks can write Overhand's own files (its config and records) as it can any file you can: the guard stops accidents and plain prompt injection, and it isn't a sandbox. Holding a run's writes to its own folder is the OS sandbox's job, when you turn it on (Settings, Agent accounts).";

/** CLI names joined as people read a list: "A", "A and B", "A, B and C". */
const listOf = (ids: string[]): string => {
  const names = ids.map((id) => RUNTIME_NAMES[id] ?? id).sort();
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};
const rows = (keep: (c: GuardCoverage) => boolean) =>
  Object.entries(GUARD_COVERAGE)
    .filter(([, c]) => keep(c))
    .map(([id]) => id);

/** CLIs whose hook a real run saw block; CLIs confirmed to run no shell; CLIs only set up so far. */
export const GUARD_CONFIRMED = rows((c) => c.kind === "hook" && c.verified !== null);
export const NO_SHELL_CONFIRMED = rows((c) => c.kind === "no-shell" && c.verified !== null);
export const GUARD_UNCONFIRMED = rows((c) => c.verified === null);

const verb = (ids: string[], one: string, many: string) => (ids.length === 1 ? one : many);
/** "Aider runs no shell commands." for the confirmed no-shell CLIs; "" for none. */
const noShell = NO_SHELL_CONFIRMED.length
  ? `${listOf(NO_SHELL_CONFIRMED)} ${verb(NO_SHELL_CONFIRMED, "runs", "run")} no shell commands.`
  : "";
/** "Cursor Agent and Gemini CLI run through the same guard, not yet confirmed in a real run." for the rest; "" for none. */
const unconfirmed = GUARD_UNCONFIRMED.length
  ? `${listOf(GUARD_UNCONFIRMED)} ${verb(GUARD_UNCONFIRMED, "runs", "run")} through the same guard, not yet confirmed in a real run.`
  : "";
/** "With Claude Code, Codex and OpenCode, " while any CLI isn't confirmed by its hook; "" once every one is. */
const withConfirmed = GUARD_CONFIRMED.length < Object.keys(GUARD_COVERAGE).length ? `With ${listOf(GUARD_CONFIRMED)}, ` : "";
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const join = (...parts: string[]) => parts.filter(Boolean).join(" ");

/** One account's line in Settings: how the guard reaches its agent, and whether a real run has confirmed it. */
export function guardLine(runtime: string): string {
  const c = GUARD_COVERAGE[runtime];
  if (!c) return "Overhand's guard doesn't reach this agent.";
  if (!c.verified) return `Overhand's guard is set up for this agent, not yet confirmed: ${c.how}.`;
  if (c.kind === "no-shell")
    return `Overhand runs this agent with no shell commands: ${c.how}. Confirmed in a real run (${c.verified.version}).`;
  return `Overhand blocks merges, deploys and secret files for this agent: ${c.how}. Confirmed in a real run (${c.verified.version}).`;
}

/** The no-merge claim (site/site.ts CLAIMS.noMerge): firm for confirmed CLIs, and says where each other one stands. */
export const NO_MERGE_CLAIM = join(
  sentence(`${withConfirmed}agents can't merge: only Ship merges, through GitHub's own auto-merge once the required checks pass.`),
  noShell,
  unconfirmed,
);

/** Where the guard stands, for the guard section of Under the hood, the README and SECURITY. */
export const GUARD_REACH = join(
  `Confirmed blocking in a real run: ${listOf(GUARD_CONFIRMED)}.`,
  NO_SHELL_CONFIRMED.length
    ? `${listOf(NO_SHELL_CONFIRMED)} ${verb(NO_SHELL_CONFIRMED, "has", "have")} no pre-tool hook: ${verb(NO_SHELL_CONFIRMED, "it runs", "they run")} no shell commands (confirmed), and the OS sandbox, when on, holds its writes to the run's folder as it does every agent's.`
    : "",
  GUARD_UNCONFIRMED.length
    ? `Set up to each agent's documented pre-tool hook, not yet confirmed in a real run: ${listOf(GUARD_UNCONFIRMED)}.`
    : "",
);

/** ", in Claude Code, Codex and OpenCode" while any CLI isn't confirmed by its hook; "" once every one is: the short lines' scope, said last. */
const inConfirmed = withConfirmed ? `, in ${listOf(GUARD_CONFIRMED)}` : "";

/** The home page's guard line, under its own label (index.html "Safe by design"); the detail is Under the hood's. */
export const GUARD_BLOCKS_CLAIM = `Blocks merges, force pushes, deploys and production secrets${inConfirmed}.`;

/** The quiet-mode line, under its label (index.html, for/solo.html): the governor runs in the guard, so it reaches what the guard does. */
export const QUIET_CLAIM = `Holds builds, full test runs and dev servers while you need the laptop${inConfirmed}.`;
