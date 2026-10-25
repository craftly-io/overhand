/**
 * A first win in five minutes: right after setup, Overhand picks one small, safe task in your own repos without asking
 * (a failing check the repo's own scripts report, a patch-level dependency upgrade, a README with no way to run the
 * project, or a test for an untested pure function) and runs an agent on it at once. Detection is local and read-only:
 * it reads files and runs the repo's own check scripts, never an install and never the network. The task is local
 * (first-win.json); the user's tracker is never touched.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { FIRST_WIN_KINDS, type FirstWin, type FirstWinKind, type TaskKind } from "@overhand/contract";
import { activeRepos } from "./agent";
import { assign } from "./assign";
import type { Client } from "./config";
import { CLIENTS, CODE, HOME, LABEL, needsSetup, OPS, sh } from "./env";
import { report } from "./notify";
import { projectSh } from "./sandbox";
import { readJson, writeJsonAtomic } from "./state";
import { createTicket } from "./trackers/index";

/** A task found in a repo: what it's called and what the agent is told about it. */
export interface WinTask {
  kind: TaskKind;
  title: string;
  brief: string;
}

/** The whole search stops by this long after it starts; a script that would run past it is skipped. */
const SEARCH_MS = 30_000;

// ---------- pure checks ----------

/** The repo's package manager, from its lockfile. */
export function packageManager(files: readonly string[]): "bun" | "pnpm" | "yarn" | "npm" {
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

const CHECK_NAMES = /^(?:typecheck|type-check|check-types|types|tsc|lint|lint:[\w:-]+|eslint|biome)$/;
/** Anything that writes, installs or reaches out: such a script isn't run during the search. */
const UNSAFE = /--fix\b|--write\b|\s-w\b|--apply\b|\bformat\b|\b(?:install|add|publish|deploy|push|upload|curl|wget)\b|[>|]/;

/** The repo's own read-only check scripts worth running, type checks first: none that fix, write or install. */
export function checkScripts(scripts: Readonly<Record<string, string>>): string[] {
  const safe = Object.entries(scripts).filter(
    ([name, cmd]) => CHECK_NAMES.test(name) && !UNSAFE.test(cmd) && !(/\btsc\b/.test(cmd) && !/--noEmit\b/.test(cmd)),
  );
  return safe.map(([name]) => name).sort((a, b) => Number(/^lint|eslint|biome/.test(a)) - Number(/^lint|eslint|biome/.test(b)));
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * A dependency with a newer patch release known on this machine: same major and minor, a higher patch, no prerelease,
 * declared as an exact, `^` or `~` version. `installed` and `known` look versions up; the highest patch wins.
 */
export function patchUpgrade(
  deps: Readonly<Record<string, string>>,
  installed: (name: string) => string | null,
  known: (name: string) => readonly string[],
): { name: string; from: string; to: string } | null {
  for (const [name, range] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[\^~]?\d+\.\d+\.\d+$/.test(range)) continue; // workspace:, file:, git, tags and wide ranges are left alone
    const from = installed(name) ?? range.replace(/^[\^~]/, "");
    const f = SEMVER.exec(from);
    if (!f) continue;
    const best = known(name)
      .map((v) => ({ v, m: SEMVER.exec(v) }))
      .filter(({ m }) => m && m[1] === f[1] && m[2] === f[2] && Number(m[3]) > Number(f[3]))
      .sort((a, b) => Number(b.m?.[3]) - Number(a.m?.[3]))[0];
    if (best) return { name, from, to: best.v };
  }
  return null;
}

/** What a README lacks: there's none, it's a placeholder, or it never says how to install or run the project. */
export function readmeGap(text: string | null): "missing" | "placeholder" | "no-run" | null {
  if (text === null) return "missing";
  const body = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (body.length < 80 || /lorem ipsum|\bTODO\b|coming soon|write something here/i.test(text)) return "placeholder";
  const headings = text.split("\n").filter((l) => /^\s*#/.test(l));
  const how = /install|setup|set up|getting started|usage|running|run\b|develop|quick ?start|build|local/i;
  return headings.some((h) => how.test(h)) ? null : "no-run";
}

const IMPURE =
  /\b(?:await|async|fetch|process|document|window|localStorage|sessionStorage|console|require|import|this|Date|Math\.random|readFileSync|writeFileSync|setTimeout|setInterval|Promise|throw)\b/;

/**
 * The first exported function, by path, that looks pure (takes arguments, returns, short, touches no I/O, time or
 * randomness) and that no test file mentions. A regex read, not a parser: it only needs to find one good candidate.
 */
export function untestedPure(sources: readonly { path: string; text: string }[], tests: string): { name: string; path: string } | null {
  for (const s of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const m of s.text.matchAll(/^export function (\w+)(?:<[^>]*>)?\(([^)]*)\)[^{\n]*\{\n([\s\S]*?)\n\}/gm)) {
      const [, name = "", params = "", body = ""] = m;
      if (!params.trim() || !/\breturn\b/.test(body) || body.split("\n").length > 12 || IMPURE.test(body)) continue;
      if (new RegExp(`\\b${name}\\b`).test(tests)) continue;
      return { name, path: s.path };
    }
  }
  return null;
}

// ---------- reading a repo ----------

const readText = (p: string): string | null => {
  try {
    return statSync(p).size < 512 * 1024 ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
};

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const readPkg = (repo: string): Pkg | null => {
  const t = readText(join(repo, "package.json"));
  try {
    return t ? (JSON.parse(t) as Pkg) : null;
  } catch {
    return null;
  }
};

/** Source and test files under src/ or lib/ (else the root), up to 400, without dependencies or builds. */
function codeFiles(repo: string): { sources: { path: string; text: string }[]; tests: string } {
  const roots = ["src", "lib"].map((d) => join(repo, d)).filter(existsSync);
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (files.length >= 400 || depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", "vendor"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(?:[cm]?[jt]s)$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(p);
    }
  };
  for (const r of roots.length ? roots : [repo]) walk(r, roots.length ? 0 : 5);
  // the tests: next to the code, or in a test folder at the root
  for (const d of ["test", "tests", "__tests__"]) if (existsSync(join(repo, d))) walk(join(repo, d), 0);
  const isTest = (p: string) => /\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)(?:__tests__|tests?)\//.test(relative(repo, p));
  return {
    sources: files
      .filter((p) => !isTest(p))
      .flatMap((p) => ((t) => (t === null ? [] : [{ path: relative(repo, p), text: t }]))(readText(p))),
    tests: files
      .filter(isTest)
      .map((p) => readText(p) ?? "")
      .join("\n"),
  };
}

/** Bun's package cache: the versions this machine has already downloaded, by package. */
const BUN_CACHE = process.env.BUN_INSTALL_CACHE_DIR ?? join(HOME, ".bun", "install", "cache");

/** Versions of a package in a Bun cache folder (`name@1.2.3@@@1`, scoped ones in `@scope/`). */
export function cachedVersions(cache: string, name: string): string[] {
  const [scope, base] = name.startsWith("@") ? [name.split("/")[0] ?? "", name.split("/")[1] ?? ""] : ["", name];
  let entries: string[];
  try {
    entries = readdirSync(scope ? join(cache, scope) : cache);
  } catch {
    return [];
  }
  return entries.filter((e) => e.startsWith(`${base}@`)).map((e) => e.slice(base.length + 1).split("@")[0] ?? "");
}

/**
 * One kind of task in one repo, or null. `until` is the search's deadline: the check scripts get what's left of it.
 * ponytail: JavaScript repos only for checks, upgrades and tests (package.json); any repo for the README.
 */
export async function findTask(repo: string, kind: FirstWinKind, until: number, cache = BUN_CACHE): Promise<WinTask | null> {
  const pkg = readPkg(repo);
  const name = basename(repo);
  if (kind === "readme") {
    const file = readdirSync(repo).find((f) => /^readme(?:\.md|\.markdown|\.txt)?$/i.test(f));
    const gap = readmeGap(file ? readText(join(repo, file)) : null);
    if (!gap) return null;
    const title =
      gap === "missing"
        ? "Add a README with how to install and run it"
        : gap === "placeholder"
          ? "Replace the placeholder README with how to install and run it"
          : "Add install and run steps to the README";
    return {
      kind,
      title,
      brief: `${name}'s README ${gap === "missing" ? "doesn't exist" : gap === "placeholder" ? "is a placeholder" : "never says how to install or run it"}. Write those steps from what the repo actually uses (its package manager, scripts, env files); keep the rest of the README as it is.`,
    };
  }
  if (!pkg) return null;
  const files = readdirSync(repo);
  const pm = packageManager(files);
  const deps = existsSync(join(repo, "node_modules"));
  if (kind === "lint") {
    if (!deps || !Bun.which(pm)) return null; // installing would mean the network
    for (const script of checkScripts(pkg.scripts ?? {})) {
      const left = until - Date.now();
      if (left < 2_000) return null;
      // the project's own script: under its sandbox when that's on
      const r = await projectSh([pm, "run", script], repo, Math.min(20_000, left));
      if (r.ok || /timed out/.test(r.err)) continue;
      const out = [r.out, r.err].join("\n").trim().split("\n").slice(-60).join("\n");
      return {
        kind,
        title: `Make \`${pm} run ${script}\` pass`,
        brief: `\`${pm} run ${script}\` fails in ${name}. Fix the code so it passes, without turning rules off or loosening the config. Its output ended with:\n\n\`\`\`\n${out}\n\`\`\``,
      };
    }
    return null;
  }
  if (kind === "dependency") {
    if (!deps) return null;
    const installed = (dep: string) => {
      const t = readText(join(repo, "node_modules", dep, "package.json"));
      try {
        return t ? ((JSON.parse(t) as { version?: string }).version ?? null) : null;
      } catch {
        return null;
      }
    };
    const up = patchUpgrade({ ...pkg.devDependencies, ...pkg.dependencies }, installed, (dep) => cachedVersions(cache, dep));
    if (!up) return null;
    return {
      kind,
      title: `Upgrade ${up.name} from ${up.from} to ${up.to}`,
      brief: `${up.name} ${up.to} is a patch release over the ${up.from} ${name} uses. Upgrade it with ${pm}, update the lockfile, and run the repo's checks and tests. If anything breaks, don't work around it: report it.`,
    };
  }
  const runner = pkg.scripts?.test;
  if (!runner || /no test specified/.test(runner)) return null;
  const { sources, tests } = codeFiles(repo);
  const fn = untestedPure(sources, tests);
  if (!fn) return null;
  return {
    kind,
    title: `Add a test for ${fn.name}`,
    brief: `\`${fn.name}\` in ${fn.path} has no test. Add a small one next to the repo's other tests, in its style and runner (\`${pm} run test\`), covering a normal case and an edge case. Don't change the function.`,
  };
}

/** The first task in kind order (checks, upgrades, README, tests), each kind tried across the repos before the next. */
export async function findFirstWin(
  repos: readonly string[],
  until = Date.now() + SEARCH_MS,
  cache = BUN_CACHE,
): Promise<{ repo: string; task: WinTask } | null> {
  for (const kind of FIRST_WIN_KINDS)
    for (const repo of repos) {
      if (Date.now() > until) return null;
      const task = await findTask(repo, kind, until, cache).catch(() => null);
      if (task) return { repo, task };
    }
  return null;
}

// ---------- the first win's state ----------

const FILE = join(OPS, "first-win.json");

/** first-win.json: what the dashboard shows, plus where the repo is and what the agent is told (never shown). */
export interface StoredWin extends FirstWin {
  repoPath: string;
  brief: string;
}

/** The stored first win, or null before setup ran it. */
export const loadWin = (): StoredWin | null => readJson<StoredWin | null>(FILE, null);
/** Saves the first win atomically. */
export const saveWin = (w: StoredWin): void => writeJsonAtomic(FILE, w);

/** When this daemon started: a first win still "running" from before then was stranded by a restart. */
const STARTED = Date.now();
/** The first win is one to run now: queued, or left running by an Overhand that has since restarted. */
export const winToRun = (w: { state: StoredWin["state"]; at: number } | null, started = STARTED): boolean =>
  w?.state === "queued" || (w?.state === "running" && w.at < started);

/** How long a finished first win stays on Now. */
const SHOW_MS = 3 * 864e5;

/** The first win as the dashboard shows it: while it's under way, and for three days after. */
export function firstWinState(now = Date.now()): FirstWin | null {
  const w = loadWin();
  if (!w) return null;
  if (!["looking", "queued", "running"].includes(w.state) && now - w.at > SHOW_MS) return null;
  const { repoPath: _, brief: __, ...shown } = w;
  return shown;
}

/**
 * Runs once, right after setup: searches the projects' active repos (most recently committed first, five at most) for
 * a first win and queues it for the next work pass, which starts it at once. Never throws.
 */
export async function startFirstWin(now = Date.now()): Promise<void> {
  if (loadWin()) return; // once per install
  const blank: StoredWin = {
    state: "looking",
    kind: null,
    title: "",
    project: "",
    repo: "",
    key: "",
    url: "",
    message: "",
    at: now,
    repoPath: "",
    brief: "",
  };
  saveWin(blank);
  try {
    // a task you picked from the check-up during setup goes first, when its repo is one of the projects'
    const pick = loadPick();
    const picked = pick ? clientOfRepo(pick.repoPath) : undefined;
    if (pick && picked) {
      queueWin(picked, pick.repoPath, pick.task);
      return;
    }
    const repos = CLIENTS.flatMap((c) => activeRepos(c).map((path) => ({ c, path })))
      .map((r) => ({ ...r, last: Number(sh(["git", "log", "-1", "--format=%ct"], r.path, 10_000).out) || 0 }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 5);
    const found = await findFirstWin(repos.map((r) => r.path));
    const c = repos.find((r) => r.path === found?.repo)?.c;
    if (!found || !c) {
      saveWin({ ...blank, state: "none", at: Date.now() });
      report("🌱 first win: nothing small and safe found; arm a real ticket");
      return;
    }
    queueWin(c, found.repo, found.task);
  } catch (e) {
    saveWin({ ...blank, state: "none", message: e instanceof Error ? e.message : String(e), at: Date.now() });
  }
}

/** Queues a task as the first win (key PREFIX-0, local, never in the tracker) and asks for a work pass. */
function queueWin(c: Client, repoPath: string, task: WinTask): void {
  saveWin({
    state: "queued",
    kind: task.kind,
    title: task.title,
    project: c.name,
    repo: basename(repoPath),
    key: `${c.prefix}-0`, // no tracker uses 0, so it never collides with a real ticket
    url: "",
    message: "",
    at: Date.now(),
    repoPath,
    brief: task.brief,
  });
  report(`🌱 first win in ${c.name}: ${task.title}`);
  writeFileSync(join(OPS, ".request-work"), "");
}

// ---------- a task picked from the check-up ----------

const PICK = join(OPS, "first-pick.json");
type Pick = { repoPath: string; task: WinTask };
const loadPick = (): Pick | null => readJson<Pick | null>(PICK, null);

/** The project a repo folder belongs to: the one whose folder holds it. */
export function clientOfRepo(repoPath: string, clients: readonly Client[] = CLIENTS, code = CODE): Client | undefined {
  return clients.find((c) => repoPath === join(code, c.dir) || repoPath.startsWith(`${join(code, c.dir)}/`));
}

/**
 * Hands a check-up finding to an agent. Before setup it's remembered and becomes the first win once setup runs. After,
 * it becomes the first win when there's none under way (or the last one found nothing or failed); otherwise a ticket
 * in the project's tracker, labelled for the agents, so it's reviewable like any other. Asks for a work pass. On a
 * watch project it is always you assigning an agent (assign.ts): a task with no ticket, built at assignedAutonomy;
 * nothing is filed in the client's tracker.
 */
export async function pickTask(
  repoPath: string,
  task: WinTask,
  file: typeof createTicket = createTicket,
): Promise<{ state: "picked" | "queued" | "ticket" | "assigned"; key: string }> {
  if (needsSetup()) {
    writeJsonAtomic(PICK, { repoPath, task } satisfies Pick);
    return { state: "picked", key: "" };
  }
  const c = clientOfRepo(repoPath);
  if (!c) throw new Error(`${basename(repoPath)} isn't in any project yet`);
  if (c.autonomy === "watch") {
    // watch files nothing in the client's tracker: your pick is you assigning an agent, a task with no ticket
    const a = assign({
      project: c.name,
      title: task.title,
      brief: `${task.brief}\n\nFound by Overhand's check-up of ${basename(repoPath)}.`,
      by: "dashboard",
    });
    writeFileSync(join(OPS, ".request-work"), "");
    report(`🩺 ${a.key}: ${task.title} (from the check-up, assigned)`);
    return { state: "assigned", key: a.key };
  }
  const w = loadWin();
  if (!w || w.state === "none" || w.state === "failed") {
    queueWin(c, repoPath, task);
    return { state: "queued", key: `${c.prefix}-0` };
  }
  const key = await file(c, task.title, `${task.brief}\n\nFound by Overhand's check-up of ${basename(repoPath)}.`, LABEL.queue);
  writeFileSync(join(OPS, ".request-work"), "");
  report(`🩺 ${key}: ${task.title} (from the check-up)`);
  return { state: "ticket", key };
}
