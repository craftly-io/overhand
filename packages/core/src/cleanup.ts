/**
 * Disk cleanup: a planner that lists what can go (removing nothing), and a worker that removes only the ticked items,
 * re-checking each one right before it goes. Everything it may touch is derived from rules here, never from the plan
 * file: an item a fresh scan wouldn't propose is skipped.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CLEANUP_CATEGORIES, type CleanupCategory, type CleanupItem, type CleanupResult, ownData, RUNTIME_NAMES } from "@overhand/contract";
import {
  buildDirs,
  pathsOn,
  RUN_CACHE_DAYS,
  RUN_CACHE_MAX_GB,
  RUN_CACHES,
  runCacheKey,
  SOURCES,
  type Source,
  source,
} from "./cleanup-sources";
import { type Config, loadConfig } from "./config";
import { gitRefused, OPS, SRC } from "./env";
import { cwdOf } from "./platform";
import { gitEnv, isGit, safeCmd } from "./runtimes/runtime";

/** Where cleanup looks, and what it must leave alone. Tests pass scratch folders and a `which` that finds nothing. */
export interface Scope {
  cfg: Config;
  home: string;
  /** The Code root: projects and their worktrees. */
  code: string;
  /** Overhand's state folder (logs/, runs/, .current.json). */
  ops: string;
  /** The Overhand checkout or install; never cleaned. */
  src: string;
  /** Folders an agent or lead works in right now: nothing in them, or containing them, is touched. */
  busy: string[];
  /** Every process's working folder: nothing containing one is touched. */
  cwds: string[];
  now: number;
  which: (bin: string) => string | null;
  /** Overhand's projects folder, where it clones; a repo outside it and the Code root is your own. Unset = the Code root only. */
  projects?: string;
  /** A branch's pull request state (OPEN, MERGED, CLOSED), or "" when there's none or it can't be asked. */
  prState?: (repo: string, branch: string) => string;
  /** The temp folder (os.tmpdir()). Unset = none is looked at. */
  tmp?: string;
  /** Every running program's command line: a tool running keeps its caches, a path one names is in use. */
  procs?: string[];
  /** darwin or linux: which paths each source lists. Unset = this machine's. */
  platform?: string;
}

const DAY = 86_400_000;
// every git command here goes the daemon's one safe way (runtimes/runtime.ts safeCmd and gitEnv, env.ts gitRefused):
// cleanup runs in agents' worktrees, whose git a run may have tried to redirect
const run = (cmd: string[], cwd?: string, timeout = 120_000, env?: Record<string, string>) => {
  const git = isGit(cmd);
  // git told its repository outright (GIT_DIR, a scratch one of cleanup's own) never follows the folder's .git
  if (git && !env?.GIT_DIR && gitRefused(cwd ?? process.cwd())) return { ok: false, out: "" };
  try {
    const r = Bun.spawnSync(safeCmd(cmd), {
      cwd,
      env: git ? gitEnv({ ...process.env, ...env }) : env && { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout,
      killSignal: "SIGKILL", // a hung docker CLI ignores SIGTERM
    });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" }; // cwd gone, or the binary vanished
  }
};
/** Like run, but async, so independent fetches and `du`s overlap. */
const runAsync = async (cmd: string[], cwd?: string) => {
  const git = isGit(cmd);
  if (git && gitRefused(cwd ?? process.cwd())) return { ok: false, out: "" };
  const p = Bun.spawn(safeCmd(cmd), { cwd, env: git ? gitEnv() : process.env, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return { ok: (await p.exited) === 0, out: out.trim() };
};
const expand = (p: string, home: string, tmp = "") =>
  p.startsWith("~/") ? join(home, p.slice(2)) : p.startsWith("$TMPDIR/") ? (tmp ? join(tmp, p.slice(8)) : "") : p;
const lstat = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
/**
 * When p was last touched: the newest change (and, with `read`, files' access) time of it and what's inside, `depth`
 * levels down. Links are read, never followed.
 */
export function newest(p: string, depth = 1, read = false): number {
  const st = lstat(p);
  if (!st) return 0;
  // a folder's access time moves whenever it's listed (Linux), this scan included: only a file's says it was used
  let at = Math.max(st.mtimeMs, read && !st.isDirectory() ? st.atimeMs : 0);
  if (depth > 0 && st.isDirectory())
    try {
      for (const f of readdirSync(p)) at = Math.max(at, newest(join(p, f), depth - 1, read));
    } catch {
      // unreadable: what we have
    }
  return at;
}
const days = (s: Pick<Scope, "now">, at: number) => Math.floor((s.now - at) / DAY);
const du = (p: string): number => Number(run(["du", "-sk", p]).out.split(/\s/)[0]) || 0;
/** True when p is root or inside it. */
const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** Runs fn over every item, at most `limit` at a time. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const PARALLEL = 8; // fetches and disk scans at once; past this the network and the disk are the limit

// -prune, not -not -path: the latter still walks every node_modules tree, seconds per project on the status timer
const findRepos = (root: string): string[] => [
  "find",
  root,
  "-maxdepth",
  "4",
  "(",
  "-name",
  "node_modules",
  "-o",
  "-path",
  "*/.claude/worktrees",
  ")",
  "-prune",
  "-o",
  "-name",
  ".git",
  "-type",
  "d",
  "-prune",
  "-print",
  // a repo you already had, linked into Overhand's projects folder instead of cloned twice (projects.ts): find
  // doesn't follow links, so links are listed and kept when they lead to a repo
  "-o",
  "-type",
  "l",
  "-print",
];
const reposIn = (found: string): string[] =>
  found
    .split("\n")
    .filter(Boolean)
    .flatMap((p) => (basename(p) === ".git" ? [dirname(p)] : isRepoLink(p) ? [p] : []));

/** Every git repo (not worktree or dependency) up to 4 levels under root. */
export function gitRepos(root: string): string[] {
  return existsSync(root) ? reposIn(run(findRepos(root)).out) : [];
}

/** `gitRepos` without blocking the daemon while find walks: for reads on a timer. */
export async function gitReposAsync(root: string): Promise<string[]> {
  return existsSync(root) ? reposIn((await runAsync(findRepos(root))).out) : [];
}

/** A link to a git checkout (its .git a folder, so not a worktree). */
const isRepoLink = (p: string): boolean => {
  try {
    return statSync(join(p, ".git")).isDirectory();
  } catch {
    return false;
  }
};

// ---------- safety predicates ----------

/** Under home: never cleaned, whatever the config says (models, documents, keys). */
const PROTECTED = [
  ".ollama",
  ".lmstudio",
  ".cache/huggingface",
  ".cache/lm-studio",
  ".ssh",
  ".gnupg",
  "Documents",
  "Desktop",
  "Downloads",
  "Pictures",
  "Movies",
  "Music",
  "Library/Mobile Documents",
];

/**
 * Why `p` must not be deleted, or null when it may be: it isn't a symlink, it resolves (symlinks in its parents followed)
 * strictly inside home, the Code root or Overhand's own folder, it isn't a protected folder, and it isn't a git repo (worktrees are, and go
 * through git, so `worktree` allows that).
 */
export function refusePath(
  p: string,
  s: Pick<Scope, "home" | "code" | "ops">,
  worktree = false,
  allow: { models?: boolean; tmp?: string } = {},
): string | null {
  try {
    if (lstatSync(p).isSymbolicLink()) return "it's a symlink";
  } catch {
    return null; // already gone: nothing to delete, nothing to refuse
  }
  const at = real(p);
  const home = real(s.home);
  const roots = [home, s.code && real(s.code), real(s.ops), allow.tmp && real(allow.tmp)].filter(Boolean);
  if (!roots.some((r) => at.startsWith(`${r}/`))) return "it's outside your home and Code folders";
  // one model inside a model folder, never the folder itself (models items name each model)
  const model = allow.models && MODEL_ROOTS.some((r) => at.startsWith(`${join(home, r)}/`));
  if (!model && PROTECTED.some((x) => under(at, join(home, x)))) return "it's a protected folder (models, documents or keys)";
  if (!worktree && existsSync(join(at, ".git"))) return "it's a git repository";
  return null;
}

/** Where models can go one by one: each is a folder inside these (Ollama's go by `ollama rm`). */
const MODEL_ROOTS = [".lmstudio/models", ".cache/lm-studio/models", ".cache/huggingface/hub"];

/**
 * Why `p` is in use, or null: an agent or lead works in or around it, a running program sits inside it, or a running
 * program's command line names something in it (an MCP server npx or bunx started from its cache).
 */
export function inUse(p: string, s: Pick<Scope, "busy" | "cwds" | "procs">): string | null {
  const at = real(p);
  if (s.busy.some((b) => under(real(b), at) || under(at, real(b)))) return "an agent or lead is working there";
  if (s.cwds.some((c) => under(c, at))) return "a running program is inside it";
  if ([p, at].some((x) => s.procs?.some((c) => c.includes(`${x}/`) || c.endsWith(x) || c.includes(`${x} `))))
    return "a running program uses it";
  return null;
}

/** True while one of a source's programs runs (argv[0]'s name, or its macOS app bundle). */
const running = (src: Source, s: Pick<Scope, "procs">): boolean =>
  (s.procs ?? []).some((c) => {
    const argv0 = basename(c.split(" ")[0] ?? "");
    return (src.procs ?? []).includes(argv0) || (src.apps ?? []).some((a) => c.includes(`/${a}.app/`));
  });

/** Folders agents and leads use right now: running tasks, open agent PRs, Overhand's lead worktrees and live leads. */
function busyPaths(cfg: Config, code: string, ops: string, src = ops): string[] {
  const read = (f: string): unknown => {
    try {
      return existsSync(join(ops, f)) ? JSON.parse(readFileSync(join(ops, f), "utf8")) : {};
    } catch {
      return {};
    }
  };
  const alive = (pid: unknown) => {
    try {
      return typeof pid === "number" && pid > 0 && process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  const running = [read(".current.json")].flat() as { cwd?: string }[]; // a list since parallel runs, one run before
  const prs = (read("state.json") as { prs?: Record<string, { repoPath?: string }> }).prs ?? {};
  const leadWts = [ops, src].flatMap((root) => {
    const wts = join(root, ".claude", "worktrees");
    return existsSync(wts)
      ? readdirSync(wts)
          .filter((d) => d.startsWith("lead-"))
          .map((d) => join(wts, d))
      : [];
  });
  const leads = read(".leads.json") as Record<string, { pid?: number }>;
  const liveLeads = cfg.godmode.flatMap((g) => {
    let lock = false;
    if (g.lockFile)
      try {
        const l = JSON.parse(readFileSync(join(code, g.lockFile), "utf8")) as { pid?: number; heartbeat?: number };
        lock = Date.now() - Number(l.heartbeat ?? 0) < g.lockStaleMin * 60_000 && alive(Number(l.pid));
      } catch {
        // no lock, or a half-written one: the pid check below still counts
      }
    return lock || alive(leads[g.key]?.pid) ? [join(code, g.dir)] : [];
  });
  return [...running.map((r) => r.cwd), ...Object.values(prs).map((p) => p.repoPath), ...leadWts, ...liveLeads].filter(
    (p): p is string => !!p,
  );
}

/**
 * Every process's working folder, resolved: /proc on Linux (lsof often isn't installed there, and an empty list would let
 * cleanup take a folder an agent is working in), `lsof` on macOS.
 */
function processCwds(): string[] {
  if (process.platform === "linux")
    return readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .map((p) => cwdOf(Number(p)))
      .filter(Boolean);
  return run(["lsof", "-w", "-d", "cwd", "-Fn"], undefined, 30_000)
    .out.split("\n")
    .filter((l) => l.startsWith("n/"))
    .map((l) => l.slice(1));
}

/** Every running program's command line (`ps`), so a tool's caches and what a program runs from are left alone. */
const processCommands = (): string[] => run(["ps", "-eww", "-o", "command="], undefined, 30_000).out.split("\n").filter(Boolean);

/**
 * Free space in GB on the volume holding `path`, or, while it doesn't exist yet (a code folder not made), on the volume
 * of its nearest existing parent.
 */
export function freeGb(path: string): number {
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const s = statfsSync(at);
  return (s.bavail * s.bsize) / 1e9;
}

/** The low-disk guard: why new agents mustn't start (free space under the floor), or null. */
export function diskGuard(free: number, floorGb: number): string | null {
  return free < floorGb ? `only ${free.toFixed(1)} GB free (the floor is ${floorGb} GB)` : null;
}

/**
 * Whether the unattended cleanup should run now, and why; null to wait. Never with the schedule off or while an agent or
 * lead runs, and at most every six hours; runs when the schedule is due, or early when free space is under its threshold.
 */
export function autoDue(auto: Config["cleanup"]["auto"], o: { freeGb: number; lastAt: number; now: number; idle: boolean }): string | null {
  if (auto.schedule === "off" || !o.idle || o.now - o.lastAt < 6 * 3_600_000) return null;
  if (o.freeGb < auto.belowFreeGb) return `free space is down to ${o.freeGb.toFixed(1)} GB`;
  if (o.now - o.lastAt >= (auto.schedule === "daily" ? 1 : 7) * DAY) return `the ${auto.schedule} cleanup`;
  return null;
}

// ---------- what each category proposes ----------

const item = (category: CleanupCategory, kind: CleanupItem["kind"], path: string, why: string, auto = false): CleanupItem => ({
  id: `${category}:${path}`,
  category,
  kind,
  path,
  why,
  kb: 0,
  checked: true,
  auto,
  personal: false,
  confirmed: "",
});

/**
 * A repo that is your own checkout, not Overhand's: a link in the projects folder (a copy you already had, reused
 * instead of cloned, projects.ts), or anything that really lives outside the projects folder and the Code root.
 */
export function personalRepo(repo: string, s: Pick<Scope, "code" | "projects">): boolean {
  try {
    if (lstatSync(repo).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  const at = real(repo);
  return ![s.code, s.projects].some((r) => r && under(at, real(r)));
}

/** An item inside your own checkout: only for you to review, never ticked, never unattended. */
const mine = (it: CleanupItem, repo: string): CleanupItem => ({
  ...it,
  checked: false,
  auto: false,
  personal: true,
  why: `in your own checkout ${repo}: removed only when you confirm it. ${it.why}`,
});

/** Every git repo under the configured project folders. */
const projectRepos = (s: Scope): string[] => s.cfg.clients.flatMap((c) => gitRepos(join(s.code, c.dir)));

/** A worktree's own git folder: named in its `.git` file (`gitdir: …`), so no git process is needed to find it. */
function gitDirOf(wt: string): string {
  try {
    const at = readFileSync(join(wt, ".git"), "utf8").match(/^gitdir: (.+)$/m)?.[1];
    if (at) return resolve(wt, at.trim());
  } catch {
    // not a file (a full checkout) or unreadable: ask git
  }
  return run(["git", "rev-parse", "--absolute-git-dir"], wt).out;
}

/** When a worktree was last used: its folder, or its index, HEAD or reflog moving. */
export function lastUsed(wt: string): number {
  const gitDir = gitDirOf(wt);
  return Math.max(mtime(wt), mtime(join(gitDir, "index")), mtime(join(gitDir, "HEAD")), mtime(join(gitDir, "logs", "HEAD")));
}

/** Folders an idle worktree can lose and get back: dependencies (reinstalled on next use) and test artifacts. */
const REGROWS = ["node_modules", "test-results", "playwright-report", "screenshots", "shots", ".shots", "coverage"];

/**
 * In a worktree kept for its unmerged work but idle `depsIdleDays`: its git-ignored dependencies and test artifacts
 * (screenshots, reports). Its work is untouched; an agent working there again reinstalls.
 */
function regrowable(repo: string, wt: string, s: Scope): CleanupItem[] {
  if (!existsSync(wt) || refusePath(wt, s, true) || inUse(wt, s)) return [];
  const used = lastUsed(wt);
  const days = Math.floor((s.now - used) / DAY);
  if (days < s.cfg.cleanup.categories.worktrees.depsIdleDays) return [];
  const names = REGROWS.flatMap((d, i) => (i ? ["-o", "-name", d] : ["-name", d]));
  const found = run([
    "find",
    wt,
    "-maxdepth",
    "3",
    "-path",
    "*/.git",
    "-prune",
    "-o",
    "-type",
    "d",
    "(",
    ...names,
    ")",
    "-prune",
    "-print",
  ]);
  return found.out
    .split("\n")
    .filter(Boolean)
    .filter((dir) => {
      const rel = relative(wt, dir);
      return run(["git", "check-ignore", "-q", rel], wt).ok && !run(["git", "ls-files", "--", rel], wt).out;
    })
    .map((dir) => ({
      ...item(
        "worktrees",
        "dir",
        dir,
        basename(dir) === "node_modules"
          ? `dependencies of an agent worktree idle ${days} days; reinstalled when an agent works there again`
          : `test artifacts in an agent worktree idle ${days} days`,
        true,
      ),
      repo,
      usedAt: used,
    }));
}

/**
 * Why a worktree can go (and whether unattended), or null to keep it. Never one with uncommitted, untracked or unpushed
 * work. `baseOf` gives the repo's base branch on the remote, looked up once per repo and only when a verdict needs it.
 */
function worktreeVerdict(
  repo: string,
  wt: string,
  branch: string,
  baseOf: () => string | undefined,
  s: Scope,
): { why: string; auto: boolean } | null {
  if (!existsSync(wt)) return { why: "folder already gone", auto: true };
  if (refusePath(wt, s, true) || inUse(wt, s)) return null;
  const status = run(["git", "status", "--porcelain"], wt);
  if (!status.ok || status.out) return null; // uncommitted or untracked (not ignored) files
  if (s.now - lastUsed(wt) < DAY) return null; // touched in the last day: an agent may have just started there
  const base = baseOf();
  if (!branch)
    return base && run(["git", "merge-base", "--is-ancestor", "HEAD", base], wt).ok
      ? { why: "detached, already in base", auto: true }
      : null;
  const track = run(["git", "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`], repo).out;
  if (track === "[gone]") return { why: "branch deleted on the remote (merged or closed); the branch stays", auto: true };
  if (base && run(["git", "merge-base", "--is-ancestor", branch, base], repo).ok)
    return { why: `nothing beyond ${base.replace("origin/", "")} (merged, or the agent never committed)`, auto: true };
  const pr = s.prState?.(repo, branch) ?? "";
  if (pr === "MERGED" || pr === "CLOSED") return { why: `its pull request was ${pr.toLowerCase()}; the branch stays`, auto: true };
  const unpushed = run(["git", "rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"], repo);
  const age = (s.now / 1000 - Number(run(["git", "log", "-1", "--format=%ct", branch], repo).out)) / 86400;
  const days = s.cfg.cleanup.categories.worktrees.staleDays;
  if (unpushed.ok && unpushed.out === "0" && age > days) return { why: `idle ${Math.floor(age)} days, everything pushed`, auto: false };
  return null;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Ignored folders and files that come back by themselves: dependencies, build output, test artifacts. */
const REGROWS_IGNORED = new Set([...buildDirs(), ...REGROWS, ".DS_Store", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache"]);

/**
 * The git-ignored files and folders in `dir` that don't regrow (anything with no regrowable folder in its path), from
 * `git ls-files -o -i --exclude-standard --directory`; `env` points git at a folder that lost its own git folder.
 */
export function ignoredKept(dir: string, env?: Record<string, string>): string[] {
  const r = run(["git", "ls-files", "-o", "-i", "--exclude-standard", "--directory"], dir, 60_000, env);
  if (!r.ok) return ["(git couldn't list its ignored files)"];
  return r.out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.split("/").some((part) => REGROWS_IGNORED.has(part)));
}
const keptWhy = (kept: string[]) =>
  `holds git-ignored files such as ${kept
    .slice(0, 3)
    .map((p) => p.replace(/\/$/, ""))
    .join(", ")}, lost for good if it goes`;

/**
 * Whether a folder's files are in a commit, without its own git folder: its files (minus what's ignored) hashed into a
 * throwaway index and object store beside the repo's, and that tree looked for among every commit. "pushed" = a
 * commit on a remote has exactly these files; "local" = only a local commit has them; "uncommitted" = none does.
 */
export function committedState(
  repo: string,
  dir: string,
): { state: "pushed" | "local" | "uncommitted" | "ignored-files" | "unknown"; kept: string[] } {
  const gitDir = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], repo).out;
  if (!gitDir) return { state: "unknown", kept: [] };
  const scratch = mkdtempSync(join(tmpdir(), "overhand-orphan-"));
  try {
    const env = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: dir,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
    };
    mkdirSync(env.GIT_OBJECT_DIRECTORY);
    if (!run(["git", "add", "-A"], dir, 120_000, env).ok) return { state: "unknown", kept: [] };
    const tree = run(["git", "write-tree"], dir, 30_000, env).out;
    if (!tree) return { state: "unknown", kept: [] };
    // the hash leaves out what git ignores: anything ignored that doesn't regrow (.env.local, a dev database) is yours
    const kept = ignoredKept(dir, env);
    if (kept.length) return { state: "ignored-files", kept };
    // nothing at all to compare: never "pushed", whatever empty commit a remote has
    if (tree === EMPTY_TREE) return { state: "uncommitted", kept };
    const trees = (refs: string) => run(["git", "log", refs, "--format=%T"], repo, 60_000).out.split("\n");
    if (trees("--remotes").includes(tree)) return { state: "pushed", kept };
    return { state: trees("--all").includes(tree) ? "local" : "uncommitted", kept };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Folders in a repo's worktree folder (.claude/worktrees) that `git worktree list` doesn't know: removed, their admin
 * folder pruned, or their `.git` pointing at nothing. Each is first compared with every commit: one whose files a
 * pushed commit has can go (unattended when it's a week old); one with unpushed or uncommitted work says so and waits
 * for you, uncommitted work only with your confirmation.
 */
function orphans(repo: string, known: string[], s: Scope): CleanupItem[] {
  const src = source("orphan-worktrees");
  const knownAt = new Set(known.map(real));
  return (src.dirs ?? []).flatMap((d) =>
    entries(join(repo, d)).flatMap((dir) => {
      // a dot folder there is a tool's state (.omc), not a worktree
      if (basename(dir).startsWith(".") || !lstat(dir)?.isDirectory() || knownAt.has(real(dir)) || under(real(dir), real(s.src))) return [];
      const dotGit = lstat(join(dir, ".git"));
      if (dotGit?.isDirectory()) return []; // a clone of its own, not a worktree
      const pointsAt = dotGit?.isFile() ? gitDirOf(dir) : "";
      if (pointsAt && existsSync(pointsAt)) return []; // git knows it, from another repo
      if (inUse(dir, s)) return [];
      const used = newest(dir, 1);
      const age = days(s, used);
      const { state, kept } = committedState(repo, dir);
      const base = { ...ofSource(src, "dir", dir, ""), repo, usedAt: used };
      if (state === "ignored-files")
        return [{ ...base, why: `${src.what}; it ${keptWhy(kept)}`, checked: false, auto: false, personal: true }];
      if (state === "pushed")
        return [{ ...base, why: `${src.what}; its files match a pushed commit, nothing uncommitted`, auto: age >= 7 }];
      if (state === "local")
        return [{ ...base, why: `${src.what}; its files match a commit not pushed yet (the commit stays in the repo)`, checked: false }];
      if (state === "uncommitted")
        return [{ ...base, why: `${src.what}; it holds changes in no commit, lost for good if it goes`, checked: false, personal: true }];
      return [];
    }),
  );
}

function scanWorktrees(s: Scope): CleanupItem[] {
  const items: CleanupItem[] = [];
  for (const repo of projectRepos(s)) {
    const own = personalRepo(repo, s);
    let base: { at: string | undefined } | null = null;
    const baseOf = () => {
      base ??= {
        at: ["origin/develop", "origin/main", "origin/master"].find((b) => run(["git", "rev-parse", "-q", "--verify", b], repo).ok),
      };
      return base.at;
    };
    const blocks = run(["git", "worktree", "list", "--porcelain"], repo).out.split("\n\n");
    const known = blocks.map((b) => b.match(/^worktree (.+)$/m)?.[1] ?? "").filter(Boolean);
    items.push(...orphans(repo, known, s).map((it) => (own ? mine(it, repo) : it)));
    // the first block is the main checkout, which is never proposed
    for (const block of blocks.slice(1)) {
      const wt = block.match(/^worktree (.+)$/m)?.[1];
      if (!wt || under(real(wt), real(s.src)) || /^locked/m.test(block)) continue;
      const v = worktreeVerdict(repo, wt, block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "", baseOf, s);
      // `git worktree remove` takes ignored files too: any that don't regrow make it yours to confirm
      const kept = v && existsSync(wt) ? ignoredKept(wt) : [];
      const found = v
        ? [
            {
              ...item("worktrees", "worktree", wt, kept.length ? `${v.why}; ${keptWhy(kept)}` : v.why, v.auto && !kept.length),
              repo,
              usedAt: existsSync(wt) ? lastUsed(wt) : undefined,
              ...(kept.length ? { checked: false, personal: true } : {}),
            },
          ]
        : regrowable(repo, wt, s);
      items.push(...found.map((it) => (own ? mine(it, repo) : it)));
    }
  }
  return items;
}

/** A remote URL in one form for every protocol: host/owner/name, lower case (git@h:o/n.git and https://h/o/n match). */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Second full clones of a remote already cloned elsewhere under the Code root or the projects folder: listed for you to
 * confirm one by one, never ticked or unattended. A clone a configured project uses is kept, else the latest used; only
 * a clone with no uncommitted or unpushed work, no stash and no worktrees of its own is proposed. One clone with
 * worktrees for parallel work costs a fraction of the disk.
 */
function scanClones(s: Scope): CleanupItem[] {
  const repos = [
    ...new Set(
      [s.code, s.projects]
        .filter((r): r is string => !!r && existsSync(r))
        .flatMap(gitRepos)
        .map(real),
    ),
  ];
  const groups = new Map<string, string[]>();
  for (const repo of repos) {
    const url = run(["git", "remote", "get-url", "origin"], repo);
    if (url.ok && url.out) groups.set(remoteKey(url.out), [...(groups.get(remoteKey(url.out)) ?? []), repo]);
  }
  const projectDirs = s.cfg.clients.map((c) => real(join(s.code, c.dir)));
  const used = (repo: string) => projectTouched(repo) || mtime(join(repo, ".git", "index"));
  const items: CleanupItem[] = [];
  for (const [remote, clones] of groups) {
    if (clones.length < 2) continue;
    const ranked = [...clones].sort(
      (a, b) => Number(projectDirs.some((d) => under(b, d))) - Number(projectDirs.some((d) => under(a, d))) || used(b) - used(a),
    );
    const keep = ranked[0] ?? "";
    for (const repo of ranked.slice(1)) {
      if (projectDirs.some((d) => under(repo, d)) || under(repo, real(s.src)) || inUse(repo, s)) continue;
      const clean =
        run(["git", "status", "--porcelain"], repo).out === "" &&
        run(["git", "rev-list", "--count", "--branches", "--not", "--remotes"], repo).out === "0" &&
        run(["git", "stash", "list"], repo).out === "" &&
        run(["git", "worktree", "list", "--porcelain"], repo).out.split("\n\n").filter(Boolean).length === 1;
      if (!clean) continue;
      const it = {
        ...item("clones", "dir", repo, `a second full clone of ${remote} (also at ${keep}); clean and fully pushed`),
        repo,
        keep,
        usedAt: used(repo),
      };
      items.push(mine(it, keep));
    }
  }
  return items;
}

/** Simulator runtimes Xcode can delete, beyond the newest per platform, from `xcrun simctl runtime list -j`. */
export function oldRuntimes(json: string): { id: string; name: string; kb: number; usedAt: number }[] {
  let all: {
    identifier?: string;
    version?: string;
    platformIdentifier?: string;
    sizeBytes?: number;
    deletable?: boolean;
    lastUsedAt?: string;
  }[];
  try {
    all = Object.values(JSON.parse(json) as Record<string, (typeof all)[number]>);
  } catch {
    return [];
  }
  const newest = new Map<string, string>();
  const cmp = (a = "", b = "") => a.localeCompare(b, undefined, { numeric: true });
  for (const r of all)
    if (cmp(r.version, newest.get(r.platformIdentifier ?? "")) > 0) newest.set(r.platformIdentifier ?? "", r.version ?? "");
  return all
    .filter((r) => r.deletable && r.identifier && r.version !== newest.get(r.platformIdentifier ?? ""))
    .map((r) => ({
      id: r.identifier ?? "",
      name: `${(r.platformIdentifier ?? "").replace(/^com\.apple\.platform\./, "")} ${r.version ?? ""}`,
      kb: Math.round((r.sizeBytes ?? 0) / 1024),
      usedAt: Date.parse(r.lastUsedAt ?? "") || 0,
    }));
}

const platformOf = (s: Scope) => s.platform ?? process.platform;
/**
 * A source's places on this machine: each plain path that is a folder, and for a `*` pattern every entry matching it
 * (`pattern` then names each entry as one item). Links are never followed.
 */
function sourcePaths(src: Source, s: Scope): { p: string; pattern: boolean }[] {
  return pathsOn(src, platformOf(s)).flatMap((raw): { p: string; pattern: boolean }[] => {
    const p = expand(raw, s.home, s.tmp);
    if (!p) return [];
    if (!p.endsWith("*")) return lstat(p)?.isDirectory() ? [{ p, pattern: false }] : [];
    const prefix = basename(p).slice(0, -1);
    return entries(dirname(p))
      .filter((e) => basename(e).startsWith(prefix) && !lstat(e)?.isSymbolicLink())
      .map((e) => ({ p: e, pattern: true }));
  });
}
const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f !== ".DS_Store")
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
};
const ofSource = (src: Source, kind: CleanupItem["kind"], path: string, why: string, auto = false): CleanupItem => ({
  ...item(src.category, kind, path, why, auto),
  source: src.id,
});

/** Within a folder of versioned downloads (`chromium-1187`, `mac_arm-131.0.6778.85`), all but the newest of each name. */
export function olderVersions(names: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const m = n.match(/^(.*?)[-_]v?(\d[\w.]*)$/);
    if (m) groups.set(m[1] ?? "", [...(groups.get(m[1] ?? "") ?? []), n]);
  }
  return [...groups.values()].flatMap((g) => g.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(1));
}
const olderIn = (dir: string) => olderVersions(entries(dir).map((e) => basename(e))).map((n) => join(dir, n));

/**
 * The builds a still-installed Playwright pins: each `.links` entry names an install's playwright-core folder, whose
 * browsers.json lists the revisions it launches (folders like `chromium_headless_shell-1243`). Playwright's own
 * install keeps exactly these; an install whose folder is gone pins nothing.
 */
export function pinnedBuilds(dir: string): Set<string> {
  const pinned = new Set<string>();
  for (const link of entries(join(dir, ".links"))) {
    try {
      const browsers = JSON.parse(readFileSync(join(readFileSync(link, "utf8").trim(), "browsers.json"), "utf8")) as {
        browsers?: { name?: unknown; revision?: unknown; revisionOverrides?: Record<string, unknown> }[];
      };
      for (const b of browsers.browsers ?? []) {
        if (typeof b.name !== "string") continue;
        for (const r of [b.revision, ...Object.values(b.revisionOverrides ?? {})])
          if (typeof r === "string") pinned.add(`${b.name.replaceAll("-", "_")}-${r}`);
      }
    } catch {
      // an install that's gone, or a file that isn't one
    }
  }
  return pinned;
}

/**
 * What the sources of one category propose: a cache's contents (unattended only when its tool isn't running and it's
 * a day old), every entry of an `each` source unused long enough, and older versions of versioned downloads. History
 * is yours: never ticked, never unattended, removed only when you confirm it.
 */
function scanSources(category: CleanupCategory, s: Scope): CleanupItem[] {
  const mine = SOURCES.filter((src) => src.category === category && src.type !== "rule" && !src.links && !src.packages);
  return mine.flatMap((src) => {
    const busy = running(src, s);
    const minDays = src.days ?? (src.each ? 1 : 0);
    const one = (p: string, kind: CleanupItem["kind"]): CleanupItem[] => {
      if (kind === "contents" && !entries(p).length) return [];
      const used = newest(p, src.type === "record" ? 2 : 1);
      const age = days(s, used);
      if (age < minDays || inUse(p, s)) return [];
      const why = `${src.what}; ${src.type === "record" ? `unused ${age} days; ` : ""}${src.back}${busy ? " (it's running now)" : ""}`;
      const it = { ...ofSource(src, kind, p, why, src.type === "cache" && !busy && age >= 1), usedAt: used };
      if (src.type === "record") return [{ ...it, checked: false, personal: true }];
      return [{ ...it, checked: src.type === "cache" || !!src.old || !!src.each }];
    };
    // a tool's cache folder in the temp folder goes by its contents; anything else listed one by one goes whole
    const kindOf = (e: string): CleanupItem["kind"] => (src.id === "tmp-tool-caches" && lstat(e)?.isDirectory() ? "contents" : "dir");
    return sourcePaths(src, s).flatMap(({ p, pattern }) => {
      if (src.old) {
        // Playwright keeps versions side by side; Puppeteer keeps a folder per browser, each holding its versions
        const inner = olderIn(p).length ? [p] : entries(p).filter((e) => lstat(e)?.isDirectory());
        const pinned = pinnedBuilds(p);
        return inner
          .flatMap(olderIn)
          .filter((e) => !pinned.has(basename(e)))
          .flatMap((e) => one(e, "dir"));
      }
      if (pattern) return one(p, kindOf(p));
      if (src.each) return entries(p).flatMap((e) => one(e, kindOf(e)));
      return one(p, "contents");
    });
  });
}

/** VS Code and the editors built on it list the extension versions they replaced in `.obsolete`, and drop them on a restart. */
function obsoleteExtensions(src: Source, s: Scope): CleanupItem[] {
  const busy = running(src, s);
  return sourcePaths(src, s).flatMap(({ p: dir }) => {
    let names: string[] = [];
    try {
      names = Object.keys(JSON.parse(readFileSync(join(dir, ".obsolete"), "utf8")) as Record<string, unknown>);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^[\w][\w.-]*$/.test(n) && lstat(join(dir, n))?.isDirectory()) // no ".", "..", "/" or flags
      .map((n) => ({ ...ofSource(src, "dir", join(dir, n), `${src.what}; ${src.back}`, !busy), usedAt: newest(join(dir, n), 0) }));
  });
}

function scanVersions(s: Scope): CleanupItem[] {
  const keep = s.cfg.cleanup.categories.versions.keep;
  const agents = SOURCES.filter((src) => src.category === "versions" && src.links).flatMap((src) =>
    sourcePaths(src, s).flatMap(({ p: root }) => {
      const live = (src.links ?? [])
        .map((l) => expand(l, s.home))
        .filter((l) => existsSync(l))
        .map(real);
      const sorted = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      return sorted
        .slice(keep)
        .map((v) => join(root, v))
        .filter((p) => !live.some((l) => under(l, real(p))))
        .map((p) => ofSource(src, "dir", p, `${src.tool}: older than the newest ${keep}, not the one in use`, true));
    }),
  );
  const editors = SOURCES.filter((src) => src.category === "versions" && !src.links).flatMap((src) => obsoleteExtensions(src, s));
  return [...agents, ...editors];
}

function scanCaches(s: Scope): CleanupItem[] {
  const c = s.cfg.cleanup.categories.caches;
  const known = scanSources("caches", s);
  const covered = new Set(SOURCES.flatMap((src) => sourcePaths(src, s)).map((x) => real(x.p)));
  // your own paths, and older configs that listed the known ones: each known path once, by its source's rules
  const yours = c.paths.flatMap((raw) => {
    const p = expand(raw, s.home);
    if (covered.has(real(p)) || !existsSync(p) || !statSync(p).isDirectory() || !readdirSync(p).length) return [];
    return [item("caches", "contents", p, "rebuilds itself on next use; contents only", true)];
  });
  const cmds = c.commands
    .filter((cmd) => s.which(cmd.split(/\s+/)[0] ?? ""))
    .map((cmd) => ({
      ...item("caches", "command", cmd, "the tool's own cleanup", true),
      source: SOURCES.find((src) => src.cmd === cmd)?.id,
    }));
  return [...known, ...yours, ...cmds, ...scanRunCaches(s)];
}

/**
 * The projects with an agent run, or a check the daemon runs in their files, live now: Overhand's record of its runs
 * (control/runs.json) and its running checks (control/checks/<project key>.<pid>.<at>), whose process is alive.
 */
export function liveProjects(ops: string): Set<string> {
  const alive = (pid: number) => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  const checks = entries(join(ops, "control", "checks")).flatMap((f) => {
    const [key = "", pid = ""] = basename(f).split(".");
    return key && alive(Number(pid)) ? [key] : [];
  });
  return new Set([...checks, ...liveRuns(ops, alive)]);
}

/** The project keys of agent runs Overhand recorded whose process is alive (control/runs.json). */
function liveRuns(ops: string, alive: (pid: number) => boolean): string[] {
  try {
    const runs = JSON.parse(readFileSync(join(ops, "control", "runs.json"), "utf8")) as Record<string, { project?: string; run?: string }>;
    return Object.entries(runs).flatMap(([pid, r]) => {
      if (!alive(Number(pid))) return [];
      // a run's cache is its project's, or its own name's when it had no project (sandbox.ts projectCache)
      return [r.project, r.run].filter((x): x is string => !!x).map(runCacheKey);
    });
  } catch {
    return [];
  }
}

/**
 * Each project's sandboxed agent-run caches (RUN_CACHES): proposed, and unattended allowed, when the project is gone,
 * has had no run in RUN_CACHE_DAYS days or holds more than RUN_CACHE_MAX_GB; never while one of its runs is live or a
 * program is in it. ponytail: the folder's newest write stands for its last run, since runs fill their caches; a run
 * can keep its project's cache looking fresh that way, and the size cap still bounds it.
 */
export function scanRunCaches(s: Scope, live = liveProjects(s.ops), maxKb = RUN_CACHE_MAX_GB * 1024 * 1024): CleanupItem[] {
  const src = source("overhand-run-caches");
  const projects = new Set(s.cfg.clients.map((c) => runCacheKey(c.name)));
  return entries(join(s.ops, RUN_CACHES)).flatMap((p) => {
    const key = basename(p);
    if (!lstat(p)?.isDirectory() || live.has(key) || inUse(p, s)) return [];
    const idle = days(s, newest(p, 2));
    const kb = du(p);
    const why = !projects.has(key)
      ? "its project is no longer one of Overhand's"
      : idle >= RUN_CACHE_DAYS
        ? `no run in ${idle} days`
        : kb > maxKb
          ? `over ${RUN_CACHE_MAX_GB} GB`
          : "";
    return why ? [{ ...ofSource(src, "dir", p, `${src.tool}: ${key}'s agent-run caches; ${why}; ${src.back}`, true), kb }] : [];
  });
}

/** When a project was last worked on: its last commit or its index, whichever is newer; 0 when it has no commit yet. */
function projectTouched(repo: string): number {
  const log = run(["git", "log", "-1", "--format=%ct"], repo);
  return log.ok && log.out ? Math.max(Number(log.out) * 1000, mtime(join(repo, ".git", "index"))) : 0;
}

/** True when a folder between repo and dir (exclusive) is its own repo or worktree, so dir isn't this repo's to judge. */
const nested = (repo: string, dir: string): boolean => {
  for (let d = dirname(dir); d !== repo && under(d, repo); d = dirname(d)) if (existsSync(join(d, ".git"))) return true;
  return false;
};

function scanBuilds(s: Scope): CleanupItem[] {
  const b = s.cfg.cleanup.categories.builds;
  const items: CleanupItem[] = [];
  for (const repo of gitRepos(s.code)) {
    if (under(real(repo), real(s.src)) || inUse(repo, s) || refusePath(repo, s, true)) continue;
    const own = personalRepo(repo, s);
    const touched = projectTouched(repo);
    const idle = Math.floor((s.now - touched) / DAY);
    if (!touched || idle < b.idleDays) continue; // no commit yet: can't tell how idle it is, so keep it
    const names = b.dirs.flatMap((d, i) => (i ? ["-o", "-name", d] : ["-name", d]));
    const found = run([
      "find",
      repo,
      "-maxdepth",
      "3",
      "-path",
      "*/.git",
      "-prune",
      "-o",
      "-type",
      "d",
      "(",
      ...names,
      ")",
      "-prune",
      "-print",
    ]);
    for (const dir of found.out.split("\n").filter(Boolean)) {
      const rel = relative(repo, dir);
      if (nested(repo, dir)) continue; // a nested repo or worktree is judged on its own
      // only what git ignores and tracks nothing in: a committed dist/ or build/ is source, not output
      if (!run(["git", "check-ignore", "-q", rel], repo).ok || run(["git", "ls-files", "--", rel], repo).out) continue;
      if (refusePath(dir, s) || inUse(dir, s)) continue;
      const src = SOURCES.find((x) => x.category === "builds" && x.dirs?.includes(basename(dir))) ?? source("project-builds");
      const it = ofSource(src, "dir", dir, `${src.what}; project idle ${idle} days; ${src.back}`);
      items.push(own ? mine(it, repo) : it);
    }
  }
  return items;
}

/** Bytes in a size Docker prints ("1.2GB", "300kB"): Docker's units are decimal. */
export function dockerBytes(text: string): number {
  const m = text.match(/([\d.]+)\s*([kMGT]?B)\b/);
  return Number(m?.[1] ?? 0) * ({ B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m?.[2] ?? "B"] ?? 0);
}

/**
 * Docker's own prunes, each sized by what it really frees, from `docker system df -v`: stopped containers' own layers,
 * and the unique size of dangling images nothing uses. Build cache and volumes prune less than df counts as
 * reclaimable (shared and named ones stay), so their size is unknown (0) rather than a guess.
 */
function scanDocker(s: Scope): CleanupItem[] {
  const docker = s.which("docker");
  if (!docker || !run([docker, "info", "--format", "{{.ID}}"], undefined, 8000).ok) return [];
  let df: {
    Images?: { Repository?: string; Tag?: string; Containers?: string | number; UniqueSize?: string }[];
    Containers?: { State?: string; Size?: string }[];
  } = {};
  try {
    df = JSON.parse(run([docker, "system", "df", "-v", "--format", "{{json .}}"], undefined, 30_000).out) as typeof df;
  } catch {
    // an older Docker without JSON: every size unknown
  }
  const kb = (bytes: number) => Math.round(bytes / 1024);
  const sized: Record<string, number> = {
    "docker-containers": kb(
      (df.Containers ?? [])
        .filter((c) => !/running|paused|restarting/.test(c.State ?? ""))
        .reduce((n, c) => n + dockerBytes(c.Size ?? ""), 0),
    ),
    "docker-images": kb(
      (df.Images ?? [])
        .filter((i) => i.Repository === "<none>" && i.Tag === "<none>" && Number(i.Containers ?? 0) === 0)
        .reduce((n, i) => n + dockerBytes(i.UniqueSize ?? ""), 0),
    ),
  };
  const ids = [
    "docker-containers",
    "docker-images",
    "docker-build-cache",
    ...(s.cfg.cleanup.categories.docker.volumes ? ["docker-volumes"] : []),
  ];
  return ids.map((id) => {
    const src = source(id);
    return { ...ofSource(src, "command", src.cmd ?? "", `${src.what}; ${src.back}`), kb: sized[id] ?? 0 };
  });
}

function scanSimulators(s: Scope): CleanupItem[] {
  if (!s.which("xcrun")) return [];
  const devices = join(s.home, "Library", "Developer", "CoreSimulator", "Devices");
  const list = run(["xcrun", "simctl", "list", "devices", "unavailable", "-j"], undefined, 30_000);
  let unavailable: string[] = [];
  try {
    const d = JSON.parse(list.out) as { devices?: Record<string, { udid: string }[]> };
    unavailable = Object.values(d.devices ?? {}).flatMap((xs) => xs.map((x) => x.udid));
  } catch {
    return []; // simctl isn't set up (no Xcode)
  }
  const items: CleanupItem[] = [];
  const gone = source("sim-unavailable");
  if (unavailable.length)
    items.push({
      ...ofSource(gone, "command", gone.cmd ?? "", `${unavailable.length} ${gone.what}`),
      kb: unavailable.reduce((n, u) => n + du(join(devices, u)), 0),
    });
  const rt = source("sim-runtimes");
  for (const r of oldRuntimes(run(["xcrun", "simctl", "runtime", "list", "-j"], undefined, 30_000).out))
    items.push({
      ...ofSource(rt, "command", `${rt.cmd} ${r.id}`, `${r.name} simulator runtime; a newer one is installed; ${rt.back}`),
      kb: r.kb,
      checked: false,
      usedAt: r.usedAt || undefined,
    });
  if (s.cfg.cleanup.categories.simulators.all && existsSync(devices))
    items.push({
      ...ofSource(gone, "command", "xcrun simctl delete all", "every simulator and its apps and data (you turned this on)"),
      kb: du(devices),
    });
  return items;
}

function scanLogs(s: Scope): CleanupItem[] {
  const keep = s.cfg.cleanup.categories.logs.days;
  return ["logs", "runs", "shots", "scratch"].flatMap((dir) => {
    const root = join(s.ops, dir);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .map((f) => join(root, f))
      .filter((p) => s.now - mtime(p) > keep * DAY)
      .map((p) => ofSource(source("overhand-logs"), "dir", p, `older than ${keep} days`, true));
  });
}

/** The in-page voice model older versions downloaded into the state folder (about 28 MB); nothing reads it any more. */
export function dropVoiceModel(ops: string): boolean {
  const voice = join(ops, "voice");
  if (!existsSync(voice) || lstatSync(voice).isSymbolicLink()) return false;
  rmSync(voice, { recursive: true, force: true });
  return true;
}

/** Agents' history the sources list, and Aider's chat logs in your projects: offered unticked once unused 90 days. */
function scanHistory(s: Scope): CleanupItem[] {
  const aider = source("aider-history");
  const inRepos = gitRepos(s.code).flatMap((repo) =>
    (aider.dirs ?? []).flatMap((name) => {
      const f = join(repo, name);
      const st = lstat(f);
      const age = days(s, st?.mtimeMs ?? 0);
      if (!st?.isFile() || age < (aider.days ?? 0)) return [];
      const it = ofSource(aider, "dir", f, `${aider.what}; unused ${age} days; ${aider.back}`);
      return [{ ...it, checked: false, personal: true, usedAt: st.mtimeMs }];
    }),
  );
  return [...scanSources("history", s), ...inRepos];
}

/** An Ollama manifest's layers (digest and size): the model's blobs. */
const layersOf = (file: string): { digest: string; size: number }[] => {
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      config?: { digest: string; size: number };
      layers?: { digest: string; size: number }[];
    };
    return [...(m.config ? [m.config] : []), ...(m.layers ?? [])];
  } catch {
    return [];
  }
};

/**
 * Ollama's models, read from its manifests (so the server needn't run): each one's name, the blobs only it uses (what
 * `ollama rm` frees), and its last use from its files' access times. Removed with `ollama rm`, which needs Ollama running.
 */
function ollamaModels(s: Scope): CleanupItem[] {
  const src = source("ollama-models");
  const ollama = s.which("ollama");
  const root = sourcePaths(src, s)[0]?.p;
  if (!ollama || !root) return [];
  const manifests = run(["find", join(root, "manifests"), "-mindepth", "4", "-maxdepth", "4", "-type", "f"])
    .out.split("\n")
    .filter(Boolean);
  const users = new Map<string, number>();
  const layers = new Map(manifests.map((m) => [m, layersOf(m)]));
  for (const ls of layers.values()) for (const l of ls) users.set(l.digest, (users.get(l.digest) ?? 0) + 1);
  return manifests.flatMap((m) => {
    const [host, ns, model, tag] = relative(join(root, "manifests"), m).split("/");
    const name = `${host === "registry.ollama.ai" ? (ns === "library" ? "" : `${ns}/`) : `${host}/${ns}/`}${model}:${tag}`;
    if (!/^\w[\w.:/-]*$/.test(name)) return []; // never a leading "-": it would be a flag to ollama
    const own = layers.get(m) ?? [];
    const used = Math.max(newest(m, 0), ...own.map((l) => newest(join(root, "blobs", l.digest.replace(":", "-")), 0, true)));
    const age = days(s, used);
    if (age < (src.days ?? 0)) return [];
    const it = ofSource(
      src,
      "command",
      `ollama rm ${name}`,
      `${src.what}; no use in ${age} days (file access times); ${src.back.replace("<name>", name)}`,
    );
    const kb = Math.round(own.filter((l) => users.get(l.digest) === 1).reduce((n, l) => n + l.size, 0) / 1024);
    return [{ ...it, kb, checked: false, personal: true, usedAt: used }];
  });
}

/** Local AI models unused 90 days: Ollama's, LM Studio's (publisher/model folders) and Hugging Face's (one per repo). */
function scanModels(s: Scope): CleanupItem[] {
  const folders = (id: string, depth: number, keep: (name: string) => boolean) => {
    const src = source(id);
    return sourcePaths(src, s).flatMap(({ p }) => {
      const found = depth === 2 ? entries(p).flatMap(entries) : entries(p);
      return found.flatMap((dir) => {
        if (!keep(basename(dir)) || !lstat(dir)?.isDirectory()) return [];
        const used = newest(dir, 2, true);
        const age = days(s, used);
        if (age < (src.days ?? 0)) return [];
        const back = src.back.replace("<model>", basename(dir)).replace("<repo>", basename(dir).split("--").slice(1).join("/"));
        const it = ofSource(src, "dir", dir, `${src.what}; no use in ${age} days (file access times); ${back}`);
        return [{ ...it, checked: false, personal: true, usedAt: used }];
      });
    });
  };
  return [
    ...ollamaModels(s),
    ...folders("lmstudio-models", 2, () => true),
    ...folders("huggingface-models", 1, (n) => /^(models|datasets|spaces)--/.test(n)),
  ];
}

/**
 * Agent CLIs installed globally (npm -g, uv tool, Homebrew) that no Overhand account runs and whose own config shows
 * no use in 90 days. Removed only by the package manager that installed it, as argv.
 */
function scanTools(s: Scope): CleanupItem[] {
  const src = source("unused-agent-clis");
  const used = new Set<string>(s.cfg.accounts.map((a) => s.cfg.runtimes[a]?.kind ?? "claude-code"));
  const ask = (bin: string, ...args: string[]) => {
    const at = s.which(bin);
    return at ? run([at, ...args], undefined, 15_000).out : "";
  };
  const npm = ask("npm", "root", "-g");
  const uv = ask("uv", "tool", "dir");
  const brew = ask("brew", "--prefix");
  return Object.entries(src.packages ?? {}).flatMap(([runtime, pkg]) => {
    if (used.has(runtime)) return [];
    const installs: [string, string][] = [
      [npm && pkg.npm ? join(npm, pkg.npm) : "", `npm uninstall -g ${pkg.npm}`],
      [uv && pkg.uv ? join(uv, pkg.uv) : "", `uv tool uninstall ${pkg.uv}`],
      [brew && pkg.brew ? join(brew, "Cellar", pkg.brew) : "", `brew uninstall ${pkg.brew}`],
      [brew && pkg.cask ? join(brew, "Caskroom", pkg.cask) : "", `brew uninstall --cask ${pkg.cask}`],
    ];
    return installs.flatMap(([dir, cmd]) => {
      if (!dir || !lstat(dir)?.isDirectory()) return [];
      const last = Math.max(...pkg.config.map((c) => newest(expand(c, s.home), 1)), 0) || newest(dir, 0);
      const age = days(s, last);
      if (age < (src.days ?? 0)) return [];
      const name = RUNTIME_NAMES[runtime] ?? runtime;
      const it = ofSource(src, "command", cmd, `${name}: ${src.what}; its config shows no use in ${age} days; ${src.back}`);
      return [{ ...it, kb: du(dir), checked: false, personal: true, usedAt: last }];
    });
  });
}

/** Leftovers in the temp folder: Overhand's own scratch folders and known tools' caches there, a day old. */
const scanTemp = (s: Scope): CleanupItem[] => (s.tmp ? scanSources("temp", s) : []);

const SCANNERS: Record<CleanupCategory, (s: Scope) => CleanupItem[]> = {
  worktrees: scanWorktrees,
  versions: scanVersions,
  caches: scanCaches,
  builds: scanBuilds,
  clones: scanClones,
  history: scanHistory,
  models: scanModels,
  tools: scanTools,
  temp: scanTemp,
  docker: scanDocker,
  simulators: scanSimulators,
  logs: scanLogs,
};

/** Why an item's folder must not go: refusePath with what its category may reach (models, the temp folder, worktrees). */
const refuseItem = (i: CleanupItem, s: Scope): string | null =>
  refusePath(i.path, s, mayBeRepo(i), { models: i.category === "models", tmp: i.category === "temp" ? s.tmp : undefined });

/** What one category proposes right now, minus any folder the safety predicates refuse, whatever the scanner found. */
export const scan = (category: CleanupCategory, s: Scope): CleanupItem[] =>
  SCANNERS[category](s).filter((i) => i.kind === "command" || !(refuseItem(i, s) || inUse(i.path, s)));

/**
 * Items that are git repos by nature: worktrees (removed through git, or a folder git lost), duplicate clones (each one
 * confirmed), and scratch folders in the temp folder (tests make repos there).
 */
const mayBeRepo = (i: CleanupItem): boolean =>
  i.kind === "worktree" || i.category === "clones" || i.category === "temp" || i.source === "orphan-worktrees";

/**
 * Lists what cleanup could remove in every category, with sizes, removing nothing. A category that's off is listed too,
 * so switching it on shows at once what it would do; `checked` is each item's default, whatever its category's switch.
 * A folder's size is what `du` counts, except for sources that share files with what they made (unknown: 0).
 */
export async function planCleanup(s: Scope): Promise<CleanupItem[]> {
  await pool(projectRepos(s), PARALLEL, (repo) => runAsync(["git", "fetch", "--prune", "--quiet"], repo));
  const items = CLEANUP_CATEGORIES.flatMap((c) => scan(c, s));
  const shared = new Set(SOURCES.filter((x) => x.shared).map((x) => x.id));
  await pool(items, PARALLEL, async (it) => {
    if (it.kind !== "command" && !shared.has(it.source ?? "") && existsSync(it.path))
      it.kb = Number((await runAsync(["du", "-sk", it.path])).out.split(/\s/)[0]) || 0;
  });
  return items;
}

const freeKb = (path: string) => {
  const st = statfsSync(path);
  return (st.bavail * st.bsize) / 1024;
};

/**
 * Removes the ticked items whose category is on. Right before each category, it scans that category again; an item the fresh scan no longer
 * proposes (new work, an agent started, switched off, gone) is skipped with why. Worktrees go through git, which also
 * refuses dirty ones, and their branches stay.
 */
export function runCleanup(
  items: CleanupItem[],
  s: Scope,
  refresh: () => Pick<Scope, "busy" | "cwds" | "procs"> = () => s,
  progress: (done: number, total: number) => void = () => {},
  unattended = false,
): CleanupResult {
  const todo = items.filter((i) => i.checked);
  const result: CleanupResult = { removed: 0, freedKb: 0, failed: [], skipped: [] };
  // what df says came free: du overcounts APFS clones and shared blocks, so sizes from the plan aren't summed
  const before = freeKb(s.home);
  let done = 0;
  for (const category of CLEANUP_CATEGORIES) {
    const mine = todo.filter((i) => i.category === category);
    if (!mine.length) continue;
    const fresh = { ...s, ...refresh() };
    const on = s.cfg.cleanup.categories[category].enabled;
    const now = on ? new Map(scan(category, fresh).map((i) => [i.id, i])) : new Map<string, CleanupItem>();
    for (const it of mine) {
      progress(done++, todo.length);
      const again = now.get(it.id);
      let why: string | null = on ? null : "its category is switched off";
      // yours (your own checkout, an agent's history, a model, a CLI, uncommitted work): never in an unattended pass, and
      // otherwise only with your confirmation naming it (the fresh scan decides, so a plan file can't claim it isn't)
      const own = it.personal || again?.personal === true;
      const whose = ownData(again ?? it) ? "it's yours (history, a model, a tool or uncommitted work)" : "it's in your own checkout";
      if (!why && own && unattended) why = `${whose}, which is never cleaned unattended`;
      if (!why && own && it.confirmed !== it.path) why = `${whose} and you didn't confirm removing it`;
      if (!why && it.kind !== "command") why = refuseItem(it, fresh) ?? inUse(it.path, { ...fresh, ...refresh() });
      if (!why && (!again || again.kind !== it.kind || again.repo !== it.repo)) why = "changed since the scan (new work, in use, or gone)";
      // unattended: only what the fresh scan still calls safe to go alone (a tool may have started since)
      if (!why && unattended && !again?.auto) why = "not safe to remove unattended right now";
      if (why) {
        result.skipped.push({ path: it.path, why });
        continue;
      }
      let ok = true;
      if (it.kind === "worktree" && it.repo) {
        ok = !existsSync(it.path) || run(["git", "worktree", "remove", it.path], it.repo).ok;
        run(["git", "worktree", "prune"], it.repo);
      } else if (it.kind === "contents") {
        for (const f of readdirSync(it.path)) rmSync(join(it.path, f), { recursive: true, force: true });
      } else if (it.kind === "command") {
        // fixed commands run as argv; the config's own cache commands may use the shell
        ok = (it.category === "caches" ? run(["sh", "-c", it.path], undefined, 600_000) : run(it.path.split(" "), undefined, 600_000)).ok;
      } else rmSync(it.path, { recursive: true, force: true });
      if (ok) result.removed++;
      else result.failed.push(it.path);
    }
  }
  result.freedKb = Math.max(0, Math.round(freeKb(s.home) - before));
  progress(done, todo.length);
  return result;
}

/** The scope for this machine: the real home, running agents and leads, and every process's working folder. */
export function liveScope(cfg: Config, code: string, ops: string, src: string): Scope {
  return {
    cfg,
    home: homedir(),
    code,
    ops,
    src,
    busy: busyPaths(cfg, code, ops, src),
    cwds: processCwds(),
    procs: processCommands(),
    tmp: tmpdir(),
    now: Date.now(),
    which: (b) => Bun.which(b),
    prState: (repo, branch) =>
      Bun.which("gh") ? run(["gh", "pr", "view", branch, "--json", "state", "-q", ".state"], repo, 15_000).out : "",
    // where Overhand clones (env.ts projectsDirOf; a checkout's is the Code root, already a root here)
    projects: cfg.projectsDir || join(homedir(), "Overhand", "projects"),
  };
}

/**
 * A cleanup pass for the dashboard: `plan` lists what can go, `run` removes the ticked items, `auto` plans and removes
 * only the ticked items safe for an unattended pass. It runs out of process (`overhand cleanup plan|run|auto`, or
 * `bun packages/core/src/cleanup.ts` from a checkout) so the dashboard stays responsive; progress and results land in .cleanup.json.
 */
export async function cleanupJob(mode: string, cfg: Config, code: string, ops: string, src = ops): Promise<CleanupResult | null> {
  const file = join(ops, ".cleanup.json");
  const write = (x: object) => writeFileSync(file, JSON.stringify({ at: Date.now(), ...x }), { mode: 0o600 });
  const s = liveScope(cfg, code, ops, src);
  const refresh = () => ({ busy: busyPaths(cfg, code, ops, src), cwds: processCwds(), procs: processCommands() });
  try {
    if (mode === "plan") {
      write({ status: "planning" });
      write({ status: "ready", items: await planCleanup(s) });
    } else if (mode === "run" || mode === "auto") {
      const auto = mode === "auto";
      if (auto) write({ status: "planning", auto });
      const items = auto
        ? (await planCleanup(s))
            .filter((i) => !i.personal) // your own checkouts aren't even listed in an unattended pass
            .map((i) => ({ ...i, checked: i.checked && i.auto && cfg.cleanup.categories[i.category].enabled }))
        : (JSON.parse(readFileSync(file, "utf8")) as { items: CleanupItem[] }).items;
      const result = runCleanup(
        items,
        s,
        refresh,
        (done, total) => write({ status: "running", auto, items, progress: { done, total } }),
        auto,
      );
      write({ status: "done", auto, items, result });
      return result;
    }
  } catch (e) {
    // otherwise the dashboard shows "planning" until its 30-minute staleness guess
    write({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
  return null;
}

if (import.meta.main) {
  const cfg = loadConfig(OPS); // same state folder as run.ts
  await cleanupJob(process.argv[2] ?? "", cfg, cfg.codeRoot || dirname(OPS), OPS, SRC);
}
