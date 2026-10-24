/**
 * The OS sandbox every agent run Overhand starts runs under (docs/specs/2026-10-23-agent-sandbox-design.md):
 * writes only where its run should write, whatever the command's spelling. macOS: `sandbox-exec` with a generated
 * profile; Linux: bubblewrap. The guard stays for intent (merges, pushes, deploys, autonomy); this holds the files.
 *
 * One policy (`sandboxPolicy`) feeds both builders, the tests and the claims (contract/src/sandbox.ts).
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { guardOnly, type ProjectSandbox } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { AGENT_HOMES } from "./agent-home";
import { RUN_CACHES, runCacheKey } from "./cleanup-sources";
import type { RuntimeId } from "./config";
import { controlDir, outboxDir, RUN_KEY_ENV, runKey, writeAtomic } from "./control";
import { CFG, OPS, safeCmd, shAsync } from "./env";
import { projectAt, selfPaths } from "./guard";
import { report } from "./notify";
import { gitCommonDir, gitEnv, gitPointersOk } from "./runtimes/runtime";

/** off: runs as before; log: runs as before and records what enforce would deny (macOS); enforce: denies it. */
export type SandboxMode = "off" | "log" | "enforce";

/** What one run may write, what it may not even inside that, and what it may not read. Absolute, symlinks resolved. */
export interface SandboxPolicy {
  /** Folders (and files) writable, with everything under them. */
  write: string[];
  /** Paths never writable, even under a `write` folder; each with its ancestors up to that folder (see `guarded`). */
  deny: string[];
  /** Folders and files not readable. */
  hide: string[];
  /** Folders whose entry can't be renamed, removed or replaced (a symlink in its place), though what's in them can be written. */
  lock?: string[];
}

/** One run's places, as its spawn knows them. */
export interface RunPlaces {
  /** The folder the CLI runs in: a ticket's worktree, a lead's project checkout. */
  cwd: string;
  /** The repository's shared git folder (gitCommonDir), "" outside git. */
  gitCommon: string;
  /** This checkout's own git folder: `<common>/worktrees/<name>` for a worktree, the common one for a main checkout. */
  gitDir: string;
  /** The agent CLI. */
  /** The agent CLI, or "none" for a project's own command the daemon runs (projectCommand). */
  runtime: RuntimeId | "none";
  /** The CLI's config folder for this run (RunInput.configDir), "" for the CLI's default under your home. */
  configDir: string;
  /** The run's log name; its outbox is named for it. */
  run: string;
  /** A project on watch: the run's own folder isn't writable either. */
  readOnly: boolean;
  /** More folders this run writes: a lead's own folder under Overhand's (its inbox and report). */
  also?: string[];
  /** The run's own temp folder (sandboxSpawn makes it, removes it after). */
  runTmp?: string;
  /** Its project's cache folder (projectCache), which only that project's sandboxed runs write. */
  cache?: string;
}

/**
 * Where each CLI keeps its state (writable) under your home when it has no folder of Overhand's, and the files in that
 * state folder that steer it (settings, hooks, plugins, instructions), never writable: one of them changed would change
 * the guard or what your own sessions run. Claude Code always gets a folder of Overhand's (agent-home.ts).
 */
const CLI_STATE: Record<RuntimeId | "none", { homes: string[]; steer: string[] }> = {
  none: { homes: [], steer: [] },
  "claude-code": { homes: [".claude", ".claude.json"], steer: ["settings.json", "settings.local.json", "CLAUDE.md", "output-styles"] },
  codex: { homes: [".codex"], steer: ["config.toml", "AGENTS.md", "hooks.json", "rules", "prompts"] },
  gemini: { homes: [".gemini"], steer: ["settings.json", "GEMINI.md"] },
  cursor: { homes: [".cursor"], steer: ["hooks.json", "cli-config.json", "mcp.json", "rules"] },
  opencode: { homes: [".local/share/opencode"], steer: [] },
  aider: { homes: [".aider"], steer: [] },
};

/**
 * In every CLI's state folder: what a CLI loads and runs on its next start, outside a run too (programs it downloaded,
 * extensions, plugins, subagents, skills, commands, hooks). MCP servers a run leaves in Claude Code's .claude.json never
 * start: every Claude Code run takes its servers strictly from Overhand (runtimes/claude-code.ts mcpConfig).
 */
const STEER_ALL = ["bin", "extensions", "plugins", "agents", "skills", "commands", "hooks"];

/**
 * Each tool's cache, by the variable that moves it: a run's caches live in its project's cache folder under Overhand's
 * (projectCache), written only by that project's sandboxed runs and never read by your own tools or sessions, so
 * nothing it downloads (a pre-commit hook, a browser build, a crate's build script) runs later as you outside the
 * sandbox. Your own caches stay readable to it, never writable. Maven has no variable: MAVEN_OPTS carries it.
 * ponytail: a poisoned per-project cache reaches only later sandboxed runs of that same project; a cache per run
 * would close that too, at the cost of downloading everything every run.
 */
const CACHE_ENV: Record<string, string> = {
  XDG_CACHE_HOME: "xdg",
  npm_config_cache: "npm",
  npm_config_store_dir: "pnpm",
  YARN_CACHE_FOLDER: "yarn",
  BUN_INSTALL_CACHE_DIR: "bun",
  PIP_CACHE_DIR: "pip",
  UV_CACHE_DIR: "uv",
  POETRY_CACHE_DIR: "poetry",
  PRE_COMMIT_HOME: "pre-commit",
  PLAYWRIGHT_BROWSERS_PATH: "ms-playwright",
  CARGO_HOME: "cargo",
  GOMODCACHE: "gomod",
  GOCACHE: "gobuild",
  GRADLE_USER_HOME: "gradle",
  COMPOSER_CACHE_DIR: "composer",
  // node-gyp's Node headers for native module builds (npm hands node-gyp its npm_config_* variables)
  npm_config_devdir: "node-gyp",
  // Python's bytecode, which macOS's own python3 otherwise writes under ~/Library/Caches/com.apple.python
  PYTHONPYCACHEPREFIX: "pycache",
  UV_TOOL_DIR: "uv-tools",
};

/** A project's cache folder under Overhand's, for its sandboxed runs only (CACHE_ENV). */
export const projectCache = (project: string, ops = OPS): string => join(ops, RUN_CACHES, runCacheKey(project));

/** The environment that puts a run's temp in its own folder and its caches in its project's (CACHE_ENV). */
export const runCacheEnv = (runTmp: string, cache: string, env: Record<string, string | undefined> = {}): Record<string, string> => ({
  TMPDIR: runTmp,
  // Claude Code's own temp (claude-<uid>, its sockets in cc-socks) goes under this, not the shared /tmp
  CLAUDE_CODE_TMPDIR: runTmp,
  ...Object.fromEntries(Object.entries(CACHE_ENV).map(([k, v]) => [k, join(cache, v)])),
  MAVEN_OPTS: [env.MAVEN_OPTS ?? "", `-Dmaven.repo.local=${join(cache, "m2")}`].filter(Boolean).join(" "),
});
/**
 * Browser profiles: their cookie stores are sign-ins to everything; no run reads them (macOS and Linux paths of
 * Chrome, Chromium, Brave, Edge, Arc, Firefox and Safari).
 */
const BROWSERS = [
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
  "Library/Safari",
  "Library/Cookies",
  "Library/Containers/com.apple.Safari",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".mozilla",
  "snap/chromium",
  "snap/firefox",
  "snap/brave",
  ".var/app/org.mozilla.firefox",
  ".var/app/com.google.Chrome",
  ".var/app/org.chromium.Chromium",
  ".var/app/com.brave.Browser",
  ".var/app/com.microsoft.Edge",
];

/** The CLIs whose runs never use your own state folder (agent-home.ts runHome: their login moves to one of Overhand's). */
const MOVED_IDS = ["claude-code", "codex"] as const;
const MOVED: ReadonlySet<string> = new Set(MOVED_IDS);

/** A repo's files that run code later, outside any sandbox (git's config can name programs; hooks are programs). */
const GIT_STEER = ["config", "config.lock", "config.worktree", "hooks", "info", "commondir", "gitdir"];

/** In a project: each CLI's project config, which could turn the guard off for the next run (guard.ts AGENT_CONFIG). */
const PROJECT_STEER = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".gemini",
  ".codex",
  ".opencode",
  ".cursor/hooks.json",
  ".cursor/cli.json",
  "opencode.json",
  "opencode.jsonc",
  ".aider.conf.yml",
  ".aider.conf.yaml",
  ".aiderignore",
  ".envrc",
  // project MCP servers each CLI starts: Claude Code's, Cursor's, VS Code's (Copilot)
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
];

/** Credentials no run reads (the guard's credential PATH_RULES say the same for commands that name them). */
const SECRETS = [".aws", ".config/gcloud", ".azure"];

/**
 * Claude Code's log folder for a run in `cwd` (its mcp-logs and errors): macOS only, where it is
 * `~/Library/Caches/claude-cli-nodejs/<cwd with every other character a dash>` and no variable moves it (on Linux it
 * follows XDG_CACHE_HOME, the project's cache). Only this run's folder, never another project's or the parent.
 * ponytail: a cwd longer than 200 characters gets a hashed name there; its run then logs nothing, add the hash if one does.
 */
export const claudeCache = (cwd: string, home = homedir()): string =>
  join(home, "Library", "Caches", "claude-cli-nodejs", real(cwd).replace(/[^a-zA-Z0-9]/g, "-"));

/** A path with symlinks resolved as far as it exists (macOS: /tmp is /private/tmp), the rest kept as given. */
export function real(p: string): string {
  const abs = resolve(p);
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    // a folder macOS keeps from this process (Safari's, under privacy protection): its path as given, below
  }
  const parent = dirname(abs);
  return parent === abs ? abs : join(real(parent), basename(abs));
}

/** `p` is `root` or inside it. */
const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** The policy for one run; `home` and `ops` are for tests. The shared temp folders aren't its: it gets its own (`runTmp`). */
export function sandboxPolicy(r: RunPlaces, home = homedir(), ops = OPS): SandboxPolicy {
  const h = (p: string) => join(home, p);
  const cli = CLI_STATE[r.runtime];
  // a CLI whose login moves runs in a folder of Overhand's (agent-home.ts runHome): never its state under your home,
  // even when no folder came (that run then fails on its own, not into yours)
  const homes = r.configDir ? [r.configDir] : MOVED.has(r.runtime) ? [] : cli.homes.map(h);
  const gitPieces =
    r.gitCommon && r.gitDir && r.gitDir !== r.gitCommon
      ? [
          r.gitDir,
          ...["objects", "refs", "logs", "packed-refs", "packed-refs.lock", "gc.pid", "gc.pid.lock", "gc.log"].map((p) =>
            join(r.gitCommon, p),
          ),
        ]
      : [];
  // made before the run (sandboxSpawn) and locked, so the run can't swap it for a symlink your own sessions write through
  const claudeLogs = r.runtime === "claude-code" ? [claudeCache(r.cwd, home)] : [];
  const write = [
    ...(r.readOnly ? [] : [r.cwd, ...gitPieces]),
    ...claudeLogs,
    r.runTmp ?? "",
    r.cache ?? "",
    ...homes,
    join(ops, "slots"),
    outboxDir(ops, r.run),
    ...(r.also ?? []),
  ];
  // in the shared git folder and this checkout's own alike (a main checkout's is the shared one): config, hooks, info
  // and the pointers (a main checkout's commondir sends git to a repository of the run's making)
  const repoSteer = [...new Set([r.gitCommon, r.gitDir].filter(Boolean))].flatMap((d) => GIT_STEER.map((p) => join(d, p)));
  // where git finds the repository: rewritten, the daemon's next git command there would read a config of the run's
  // making (core.fsmonitor runs a program). A worktree's .git file and its pointers; a checkout's other worktrees and
  // its submodules' config and hooks
  const worktree = r.gitCommon !== "" && r.gitDir !== "" && r.gitDir !== r.gitCommon;
  const pointers = worktree
    ? [join(r.cwd, ".git"), join(r.gitDir, "commondir"), join(r.gitDir, "gitdir")]
    : r.gitCommon
      ? [join(r.gitCommon, "worktrees"), ...submoduleSteer(join(r.gitCommon, "modules"))]
      : [];
  // Overhand's own files, but the CLI state folders under agent-home are this run's to write (their steering files
  // aren't) and so are the governor's slots (`overhand heavy` runs inside the run)
  const own = selfPaths(ops).filter((p) => p !== join(ops, "agent-home") && p !== join(ops, "slots"));
  const deny = [
    // your own config and state of the CLIs whose runs moved to Overhand's folders: what your own sessions start with
    ...MOVED_IDS.flatMap((id) => CLI_STATE[id].homes.map(h)),
    ...repoSteer,
    ...pointers,
    ...PROJECT_STEER.map((p) => join(r.cwd, p)),
    ...homes.flatMap((d) => [...cli.steer, ...STEER_ALL].map((p) => join(d, p))),
    ...own,
  ];
  const hide = [
    ...SECRETS.map(h),
    ...BROWSERS.map(h),
    join(controlDir(ops), "local-key"),
    join(ops, ".devices.json"),
    process.env.OVERHAND_SECRETS_FILE ?? "",
  ];
  const clean = (ps: string[]) => [...new Set(ps.filter(Boolean).map(real))];
  // the outbox's folders, made before the run: one swapped for a symlink, the daemon's intake would read and clear
  // somewhere else, so none can be renamed, removed or replaced (only the files in them are the run's)
  const box = outboxDir(ops, r.run);
  return { write: clean(write), deny: clean(deny), hide: clean(hide), lock: clean([...outboxFolders(box), ...claudeLogs]) };
}

/** An outbox and the folders inside it the guard writes into (control/sessions), which sandboxSpawn makes before a run. */
export const outboxFolders = (box: string): string[] => [box, join(box, "control"), join(box, "control", "sessions")];

/** Each submodule's config and hooks under a repo's `.git/modules` (they nest), so none can be rewritten to run code. */
function submoduleSteer(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !e.isSymbolicLink()
      ? [join(dir, e.name, "config"), join(dir, e.name, "hooks"), ...submoduleSteer(join(dir, e.name, "modules"))]
      : [],
  );
}

/**
 * Each denied path and, for each writable folder holding it, every folder between: renaming `.git` or `.claude` away
 * would otherwise carry the protected file with it (the spike: `mv .claude .claudex` got past a deny on
 * `.claude/settings.json`). Denying the folder itself stops the rename and leaves the files beside it writable.
 */
export function guarded(p: SandboxPolicy): string[] {
  const out = new Set<string>();
  for (const d of p.deny) {
    out.add(d);
    for (const w of p.write) {
      if (!under(d, w) || d === w) continue;
      for (let a = dirname(d); under(a, w); a = dirname(a)) {
        out.add(a);
        if (a === w) break;
      }
    }
  }
  return [...out];
}

/** A string as an SBPL string literal. */
const lit = (s: string): string => JSON.stringify(s);

/**
 * The macOS profile. Everything is allowed but writes (only `write`, never `deny` and its ancestors), reads of `hide`,
 * and tmux's sockets (typing into a terminal you have open). Not Apple Events or LaunchServices: denying their services
 * didn't stop `osascript` asking Finder, and denying more hangs AppKit tools (SANDBOX_LIMIT says so). On `log`, nothing
 * is denied: what enforce would deny is allowed with a report, which the unified log records (`recordWouldDeny`).
 */
export function macProfile(p: SandboxPolicy, mode: "log" | "enforce" = "enforce"): string {
  const no = (op: string, filters: string[]) =>
    filters.length === 0
      ? ""
      : mode === "enforce"
        ? `(deny ${op} ${filters.join(" ")})`
        : `(allow ${op} (with report) ${filters.join(" ")})`;
  const paths = (ps: string[], literal = false) => ps.map((x) => `(${literal ? "literal" : "subpath"} ${lit(x)})`);
  return [
    "(version 1)",
    "(allow default)",
    mode === "enforce" ? `(deny file-write* (subpath "/"))` : "",
    `(allow file-write* ${paths(p.write).join(" ")} ${DEVICE_FILTERS})`,
    mode === "log" ? `(allow file-write* (with report) (require-not (require-any ${paths(p.write).join(" ")} ${DEVICE_FILTERS})))` : "",
    no("file-write*", [
      ...paths(p.deny),
      ...paths(
        [...guarded(p), ...(p.lock ?? [])].filter((a) => !p.deny.includes(a)),
        true,
      ),
    ]),
    no("file-read*", paths(p.hide)),
    no(
      "network-outbound",
      SOCKETS.map((s) => `(remote unix-socket (path-regex #"${s}"))`),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * macOS unix sockets no run connects to: a terminal multiplexer you have open (tmux, screen: typing into your shell)
 * and Docker (a container can mount your whole disk). Other local services stay reachable (SANDBOX_LIMIT).
 */
const SOCKETS = ["^/private/tmp/tmux-", "^/private/tmp/\\.screen", "/\\.screen/", "/docker\\.sock$", "^/private/var/run/docker"];

/** Device files every program writes to (output, terminals, dtrace's helper). */
const DEVICES = ["/dev/null", "/dev/zero", "/dev/dtracehelper", "/dev/ptmx", "^/dev/tty", "^/dev/fd/"];
const DEVICE_FILTERS = DEVICES.map((d) => (d.startsWith("^") ? `(regex #"${d}")` : `(literal ${lit(d)})`)).join(" ");

/**
 * The Linux bubblewrap arguments before the command: the whole system read-only, each writable folder bound writable,
 * each denied path bound read-only on top (a denied file that doesn't exist yet becomes an empty read-only one, removed
 * after the run: `created`), every folder between a writable folder and a denied path bound onto itself so it is a
 * mount point (a mount point can't be renamed), hidden paths covered with an empty tmpfs or /dev/null. Network shared.
 */
export function bwrapArgs(p: SandboxPolicy, env: Record<string, string | undefined> = process.env): { args: string[]; created: string[] } {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--new-session", "--unshare-pid"];
  args.push("--unshare-ipc");
  // the shared /tmp stays read-only like the rest (a private tmpfs there would turn writes to anything under it into
  // writes that seem to work), with tmux's, screen's and X's sockets in it covered; none of your session's sockets in
  // /run/user (D-Bus, the keyring, Wayland); only your SSH agent's socket comes back, since agents push over it
  // every target as it is on disk now, symlinks above it resolved (/var/run is a link to /run): bwrap can't make a
  // mount point through a link, nor for something that isn't there, and a missing one needs no mask
  const cover = (s: string): string[] => {
    const at = onDisk(s);
    return at ? (statSync(at).isDirectory() ? ["--tmpfs", at] : ["--ro-bind", "/dev/null", at]) : [];
  };
  const runUser = typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "";
  if (runUser) args.push(...cover(runUser));
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  for (const s of [`/tmp/tmux-${uid}`, "/tmp/screens", "/tmp/.X11-unix"]) args.push(...cover(s));
  for (const s of new Set(LINUX_SOCKETS.map((x) => onDisk(x)).filter((x): x is string => x !== null))) args.push(...cover(s));
  const bind = (x: string): string[] => {
    const at = onDisk(x);
    return at ? ["--bind", at, at] : [];
  };
  for (const w of p.write) args.push(...bind(w));
  const agent = env.SSH_AUTH_SOCK ?? "";
  if (agent) args.push(...bind(agent));
  for (const l of p.lock ?? []) args.push(...bind(l));
  const created: string[] = [];
  for (const a of guarded(p)) {
    if (p.deny.includes(a)) continue;
    if (p.write.some((w) => under(a, w))) args.push(...bind(a));
  }
  for (const d of p.deny) {
    const at = onDisk(d);
    if (at) args.push("--ro-bind", at, at);
    else if (p.write.some((w) => under(d, w)) && onDisk(dirname(d))) {
      // missing, inside a writable folder whose own folder is there: a read-only file stands in, so a run can't create
      // it (cleanCreated removes it after). An empty one, but for a git folder's commondir, which git outside the
      // sandbox reads too while the run lasts: that one is written first, saying "." (the repository is its own,
      // what a missing one means), and bound read-only as it is
      if (basename(d) === "commondir") {
        writeFileSync(d, ".\n", { mode: 0o644, flag: "wx" });
        args.push("--ro-bind", d, d);
      } else args.push("--ro-bind", "/dev/null", d);
      created.push(d);
    }
  }
  for (const s of p.hide) args.push(...cover(s));
  return { args, created };
}

/** `p` as it is on disk now, its folders' symlinks resolved but not a socket's own (realpath can't take one); null when missing. */
function onDisk(p: string): string | null {
  try {
    lstatSync(p);
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return null;
  }
}

/** Linux sockets and their folders no run reaches: Docker, the system D-Bus, screen's. */
const LINUX_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/run/dbus/system_bus_socket", "/run/screen", "/var/run/screen"];

/** Removes the empty files bwrap made as mount points for denied paths that didn't exist (bwrapArgs `created`). */
export function cleanCreated(created: string[]): void {
  for (const f of created) {
    // only what bwrap made: still empty, or the stand-in commondir that says "."
    const text = existsSync(f) && Bun.file(f).size <= 2 ? readFileSync(f, "utf8") : null;
    if (text === "" || (basename(f) === "commondir" && text === ".\n")) rmSync(f, { force: true });
  }
}

/** The platforms a sandbox exists for, by `process.platform`. */
export const SANDBOX_TOOL: Partial<Record<NodeJS.Platform, string>> = { darwin: "/usr/bin/sandbox-exec", linux: "bwrap" };

/**
 * `argv` wrapped in the sandbox for `p`: `sandbox-exec -p <profile> …` on macOS, `bwrap … --` on Linux. `files` holds
 * what bwrap creates (to clean after the run). Unwrapped on any other platform or on `off`, and on Linux in `log` mode
 * (bubblewrap can't report without denying).
 */
export function sandboxArgv(
  argv: string[],
  p: SandboxPolicy,
  mode: SandboxMode,
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; created: string[] } {
  if (mode === "off") return { argv, created: [] };
  if (platform === "darwin") return { argv: [SANDBOX_TOOL.darwin ?? "", "-p", macProfile(p, mode), ...argv], created: [] };
  if (platform === "linux" && mode === "enforce") {
    const { args, created } = bwrapArgs(p);
    return { argv: [Bun.which("bwrap") ?? "bwrap", ...args, "--", ...argv], created };
  }
  return { argv, created: [] };
}

/** What the startup probe found: whether the sandbox works here, and why not in plain words. */
export interface SandboxProbe {
  ok: boolean;
  why: string;
}

/**
 * Runs `true` and one write the sandbox must refuse, inside the real sandbox: ok only when the first works and the second
 * fails. Never throws.
 */
export function probeSandbox(platform: NodeJS.Platform = process.platform): SandboxProbe {
  const tool = platform === "linux" ? Bun.which("bwrap") : SANDBOX_TOOL[platform];
  if (!tool || !existsSync(tool))
    return {
      ok: false,
      why:
        platform === "linux"
          ? "bubblewrap isn't installed (apt install bubblewrap)"
          : platform === "darwin"
            ? "sandbox-exec is missing"
            : "no sandbox on this system",
    };
  const dir = real(mkdtempSync(join(tmpdir(), "overhand-probe-")));
  try {
    const allowed = join(dir, "allowed");
    const refused = join(dir, "refused");
    mkdirSync(allowed);
    const policy: SandboxPolicy = { write: [allowed], deny: [], hide: [] };
    const run = (cmd: string[]) =>
      Bun.spawnSync(sandboxArgv(cmd, policy, "enforce", platform).argv, { stdout: "ignore", stderr: "pipe", timeout: 10_000 });
    const t = run([Bun.which("true") ?? "/usr/bin/true"]);
    if (t.exitCode !== 0) {
      const err = t.stderr.toString().trim().split("\n")[0] ?? "";
      return {
        ok: false,
        why:
          platform === "linux" ? `bubblewrap can't start here (${err || "user namespaces are off"})` : `the sandbox didn't start (${err})`,
      };
    }
    run(["/bin/sh", "-c", `echo x > '${refused}'; echo x > '${join(allowed, "ok")}'`]);
    if (existsSync(refused)) return { ok: false, why: "the sandbox let through a write it must refuse" };
    if (!existsSync(join(allowed, "ok"))) return { ok: false, why: "the sandbox refused a write it must allow" };
    return { ok: true, why: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The sandbox on this machine: the configured mode, the one runs get, whether it works and, if not, why. */
export interface SandboxState {
  mode: SandboxMode;
  /** What runs get: off when it's off, can't run here, or is on log where only macOS can log. */
  effective: SandboxMode;
  ok: boolean;
  why: string;
  /** Runs don't start: macOS, where a failing probe is a bug, or `sandbox.required` on a machine without it. */
  refuse: boolean;
  /** This project is set to run without the sandbox (contract guardOnly): its runs have the guard only. */
  guardOnly?: boolean;
}

// ponytail: one probe per daemon (a machine's sandbox doesn't come and go); a restart probes again
let probed: SandboxProbe | null = null;

/**
 * The sandbox state for `cfg` (config `sandbox`), probing once. With `project` (that project's own `sandbox` setting),
 * the state its runs get: one set to off runs on the guard only, unless the sandbox is required.
 */
export function sandboxState(
  cfg: { mode: SandboxMode; required: boolean; project?: ProjectSandbox | undefined },
  platform: NodeJS.Platform = process.platform,
  probe: () => SandboxProbe = () => {
    probed ??= probeSandbox(platform);
    return probed;
  },
): SandboxState {
  if (cfg.mode === "off") return { mode: "off", effective: "off", ok: true, why: "", refuse: false };
  if (guardOnly(cfg, cfg.project)) return { mode: cfg.mode, effective: "off", ok: true, why: "", refuse: false, guardOnly: true };
  const p = probe();
  if (!p.ok) return { mode: cfg.mode, effective: "off", ok: false, why: p.why, refuse: platform === "darwin" || cfg.required };
  return { mode: cfg.mode, effective: cfg.mode === "log" && platform !== "darwin" ? "off" : cfg.mode, ok: true, why: "", refuse: false };
}

/** The sandbox state `project`'s runs and checks get, from the config: the one place a spawn site asks. */
export const projectSandbox = (project: string): SandboxState =>
  sandboxState({ ...CFG.sandbox, project: CFG.clients.find((c) => c.name === project)?.sandbox });

/** Marks of a tool that can't run inside the sandbox, at a project's top or one or two folders down. */
const HOST_TOOLS: [RegExp, string][] = [
  [/\.(xcodeproj|xcworkspace)$|^Package\.swift$/, "Xcode"],
  [/^firebase\.json$/, "firebase-tools"],
];

/**
 * The tool in `dir` that can't run inside the sandbox ("Xcode", "firebase-tools"), "" for none: for Settings to suggest
 * running the project without it. Never switches anything.
 */
export function hostTool(dir: string, depth = 2): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  for (const n of names) for (const [re, tool] of HOST_TOOLS) if (re.test(n)) return tool;
  if (depth === 0) return "";
  for (const n of names) {
    if (n.startsWith(".") || n === "node_modules") continue;
    const p = join(dir, n);
    try {
      if (!lstatSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const t = hostTool(p, depth - 1);
    if (t) return t;
  }
  return "";
}

/** What a spawn site needs to know of one run to sandbox it. */
export interface RunSpawn extends Omit<RunPlaces, "gitCommon" | "gitDir"> {
  argv: string[];
  env: Record<string, string>;
}

/** This checkout's own git folder (a worktree's `<common>/worktrees/<name>`), "" outside git. */
function gitDirOf(cwd: string): string {
  if (!gitPointersOk(cwd)) return "";
  const r = Bun.spawnSync(safeCmd(["git", "rev-parse", "--absolute-git-dir"]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

/**
 * One run's process, as it starts under `st`: its own run key in the environment (control.ts runKey), and on log or
 * enforce the command wrapped in the sandbox (its outbox made first). `sandboxed` and `guardOnly` (its project is set to
 * run without the sandbox, projectSandbox) go into the run's record (recordSpawn); `done` runs after it exits: it removes bwrap's mount-point files and, on log, records what enforce
 * would have denied. Throws when the sandbox must refuse runs here (`st.refuse`), with why.
 */
export function sandboxSpawn(
  s: RunSpawn,
  st: SandboxState,
  gitCommon: (cwd: string) => string,
  ops = OPS,
): { argv: string[]; env: Record<string, string>; sandboxed: boolean; guardOnly: boolean; done: (startedAt: number) => void } {
  if (st.refuse) throw new Error(`the OS sandbox can't run here (${st.why}), and Overhand doesn't start runs without it`);
  // an account still on your own config (agent-home.ts pendingMove) waits under the enforced sandbox: never a run
  // against your ~/.claude or ~/.codex, sandboxed or not
  if (st.effective === "enforce" && MOVED.has(s.runtime) && !s.configDir.startsWith(`${AGENT_HOMES}/`))
    throw new Error(plainWords.movedWaitsSandbox);
  const env = { ...s.env, [RUN_KEY_ENV]: runKey() };
  const common = gitCommon(s.cwd);
  const gitDir = common ? gitDirOf(s.cwd) : "";
  // with the sandbox or without: where git finds this repo must be where it was, or the daemon runs no git there
  const before = gitPointers(s.cwd, gitDir);
  const after = () => {
    if (gitPointers(s.cwd, gitDir) !== before) flagRepo(s.cwd, s.run, ops);
  };
  if (st.effective === "off") return { argv: s.argv, env, sandboxed: false, guardOnly: st.guardOnly === true, done: after };
  const runTmp = real(mkdtempSync(join(tmpdir(), "overhand-run-")));
  const cache = projectCache(s.env.OVERHAND_PROJECT || s.run, ops);
  mkdirSync(cache, { recursive: true });
  const policy = sandboxPolicy({ ...s, gitCommon: common, gitDir, runTmp, cache }, homedir(), ops);
  mkdirSync(join(outboxDir(ops, s.run), "control", "sessions"), { recursive: true });
  if (s.runtime === "claude-code" && process.platform === "darwin") mkdirSync(claudeCache(s.cwd), { recursive: true });
  const { argv, created } = sandboxArgv(s.argv, policy, st.effective);
  const done = (startedAt: number) => {
    after();
    cleanCreated(created);
    rmSync(runTmp, { recursive: true, force: true });
    if (st.effective === "log") void recordWouldDeny(s.run, startedAt, join(ops, "logs", "sandbox-would-deny.jsonl"));
  };
  // Claude Code doesn't update itself from inside a run: its install is outside what a run may write
  return { argv, env: { ...env, ...runCacheEnv(runTmp, cache, env), DISABLE_AUTOUPDATER: "1" }, sandboxed: true, guardOnly: false, done };
}

/**
 * What tells git where a checkout's repository is: a worktree's `.git` file and its `commondir` and `gitdir`, or a
 * main checkout's `.git` folder, as one string to compare before and after a run. "" outside git.
 */
export function gitPointers(cwd: string, gitDir: string): string {
  if (!gitDir) return "";
  const read = (p: string) => {
    try {
      const st = lstatSync(p);
      return st.isFile() ? readFileSync(p, "utf8") : `${st.isSymbolicLink() ? "link" : "dir"}:${st.ino}`;
    } catch {
      return "-";
    }
  };
  return [join(cwd, ".git"), join(gitDir, "commondir"), join(gitDir, "gitdir")].map(read).join("\n");
}

/**
 * Marks a checkout whose git pointers a run changed: the daemon runs no git there again (env.ts sh refuses it), and
 * says so. Only you can clear it (control/git-tampered.json), after looking.
 */
export function flagRepo(cwd: string, run: string, ops = OPS): void {
  const file = join(controlDir(ops), "git-tampered.json");
  let list: string[] = [];
  if (existsSync(file)) {
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(v)) throw new Error("not a list");
      list = v.filter((x): x is string => typeof x === "string");
    } catch {
      // an unreadable list already refuses all git (env.ts gitRefused); rewriting it would drop every earlier flag
      report(
        `⚠ ${run} changed where git finds the repository in ${cwd}, and ${file} can't be read: Overhand runs no git anywhere until you fix it`,
      );
      return;
    }
  }
  writeAtomic(file, JSON.stringify([...new Set([...list, real(cwd)])]));
  report(`⚠ ${run} changed where git finds the repository in ${cwd}: Overhand runs no git there until you look (${file})`);
}

/** What the macOS sandbox wrote to the unified log since `since` (a few seconds' slack), in the compact style. */
async function sandboxLog(since: number): Promise<string> {
  const secs = Math.ceil((Date.now() - since) / 1000) + 5;
  const p = Bun.spawn(["log", "show", "--last", `${secs}s`, "--style", "compact", "--predicate", 'sender == "Sandbox"'], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return new Response(p.stdout).text();
}

/**
 * One line the unified log keeps for a write a sandbox refused. Only writes: the system's own daemons fill the log with
 * refused reads and lookups, and writes are what the enforced profile refuses (its hidden reads go uncounted).
 */
const REFUSED = /Sandbox: .+?\(\d+\) deny\(\d+\) file-write/;

/** How many refusals the enforced sandbox logged in `text` (the unified log, sandboxLog). */
export const countRefusals = (text: string): number => text.split("\n").filter((l) => REFUSED.test(l)).length;

/**
 * How many operations the enforced sandbox refused since `since`, from the unified log (macOS); null where it can't be
 * read. ponytail: the log is the whole computer's, so the count can hold other runs' and other sandboxes' refused
 * writes; filter by the run's process tree if it needs to be exact.
 */
export async function sandboxRefusals(since: number, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform !== "darwin") return null;
  try {
    return countRefusals(await sandboxLog(since));
  } catch {
    return null;
  }
}

/** One line the unified log keeps for a write or read the log-mode profile reported. */
const REPORTED = /Sandbox: (.+?)\((\d+)\) allow (\S+) (\/.*)$/;

/**
 * On log: what the profile reported (allowed, but enforce would deny) since `since`, from the unified log, one line per
 * operation and path into `file`. ponytail: runs at the same time share the log, so a line can be another run's; it's for
 * tuning the policy before enforce, not for blame.
 */
export async function recordWouldDeny(run: string, since: number, file: string): Promise<number> {
  const text = await sandboxLog(since);
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    const m = REPORTED.exec(line);
    if (!m) continue;
    const [, proc = "", , op = "", path = ""] = m;
    if (seen.has(`${op} ${path}`)) continue;
    seen.add(`${op} ${path}`);
    rows.push(JSON.stringify({ at: Date.now(), run, process: proc, op, path }));
  }
  if (rows.length) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${rows.join("\n")}\n`, { mode: 0o600 });
  }
  return rows.length;
}

/** `shAsync` for a command that executes a project's own files: under the project's sandbox when it's on (projectCommand). */
export async function projectSh(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  project = projectAt(cwd),
): Promise<{ ok: boolean; out: string; err: string }> {
  const box = projectCommand(cmd, cwd, projectSandbox(project), project);
  try {
    return await shAsync(box.argv, cwd, timeoutMs);
  } finally {
    box.done();
  }
}

/**
 * A command the daemon itself runs that executes a project's own files (its package manager reading the project's
 * hooks, a lint script, a virtualenv's pip): files runs write, so with the sandbox on it runs under that project's
 * policy, as a run would (its folder and caches writable, nothing else); off, as before. `done` removes its temp.
 * Where the sandbox must refuse, the command doesn't run at all (`false`).
 */
export function projectCommand(
  cmd: string[],
  cwd: string,
  st: SandboxState,
  // the project's name as runs and cleanup know it (its config name, else its repo's folder): one cache key for all three
  project = projectAt(cwd),
  ops = OPS,
): { argv: string[]; done: () => void } {
  if (st.refuse) return { argv: ["false"], done: () => {} };
  if (st.effective === "off") return { argv: cmd, done: () => {} };
  const common = gitCommonDir(cwd);
  const runTmp = real(mkdtempSync(join(tmpdir(), "overhand-check-")));
  const cache = projectCache(project, ops);
  mkdirSync(cache, { recursive: true });
  const run = `daemon-${runCacheKey(project)}`;
  // while it runs, cleanup leaves the project's cache alone (cleanup.ts liveProjects reads this)
  const checking = join(checksDir(ops), `${runCacheKey(project)}.${process.pid}.${Date.now()}`);
  mkdirSync(dirname(checking), { recursive: true });
  writeFileSync(checking, "", { mode: 0o600 });
  const policy = sandboxPolicy(
    { cwd, gitCommon: common, gitDir: common ? gitDirOf(cwd) : "", runtime: "none", configDir: "", run, readOnly: false, runTmp, cache },
    homedir(),
    ops,
  );
  const vars = Object.entries(runCacheEnv(runTmp, cache, process.env)).map(([k, v]) => `${k}=${v}`);
  const { argv, created } = sandboxArgv(["/usr/bin/env", ...vars, ...cmd], policy, st.effective);
  return {
    argv,
    done: () => {
      cleanCreated(created);
      rmSync(runTmp, { recursive: true, force: true });
      rmSync(checking, { force: true });
    },
  };
}

/** Where a check the daemon runs in a project's files says it's running (`<project key>.<pid>.<at>`), for cleanup. */
export const checksDir = (ops = OPS): string => join(controlDir(ops), "checks");
