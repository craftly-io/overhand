/**
 * Every worktree of every project's repo, Overhand's own and the ones you or your agents made, with who works in each
 * now, its pull request, when it last changed, its size, and whether Cleanup's latest scan offers to remove it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanupItem, Worktree, Worktrees } from "@overhand/contract";
import { gitRepos, lastUsed, pool } from "./cleanup";
import { CFG, CLIENTS, CODE, gitRefused, HOME, OPS, safeCmd } from "./env";
import { report } from "./notify";
import { type FirewallConfig, scanOutward } from "./outward";
import { tilde } from "./projects";
import { gitEnv, isGit } from "./runtimes/runtime";
import type { LiveSession } from "./sessions";

/** A worktree as `git worktree list --porcelain` names it: its folder and branch ("" when detached). */
export interface WorktreeEntry {
  path: string;
  branch: string;
}

/** `git worktree list --porcelain`, the repo's own checkout first. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split("\n\n")
    .map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1] ?? "", branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "" }))
    .filter((w) => w.path);
}

const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const full = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

/**
 * Who works in the worktree at `path`: each session, and each subagent with a folder of its own, whose folder is in it
 * and in no deeper worktree of `all` (a repo's checkout holds its `.claude/worktrees`, which count on their own).
 */
export function whoIn(path: string, all: readonly string[], sessions: readonly LiveSession[]): Worktree["who"] {
  const inHere = (dir: string) => all.filter((p) => under(dir, p)).reduce((best, p) => (p.length > best.length ? p : best), "") === path;
  return sessions.flatMap((s) => [
    ...(inHere(full(s.cwd)) ? [{ kind: s.kind, label: s.kind === "you" ? s.name : s.label }] : []),
    ...s.subagents.filter((a) => a.cwd && inHere(full(a.cwd))).map((a) => ({ kind: "subagent" as const, label: a.name })),
  ]);
}

/** Runs a command without blocking the dashboard; "" when it fails or outlasts `timeout` ms. */
async function out(cmd: string[], cwd: string, timeout = 15_000): Promise<string> {
  try {
    if (isGit(cmd) && gitRefused(cwd)) return "";
    const p = Bun.spawn(safeCmd(cmd), {
      cwd,
      env: isGit(cmd) ? gitEnv() : process.env,
      stdout: "pipe",
      stderr: "ignore",
      timeout,
      killSignal: "SIGKILL",
    });
    const text = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? text.trim() : "";
  } catch {
    return "";
  }
}

type BranchPr = { url: string; state: string; title: string };
/** Each branch's newest pull request in a repo, from the code host's CLI; empty without `gh` or off GitHub. */
async function prsByBranch(repo: string): Promise<Map<string, BranchPr>> {
  const prs = new Map<string, BranchPr>();
  if (!Bun.which("gh")) return prs;
  const raw = await out(["gh", "pr", "list", "--state", "all", "--limit", "100", "--json", "headRefName,url,state,isDraft,title"], repo);
  try {
    for (const p of JSON.parse(raw || "[]") as { headRefName: string; url: string; state: string; isDraft: boolean; title: string }[])
      if (!prs.has(p.headRefName))
        prs.set(p.headRefName, { url: p.url, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, title: p.title });
  } catch {
    // an answer we can't read: no PRs shown, the rest still is
  }
  return prs;
}

/**
 * The project's own words for a worktree's work, best first, as its name reads them (contract `workName`): its PR's
 * title, then its own commits' subjects. Only words that may go anywhere this project's do: one carrying another
 * project's private words, or anything the firewall holds, is left out. Made here from the machine's own git; nothing is
 * sent anywhere to make it.
 */
export function projectWords(project: string, candidates: readonly string[], cfg: FirewallConfig = CFG): string[] {
  return [...new Set(candidates.map((c) => c.trim()).filter(Boolean))].filter((c) => !scanOutward(c, [project], cfg).length);
}

/** Why Cleanup's latest scan (.cleanup.json) offers each worktree, by its folder. */
function cleanupOffers(): Map<string, string> {
  try {
    const f = join(OPS, ".cleanup.json");
    const items = existsSync(f) ? ((JSON.parse(readFileSync(f, "utf8")) as { items?: CleanupItem[] }).items ?? []) : [];
    return new Map(items.filter((i) => i.kind === "worktree").map((i) => [i.path, i.why]));
  } catch {
    return new Map();
  }
}

/**
 * `scan` shared and kept: callers at the same time share one scan, a result younger than `freshMs` is served as it
 * is, and an older one is served at once while a fresh scan runs behind it (only the very first call waits). A
 * refresh that fails is told to `onError` and keeps the old result; nothing is left rejecting with no one to hear it.
 */
export function sharedScan<T>(
  scan: () => Promise<T>,
  freshMs: number,
  now = () => Date.now(),
  onError: (e: unknown) => void = (e) => report(`⚠ worktree scan failed: ${e instanceof Error ? e.message : String(e)}`),
): () => Promise<T> {
  let kept: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (kept && now() - kept.at < freshMs) return Promise.resolve(kept.data);
    inflight ??= scan()
      .then((data) => {
        kept = { at: now(), data };
        return data;
      })
      .catch((e: unknown) => {
        onError(e);
        if (kept) return kept.data;
        throw e; // the first scan: its caller is waiting on it and hears the error
      })
      .finally(() => {
        inflight = null;
      });
    return kept ? Promise.resolve(kept.data) : inflight;
  };
}

/**
 * Each worktree's size as only its own: a repo's checkout holds the agents' worktrees in its `.claude/worktrees`, and
 * `du` of the checkout counts them again, so what's nested in another listed worktree comes off that one.
 */
export function ownSizes(list: readonly Pick<Worktree, "path" | "kb">[]): number[] {
  return list.map((w) => {
    if (w.kb < 0) return w.kb;
    const nested = list.filter((x) => x !== w && x.kb > 0 && x.path.startsWith(`${w.path}/`)).reduce((n, x) => n + x.kb, 0);
    return Math.max(0, w.kb - nested);
  });
}

/** A project's worktrees as measured: everything but who is in them, which changes faster than a scan is worth. */
type Scanned = { project: string; repoPaths: string[]; wt: Worktree }[];

/** The slow part, behind sharedScan: git, the code host's PRs and `du` for every worktree of every project. */
async function scanAll(): Promise<Scanned> {
  const offers = cleanupOffers();
  const rows: Scanned = [];
  await Promise.all(
    CLIENTS.map(async (c) => {
      for (const repo of gitRepos(join(CODE, c.dir))) {
        const [entries, prs] = await Promise.all([
          out(["git", "worktree", "list", "--porcelain"], repo).then(parseWorktrees),
          prsByBranch(repo),
        ]);
        const repoPaths = entries.map((e) => e.path);
        // an added worktree's own commits (not on the default branch): what its work is called in the person's words
        const commits = await Promise.all(
          entries.map((e, i) =>
            i === 0 || !existsSync(e.path)
              ? ""
              : out(["git", "log", "--no-merges", "-3", "--format=%s", "HEAD", "--not", "origin/HEAD"], e.path),
          ),
        );
        entries.forEach((e, i) => {
          const pr = e.branch ? prs.get(e.branch) : undefined;
          rows.push({
            project: c.name,
            repoPaths,
            wt: {
              path: tilde(e.path),
              repo: repo.split("/").pop() ?? repo,
              branch: e.branch,
              main: i === 0,
              who: [],
              pr: pr?.url ?? "",
              prState: pr?.state ?? "",
              usedAt: existsSync(e.path) ? lastUsed(e.path) : 0,
              kb: -1,
              cleanup: offers.get(e.path) ?? "",
              words: projectWords(c.name, [pr?.title ?? "", ...(commits[i] ?? "").split("\n")]),
            },
          });
        });
      }
    }),
  );
  await pool(
    rows.filter((r) => existsSync(full(r.wt.path))),
    4,
    async ({ wt }) => {
      wt.kb = Number((await out(["du", "-sk", full(wt.path)], HOME, 20_000)).split(/\s/)[0]) || -1;
    },
  );
  const own = ownSizes(rows.map((r) => r.wt));
  rows.forEach((r, i) => {
    r.wt.kb = own[i] ?? r.wt.kb;
  });
  return rows;
}

/** Measured at most every five minutes (the dashboard asks every two); served stale while a new scan runs. */
const scanned = sharedScan(scanAll, 5 * 60_000);

/** Every project's worktrees, with who works in each right now (from `sessions`, read fresh on every call). */
export async function listWorktrees(sessions: readonly LiveSession[]): Promise<Worktrees> {
  const rows = await scanned();
  const projects: Worktrees["projects"] = Object.fromEntries(CLIENTS.map((c) => [c.name, []]));
  for (const r of rows) projects[r.project]?.push({ ...r.wt, who: whoIn(full(r.wt.path), r.repoPaths, sessions) });
  return { at: Date.now(), projects };
}
