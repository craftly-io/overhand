/**
 * What the OS sandbox around Overhand's agent runs (core/src/sandbox.ts) does and can't stop: one source for Settings,
 * the README, SECURITY and the site (a test holds them to it). Claims say "when it's on": it's on by default only where
 * the machine can run it, turns off per machine (Settings, `sandbox.mode`) and per project, so nothing here says every
 * run is sandboxed.
 */
import { z } from "zod";

/** The sandbox on this machine, as `GET /api/settings` reports it (core/src/sandbox.ts sandboxState). */
export const SandboxStatusSchema = z.object({
  mode: z.enum(["off", "log", "enforce"]),
  effective: z.enum(["off", "log", "enforce"]),
  ok: z.boolean(),
  why: z.string(),
  refuse: z.boolean(),
  /** process.platform of the daemon's machine. */
  platform: z.string(),
  /** Projects, by name, holding a tool that can't run inside the sandbox (core/src/sandbox.ts hostTool), with that tool. */
  tools: z.record(z.string(), z.string()).default({}),
});
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

/**
 * A project's own sandbox setting (config `clients[].sandbox`); left out, "inherit". "keep": inside the sandbox even
 * with a tool Overhand would otherwise run it without.
 */
export type ProjectSandbox = "inherit" | "off" | "keep";

/**
 * Whether a project's runs go without the OS sandbox, on the guard only, while the machine's sandbox is on and not
 * required (a project can't leave a required sandbox): the project set to off, or, on enforce, one left as the
 * machine's that holds `tool`, a tool that can't run inside it (Overhand sets that itself). One rule for the daemon
 * and Settings.
 */
export const guardOnly = (s: { mode: SandboxStatus["mode"]; required: boolean }, project: ProjectSandbox | undefined, tool = ""): boolean =>
  s.mode !== "off" && !s.required && (project === "off" || (project !== "keep" && s.mode === "enforce" && tool !== ""));

/** The per-project way out, for the docs: said once, here. */
export const SANDBOX_PROJECT_OFF =
  "A project with an Xcode project or workspace, a Package.swift or a firebase.json runs without the OS sandbox, set by Overhand itself, since those tools can't run inside it: its runs, and the checks Overhand runs in its files, have the guard only, and Needs you says so, with Keep it in the sandbox to put it back (sandbox: keep on the project in the config). Any other project can leave it too: set its sandbox to off (Settings, Projects, or sandbox: off on the project in the config). With Refuse runs without it on (Settings, Advanced), every project stays inside the sandbox.";

/** The sandbox switch's one sentence in Settings: what it does, said once, here. */
export const SANDBOX_SWITCH =
  "Each agent run, and each check Overhand runs in a project's files, writes only its own folder and never your other files, however the command is spelled.";

/** What it stops, when it's on: said once, here. */
export const SANDBOX_STOPS =
  "With the OS sandbox on, each agent run Overhand starts, and each check Overhand itself runs in a project's own files (its package manager, lint script, virtualenv or screenshot preview), can write only its own folder, the git data its commits need, its own temp folder (gone when it ends), its project's package caches and its agent's own state in a folder of Overhand's: never Overhand's files, another project, your own agent config, your shell startup files, LaunchAgents, git config, hooks and where git finds the repository, or the settings, hooks, plugins and extensions that steer an agent, however the command is spelled. It can't read cloud credentials, browser profiles or Overhand's local key, and no run can read your GitHub and SSH sign-ins (gh's login, SSH keys, git's stored passwords) or reach your SSH agent: Overhand pushes a run's branch and opens its pull request itself, and a lead's git push and fetch and its gh commands go through Overhand, which checks each one against the guard's rules first.";

/** What it can't stop: said once, here. */
export const SANDBOX_LIMIT =
  "It doesn't filter the network: a run can send what it can read to any site. No run can sign its commits with a key in ~/.ssh, or install a dependency over SSH. It doesn't stop what a run writes into its own project from running later when you run it, or a program that asks a service outside it to act, such as a database or a server on a local port: tmux, screen and Docker's sockets are closed to it, other local sockets aren't, and on macOS neither is another app, through osascript or open. A lead can't make git worktrees in its own checkout under it: no lead needs one, since Overhand makes the worktrees runs work in. On Plan and warn only, Codex's commands can reach the network under it (Codex's own sandbox, which kept them off it, can't nest inside Overhand's). With it off, Overhand's own checks run a project's files as you, as before. Leads and tasks start your own MCP servers, handed over by Overhand and no others, since they need them for your trackers; a run on Plan and warn only starts none of yours. State a tool or plugin keeps in your home, outside the run's folders, its caches and its agent's own, stays closed to it (a plugin's database in its own folder in your home, or firebase-tools' login and log): such a tool fails under it until it can be pointed at a folder the run writes. On macOS, Xcode builds don't run under it: xcodebuild writes macOS's shared temp and cache folders, and Swift packages start a sandbox of their own, which can't nest. macOS Keychain items stay reachable, since the agents' logins live there: so does a GitHub sign-in gh keeps in the Keychain, to a run that asks the Keychain for it by name. It runs on macOS and on Linux with bubblewrap and user namespaces; elsewhere, including most Docker setups, runs have the guard only.";

/** The machine's sandbox line in Settings: its mode and, when it can't run here, why and what happens. */
export function sandboxLine(s: SandboxStatus): string {
  if (s.mode === "off") return "The OS sandbox is off: agent runs have the guard only.";
  if (!s.ok)
    return s.refuse
      ? `The OS sandbox can't run on this machine (${s.why}), so Overhand starts no agent runs.`
      : `The OS sandbox can't run on this machine (${s.why}): agent runs have the guard only. Turn on "Refuse runs without it" in Advanced to stop them instead.`;
  if (s.effective === "off") return "Log only records on macOS: on this machine agent runs have the guard only.";
  if (s.effective === "log")
    return "Log only: runs go ahead as before, and what the sandbox would block goes to logs/sandbox-would-deny.jsonl.";
  return "On: each agent run started from now on writes only where its run should.";
}
