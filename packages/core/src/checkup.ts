/**
 * The project check-up: right after you pick a repo, before any agent runs, Overhand reads it and says what it found
 * (its stack, whether its own checks pass, CI, open PRs and issues, stale branches, missing docs, TODO hot spots).
 * Read-only: it reads files, asks git, runs the repo's own read-only check scripts (firstwin.ts) and, when the GitHub
 * CLI is signed in, reads PRs, issues and CI runs. Each finding an agent can fix carries the task it would hand over.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { CheckupFinding, CheckupReport, FirstWinKind } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { shAsync } from "./env";
import { checkScripts, findTask, type WinTask } from "./firstwin";

/** How long one repo's check-up may take in all; the repo's own checks get what's left after the quick reads. */
const CHECKUP_MS = 25_000;
const DAY = 864e5;

// ---------- pure readings ----------

/** The stack in a few words, from the files at the repo's root and its package.json dependencies. */
export function stackOf(files: readonly string[], deps: Readonly<Record<string, string>> = {}): string {
  const has = (f: string) => files.includes(f);
  const dep = (d: string) => d in deps;
  const lang = has("tsconfig.json")
    ? "TypeScript"
    : has("package.json")
      ? "JavaScript"
      : has("go.mod")
        ? "Go"
        : has("Cargo.toml")
          ? "Rust"
          : has("pyproject.toml") || has("requirements.txt") || has("setup.py")
            ? "Python"
            : has("Gemfile")
              ? "Ruby"
              : has("pom.xml") || has("build.gradle") || has("build.gradle.kts")
                ? "Java/Kotlin"
                : has("composer.json")
                  ? "PHP"
                  : files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))
                    ? "C#"
                    : "";
  const framework = dep("next")
    ? "Next.js"
    : dep("expo")
      ? "Expo"
      : dep("react-native")
        ? "React Native"
        : dep("@remix-run/react") || dep("react-router")
          ? "React Router"
          : dep("astro")
            ? "Astro"
            : dep("nuxt")
              ? "Nuxt"
              : dep("vue")
                ? "Vue"
                : dep("svelte")
                  ? "Svelte"
                  : dep("react")
                    ? "React"
                    : dep("hono")
                      ? "Hono"
                      : dep("express")
                        ? "Express"
                        : "";
  const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "";
  return [lang, framework, pm].filter(Boolean).join(" · ");
}

/** CI the repo has, by its config files: GitHub Actions workflows, GitLab, CircleCI or others. */
export function ciOf(files: readonly string[], workflows: readonly string[]): boolean {
  return (
    workflows.some((f) => /\.ya?ml$/.test(f)) ||
    [".gitlab-ci.yml", ".circleci", "azure-pipelines.yml", ".travis.yml", "Jenkinsfile"].some((f) => files.includes(f))
  );
}

/**
 * Local branches nobody touched in `days`, from `git for-each-ref --format='%(refname:short) %(committerdate:unix)'`,
 * leaving out the ones in `keep` (the default and current branch).
 */
export function staleBranches(refs: string, keep: readonly string[], now = Date.now(), days = 90): string[] {
  return refs
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter(([name, at]) => name && at && !keep.includes(name) && now - Number(at) * 1000 > days * DAY)
    .map(([name]) => name ?? "");
}

/** How the check-up counts TODO notes in a repo: `path:count` lines, one per tracked text file that has any. */
export const TODO_GREP = ["git", "grep", "-c", "-I", "-w", "-E", "TODO|FIXME|HACK|XXX"];

/** Every file with TODO, FIXME, HACK or XXX marks from `TODO_GREP`'s output, most first; vendored and built files left out. */
export function todoCounts(counts: string): { path: string; n: number }[] {
  return counts
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf(":");
      return { path: line.slice(0, i), n: i > 0 ? Number(line.slice(i + 1)) : 0 };
    })
    .filter((f) => f.n > 0 && !/(^|\/)(?:node_modules|vendor|dist|build)\//.test(f.path))
    .sort((a, b) => b.n - a.n);
}

/** The file with the most TODO, FIXME, HACK or XXX marks (`todoCounts`), at least `min` of them. */
export function todoHotspot(counts: string, min = 5): { path: string; n: number } | null {
  const [best] = todoCounts(counts);
  return best && best.n >= min ? best : null;
}

/** Open PRs from `gh pr list --json number,updatedAt,isDraft`: how many, and how many nobody touched in two weeks. */
export function prsWaiting(json: string, now = Date.now()): { open: number; quiet: number } | null {
  const prs = parse<{ updatedAt: string }[] | null>(json, null);
  return prs ? { open: prs.length, quiet: prs.filter((p) => now - Date.parse(p.updatedAt) > 14 * DAY).length } : null;
}

/** The task that adds CI, from the repo's own scripts so the agent wires real commands. */
export function ciTask(name: string, scripts: Readonly<Record<string, string>>): WinTask {
  const run = ["typecheck", "lint", "test", "build"].filter((s) => s in scripts);
  return {
    kind: "ci",
    title: "Add a workflow that runs the checks on every pull request",
    brief: `${name} has no CI, so nothing checks a pull request before it's merged. Add one GitHub Actions workflow (.github/workflows/ci.yml) that installs dependencies the way the repo does and runs ${run.length ? run.map((s) => `\`${s}\``).join(", ") : "its tests and build"} on pull requests and pushes to the default branch. Keep it to that one job; no deploys, no secrets.`,
  };
}

// ---------- the check-up ----------

/** A check-up with the full task behind each finding an agent can take (what it's told; never sent to the page). */
export interface Checked extends CheckupReport {
  tasks: Record<string, WinTask>;
}

/** Parsed JSON, or the fallback when it isn't. */
const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const quick = (cmd: string[], cwd: string) => shAsync(cmd, cwd, 8_000);

/**
 * Checks one repo, read-only. Every finding is caused by what's in the repo; one an agent can fix carries its task.
 * ponytail: the repo's own checks run only for JavaScript repos with dependencies installed (firstwin.ts); tests are
 * never run (they may need services or write data), only checked for.
 */
export async function checkup(repo: string, until = Date.now() + CHECKUP_MS, now = Date.now()): Promise<Checked> {
  const name = basename(repo);
  const files = readdirSync(repo);
  const pkg = await Bun.file(join(repo, "package.json"))
    .json()
    .then((p: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) => p)
    .catch(() => null);
  const scripts = pkg?.scripts ?? {};
  const workflows = existsSync(join(repo, ".github", "workflows")) ? readdirSync(join(repo, ".github", "workflows")) : [];
  const out: CheckupFinding[] = [];
  const add = (id: string, tone: CheckupFinding["tone"], title: string, task: WinTask | null = null) =>
    out.push({ id, tone, title, task: task ? { kind: task.kind, title: task.title } : null });
  const tasks = new Map<string, WinTask>();
  const offer = (id: string, tone: CheckupFinding["tone"], title: string, task: WinTask) => {
    tasks.set(id, task);
    add(id, tone, title, task);
  };

  // git: the default branch, stale branches, leftover worktrees, TODO hot spots; gh: CI, PRs, issues (all at once)
  const baseOf = (h: { ok: boolean; out: string }) => (h.ok ? h.out.replace(/^origin\//, "") : "main");
  const headRef = quick(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  const [head, current, refs, worktrees, todos, run, prs, issues] = await Promise.all([
    headRef,
    quick(["git", "branch", "--show-current"], repo),
    quick(["git", "for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "refs/heads"], repo),
    quick(["git", "worktree", "list", "--porcelain"], repo),
    quick(TODO_GREP, repo),
    // the latest finished run on the default branch: what a pull request is measured against
    workflows.length
      ? headRef.then((h) =>
          quick(
            [
              "gh",
              "run",
              "list",
              "--branch",
              baseOf(h),
              "--status",
              "completed",
              "--limit",
              "1",
              "--json",
              "conclusion,workflowName,headBranch,url",
            ],
            repo,
          ),
        )
      : null,
    quick(["gh", "pr", "list", "--limit", "100", "--json", "number,updatedAt,isDraft"], repo),
    quick(["gh", "issue", "list", "--limit", "100", "--json", "number"], repo),
  ]);
  const base = baseOf(head);

  // the repo's own checks, dependency and README gaps, an untested pure function: the first-win search, per kind
  for (const kind of ["lint", "dependency", "readme", "test"] as const satisfies readonly FirstWinKind[]) {
    const t = await findTask(repo, kind, until).catch(() => null);
    if (t) offer(kind, kind === "lint" ? "bad" : "warn", t.title, t);
    // only said when they really ran: dependencies installed, and time left for them
    else if (kind === "lint" && checkScripts(scripts).length && existsSync(join(repo, "node_modules")) && Date.now() < until)
      add("checks", "ok", "Its own checks pass");
  }
  if (!scripts.test && !files.some((f) => ["pytest.ini", "go.mod", "Cargo.toml"].includes(f)) && pkg)
    add("tests", "warn", "No test script in package.json");

  // CI: none at all, or the latest run failed
  if (!ciOf(files, workflows)) offer("ci", "warn", w.checkupNoChecks, ciTask(name, scripts));
  else if (run?.ok) {
    const [last] = parse<{ conclusion: string; workflowName: string; headBranch: string; url: string }[]>(run.out, []);
    if (last?.conclusion === "failure")
      offer("ci", "bad", w.checkupChecksRed.replace("{workflow}", last.workflowName).replace("{branch}", last.headBranch), {
        kind: "ci",
        title: `Fix the failing ${last.workflowName} run`,
        brief: `The latest ${last.workflowName} run on ${last.headBranch} failed (${last.url}). Read its log with \`gh run view --log-failed\`, find the cause and fix it in the code. Don't skip or disable the failing step.`,
      });
    else if (last?.conclusion === "success") add("ci", "ok", w.checkupChecksGreen.replace("{workflow}", last.workflowName));
  }

  // open work on GitHub
  const waiting = prs.ok ? prsWaiting(prs.out, now) : null;
  if (waiting?.open) {
    const open = waiting.open === 1 ? w.checkupPrsOne : w.checkupPrsMany.replace("{n}", String(waiting.open));
    const quiet = w.checkupPrsQuiet.replace("{prs}", open).replace("{quiet}", String(waiting.quiet));
    add("prs", waiting.quiet ? "warn" : "info", waiting.quiet ? quiet : open);
  }
  const issueCount = issues.ok ? parse<unknown[]>(issues.out, []).length : 0;
  if (issueCount) add("issues", "info", `${issueCount}${issueCount === 100 ? "+" : ""} open issue${issueCount === 1 ? "" : "s"}`);

  // docs a newcomer looks for
  if (!files.some((f) => /^contributing(?:\.md)?$/i.test(f)) && !existsSync(join(repo, ".github", "CONTRIBUTING.md")))
    offer("contributing", "info", w.checkupNoContributing, {
      kind: "contributing",
      title: "Add a CONTRIBUTING guide",
      brief: `${name} has no CONTRIBUTING.md. Write a short one from what the repo actually uses: how to set it up, run it, run the checks and tests, the branch and commit style its history shows, and how a pull request gets reviewed. Only facts you can see in the repo; no invented policy.`,
    });

  // housekeeping
  const stale = refs.ok ? staleBranches(refs.out, [base, current.out]) : [];
  if (stale.length) add("branches", "info", `${stale.length} local branch${stale.length === 1 ? "" : "es"} untouched for three months`);
  const prunable = worktrees.ok ? worktrees.out.split("\n").filter((l) => l.startsWith("prunable")).length : 0;
  if (prunable) add("worktrees", "info", `${prunable} leftover worktree${prunable === 1 ? "" : "s"} whose folder is gone`);
  const hot = todos.ok ? todoHotspot(todos.out) : null;
  if (hot)
    offer("todo", "info", `${hot.n} TODOs in ${hot.path}: work left unfinished`, {
      kind: "todo",
      title: `Work through the TODOs in ${basename(hot.path)}`,
      brief: `${hot.path} has ${hot.n} TODO, FIXME or HACK notes. Resolve the ones that are small and safe to do now, each with its test where the repo has tests. Leave any that need a product decision in place and list them in your summary with why.`,
    });

  // the readme's state when it's fine (the gap itself came from the first-win search)
  if (!tasks.has("readme")) add("readme", "ok", "README says how to install and run it");
  const rank = { bad: 0, warn: 1, info: 2, ok: 3 } as const;
  return {
    repo: name,
    path: repo,
    stack: stackOf(files, { ...pkg?.devDependencies, ...pkg?.dependencies }),
    findings: out.sort((a, b) => rank[a.tone] - rank[b.tone]),
    at: now,
    tasks: Object.fromEntries(tasks),
  };
}

const CACHE = new Map<string, Promise<Checked>>();
const CACHE_MS = 10 * 60_000;

/** The check-up of a repo, run once and reused for ten minutes (the page asks again as it polls). */
export function cachedCheckup(repo: string): Promise<Checked> {
  const hit = CACHE.get(repo);
  if (hit) return hit;
  const p = checkup(repo);
  CACHE.set(repo, p);
  setTimeout(() => CACHE.delete(repo), CACHE_MS).unref?.();
  return p;
}
