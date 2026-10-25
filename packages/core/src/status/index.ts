/** Status sources, refreshed in the background every 3 minutes. This module owns the status cache. */
import { join } from "node:path";
import { OPS, shAsync } from "../env";
import { report } from "../notify";
import { checkOpsUpdate } from "../selfupdate";
import { readJson, writeJsonAtomic } from "../state";
import { calendarToday } from "./calendar";
import { ciHealth } from "./ci";
import { dependabotAlerts } from "./dependabot";
import { githubPrs } from "./github";
import { sentryIssues } from "./sentry";
import { status, type UiPr } from "./types";
import { upkeep } from "./upkeep";

export { status };

import { vercelDeploys } from "./vercel";

const failing = (p: UiPr) => /FAILURE|ERROR/.test(p.checks);
const named = (p: UiPr) => `${p.client}: ${p.repo.split("/")[1] ?? p.repo}#${p.number}`;

/**
 * What changed in your open pull requests between two refreshes, as lines for the day's log: opened, checks turning red,
 * changes requested, approved. `gone` left the open list; the caller looks up whether they merged. A pull request in
 * `told` was seen open before (a restart, or one GitHub's search left out for a refresh): it isn't "opened" again.
 */
export function prChanges(
  before: readonly UiPr[],
  after: readonly UiPr[],
  told: ReadonlySet<string> = new Set(),
): { lines: string[]; gone: UiPr[] } {
  const was = new Map(before.map((p) => [p.url, p]));
  const now = new Set(after.map((p) => p.url));
  const lines: string[] = [];
  for (const p of after) {
    const old = was.get(p.url);
    if (!old) {
      if (!told.has(p.url)) lines.push(`🆕 ${named(p)} opened: ${p.title}`);
    } else if (failing(p) && !failing(old)) lines.push(`🔴 ${named(p)} checks failing: ${p.title}`);
    if (old && p.review !== old.review && p.review === "CHANGES_REQUESTED") lines.push(`✍ ${named(p)} changes requested: ${p.title}`);
    if (old && p.review !== old.review && p.review === "APPROVED") lines.push(`👍 ${named(p)} approved: ${p.title}`);
  }
  return { lines, gone: before.filter((p) => !now.has(p.url)) };
}

/** The pull requests already seen open, kept across restarts; the newest 500 are plenty. */
const TOLD = () => join(OPS, ".prs-seen.json");

/**
 * Tells the day's log what happened to your pull requests since the last refresh; the first only learns them. Each
 * one is "opened" once, ever: what's been seen open is kept on disk.
 */
export async function tellPrs(before: UiPr[], after: UiPr[], known: boolean): Promise<void> {
  const seen = readJson<string[]>(TOLD(), []);
  const told = new Set(seen);
  const fresh = after.map((p) => p.url).filter((u) => !told.has(u));
  if (fresh.length) writeJsonAtomic(TOLD(), [...seen, ...fresh].slice(-500));
  if (!known) return;
  const { lines, gone } = prChanges(before, after, told);
  for (const l of lines) report(l);
  for (const p of gone) {
    const r = await shAsync(["gh", "pr", "view", p.url, "--json", "state", "-q", ".state"]);
    if (r.ok && r.out.trim() === "MERGED") report(`🎉 ${named(p)} merged: ${p.title}`);
    else if (r.ok && r.out.trim() === "CLOSED") report(`🗑 ${named(p)} closed: ${p.title}`);
  }
}

/** Re-reads every status source; a failing source keeps its last value and adds an error line. */
export async function refreshStatus(): Promise<void> {
  void checkOpsUpdate();
  // usage readings aren't refreshed here: a reading costs a model call, so it's read when you open the dashboard and
  // right before a new ticket's run (claude.ts), not every few minutes around the clock
  const errors: string[] = [];
  const safe = async <T>(name: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      errors.push(`${name}: ${String(e).slice(0, 160)}`);
      return fallback;
    }
  };
  const [myPrs, reviews, ci, deploys, sentry, advisories, calendar] = await Promise.all([
    safe("GitHub PRs", () => githubPrs("is:pr is:open author:@me"), status.myPrs),
    safe("GitHub reviews", () => githubPrs("is:pr is:open review-requested:@me"), status.reviews),
    safe("CI", ciHealth, status.ci),
    safe("Vercel", vercelDeploys, status.deploys),
    safe("Sentry", sentryIssues, status.sentry),
    safe("Dependabot", dependabotAlerts, status.advisories),
    safe("Calendar", calendarToday, status.calendar),
  ]);
  // the first refresh only learns your PRs; so does one where GitHub couldn't be read (it kept the old list)
  await tellPrs(status.myPrs, myPrs, status.at > 0 && !errors.some((e) => e.startsWith("GitHub PRs")));
  // dependency updates, untested files and TODO notes: what's kept now, while anything due is read in the background
  const { error, ...kept } = upkeep();
  if (error) errors.push(`Upkeep: ${error}`);
  Object.assign(status, { at: Date.now(), myPrs, reviews, ci, deploys, sentry, advisories, ...kept, calendar, errors });
}
