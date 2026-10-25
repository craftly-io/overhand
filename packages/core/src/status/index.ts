/** Status sources, refreshed in the background every 3 minutes. This module owns the status cache. */
import { refreshUsage } from "../claude";
import { shAsync } from "../env";
import { firstWinFirst } from "../firstwin";
import { report } from "../notify";
import { checkOpsUpdate } from "../selfupdate";
import { calendarToday } from "./calendar";
import { ciHealth } from "./ci";
import { dependabotAlerts } from "./dependabot";
import { githubPrs, projectScope } from "./github";
import { sentryIssues } from "./sentry";
import { status, type UiPr } from "./types";
import { upkeep } from "./upkeep";

export { status };

import { vercelDeploys } from "./vercel";

const failing = (p: UiPr) => /FAILURE|ERROR/.test(p.checks);
const named = (p: UiPr) => `${p.client}: ${p.repo.split("/")[1] ?? p.repo}#${p.number}`;

/**
 * What changed in your open pull requests between two refreshes, as lines for the day's log: opened, checks turning red,
 * changes requested, approved. `gone` left the open list; the caller looks up whether they merged.
 */
export function prChanges(before: readonly UiPr[], after: readonly UiPr[]): { lines: string[]; gone: UiPr[] } {
  const was = new Map(before.map((p) => [p.url, p]));
  const now = new Set(after.map((p) => p.url));
  const lines: string[] = [];
  for (const p of after) {
    const old = was.get(p.url);
    if (!old) lines.push(`🆕 ${named(p)} opened: ${p.title}`);
    else if (failing(p) && !failing(old)) lines.push(`🔴 ${named(p)} checks failing: ${p.title}`);
    if (old && p.review !== old.review && p.review === "CHANGES_REQUESTED") lines.push(`✍ ${named(p)} changes requested: ${p.title}`);
    if (old && p.review !== old.review && p.review === "APPROVED") lines.push(`👍 ${named(p)} approved: ${p.title}`);
  }
  return { lines, gone: before.filter((p) => !now.has(p.url)) };
}

/** Tells the day's log what happened to your pull requests since the last refresh; skips the first, which only learns them. */
async function tellPrs(before: UiPr[], after: UiPr[], known: boolean): Promise<void> {
  if (!known) return;
  const { lines, gone } = prChanges(before, after);
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
  if (!firstWinFirst()) void refreshUsage(); // a usage probe is a model run too (firstWinFirst)
  const errors: string[] = [];
  const safe = async <T>(name: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      errors.push(`${name}: ${String(e).slice(0, 160)}`);
      return fallback;
    }
  };
  // only your projects' PRs: gh searches your whole account
  const inProjects = projectScope();
  const [myPrs, reviews, ci, deploys, sentry, advisories, calendar] = await Promise.all([
    safe("GitHub PRs", () => githubPrs("is:pr is:open author:@me", inProjects), status.myPrs),
    safe("GitHub reviews", () => githubPrs("is:pr is:open review-requested:@me", inProjects), status.reviews),
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
