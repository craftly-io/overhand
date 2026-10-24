/**
 * Each project's onboarding guide: ONBOARDING.md at its main repo's root, written or refreshed by the project's own agent
 * as a normal Overhand task (local like the first win, so no tracker ticket), within the daily budget and its autonomy:
 * a PR (draft on propose) adding the file, or on watch a report with the text. The dashboard reads the guide from the
 * default branch, or from the open guide PR's branch, and checks it for drift against the repo. Never on a timer.
 *
 * Claude Code's own `/team-onboarding` command isn't used, for Claude Code projects either: it builds its guide from one
 * person's usage history (their sessions, commands and MCP servers), not from the repo, so it's the wrong source for a
 * project guide and could put one person's private usage into a shared file. Its headless use isn't documented, and its
 * share link exists only on claude.ai Team and Enterprise (code.claude.com/docs/en/commands). Every agent CLI gets the
 * same repo-grounded prompt below instead, and "Share with your team" is the code host's link.
 */
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Autonomy,
  GUIDE_FILE,
  type Guide,
  type GuideDrift,
  guideDrift,
  makeTargets,
  type RepoFacts,
  type SummaryItem,
} from "@overhand/contract";
import { policyOf, ticketRules } from "./autonomy";
import { gitReposAsync } from "./cleanup";
import type { Client } from "./config";
import { CFG, CLIENTS, CODE, MIN, OPS, shAsync } from "./env";
import { fileUrl } from "./instructions";
import { report } from "./notify";
import { loadState, readJson, type TrackedPr, writeJsonAtomic } from "./state";

/** A guide run as guides.json keeps it, by project. `report` is a watch run's text, which never reaches the repo. */
export interface StoredGuide {
  run: "idle" | "queued" | "running" | "failed";
  /** The run's local key: the project's prefix, ONBOARDING and a stamp, so each refresh gets a branch of its own. */
  key: string;
  repoPath: string;
  message: string;
  report: string;
  at: number;
  /** When the guide's PR merged, and the file's link then: the team status update's line. */
  mergedAt?: number;
  mergedUrl?: string;
}
type Stored = Record<string, StoredGuide>;

const FILE = () => join(OPS, "guides.json");
/** Every project's stored guide run. */
export const loadGuides = (): Stored => readJson<Stored>(FILE(), {});
/** Saves one project's guide run atomically. */
export function saveGuide(project: string, g: StoredGuide): void {
  writeJsonAtomic(FILE(), { ...loadGuides(), [project]: g });
  void refreshGuides(Date.now(), true).catch(() => {});
}

/** Whether a local key is a guide run's (its PR is then a guide PR). */
export const isGuideKey = (key: string): boolean => /^[A-Z][A-Z0-9]*-ONBOARDING-[A-Z0-9]+$/.test(key);

/** The project's main repo: its most recently committed active one (a commit within limits.dormantDays). */
async function mainRepo(c: Client, now: number): Promise<string | null> {
  let best: { r: string; t: number } | null = null;
  for (const r of await gitReposAsync(join(CODE, c.dir))) {
    const t = Number((await git(["log", "-1", "--format=%ct"], r)).out) * 1000 || 0;
    if (now - t < CFG.limits.dormantDays * 24 * 60 * MIN && (!best || t > best.t)) best = { r, t };
  }
  return best?.r ?? null;
}

/** The project's open guide PR, if any. */
const openGuidePr = (c: Client, prs: Record<string, TrackedPr>): [string, TrackedPr] | undefined =>
  Object.entries(prs).find(([k]) => isGuideKey(k) && k.startsWith(`${c.prefix}-`));

/**
 * Queues a guide run for the next work pass (and asks for one now). One at a time per project: refused while one is
 * queued or running, or while its guide PR is open (review that instead). Throws a message the dashboard shows.
 */
export async function requestGuide(
  project: string,
  now = Date.now(),
  pick: (c: Client) => Promise<string | null> | string | null = (c) => mainRepo(c, Date.now()),
): Promise<StoredGuide> {
  const c = CLIENTS.find((x) => x.name === project);
  if (!c) throw new Error(`No project ${project}`);
  const prev = loadGuides()[project];
  if (prev && (prev.run === "queued" || prev.run === "running")) throw new Error(`${project}'s guide is already being written.`);
  const pr = openGuidePr(c, loadState().prs);
  if (pr) throw new Error(`${project}'s guide PR is still open: review it first (${pr[1].url}).`);
  const repoPath = await pick(c);
  if (!repoPath) throw new Error(`No active repo found for ${project}.`);
  const g: StoredGuide = {
    ...prev,
    run: "queued",
    key: `${c.prefix}-ONBOARDING-${now.toString(36).toUpperCase()}`,
    repoPath,
    message: "",
    report: prev?.report ?? "",
    at: now,
  };
  saveGuide(project, g);
  report(`📘 ${project}: onboarding guide queued for ${basename(repoPath)}`);
  writeFileSync(join(OPS, ".request-work"), "");
  return g;
}

/** What the agent is told: the same repo-grounded prompt for every agent CLI. */
export function guidePrompt(
  c: Pick<Client, "name" | "autonomy">,
  key: string,
  repo: string,
  wt: { path: string; branch: string; base: string },
) {
  const write = policyOf(c.autonomy).write;
  return [
    `Onboarding guide ${key} for ${c.name}: write or refresh ${GUIDE_FILE} at the root of ${repo}.`,
    "This was asked for in Overhand; there is no ticket in a tracker. Do exactly this and change no other file.",
    "",
    "Who it's for: an engineer joining this project who has never seen it. With this one file they should get from a fresh clone to running the tests and making a first change.",
    "",
    "Ground every line in the repository as it is now. Read before you write: the README and docs, the manifests and lockfiles (package.json, pyproject.toml, Cargo.toml, go.mod, Gemfile and the like), scripts (package.json scripts, Makefile, justfile), CI config (.github/workflows and the like), env examples, the top-level folders, and any agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules, .github/copilot-instructions.md).",
    "Never invent a command, script, folder or link: name only what you found. Quote commands exactly as the repo runs them, with the package manager its lockfile implies. When something is unclear (no tests, a step that needs credentials), say so plainly instead of guessing.",
    "",
    "Use these sections, in this order, as `##` headings:",
    "1. What this is: two or three sentences on what the project does and for whom, and its main stack.",
    "2. Layout: the top-level folders and what lives in each (only folders that exist).",
    "3. Install and run: prerequisites (the runtime versions the repo pins), install, env setup, running it locally.",
    "4. Test: running the tests, lint and type checks, and what CI runs.",
    "5. Conventions: code style, formatting, commits, branches and PRs, as the repo and its instruction files state them.",
    "6. Where to start: a few files to read first and a good first kind of change.",
    "7. Gotchas: what bites newcomers, from what the repo shows.",
    "",
    "Plain Markdown only: headings, lists, fenced code blocks with a language, links. No HTML, badges or images. Keep it to one to three screens. Put every command in a code block or `inline code`.",
    "Write for people: don't mention Overhand, orchestrators, worktrees or accounts, and don't write about yourself (no 'I didn't check'): an open question is stated as the repo's, e.g. 'which env values are required isn't documented'.",
    `If ${GUIDE_FILE} already exists, refresh it: keep what's still true and anything people added by hand, fix what's out of date, fill what's missing.`,
    "",
    write
      ? `Write the file, commit only it with a conventional message (\`docs: add onboarding guide\`, or \`docs: refresh onboarding guide\` when it existed); Overhand pushes it. pr_title is that message; pr_body says what the guide covers and, for a refresh, what changed.`
      : `You can't write files here: return status done with the whole guide as Markdown in \`guide\` and a one-line summary in message.`,
    "",
    `You are in a prepared worktree of ${repo}: ${wt.path}`,
    `Branch ${wt.branch}, based on origin/${wt.base}${write ? ` (the PR will target ${wt.base})` : ""}. Work only inside this worktree.`,
    "Finish with the structured result.",
    ticketRules(c.autonomy),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * What a finished guide run leads to, as the project's autonomy allows: a PR (a draft on propose) only when the agent
 * finished and the level opens PRs; on watch its text is kept as a report; anything else failed.
 */
export function guideNext(level: Autonomy, r: { status: string; guide?: string; message: string }): "pr" | "report" | "failed" {
  if (r.status !== "done") return "failed";
  if (policyOf(level).pr === "none") return r.guide?.trim() ? "report" : "failed";
  return "pr";
}

/** Records a guide PR's merge, for the team status update's line. */
export function guideMerged(key: string, remote: string, now = Date.now()): void {
  const all = loadGuides();
  const hit = Object.entries(all).find(([, g]) => g.key === key);
  if (!hit) return;
  saveGuide(hit[0], { ...hit[1], mergedAt: now, mergedUrl: fileUrl(remote, GUIDE_FILE) });
}

/** Guides whose PR merged, with when, as summary items: the status update writes "Onboarding guide updated: <link>". */
export function mergedGuides(stored: Stored = loadGuides()): (SummaryItem & { at: number })[] {
  return Object.entries(stored).flatMap(([project, g]) =>
    g.mergedAt !== undefined && g.mergedUrl ? [{ project, key: g.key, title: GUIDE_FILE, url: g.mergedUrl, at: g.mergedAt }] : [],
  );
}

// ---------- reading the guide ----------

/** Local git without blocking the daemon: the guides are read on the dashboard's background timer. */
const git = (args: string[], cwd: string) => shAsync(["git", ...args], cwd, 10_000);

/** A file at a ref, or null. Local git only: no network. */
const show = async (cwd: string, ref: string, path: string): Promise<string | null> => {
  const r = await git(["show", `${ref}:${path}`], cwd);
  return r.ok ? r.out : null;
};

/** What drift compares the guide with, at a ref. */
export async function repoFacts(cwd: string, ref: string): Promise<RepoFacts> {
  const [tree, pkg, make] = await Promise.all([git(["ls-tree", ref], cwd), show(cwd, ref, "package.json"), show(cwd, ref, "Makefile")]);
  const entries = tree.out.split("\n").flatMap((l) => {
    const m = /^\d+ (\w+) \w+\t(.+)$/.exec(l);
    return m ? [{ type: m[1], name: m[2] ?? "" }] : [];
  });
  let scripts: Record<string, string> | null = null;
  if (pkg !== null)
    try {
      scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      scripts = {};
    }
  return {
    dirs: entries.filter((e) => e.type === "tree").map((e) => e.name),
    files: entries.filter((e) => e.type === "blob").map((e) => e.name),
    scripts,
    makeTargets: make === null ? null : makeTargets(make),
  };
}

/** The guide on one branch: its text, when it last changed, and its drift. */
interface GuideRead {
  text: string;
  branch: string;
  at: number;
  drift: GuideDrift[];
}

/** Reads the guide at a ref; null when the file isn't there. */
async function readAt(cwd: string, ref: string, branch: string): Promise<GuideRead | null> {
  const text = await show(cwd, ref, GUIDE_FILE);
  if (text === null) return null;
  const [log, facts] = await Promise.all([git(["log", "-1", "--format=%ct", ref, "--", GUIDE_FILE], cwd), repoFacts(cwd, ref)]);
  return { text, branch, at: Number(log.out) * 1000 || 0, drift: guideDrift(text, facts) };
}

/** What `guideView` puts together for one project. */
export interface GuideInputs {
  project: string;
  repo: string;
  remote: string;
  stored?: StoredGuide;
  /** The open guide PR and the guide on its branch. */
  pr?: { key: string; url: string; read: GuideRead | null };
  /** The guide on the default branch. */
  main: GuideRead | null;
}

/**
 * A project's guide as the dashboard shows it: from the open guide PR's branch while there is one, else the default
 * branch, else a watch run's report. "Share with your team" is the PR while it's open, else the file on the code host.
 */
export function guideView(x: GuideInputs): Guide {
  const s = x.stored;
  const run = s?.run ?? "idle";
  const base = { project: x.project, repo: x.repo, run, message: s?.message ?? "", prKey: x.pr?.key ?? "" };
  const prRead = x.pr?.read;
  if (x.pr && prRead) return { ...base, source: "pr", ...prRead, share: x.pr.url };
  if (x.main) return { ...base, source: "default", ...x.main, share: fileUrl(x.remote, GUIDE_FILE) };
  if (s?.report) return { ...base, source: "report", text: s.report, branch: "", at: s.at, drift: [], share: x.pr?.url ?? "" };
  return { ...base, source: "", text: "", branch: "", at: s?.at ?? 0, drift: [], share: x.pr?.url ?? "" };
}

let cached: { at: number; list: Guide[] } = { at: 0, list: [] };

/** Every project's guide, as last read (`refreshGuides`). */
export const guides = (): Guide[] => cached.list;

/** Reads every project's guide again when the last read is a minute old, or at once (`force`: a guide run moved). Local git only. */
export async function refreshGuides(now = Date.now(), force = false): Promise<void> {
  if (!force && now - cached.at < MIN) return;
  cached.at = now; // one read at a time
  const stored = loadGuides();
  const prs = loadState().prs;
  const list: Guide[] = [];
  for (const c of CLIENTS) {
    const s = stored[c.name];
    const repo = s?.repoPath && existsSync(s.repoPath) ? s.repoPath : await mainRepo(c, now);
    if (!repo) {
      list.push(guideView({ project: c.name, repo: "", remote: "", stored: s, main: null }));
      continue;
    }
    const pr = openGuidePr(c, prs);
    const [remote, head] = await Promise.all([
      git(["remote", "get-url", "origin"], repo),
      git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo),
    ]);
    const ref = head.out || "HEAD";
    const main = await readAt(repo, ref, ref.replace(/^origin\//, ""));
    const prRead = pr && existsSync(pr[1].repoPath) ? await readAt(pr[1].repoPath, "HEAD", pr[1].branch) : null;
    list.push(
      guideView({
        project: c.name,
        repo: basename(repo),
        remote: remote.out,
        stored: s,
        pr: pr ? { key: pr[0], url: pr[1].url, read: prRead } : undefined,
        main,
      }),
    );
  }
  cached = { at: now, list };
}

/** A watch run's report, capped: the dashboard shows it, nothing writes it anywhere else. */
export const capReport = (text: string): string => (text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text);
