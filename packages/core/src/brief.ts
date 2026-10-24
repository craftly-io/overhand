/**
 * The night report: once a day, from schedule.briefAtHour, one notification (on the Mac and, with ntfy, the phone) that
 * tells the night in a sentence: what merged and opened, what waits on you, what yesterday was billed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MilestoneId, newMilestones } from "@overhand/contract";
import { spendOnDay } from "./billing";
import { CFG, OPS } from "./env";
import { guardBlocks } from "./guard";
import { progression } from "./history";
import { leadInbox } from "./leads";
import { notify } from "./notify";
import { loadState } from "./state";
import { status } from "./status/types";

export interface BriefFacts {
  merged: number;
  opened: number;
  failed: number;
  /** Lead questions, red PR checks, review requests: things only you can move. */
  waiting: number;
  /** Yesterday's estimated billed spend (pay-per-use and cloud accounts); plan and local runs aren't billed, so never in it. */
  billedYesterday: number;
  /** Of the merged, how many merged on Ship (GitHub's auto-merge, once CI was green), each with an Undo on the dashboard. */
  shipped?: number;
  /** Agent PRs whose diff may have cut a corner (corners.ts). */
  toCheck?: number;
  /** Tool calls the guard blocked overnight (the guardrail log). */
  blocked?: number;
  /** The newest milestone a project reached since the last brief, as one line. */
  milestone?: string;
}

const MILESTONE_LINES: Record<MilestoneId, string> = {
  "merge-1": "{project} merged its first PR.",
  "merge-10": "{project} reached its 10th merge.",
  "merge-50": "{project} reached its 50th merge.",
  "merge-100": "{project} reached its 100th merge.",
  "clean-week": "{project} had its first clean week: no failed runs.",
  "first-try": "{project} merged a PR on the first try for the first time.",
};

/** A milestone as the plain brief says it. */
export const milestoneLine = (project: string, id: MilestoneId): string => MILESTONE_LINES[id].replace("{project}", project);

/**
 * The brief as a notification: the night and what needs you in the title ("3 PRs overnight, 1 needs you"), the detail
 * in one line. Null when there is nothing to tell (no activity, nothing waiting, nothing billed): a quiet setup stays quiet.
 */
export function composeBrief(f: BriefFacts): { title: string; body: string } | null {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const night = [
    f.merged ? plural(f.merged, "PR merged", "PRs merged") : "",
    f.opened ? plural(f.opened, "new PR", "new PRs") : "",
    f.failed ? plural(f.failed, "run failed", "runs failed") : "",
  ].filter(Boolean);
  const toCheck = f.toCheck ?? 0;
  const blocked = f.blocked ?? 0;
  if (!night.length && !f.waiting && !f.billedYesterday && !toCheck && !blocked && !f.milestone) return null;
  const prs = f.merged + f.opened;
  const head = prs ? `${plural(prs, "PR", "PRs")} overnight` : f.failed ? `${plural(f.failed, "run", "runs")} failed overnight` : "";
  const needs = f.waiting ? `${f.waiting} ${f.waiting === 1 ? "needs" : "need"} you` : "nothing needs you";
  const title = head ? `${head}, ${needs}` : f.waiting ? `${plural(f.waiting, "thing needs", "things need")} you` : "A quiet night";
  const body = [
    night.length ? `Overnight: ${night.join(", ")}.` : "No agent activity overnight.",
    f.shipped
      ? `${f.shipped === f.merged ? (f.merged === 1 ? "It" : "All") : f.shipped} merged on Ship once CI was green; Undo is in Overhand.`
      : "",
    toCheck ? `${plural(toCheck, "PR has", "PRs have")} something to check before merging.` : "",
    blocked ? `The guardrails blocked ${plural(blocked, "action", "actions")}.` : "",
    f.billedYesterday ? `Yesterday was billed about $${f.billedYesterday.toFixed(2)}, an estimate.` : "",
    f.milestone ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return { title, body };
}

/** Counts the night's events in the activity log: yesterday from 18:00, and today until now. */
export function nightCounts(
  yesterday: readonly string[],
  today: readonly string[],
): Pick<BriefFacts, "merged" | "opened" | "failed" | "shipped"> {
  const evening = yesterday.filter((l) => (l.match(/^- (\d\d):/)?.[1] ?? "00") >= "18");
  const lines = [...evening, ...today];
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  return {
    merged: count(/^- \d\d:\d\d 🎉/u),
    opened: count(/^- \d\d:\d\d (✅|🆕)/u),
    failed: count(/^- \d\d:\d\d ✗/u),
    shipped: count(/^- \d\d:\d\d 🎉.* merged on Ship /u),
  };
}

const read = (date: string) => {
  const f = join(OPS, "reports", `${date}.md`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};

/**
 * Runs every minute: sends the brief once a day, as soon as the clock is at or past briefAtHour. "At or past", not
 * "at": a Mac asleep through that hour still gets its brief when it wakes.
 */
export function morningBrief(now = new Date()): void {
  const at = CFG.schedule.briefAtHour;
  if (at < 0 || now.getHours() < at) return;
  const date = now.toLocaleDateString("sv-SE");
  const marker = join(OPS, ".brief-sent");
  if (existsSync(marker) && readFileSync(marker, "utf8") === date) return;
  writeFileSync(marker, date); // before sending: a failing push must not repeat every minute
  // milestones since the last brief (or the last day), so each is told exactly once
  const toldAt = join(OPS, ".brief-milestones-at");
  const since = Number(existsSync(toldAt) ? readFileSync(toldAt, "utf8") : 0) || now.getTime() - 864e5;
  writeFileSync(toldAt, String(now.getTime()));
  const yesterday = new Date(now.getTime() - 864e5).toLocaleDateString("sv-SE");
  const prs = Object.values(loadState().prs);
  const waiting =
    CFG.godmode.filter((g) => leadInbox(g)?.open).length +
    status.myPrs.filter((p) => /FAILURE|ERROR/.test(p.checks)).length +
    status.reviews.length +
    prs.filter((p) => p.corners?.some((c) => c.severity === "block")).length;
  // the night: yesterday from 18:00, as nightCounts reads the activity log
  const evening = new Date(now.getTime() - 864e5);
  evening.setHours(18, 0, 0, 0);
  const brief = composeBrief({
    ...nightCounts(read(yesterday), read(date)),
    waiting,
    billedYesterday: spendOnDay(yesterday).billed,
    toCheck: prs.filter((p) => p.corners?.length).length,
    blocked: guardBlocks(evening.getTime()).length,
    milestone: newMilestones(progression({}, now.getTime()), since, now.getTime())
      .slice(0, 1)
      .map((m) => milestoneLine(m.project, m.id))[0],
  });
  if (brief) notify(brief.title, brief.body);
}
