import { type DashboardState, type MilestoneId, newMilestones } from "@overhand/contract";
import type { Words } from "@overhand/themes";
import { type Alert, brokenCount } from "./alerts";
import { fmt, hm, pick, spokenNum } from "./format";
import { resumesAt } from "./pipeline";
import { armedCount, type Plan } from "./plan";

/** Ticket keys and PR numbers read badly aloud; this drops them and spells out "PR". */
function unNumber(s: string): string {
  return s
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "")
    .replace(/#\d+/g, "")
    .replace(/\bPRs?\b/g, (m) => (m === "PR" ? "pull request" : "pull requests"))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Each milestone's line in the brief, naming the detail it left at the project's place. */
const MILESTONE_WORDS: Record<MilestoneId, keyof Words> = {
  "merge-1": "brMsMerge1",
  "merge-10": "brMsMerge10",
  "merge-50": "brMsMerge50",
  "merge-100": "brMsMerge100",
  "clean-week": "brMsCleanWeek",
  "first-try": "brMsFirstTry",
};

/** The spoken briefing: short (10–20 s), in the theme's voice, no ticket keys or PR numbers. */
export function briefing(
  s: DashboardState,
  plan: Plan,
  alerts: readonly Alert[],
  w: Words,
  now: Date,
  random: () => number = Math.random,
): string {
  const say = (word: string, vars: Record<string, string | number> = {}) => fmt(pick(word, random), vars);
  const h = now.getHours();
  const name = s.owner || "there";
  const parts = [say(h < 5 ? w.brHelloNight : h < 12 ? w.brHelloMorning : h < 18 ? w.brHelloAfternoon : w.brHelloEvening, { name })];
  const urgent = alerts.filter((a) => a.sev === 3 && a.say).slice(0, 2);
  parts.push(urgent.length ? say(w.brUrgent, { items: urgent.map((a) => a.say).join(w.brJoin) }) : say(w.brCalm));
  // red builds and new errors aren't calls, so they're said once, as a count, after what needs you
  const red = brokenCount(s);
  if (red) parts.push(say(w.brBroken, { n: spokenNum(red) }));
  const cur = s.running[0];
  if (cur) {
    const client = s.clients.find((c) => cur.name.startsWith(`${c.prefix}-`))?.name ?? w.briefSomeTicket;
    parts.push(say(w.brWorking, { client }));
  } else if (!s.paused && resumesAt(s)) parts.push(say(w.brWaitLimit, { t: hm(resumesAt(s)) }));
  else parts.push(say(s.paused ? w.brPaused : w.brIdle));
  const armed = armedCount(plan, s);
  if (armed && !s.paused) parts.push(say(w.brArmed, { n: spokenNum(armed) }));
  const reviews = s.status.reviews.length + s.prs.length;
  if (reviews) parts.push(say(w.brReviews, { n: spokenNum(reviews) }));
  if (s.guardrails.length) parts.push(say(w.brGuardrails, { n: spokenNum(s.guardrails.length) }));
  const cal = Array.isArray(s.status.calendar) ? s.status.calendar : [];
  const next = cal.find((e) => !e.allDay && e.start > now.getTime() && e.start - now.getTime() < 3 * 3600_000);
  if (next)
    parts.push(
      say(w.brMeeting, {
        title: next.title,
        at: new Date(next.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
      }),
    );
  const task = plan.top[0] ? unNumber(plan.top[0].split(/[:(,;]/)[0] ?? "").replace(/\.$/, "") : "";
  if (task.length > 6 && task.split(" ").length <= 12) parts.push(say(w.brFirst, { task: task.charAt(0).toLowerCase() + task.slice(1) }));
  // the newest milestone of the last day, and the detail it left in the world
  const ms = newMilestones(s.progression, now.getTime() - 864e5, now.getTime())[0];
  if (ms) parts.push(say(w[MILESTONE_WORDS[ms.id]], { project: ms.project }));
  parts.push(say(w.brBye));
  return parts.join(" ");
}
