/**
 * The field: Now on a computer as one screen. It fills Now behind the panes; each project is a named place, each
 * agent hangs off its project on a thread, and what waits on you leans out and holds an orange thread to its card in
 * Needs you. Live is light: a project glows by how much is moving and marks travel along working threads. Settling a
 * card lets its thread go: it springs back and the agent lights up.
 *
 * One 2D canvas, drawn from the theme's own colours. It keeps the map's clock and budget: at most 30 frames a second
 * while something changed in the last minute or the pointer moved over it, then one frame and rest; none in a hidden
 * tab; one frame per change under reduced motion or Settings › You › Still. Every agent is also a button in a list
 * screen readers and the keyboard reach.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Model } from "@/app/data";
import { useFieldTime } from "@/app/fieldTime";
import { useTheme, useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { needs } from "@/components/now/Alerts";
import { fmt } from "@/lib/format";
import { AgentGlyph, LIVE_MS, REDUCED, subscribeHidden, subscribeReduced, WorldGround } from "./AttentionMap";
import {
  agentThread,
  arrange,
  type Box,
  dayWeight,
  type FieldAgent,
  type FieldProject,
  fieldAt,
  fieldFrom,
  NAME_MAX,
  type Point,
  radiusOf,
} from "./fieldModel";
import { type MapOpen, mapFrom, signature } from "./model";

/** What one frame needs: the places, who is where, and how to say it. */
interface Scene {
  projects: FieldProject[];
  places: Map<string, Point>;
  still: boolean;
  /** Replaying the day: agents move quickly to where they were, and no thread is drawn to a card. */
  replay: boolean;
  /** The panes, so a name never runs under one. */
  avoid: Box[];
  /** The world draws each agent itself (a cat, a train, a koi), as a glyph over the canvas: the canvas draws no body. */
  art: boolean;
  labels: { crew: (n: number) => string; project: (p: FieldProject) => string; sub: (ask: number, work: number, done: number) => string };
}

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
}

interface Palette {
  fg: string;
  bg: string;
  muted: string;
  ok: string;
  bad: string;
  you: string;
  sans: string;
  mono: string;
}

/** The theme's colours and faces, read off the page so the field follows the look, light or dark. */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  // a page without the theme's variables (a test, a frame) draws in the system's own text and paper colours
  const v = (name: string, fallback: "CanvasText" | "Canvas" | "GrayText") => css.getPropertyValue(name).trim() || fallback;
  const body = getComputedStyle(document.body);
  return {
    fg: v("--foreground", "CanvasText"),
    bg: v("--background", "Canvas"),
    muted: v("--muted-foreground", "GrayText"),
    ok: v("--ok", "CanvasText"),
    bad: v("--bad", "CanvasText"),
    you: v("--you", "CanvasText"),
    sans: body.fontFamily || "system-ui, sans-serif",
    mono: css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
  };
}

/** The frame budget while moving. */
const FRAME_MS = 1000 / 30;
/** The dot grid's spacing, in CSS px. */
const GRID = 26;

const bend = (ax: number, ay: number, bx: number, by: number, k: number): [number, number] => [
  (ax + bx) / 2 - (by - ay) * k,
  (ay + by) / 2 + (bx - ax) * k,
];
const along = (ax: number, ay: number, cx: number, cy: number, bx: number, by: number, u: number): [number, number] => [
  (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * cx + u * u * bx,
  (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * cy + u * u * by,
];
const seedOf = (id: string) => [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7) / 97;

/** `text` cut to `max` px in the canvas's current font, ending in an ellipsis when it had to be cut. */
function clipText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let n = text.length;
  while (n > 1 && ctx.measureText(`${text.slice(0, n).trimEnd()}…`).width > max) n--;
  return `${text.slice(0, n).trimEnd()}…`;
}

/** Where each card's thread ends: its right edge, held inside the pane that scrolls it, relative to the field. */
function anchors(root: HTMLElement): Map<string, Point> {
  const base = root.getBoundingClientRect();
  const out = new Map<string, Point>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-thread]")) {
    const key = el.dataset.thread;
    if (!key || out.has(key)) continue;
    const r = el.getBoundingClientRect();
    const pane = el.closest<HTMLElement>("[data-field-avoid]")?.getBoundingClientRect();
    const top = pane ? pane.top + 12 : r.top;
    const bottom = pane ? pane.bottom - 12 : r.bottom;
    const y = Math.min(bottom, Math.max(top, r.top + Math.min(r.height / 2, 40)));
    out.set(key, { x: (pane ? Math.min(r.right, pane.right) : r.right) - base.left, y: y - base.top });
  }
  return out;
}

/** The panes the field keeps clear of, relative to it. */
function panes(root: HTMLElement): Box[] {
  const base = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>("[data-field-avoid]")].flatMap((el) => {
    const r = el.getBoundingClientRect();
    return r.width && r.height ? [{ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }] : [];
  });
}

/** The field behind Now's panes. `root` is the element it fills and finds its panes and cards in, once it's on the page. */
export function Field({ m, still, root }: { m: Model; still: boolean; root: HTMLElement | null }) {
  const w = useWords();
  const ui = useUi();
  const [at] = useFieldTime();
  const hidden = useSyncExternalStore(subscribeHidden, () => document.hidden);
  const reduced = useSyncExternalStore(subscribeReduced, () => matchMedia(REDUCED).matches);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [avoid, setAvoid] = useState<Box[]>([]);
  const { theme, light } = useTheme();
  // Instrument is the plain field; every other world brings its ground and its characters
  const art = theme.world !== "instrument";
  const glyphs = useRef(new Map<string, HTMLElement>());

  const live = mapFrom(m.s, m.alerts, needs(m).length, m.s.now);
  const sig = `${signature(live)}|${at ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when what it shows changes, not on every poll
  const projects = useMemo(() => (at === null ? fieldFrom(live) : fieldAt(m.s, at)), [sig]);
  const weights = projects.map((p) => `${p.name}:${dayWeight(m.s, p.name)}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: places follow the day's weights and the room, not each poll
  const places = useMemo(
    () =>
      arrange(
        projects.map((p) => ({ name: p.name, weight: dayWeight(m.s, p.name) })),
        { x: 20, y: 20, w: size.w - 40, h: size.h - 40 },
        avoid,
      ),
    [weights, size.w, size.h, JSON.stringify(avoid)],
  );

  // the room and the panes in it: measured on resize, and whenever what the panes hold changes their size
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change in what it shows can resize a pane: measure again
  useLayoutEffect(() => {
    const el = root;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
      // rounded to 8 px so a pane that grows by a line doesn't move every place
      setAvoid((was) => {
        const next = panes(el).map((b) => ({
          x: Math.round(b.x / 8) * 8,
          y: Math.round(b.y / 8) * 8,
          w: Math.round(b.w / 8) * 8,
          h: Math.round(b.h / 8) * 8,
        }));
        return JSON.stringify(next) === JSON.stringify(was) ? was : next;
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const p of el.querySelectorAll("[data-field-avoid]")) ro.observe(p);
    measure();
    return () => ro.disconnect();
  }, [root, sig]);

  const scene = useRef<Scene | null>(null);
  scene.current = {
    projects,
    places,
    still: still || reduced,
    art,
    replay: at !== null,
    avoid,
    labels: {
      crew: (n) => fmt(w.mapCrew, { n }),
      sub: (ask, work, done) =>
        ask
          ? fmt(w.fieldForYou, { n: ask })
          : work
            ? fmt(w.fieldWorking, { n: work })
            : done
              ? fmt(w.fieldDone, { n: done })
              : w.fieldQuiet,
      project: (p) => {
        const n = (s: FieldAgent["state"]) => p.agents.filter((a) => a.state === s).reduce((k, a) => k + Math.max(1, a.count), 0);
        return fmt(w.mapSummary, { waiting: n("waiting"), working: n("working"), idle: n("idle") + n("done") });
      },
    },
  };
  // `motion`: a minute of movement; without it, one frame with what changed (a progress arc creeping on)
  const wake = useRef<(motion: boolean) => void>(() => {});
  const open = useRef<(o: MapOpen) => void>(() => {});
  open.current = (o) => ui.openDrawer(o.kind === "crew" ? { kind: "crew", project: o.project } : o);

  // one loop for the field's life: it runs while there's motion to show and rests otherwise
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    const el = root;
    if (!c || !ctx || !el) return;
    const bodies = new Map<string, Body>();
    const hubs = new Map<string, Body>();
    const snaps: { id: string; t0: number; ax: number; ay: number }[] = [];
    const held = new Map<string, Point>();
    let pal = readPalette();
    let raf = 0;
    let last = 0;
    let stirred = performance.now();
    let mouse: Point | null = null;
    let hover = "";
    let dpr = 1;

    const fit = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = el.getBoundingClientRect();
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    };

    const frame = (now: number) => {
      raf = 0;
      const s = scene.current;
      if (!s) return;
      const moving = !s.still && !document.hidden && now - stirred < LIVE_MS;
      if (moving && now - last < FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 30;
      last = now;
      const tm = s.still ? 0 : now / 1000;
      const W = c.width / dpr;
      const H = c.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cards = s.replay ? new Map<string, Point>() : anchors(el);

      // places glide to their slots; agents spring to where their state puts them around their place
      for (const p of s.projects) {
        const to = s.places.get(p.name);
        if (!to) continue;
        let h = hubs.get(p.name);
        if (!h) {
          h = { x: to.x, y: to.y, vx: 0, vy: 0, a: 1 };
          hubs.set(p.name, h);
        }
        if (s.still) Object.assign(h, { x: to.x, y: to.y });
        else {
          h.vx += ((to.x - h.x) * 9 - h.vx * 5.5) * dt;
          h.vy += ((to.y - h.y) * 9 - h.vy * 5.5) * dt;
          h.x += h.vx * dt;
          h.y += h.vy * dt;
        }
        const R = radiusOf(p.agents.length);
        const ring = p.agents.filter((a) => a.state !== "waiting");
        const asking = p.agents.filter((a) => a.state === "waiting");
        for (const a of p.agents) {
          let tx: number;
          let ty: number;
          const card = a.state === "waiting" ? cards.get(agentThread(a.open) ?? "") : undefined;
          if (a.state === "waiting") {
            // it leans out of its place toward its card (or toward you, on the left, while its card is out of view)
            const goal = card ?? { x: 0, y: h.y };
            const vx = goal.x - h.x;
            const vy = goal.y - h.y;
            const len = Math.hypot(vx, vy) || 1;
            const out = Math.min(R + 52, len * 0.45);
            const k = asking.indexOf(a) * 26 - 6;
            tx = h.x + (vx / len) * out + (-vy / len) * k;
            ty = h.y + (vy / len) * out + (vx / len) * k;
          } else {
            const i = ring.indexOf(a);
            const turn = tm * 0.04 + seedOf(p.name) + (i / Math.max(1, ring.length)) * Math.PI * 2;
            const r = a.state === "working" ? 1 : 1.3;
            tx = h.x + Math.cos(turn) * (R + 34) * r;
            ty = h.y + 4 + Math.sin(turn) * (R * 0.85 + 8) * r;
          }
          const sd = seedOf(a.id);
          tx += Math.sin(tm * 0.6 + sd) * 4;
          ty += Math.cos(tm * 0.5 + sd * 1.3) * 4;
          let b = bodies.get(a.id);
          if (!b) {
            b = { x: h.x, y: h.y, vx: 0, vy: 0, a: 0 };
            bodies.set(a.id, b);
          }
          if (s.still) Object.assign(b, { x: tx, y: ty, a: 1 });
          else {
            const k = s.replay ? 70 : 18;
            const d = s.replay ? 13 : 6.5;
            b.vx += ((tx - b.x) * k - b.vx * d) * dt;
            b.vy += ((ty - b.y) * k - b.vy * d) * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.a += (1 - b.a) * Math.min(1, dt * 5);
          }
          if (card) held.set(a.id, card);
        }
      }
      // an agent that stopped waiting lets its thread go from where its card was
      const asked = new Set(s.projects.flatMap((p) => p.agents.filter((a) => a.state === "waiting").map((a) => a.id)));
      for (const [id, p] of held)
        if (!asked.has(id)) {
          held.delete(id);
          if (!s.replay && !s.still) snaps.push({ id, t0: now, ax: p.x, ay: p.y });
        }
      const agents = s.projects.flatMap((p) => p.agents);
      for (const id of bodies.keys()) if (!agents.some((a) => a.id === id)) bodies.delete(id);

      // what's under the pointer: an agent, else a place's name
      hover = "";
      if (mouse) {
        let best = 18 * 18;
        for (const a of agents) {
          const b = bodies.get(a.id);
          if (!b) continue;
          const d = (b.x - mouse.x) ** 2 + (b.y - mouse.y) ** 2;
          if (d < best) {
            best = d;
            hover = a.id;
          }
        }
        if (!hover)
          for (const [name, h] of hubs) if (Math.abs(h.x - mouse.x) < 56 && Math.abs(h.y - 4 - mouse.y) < 16) hover = `place:${name}`;
      }
      c.style.cursor = hover ? "pointer" : "";

      ctx.clearRect(0, 0, W, H);
      // live is light: each place glows by how much is moving there
      for (const p of s.projects) {
        const h = hubs.get(p.name);
        if (!h) continue;
        const busy = Math.min(3, p.agents.filter((a) => a.state === "working" || a.state === "waiting").length);
        const r = radiusOf(p.agents.length) * 1.9;
        const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, r);
        g.addColorStop(0, pal.fg);
        g.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.015 + busy * 0.018;
        ctx.fillStyle = g;
        ctx.fillRect(h.x - r, h.y - r, r * 2, r * 2);
      }
      // the dots lean toward live work and warm where something waits on you
      const pull = agents.flatMap((a) => {
        const b = bodies.get(a.id);
        return b ? [{ x: b.x, y: b.y, w: a.state === "working" ? 1 : a.state === "waiting" ? 1.2 : 0.3, ask: a.state === "waiting" }] : [];
      });
      for (let gy = GRID / 2; gy < H; gy += GRID)
        for (let gx = GRID / 2; gx < W; gx += GRID) {
          let dx = 0;
          let dy = 0;
          let lit = 0;
          let warm = 0;
          for (const q of pull) {
            const ex = q.x - gx;
            const ey = q.y - gy;
            const d2 = ex * ex + ey * ey + 600;
            if (d2 > 90_000) continue;
            const f = (q.w * 700) / d2;
            dx += ex * f;
            dy += ey * f;
            lit += (q.w * 1800) / d2;
            if (q.ask) warm += 1800 / d2;
          }
          const wave = s.still ? 0.5 : Math.sin(gx * 0.011 + gy * 0.007 - tm * 0.7) * 0.5 + 0.5;
          ctx.globalAlpha = warm > 1 ? Math.min(0.5, warm * 0.16) : Math.min(0.5, 0.06 + lit * 0.14 + wave * 0.045);
          ctx.fillStyle = warm > 1 ? pal.you : pal.fg;
          ctx.fillRect(gx + Math.max(-8, Math.min(8, dx)) - 1, gy + Math.max(-8, Math.min(8, dy)) - 1, 2, 2);
        }
      ctx.globalAlpha = 1;

      const hot = (a: FieldAgent) => hover === a.id || hover === `place:${a.project}`;
      // threads: each agent to its place, and what waits on you to its card
      for (const a of agents) {
        const b = bodies.get(a.id);
        const h = hubs.get(a.project);
        if (!b || !h) continue;
        const [cx, cy] = bend(b.x, b.y, h.x, h.y, 0.12);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.quadraticCurveTo(cx, cy, h.x, h.y);
        ctx.strokeStyle = hot(a) ? pal.fg : a.state === "waiting" ? pal.you : a.state === "done" ? (a.bad ? pal.bad : pal.ok) : pal.fg;
        ctx.globalAlpha = b.a * (hot(a) ? 0.9 : a.state === "working" ? 0.42 : a.state === "idle" ? 0.14 : 0.34);
        ctx.lineWidth = hot(a) ? 1.5 : a.state === "working" ? 1.2 : 1;
        ctx.setLineDash(a.bad ? [3, 6] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (a.state === "working" && !s.still) {
          ctx.fillStyle = pal.fg;
          ctx.globalAlpha = b.a * 0.9;
          for (let i = 0; i < 3; i++) {
            const [x, y] = along(b.x, b.y, cx, cy, h.x, h.y, (tm * 0.3 + seedOf(a.id) + i / 3) % 1);
            ctx.fillRect(x - 1.1, y - 1.1, 2.2, 2.2);
          }
        }
        const card = held.get(a.id);
        if (card && a.state === "waiting") {
          const k = -0.14 + Math.sin(tm * 1.8 + seedOf(a.id)) * 0.025;
          const [qx, qy] = bend(b.x, b.y, card.x, card.y, k);
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.quadraticCurveTo(qx, qy, card.x, card.y);
          ctx.strokeStyle = pal.you;
          ctx.globalAlpha = b.a * 0.85;
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.fillStyle = pal.you;
          if (!s.still)
            for (let i = 0; i < 4; i++) {
              const [x, y] = along(b.x, b.y, qx, qy, card.x, card.y, (tm * 0.42 + i / 4 + seedOf(a.id)) % 1);
              ctx.beginPath();
              ctx.arc(x, y, 1.7, 0, Math.PI * 2);
              ctx.fill();
            }
          ctx.beginPath();
          ctx.arc(card.x, card.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      // a settled thread springs back from its card and the agent lights up
      for (let i = snaps.length - 1; i >= 0; i--) {
        const sn = snaps[i];
        const b = sn ? bodies.get(sn.id) : undefined;
        const u = sn ? (now - sn.t0) / 800 : 1;
        if (!sn || !b || u >= 1) {
          snaps.splice(i, 1);
          continue;
        }
        const e = 1 - (1 - u) ** 3;
        ctx.globalAlpha = 1 - u;
        ctx.beginPath();
        ctx.moveTo(sn.ax + (b.x - sn.ax) * e, sn.ay + (b.y - sn.ay) * e);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = pal.you;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x, b.y, 8 + e * 36, 0, Math.PI * 2);
        ctx.strokeStyle = pal.ok;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // places are named, never coloured; a failing one's name is crimson
      ctx.textAlign = "center";
      for (const p of s.projects) {
        const h = hubs.get(p.name);
        if (!h) continue;
        const ask = p.agents.filter((a) => a.state === "waiting").length;
        const work = p.agents.filter((a) => a.state === "working").length;
        const done = p.agents.filter((a) => a.state === "done").length;
        const sub = s.labels.sub(ask, work, done);
        ctx.font = `600 14px ${pal.sans}`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = pal.bg;
        const name = clipText(ctx, p.name, NAME_MAX);
        ctx.strokeText(name, h.x, h.y);
        ctx.fillStyle = p.broken ? pal.bad : pal.fg;
        ctx.fillText(name, h.x, h.y);
        ctx.font = `400 11px ${pal.mono}`;
        ctx.strokeText(sub, h.x, h.y + 15);
        ctx.fillStyle = ask ? pal.you : done && !work ? pal.ok : pal.muted;
        ctx.fillText(sub, h.x, h.y + 15);
      }
      ctx.textAlign = "left";
      // the agents: a circle, a square for a lead, a progress arc while working, a green ring when done
      const front = cards.size ? [...cards.keys()][0] : "";
      for (const a of agents) {
        const b = bodies.get(a.id);
        if (!b) continue;
        ctx.globalAlpha = b.a * (a.state === "idle" || a.state === "done" ? 0.75 : 1);
        const big = hot(a) ? 1.35 : 1;
        if (a.state === "waiting") {
          const r = (18 + Math.sin(tm * 2.2 + seedOf(a.id)) * 4) * big;
          const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
          g.addColorStop(0, pal.you);
          g.addColorStop(1, "transparent");
          const was = ctx.globalAlpha;
          ctx.globalAlpha = was * 0.45;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = was;
        }
        if (a.count) {
          // a crew: the quiet ones past seven, as one count
          const label = s.labels.crew(a.count);
          ctx.font = `500 11px ${pal.mono}`;
          const tw = ctx.measureText(label).width + 12;
          ctx.strokeStyle = pal.muted;
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x - tw / 2, b.y - 9, tw, 18);
          ctx.fillStyle = pal.muted;
          ctx.textAlign = "center";
          ctx.fillText(label, b.x, b.y + 4);
          ctx.textAlign = "left";
          continue;
        }
        // with art, the world's own glyph stands here (the canvas keeps its glow, thread and name); without, a plain body
        if (!s.art) {
          if (a.state === "working" || a.state === "done") {
            ctx.beginPath();
            ctx.arc(b.x, b.y, 10 * big, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (a.state === "done" ? 1 : Math.max(0.05, a.progress)));
            ctx.strokeStyle = a.state === "done" ? (a.bad ? pal.bad : pal.ok) : pal.fg;
            ctx.lineWidth = 1.4;
            ctx.stroke();
          }
          if (a.state === "working" && !s.still) {
            const t = tm * 2.6 + seedOf(a.id);
            ctx.fillStyle = pal.fg;
            ctx.beginPath();
            ctx.arc(b.x + Math.cos(t) * 10 * big, b.y + Math.sin(t) * 10 * big, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
          const r = (a.lead ? 6 : 5) * big;
          ctx.beginPath();
          if (a.lead) ctx.rect(b.x - r, b.y - r, r * 2, r * 2);
          else ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fillStyle = a.state === "waiting" ? pal.you : a.state === "working" ? pal.fg : pal.bg;
          ctx.fill();
          ctx.strokeStyle =
            a.state === "waiting" ? pal.you : a.state === "done" ? (a.bad ? pal.bad : pal.ok) : a.state === "idle" ? pal.muted : pal.fg;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // only the front card's agent is named (and whatever is under the pointer), on the side away from its place
        if ((a.state === "waiting" && agentThread(a.open) === front) || hot(a)) {
          const h = hubs.get(a.project);
          ctx.font = `500 12px ${pal.mono}`;
          const tw = ctx.measureText(a.label).width;
          // on the side away from its place, unless a pane is there
          const under = (x0: number, x1: number) => s.avoid.some((p) => x1 > p.x && x0 < p.x + p.w && b.y > p.y && b.y < p.y + p.h);
          const away = (h ? b.x < h.x : false) && !under(b.x - 15 - tw, b.x - 15);
          ctx.textAlign = away ? "right" : "left";
          ctx.lineWidth = 5;
          ctx.strokeStyle = pal.bg;
          ctx.strokeText(a.label, b.x + (away ? -15 : 15), b.y + 4);
          ctx.fillStyle = a.state === "waiting" ? pal.you : pal.fg;
          ctx.fillText(a.label, b.x + (away ? -15 : 15), b.y + 4);
          ctx.textAlign = "left";
        }
      }
      // each glyph follows its body (hidden when it has none, or while the day replays out of its place)
      for (const [id, el] of glyphs.current) {
        const b = bodies.get(id);
        const a = agents.find((x) => x.id === id);
        if (!b || !a) {
          el.style.opacity = "0";
          continue;
        }
        const big = hot(a) ? 1.35 : 1;
        el.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px) scale(${big})`;
        el.style.opacity = String(b.a * (a.state === "idle" || a.state === "done" ? 0.8 : 1));
      }
      ctx.globalAlpha = 1;
      // the one plain line about what's under the pointer, beside it
      const tip = (x: number, y: number, head: string, body: string) => {
        ctx.font = `400 13px ${pal.sans}`;
        const tw = Math.min(320, Math.max(ctx.measureText(body).width, ctx.measureText(head).width + 10, 120) + 24);
        const bx = Math.max(8, Math.min(x + 16, W - tw - 8));
        const by = Math.min(y + 14, H - 58);
        ctx.fillStyle = pal.fg;
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, body ? 50 : 30, 10);
        ctx.fill();
        ctx.fillStyle = pal.bg;
        ctx.font = `500 12px ${pal.mono}`;
        ctx.fillText(head, bx + 12, by + 19, tw - 24);
        if (body) {
          ctx.font = `400 13px ${pal.sans}`;
          ctx.fillText(body, bx + 12, by + 38, tw - 24);
        }
      };
      const ha = agents.find((a) => a.id === hover);
      const hb = ha ? bodies.get(ha.id) : undefined;
      if (ha && hb) tip(hb.x, hb.y, ha.count ? `${ha.project} · ${s.labels.crew(ha.count)}` : `${ha.project} · ${ha.label}`, ha.note);
      const hp = hover.startsWith("place:") ? s.projects.find((p) => `place:${p.name}` === hover) : undefined;
      const hh = hp ? hubs.get(hp.name) : undefined;
      if (hp && hh) tip(hh.x, hh.y + 10, hp.name, s.labels.project(hp));

      if (moving || snaps.length) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    wake.current = (motion) => {
      if (motion) stirred = performance.now();
      pal = readPalette();
      kick();
    };
    const onMove = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      stirred = performance.now();
      kick();
    };
    const onLeave = () => {
      mouse = null;
      kick();
    };
    const onClick = () => {
      const a = scene.current?.projects.flatMap((p) => p.agents).find((x) => x.id === hover);
      if (a) open.current(a.open);
    };
    // the panes scroll their cards under the threads: follow them
    const onScroll = () => kick();
    const ro = new ResizeObserver(() => {
      fit();
      kick();
    });
    ro.observe(el);
    fit();
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerleave", onLeave);
    c.addEventListener("click", onClick);
    el.addEventListener("scroll", onScroll, true);
    // a look or light/dark change repaints with its colours
    const mo = new MutationObserver(() => wake.current(false));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-chrome"] });
    kick();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerleave", onLeave);
      c.removeEventListener("click", onClick);
      el.removeEventListener("scroll", onScroll, true);
    };
  }, [root]);

  // who is where, and the places, wake it for a minute of motion (one frame, when still); a run's progress alone redraws
  // one frame, so an afternoon of long runs doesn't keep the tab busy
  const moved = JSON.stringify([at, projects.map((p) => [p.name, p.agents.map((a) => [a.id, a.state, a.count])])]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the changes that should wake it
  useEffect(() => wake.current(true), [moved, places, still, reduced, hidden, size.w, size.h]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a redraw when anything it shows changed
  useEffect(() => wake.current(false), [sig]);

  const agents = projects.flatMap((p) => p.agents);
  const state = { waiting: w.mapWaiting, working: w.mapWorking, idle: w.mapIdle, done: w.mapDone };
  return (
    <>
      {art ? <WorldGround world={theme.world} light={light} /> : null}
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      {art ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          {agents
            .filter((a) => !a.count)
            .map((a) => (
              <div
                key={a.id}
                ref={(el) => {
                  if (el) glyphs.current.set(a.id, el);
                  else glyphs.current.delete(a.id);
                }}
                className="absolute top-0 left-0 -mt-5 -ml-5 size-10 will-change-transform"
                style={{ opacity: 0 }}
              >
                <AgentGlyph world={theme.world} state={a.state} lead={a.lead} name={a.label} progress={a.progress} size={40} />
              </div>
            ))}
        </div>
      ) : null}
      <ul
        className="sr-only"
        aria-label={fmt(w.mapSummary, {
          waiting: agents.filter((a) => a.state === "waiting").length,
          working: agents.filter((a) => a.state === "working").length,
          idle: agents.filter((a) => a.state === "idle" || a.state === "done").length,
        })}
      >
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => open.current(a.open)}>
              {[a.project, a.count ? fmt(w.mapCrew, { n: a.count }) : a.label, state[a.state], a.note].filter(Boolean).join(", ")}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
