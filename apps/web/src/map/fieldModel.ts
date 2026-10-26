/**
 * The field's model: Now on a computer as one screen. Each project is a place, each agent hangs off its project on a
 * thread, and what waits on you leans out toward its card. Pure, no DOM: the places, who is where, and the day as it
 * was at any minute.
 *
 * Places are slots on a staggered grid over the free room (clear of every pane). The projects busiest today take the
 * slots nearest the middle and keep them all day, so nothing moves when you answer something.
 */
import type { DashboardState } from "@overhand/contract";
import { leadName } from "@/lib/sessions";
import { leadsIn } from "@/lib/world";
import type { MapModel, MapOpen } from "./model";

export type FieldState = "waiting" | "working" | "idle" | "done";

export interface FieldAgent {
  id: string;
  label: string;
  /** A short line of what it's doing or asking. */
  note: string;
  state: FieldState;
  lead: boolean;
  project: string;
  /** 0…1 through its run; 0 when unknown. */
  progress: number;
  /** A run that ended without its result (red checks, a crash). */
  bad: boolean;
  /** A gathered crew: how many it holds. */
  count: number;
  open: MapOpen;
}

export interface FieldProject {
  name: string;
  broken: boolean;
  merged: number;
  agents: FieldAgent[];
}

/** A rectangle in CSS px: left, top, width, height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The field's projects from the attention map's model (`mapFrom`): the same agents, states and places to open. */
export function fieldFrom(m: MapModel): FieldProject[] {
  return m.sectors.map((sec, i) => ({
    name: sec.name,
    broken: sec.broken,
    merged: sec.merged,
    agents: [
      ...m.agents
        .filter((a) => a.sector === i)
        .map((a) => ({
          id: a.id,
          label: a.label,
          note: a.note,
          state: a.state,
          lead: a.lead,
          project: sec.name,
          progress: a.progress,
          bad: false,
          count: 0,
          open: a.open,
        })),
      ...m.crews
        .filter((c) => c.sector === i)
        .map((c) => ({
          id: c.id,
          label: "",
          note: "",
          state: (c.working ? "working" : "idle") as FieldState,
          lead: false,
          project: sec.name,
          progress: 0,
          bad: false,
          count: c.count,
          open: { kind: "crew", project: sec.name } as MapOpen,
        })),
    ],
  }));
}

/** A run's ticket key, from its name ("SHOP-142 fix round" → "SHOP-142"). */
const keyOf = (name: string) => /^[A-Z][A-Z0-9]+-\d+\b/.exec(name)?.[0] ?? name;

/**
 * The field as it was at `at` (epoch ms), from the day's runs: a run under way then is working, one that had ended is
 * done (or bad). The project leads, which keep no history, rest. What waited on you isn't in the runs, so a replay
 * shows the work, not the questions.
 */
export function fieldAt(s: DashboardState, at: number): FieldProject[] {
  const runs = [
    ...s.runs.flatMap((r) => (r.start && r.end ? [{ name: r.name, start: r.start, end: r.end, ok: r.ok }] : [])),
    ...s.running.map((r) => ({ name: r.name, start: r.startedAt, end: Number.POSITIVE_INFINITY, ok: true })),
  ].filter((r) => r.start <= at);
  return s.clients.map((c) => {
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs.filter((x) => x.name.startsWith(`${c.prefix}-`)).sort((a, b) => a.start - b.start)) latest.set(keyOf(r.name), r);
    const agents: FieldAgent[] = [...latest].map(([key, r]) => {
      const live = r.end > at;
      return {
        id: key,
        label: key,
        note: "",
        state: live ? "working" : "done",
        lead: false,
        project: c.name,
        progress: live && Number.isFinite(r.end) ? (at - r.start) / (r.end - r.start) : 0,
        bad: !live && !r.ok,
        count: 0,
        open: { kind: "ticket", key },
      };
    });
    for (const g of leadsIn(s.godmode, c.name))
      agents.push({
        id: `lead:${g.key}`,
        label: leadName(g, s.names),
        note: "",
        state: "idle",
        lead: true,
        project: c.name,
        progress: 0,
        bad: false,
        count: 0,
        open: { kind: "lead", key: g.key },
      });
    return { name: c.name, broken: false, merged: 0, agents };
  });
}

/** How much a project did today: its runs and the agents on it now. Busier projects sit nearer the middle. */
export function dayWeight(s: DashboardState, name: string): number {
  const c = s.clients.find((x) => x.name === name);
  if (!c) return 0;
  const mine = (n: string) => n.startsWith(`${c.prefix}-`);
  return (
    s.runs.filter((r) => mine(r.name)).length +
    s.running.filter((r) => mine(r.name)).length * 2 +
    leadsIn(s.godmode, name).filter((g) => g.running).length
  );
}

/** A project's radius: its working agents orbit at about this distance, the rest a little further out. */
export const radiusOf = (agents: number): number => Math.min(64, 28 + 6 * Math.sqrt(Math.max(1, agents)));

/** The least room a place needs, as a cell of the grid: its name and its agents, with air between. */
const CELL = { w: 190, h: 150 } as const;
/** How far a place keeps from a pane's edge. */
const PAD = { x: 96, y: 74 } as const;

const inside = (p: Point, b: Box) => p.x > b.x - PAD.x && p.x < b.x + b.w + PAD.x && p.y > b.y - PAD.y && p.y < b.y + b.h + PAD.y;

/**
 * Slots on a staggered grid over `area`, none closer to a box in `avoid` than a place needs, nearest the middle of the
 * free room first. When the room is tight the grid gets finer until there are `n` slots, or as many as fit.
 */
export function slots(n: number, area: Box, avoid: readonly Box[]): Point[] {
  let best: Point[] = [];
  for (let scale = 1; scale >= 0.6; scale -= 0.1) {
    const cw = CELL.w * scale;
    const ch = CELL.h * scale;
    const cols = Math.max(1, Math.floor(area.w / cw));
    const rows = Math.max(1, Math.floor(area.h / ch));
    const gx = area.w / cols;
    const gy = area.h / rows;
    const out: Point[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols - (r % 2); c++) {
        const p = { x: area.x + gx * (c + 0.5 + (r % 2) * 0.5), y: area.y + gy * (r + 0.5) };
        if (!avoid.some((b) => inside(p, b))) out.push(p);
      }
    if (out.length > best.length) best = out;
    if (best.length >= n) break;
  }
  if (!best.length) return [];
  const cx = best.reduce((a, p) => a + p.x, 0) / best.length;
  const cy = best.reduce((a, p) => a + p.y, 0) / best.length;
  // nearest the middle first; across a little cheaper than up and down, so a wide screen fills its width
  return best.sort((a, b) => Math.hypot((a.x - cx) * 0.8, a.y - cy) - Math.hypot((b.x - cx) * 0.8, b.y - cy) || a.y - b.y || a.x - b.x);
}

/**
 * Each project's place: the busiest today (`weight`) takes the slot nearest the middle; ties keep their order. A
 * project beyond the slots there's room for shares the last one.
 */
export function arrange(projects: readonly { name: string; weight: number }[], area: Box, avoid: readonly Box[]): Map<string, Point> {
  const free = slots(projects.length, area, avoid);
  const out = new Map<string, Point>();
  if (!free.length) return out;
  [...projects]
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .forEach((p, k) => {
      const at = free[Math.min(k, free.length - 1)];
      if (at) out.set(p.name, at);
    });
  return out;
}

/**
 * The thread an agent holds to its card: its ticket's key, or `lead:` and the lead's key. A crew holds none. The card
 * names the same string (`cardThread`), so the field finds it on the page by `data-thread`.
 */
export function agentThread(open: MapOpen): string | null {
  if (open.kind === "ticket" || open.kind === "review") return keyOf(open.key);
  return open.kind === "lead" ? `lead:${open.key}` : null;
}

/** The thread a Needs you card holds, from where its button goes: a ticket's key, a lead's, or none. */
export function cardThread(t: { kind: string; key?: string }): string | null {
  if (!t.key) return null;
  if (t.kind === "ticket" || t.kind === "review" || t.kind === "held" || t.kind === "interrupted") return keyOf(t.key);
  return t.kind === "lead" || t.kind === "crashed" || t.kind === "cantstart" ? `lead:${t.key}` : null;
}
