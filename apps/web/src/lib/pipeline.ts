import type { AgentPr, CurrentRun, DashboardState } from "@overhand/contract";
import { findTicket, type Plan, type YouItem } from "./plan";

/** Where a ticket is in its one flow, left to right. */
export const STAGES = ["planned", "queued", "running", "review", "merged"] as const;
export type Stage = (typeof STAGES)[number];

/** One ticket in the pipeline: one card that moves between stages, whichever source it was seen in. */
export interface Card {
  /** The ticket key, or the plan line for a planned item without one. */
  id: string;
  key: string;
  title: string;
  client: string;
  stage: Stage;
  /** Its line in today's plan, which arming toggles. */
  line?: number;
  on?: boolean;
  why?: string;
  pr?: AgentPr;
  run?: CurrentRun;
}

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const MERGED = /🎉 ([A-Z][A-Z0-9]+-\d+) PR merged/u;

/**
 * Every ticket the agents touch today as one flow, Planned → Queued → Running → In review → Merged, keyed by ticket
 * key: a plan line and its PR are one card at its furthest stage. Anything that matches nothing still gets its own card.
 * Running beats In review, because a PR being fixed is being worked on. Merged lists today's merges from the log.
 */
export function pipeline(s: DashboardState, plan: Plan): Record<Stage, Card[]> {
  const cards = new Map<string, Card>();
  const clientOf = (key: string) => s.clients.find((c) => key.startsWith(`${c.prefix}-`))?.name ?? "";
  const titleOf = (key: string) => findTicket(s.tickets, key)?.title ?? "";
  for (const [client, c] of Object.entries(plan.clients))
    for (const a of c.agent) {
      const id = a.key || `line-${a.i}`;
      cards.set(id, { id, key: a.key, title: a.title, client, stage: a.on ? "queued" : "planned", line: a.i, on: a.on, why: a.why });
    }
  // what you assigned an agent to on a watch or propose project starts on the next pass, armed in the plan or not; one
  // whose attempts are used up won't, so it waits in Needs you instead of Queued
  for (const a of s.assigned)
    if (!cards.has(a.key) && !a.stopped)
      cards.set(a.key, { id: a.key, key: a.key, title: titleOf(a.key) || a.title, client: a.project, stage: "queued" });
  for (const r of s.running) {
    const key = r.name.match(KEY)?.[1];
    if (!key) continue; // the planner and Slack triage aren't tickets
    const had = cards.get(key);
    cards.set(key, { ...(had ?? { id: key, key, title: titleOf(key) || r.name, client: clientOf(key) }), stage: "running", run: r });
  }
  for (const p of s.prs) {
    const had = cards.get(p.key);
    const title = s.status.myPrs.find((x) => x.url === p.url)?.title || had?.title || titleOf(p.key) || p.branch;
    const base = had ?? { id: p.key, key: p.key, title, client: clientOf(p.key) };
    cards.set(p.key, { ...base, title, pr: p, stage: had?.stage === "running" ? "running" : "review" });
  }
  for (const line of s.reports) {
    const key = line.match(MERGED)?.[1];
    if (!key || s.prs.some((p) => p.key === key)) continue;
    const had = cards.get(key);
    cards.set(key, { ...(had ?? { id: key, key, title: titleOf(key), client: clientOf(key) }), stage: "merged" });
  }
  const out: Record<Stage, Card[]> = { planned: [], queued: [], running: [], review: [], merged: [] };
  for (const c of cards.values()) out[c.stage].push(c);
  return out;
}

/**
 * When work resumes while every account is at its usage limit (the soonest one back), else 0: nothing runs until then,
 * so the dashboard says so instead of calling the agents idle.
 */
export function resumesAt(s: DashboardState): number {
  const back = s.accounts.map((a) => a.coolUntil);
  return back.length && back.every((t) => t > s.now) ? Math.min(...back) : 0;
}

/** What the planner left for you, with the client each item is for. */
export function yours(plan: Plan): (YouItem & { client: string })[] {
  return Object.entries(plan.clients).flatMap(([client, c]) => c.you.map((y) => ({ ...y, client })));
}
