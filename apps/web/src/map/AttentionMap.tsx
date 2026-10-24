/**
 * The attention map: you at the centre; the inner ring is what needs you, the middle what's working, the outer what's
 * idle or done; each project a sector. One component for every world (`World` draws the ground, the centre and the
 * characters). It renders on change only (the model's signature), its motion is CSS transforms and opacity, it stops
 * in a hidden tab, and under reduced motion (or Settings › Look & sound › Still) it is a still frame. The ground is a
 * layer of its own, so the little that moves never repaints it.
 */

import type { Words } from "@overhand/themes";
import { type CSSProperties, type KeyboardEvent, memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Model } from "@/app/data";
import { useTheme } from "@/app/theme";
import { useUi } from "@/app/ui";
import { needs } from "@/components/now/Alerts";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { hourLight } from "./hour";
import {
  type HubProject,
  hubModel,
  type LabelSpot,
  type MapAgent,
  type MapCrew,
  type MapModel,
  type MapOpen,
  mapFrom,
  placeLabels,
  polar,
  R,
  separate,
  signature,
  youAt,
} from "./model";
import { seed, type World, type WorldCtx } from "./world";
import { WORLDS, type WorldId } from "./worlds";
import { arcD } from "./worlds/instrument";
import "./map.css";

/** The map's width in map units: the outer ring, the captions outside it, and a margin. */
const SPAN = 1040;

const subscribeHidden = (f: () => void) => {
  document.addEventListener("visibilitychange", f);
  return () => document.removeEventListener("visibilitychange", f);
};

/** The map's size in CSS px, as it is laid out. */
function useSize(ref: React.RefObject<HTMLDivElement | null>): number {
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize(Math.round(Math.min(r.width, r.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * The map for the dashboard's model, in the active world. `still` freezes every motion (the Scene setting); the model
 * is rebuilt on each poll but the drawing only when what it shows has changed.
 */
export function AttentionMap({ m, world, still }: { m: Model; world: WorldId; still: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const { light, words } = useTheme();
  const ui = useUi();
  const hidden = useSyncExternalStore(subscribeHidden, () => document.hidden);
  const waiting = needs(m).length;
  const fresh = mapFrom(m.s, m.alerts, waiting, m.s.now);
  const sig = signature(fresh);
  // biome-ignore lint/correctness/useExhaustiveDependencies: redrawn when the signature changes, not on every poll
  const model = useMemo(() => fresh, [sig]);
  const w = WORLDS[world];
  const reduced = useSyncExternalStore(subscribeReduced, () => matchMedia(REDUCED).matches);
  const [resting, stir] = useResting(sig);
  // ponytail: the GPU atmospheres are night and dusk only; by day the world's 2D ground is the whole drawing
  const atmosphere = light ? undefined : w.atmosphere;
  const gl = useAtmosphere(atmosphere, still || reduced || resting);
  // Instrument takes the real hour's light: warm at dawn and dusk, cool at night, working lights brighter after dark
  const hour = w.id === "instrument" ? hourLight(m.s.now) : null;
  const tint = hour ? ({ "--hour-tint": hour.tint, "--hour-night": hour.night } as CSSProperties) : undefined;
  return (
    <div
      ref={ref}
      className={hour ? "hour-light relative size-full" : "relative size-full"}
      style={tint}
      data-gl={gl.on ? "" : undefined}
      onPointerMove={stir}
    >
      {atmosphere ? <canvas ref={gl.ref} className="atmosphere absolute inset-0 size-full" /> : null}
      {size > 0 ? (
        <MapSvg
          model={model}
          size={size}
          world={w}
          light={light}
          still={still || hidden}
          resting={resting}
          w={words}
          onOpen={(o) => ui.openDrawer(o.kind === "crew" ? { kind: "crew", project: o.project } : o)}
        />
      ) : null}
    </div>
  );
}

/**
 * Motion runs this long after the map last changed, or the pointer last moved over it; then it rests (CSS paused, the
 * atmosphere on one frame) until something happens. A question left open overnight kept it moving for hours: CPU in a
 * tab that's meant to stay open all day (release/soak.ts). Same as the scene engine's `LIVE_MS`.
 */
const LIVE_MS = 60_000;

/** Whether the map is resting, and the pointer handler that wakes it. */
function useResting(sig: string): [boolean, (e: React.PointerEvent) => void] {
  const [resting, setResting] = useState(false);
  const [woken, setWoken] = useState(0);
  const last = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts the clock when what the map shows changes, or on a wake
  useEffect(() => {
    setResting(false);
    const t = setTimeout(() => setResting(true), LIVE_MS);
    return () => clearTimeout(t);
  }, [sig, woken]);
  const stir = (e: React.PointerEvent) => {
    // the browser re-sends a resting pointer's position when the page under it changes: only a real move wakes it
    const at = [e.clientX, e.clientY].join(",");
    if (e.pointerType !== "mouse" || at === last.current) return;
    last.current = at;
    if (resting) setWoken((n) => n + 1);
  };
  return [resting, stir];
}

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (f: () => void) => {
  const q = matchMedia(REDUCED);
  q.addEventListener("change", f);
  return () => q.removeEventListener("change", f);
};

/**
 * The world's GPU atmosphere on a canvas, loaded as a chunk of its own only for a world that has one. `on` turns true
 * once it draws; until then (and without WebGL2) the world's 2D ground shows.
 */
function useAtmosphere(kind: World["atmosphere"], still: boolean) {
  const [canvas, ref] = useState<HTMLCanvasElement | null>(null);
  const [handle, setHandle] = useState<import("./atmosphere").AtmosphereHandle | null>(null);
  const first = useRef(still);
  first.current = still;
  useEffect(() => {
    if (!canvas || !kind) return;
    let gone = false;
    let h: import("./atmosphere").AtmosphereHandle | null = null;
    import("./atmosphere")
      .then((a) => {
        if (gone) return;
        h = a.startAtmosphere(canvas, kind, first.current);
        setHandle(h);
      })
      .catch(() => undefined); // no layer: the 2D ground stays
    return () => {
      gone = true;
      h?.destroy();
      setHandle(null);
    };
  }, [canvas, kind]);
  useEffect(() => handle?.setStill(still), [handle, still]);
  return { ref, on: handle !== null };
}

/** The defs every world draws with: soft halos per state, the pools of light, blurs for the ground, a planet. */
function Atlas({ c }: { c: WorldCtx }) {
  const halo = (state: string, color: string) => (
    <radialGradient key={state} id={`${c.id}h-${state}`}>
      <stop offset="0" stopColor={color} stopOpacity="0.55" />
      <stop offset="0.45" stopColor={color} stopOpacity="0.16" />
      <stop offset="1" stopColor={color} stopOpacity="0" />
    </radialGradient>
  );
  return (
    <>
      {halo("waiting", "var(--you-fill)")}
      {halo("working", "var(--ink-12)")}
      {halo("done", "var(--ok)")}
      {/* on paper a working light glows in the hour's sky colour (hour.ts): cool at night, warm at dawn, gone by day */}
      {halo("hour", "var(--hour-tint, transparent)")}
      <radialGradient id={`${c.id}pool`}>
        <stop offset="0" stopColor="var(--ink-12)" stopOpacity="0.07" />
        <stop offset="0.6" stopColor="var(--ink-12)" stopOpacity="0.02" />
        <stop offset="1" stopColor="var(--ink-12)" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}poolL`} cx="0.5" cy="0.45" r="0.5">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.7" stopColor="#ffffff" stopOpacity="0.55" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}halo`}>
        <stop offset="0" stopColor="var(--ink-12)" stopOpacity="0.16" />
        <stop offset="1" stopColor="var(--ink-12)" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}youband`}>
        <stop offset="0.3" stopColor="var(--you-fill)" stopOpacity="0" />
        <stop offset="0.75" stopColor="var(--you-fill)" stopOpacity="0.09" />
        <stop offset="1" stopColor="var(--you-fill)" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}planet`} cx="0.35" cy="0.3" r="0.85">
        <stop offset="0" stopColor="#9fb4d3" />
        <stop offset="0.6" stopColor="#3e5576" />
        <stop offset="1" stopColor="#16233a" />
      </radialGradient>
      <filter id={`${c.id}blur14`} x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="14" />
      </filter>
      <filter id={`${c.id}blur40`} x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="40" />
      </filter>
    </>
  );
}

/** The ground, a still layer of its own: redrawn only when the projects or the size change. */
const Ground = memo(function Ground({ c, world }: { c: WorldCtx; world: World }) {
  return (
    <svg viewBox={`${-SPAN / 2} ${-SPAN / 2} ${SPAN} ${SPAN}`} className="map-ground absolute inset-0 size-full" aria-hidden="true">
      <defs>
        <Atlas c={c} />
        {world.atlas(c)}
      </defs>
      {world.ground(c)}
    </svg>
  );
});

/** The drawing, memoised: a poll that changes nothing on the map draws nothing. A teammate's hub draws it too. */
export const MapSvg = memo(function MapSvg({
  model: raw,
  size,
  world,
  light,
  still,
  resting,
  you,
  w,
  onOpen,
}: {
  model: MapModel;
  size: number;
  world: World;
  light: boolean;
  still: boolean;
  /** Nothing has changed for a while: motion pauses where it is (`useResting`). */
  resting?: boolean;
  /** The word under the centre; the theme's word for you by default (a teammate's hub names them). */
  you?: string;
  w: Words;
  /** Where clicking an agent goes; without it (a hub) nothing on the map is a control. */
  onOpen?: (o: MapOpen) => void;
}) {
  const id = useId().replace(/:/g, "");
  const k = SPAN / size;
  const small = size < 520;
  const u = Math.max(50, Math.min(110, (small ? (world.big ? 40 : 30) : world.big ? 52 : 46) * k));
  const me = youAt(k);
  // a world that lays agents on its own lines (Transit) keeps them there; elsewhere no two tap targets overlap, and
  // nothing sits on you or your name
  const model = useMemo(() => {
    if (world.place) return world.place(raw);
    const body = u * 0.42;
    const keep = [
      { x: 0, y: 0, r: me.rim + body },
      { x: 0, y: me.nameY, r: me.nameSize + body },
    ];
    // tap targets with a little air between them
    return separate(raw, 2 * Math.max(22 * k, u * 0.5) + 8 * k, body, keep);
  }, [raw, world, k, u, me.rim, me.nameY, me.nameSize]);
  const c: WorldCtx = { model, k, u, lod: small ? "small" : "full", light, id, you: you ?? w.mapYou };
  // the ground draws the projects, not the agents: it changes only when a project's state or the size does
  const groundKey = JSON.stringify([model.sectors, Math.round(size / 8), light, world.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ground's own key says when it changes
  const ground = useMemo(() => <Ground c={c} world={world} />, [groundKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `c` is rebuilt each render from these; they say when it changes
  const labels = useMemo(
    () =>
      // a hub (no controls) shows no names, so it places none
      !onOpen
        ? new Map<string, LabelSpot | null>()
        : placeLabels(
            [
              ...model.agents.flatMap((a) => [
                { id: a.id, x: a.x, y: a.y, text: a.label, named: a.state === "waiting" },
                ...(world.reach?.(a, c) ?? []).map(([x, y], i) => ({ id: `${a.id}~${i}`, x: a.x + x, y: a.y + y, text: "", named: false })),
              ]),
              ...model.crews.map((x) => ({ id: x.id, x: x.x, y: x.y, text: "", named: false })),
            ],
            k,
            small ? 11 : 11.5,
          ),
    [model, world, k, small],
  );
  const open = (o: MapOpen) => onOpen?.(o);
  const working = model.agents.filter((a) => a.state === "working").length + model.crews.reduce((n, x) => n + x.working, 0);
  const asking = model.agents.filter((a) => a.state === "waiting");
  const summary = fmt(w.mapSummary, {
    waiting: model.waiting,
    working,
    idle: model.agents.length + model.crews.reduce((n, x) => n + x.count, 0) - working - asking.length,
  });
  const fs = (px: number) => ({ fontSize: px * k });
  return (
    <>
      {/* a live map keeps its ground on a still layer of its own; a hub is still anyway, so it draws all in one */}
      {onOpen ? ground : null}
      {/* biome-ignore lint/a11y/useSemanticElements: an svg can't be a fieldset; it groups the agents it draws */}
      <svg
        viewBox={`${-SPAN / 2} ${-SPAN / 2} ${SPAN} ${SPAN}`}
        className={cn("attention-map absolute inset-0 size-full", still && "still", resting && "rest")}
        data-world={world.id}
        data-lod={c.lod}
        role="group"
        aria-label={`${w.mapTitle}: ${summary}`}
      >
        <defs>
          <Atlas c={c} />
          {world.atlas(c)}
        </defs>
        {onOpen ? null : world.ground(c)}
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decoration only; nothing in it takes focus */}
        <g aria-hidden="true">
          {asking.length && onOpen ? <circle r={R.r1 + 10} fill={`url(#${id}youband)`} /> : null}
          {world.rings !== "none"
            ? [R.r0, R.r1, R.r2, R.r3].map((r) => <circle key={r} r={r} className={`ring-line ${world.rings}`} />)
            : null}
          {world.ticks && !small
            ? Array.from({ length: 120 }, (_, i) => {
                const major = i % 30 === 0;
                const [x1, y1] = polar(R.r3, i * 3);
                const [x2, y2] = polar(R.r3 + (major ? 16 : 7), i * 3);
                // biome-ignore lint/suspicious/noArrayIndexKey: a dial's ticks never move
                return <line key={i} className={major ? "tick major" : "tick"} x1={x1} y1={y1} x2={x2} y2={y2} />;
              })
            : null}
          {model.sectors.length > 1
            ? model.sectors.map((s) => {
                const [x1, y1] = polar(R.r1, s.a0);
                const [x2, y2] = polar(R.r3, s.a0);
                return <line key={s.name} className="divider" x1={x1} y1={y1} x2={x2} y2={y2} />;
              })
            : null}
          {/* each project's name follows the outer ring, its merges and failures after it */}
          {model.sectors.map((s, i) => {
            const mid = s.a0 + s.span / 2;
            const m360 = ((mid % 360) + 360) % 360;
            const bottom = m360 > 90 && m360 < 270;
            const span = Math.min(s.span, 150);
            const pid = `${id}cap${i}`;
            return (
              <g key={s.name}>
                <path id={pid} d={arcD(R.r3 + (bottom ? 40 : 28), mid - span / 2 + 4, mid + span / 2 - 4, bottom)} fill="none" />
                <text className={cn("sector-name", s.broken && "bad")} textAnchor="middle" style={fs(small ? 10.5 : 12.5)}>
                  <textPath href={`#${pid}`} startOffset="50%">
                    {s.name}
                    {!small && s.broken ? (
                      <tspan className="sector-meta" dx={10 * k} style={fs(10.5)}>
                        {w.mapBroken}
                      </tspan>
                    ) : null}
                    {!small && s.merged ? (
                      <tspan className="sector-merged" dx={8 * k} style={fs(10.5)}>
                        {fmt(w.mapMerged, { n: s.merged })}
                      </tspan>
                    ) : null}
                  </textPath>
                </text>
                {s.broken ? (
                  <>
                    <path className="scar" d={arcD(R.r3, s.a0 + s.span * 0.38, s.a0 + s.span * 0.49)} />
                    <path className="scar" d={arcD(R.r3, s.a0 + s.span * 0.52, s.a0 + s.span * 0.62)} />
                  </>
                ) : null}
              </g>
            );
          })}
          {/* hairlines from you to what's working, each with a pulse at its own time; or a short trail behind it */}
          {model.agents.map((a) => {
            if (a.state !== "working" || world.links === "none") return null;
            const r = Math.hypot(a.x, a.y);
            if (world.links === "trail") return <path key={`l-${a.id}`} className="trail" d={arcD(r, a.angle - 22, a.angle - 7)} />;
            const [x0, y0] = polar(me.rim + 4, a.angle);
            const [x1, y1] = polar(r - 30, a.angle);
            return (
              <g key={`l-${a.id}`}>
                <line className="link" x1={x0} y1={y0} x2={x1} y2={y1} />
                {seed(`${a.id}p`) < 0.7 ? (
                  <line
                    className="pulse"
                    x1={x1}
                    y1={y1}
                    x2={x0}
                    y2={y0}
                    pathLength={100}
                    style={{
                      animationDelay: `${(-seed(a.id) * 7).toFixed(2)}s`,
                      animationDuration: `${(5 + seed(`${a.id}d`) * 4).toFixed(1)}s`,
                    }}
                  />
                ) : null}
              </g>
            );
          })}
          {/* dashed tethers to what waits on you */}
          {asking.map((a) => {
            const r = Math.hypot(a.x, a.y);
            const [x0, y0] = polar(me.rim + 4, a.angle);
            const [x1, y1] = polar(Math.max(me.rim + 10, r - 20 * k), a.angle);
            return <line key={`t-${a.id}`} className="tether" x1={x0} y1={y0} x2={x1} y2={y1} />;
          })}
        </g>
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the centre repeats the summary the map's label already says */}
        <g aria-hidden="true">
          {world.centre(c)}
          {/* your rim points at each thing that waits on you */}
          {asking.map((a) => (
            <path key={`r-${a.id}`} className="you-arc" d={arcD(me.rim - 1.5, a.angle - 9, a.angle + 9)} />
          ))}
        </g>
        {model.crews.map((x) => (
          <Crew key={x.id} x={x} c={c} w={w} onOpen={() => open({ kind: "crew", project: x.project })} />
        ))}
        {[...model.agents]
          .sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y))
          .map((a) => (
            <Agent key={a.id} a={a} c={c} w={w} world={world} spot={labels.get(a.id)} onOpen={() => open(a.open)} />
          ))}
      </svg>
    </>
  );
});

/** Enter and space open, as on a button. */
const activate = (f: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    f();
  }
};

/**
 * One agent, its subagents, and its label: what waits on you is always named, at the spot the label pass found for it
 * (with a leader line when it had to go further out); the rest are named on hover or focus.
 */
function Agent({
  a,
  c,
  w,
  world,
  spot,
  onOpen,
}: {
  a: MapAgent;
  c: WorldCtx;
  w: Words;
  world: World;
  spot: LabelSpot | null | undefined;
  onOpen: () => void;
}) {
  const state = { waiting: w.mapWaiting, working: w.mapWorking, idle: w.mapIdle, done: w.mapDone }[a.state];
  const { k, u } = c;
  // without a spot (not named, or crowded out), the label shows on hover: out from you for what's waiting or idle,
  // below for the working ring
  const fallback = (): LabelSpot => {
    const d = Math.hypot(a.x, a.y) || 1;
    if (a.state === "working") return { x: a.x, y: a.y + u * 0.5 + 10 * k, anchor: "middle", leader: false };
    const out = a.state === "waiting" ? 1 : -1;
    const lx = a.x + (a.x / d) * out * 24 * k;
    return {
      x: lx,
      y: a.y + (a.y / d) * out * 24 * k,
      anchor: Math.abs(lx - a.x) < 8 * k ? "middle" : lx > a.x ? "start" : "end",
      leader: false,
    };
  };
  const at = spot ?? fallback();
  const named = a.state === "waiting" && Boolean(spot);
  const lx = at.x - a.x;
  const ly = at.y - a.y;
  const ld = Math.hypot(lx, ly) || 1;
  const subs = c.lod === "full" ? Math.min(a.subs, 4) : 0;
  const size = c.lod === "small" ? 11 : 11.5;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>; it carries the role and keys instead
    <g
      className={cn("ag", a.state, a.lead && "lead")}
      style={{ transform: `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)` }}
      role="button"
      tabIndex={0}
      aria-label={`${a.label}, ${state}${a.note ? `: ${a.note}` : ""}${a.subs ? `, ${fmt(w.mapHelpers, { n: a.subs })}` : ""}`}
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
    >
      <circle className="hit" r={Math.max(22 * k, u * 0.5)} />
      {Array.from({ length: subs }, (_, i) => {
        const [x, y] = world.orbit ? world.orbit(a, i, c) : polar(u * 0.8, -55 + i * 38);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: subagents are counted, not named
          <g key={i} className="sub" style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` }}>
            {world.links === "pulse" ? <line className="subline" x1={-x * 0.55} y1={-y * 0.55} x2={0} y2={0} /> : null}
            {world.companion(a, i, c)}
          </g>
        );
      })}
      {a.subs > 4 && c.lod === "full" ? (
        <text className="anote" x={u * 0.6} y={-u * 0.55} style={{ fontSize: 10 * k }}>
          +{a.subs - 4}
        </text>
      ) : null}
      <g className="fig">{world.character(a, c)}</g>
      {named && at.leader ? (
        <line
          className="leader"
          x1={(lx / ld) * u * 0.42}
          y1={(ly / ld) * u * 0.42}
          x2={lx - (lx / ld) * 3 * k}
          y2={ly - (ly / ld) * 3 * k}
        />
      ) : null}
      {/* what waits on you is named; its note, like everything about the others, shows on hover or focus */}
      <g className={cn("lab", named && "named")} transform={`translate(${lx.toFixed(1)} ${ly.toFixed(1)})`}>
        {named ? (
          <text
            className={cn("alabel-halo", !/\d/.test(a.label) && "word")}
            textAnchor={at.anchor}
            dominantBaseline="central"
            style={{ fontSize: size * k, strokeWidth: 3.5 * k }}
          >
            {a.label}
          </text>
        ) : null}
        <text
          className={cn("alabel", a.state === "waiting" && "you", !/\d/.test(a.label) && "word")}
          textAnchor={at.anchor}
          dominantBaseline="central"
          style={{ fontSize: size * k }}
        >
          {a.label}
        </text>
        {a.note ? (
          <text className="anote" textAnchor={at.anchor} dominantBaseline="central" y={size * 1.3 * k} style={{ fontSize: 10.5 * k }}>
            {a.note.length > 34 ? `${a.note.slice(0, 33)}…` : a.note}
          </text>
        ) : null}
      </g>
    </g>
  );
}

/** A crew: the quiet agents past the sector's cap, as a count with a dot per member in its state; words on hover. */
function Crew({ x, c, w, onOpen }: { x: MapCrew; c: WorldCtx; w: Words; onOpen: () => void }) {
  const { k, u } = c;
  const words = fmt(w.mapCrewOf, { n: x.count, project: x.project, working: x.working, idle: x.quiet });
  const n = Math.min(12, x.count);
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>; it carries the role and keys instead
    <g
      className="ag crew"
      style={{ transform: `translate(${x.x.toFixed(1)}px, ${x.y.toFixed(1)}px)` }}
      role="button"
      tabIndex={0}
      aria-label={words}
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
    >
      <circle className="hit" r={u * 0.6} />
      <rect className="crew-chip" x={-13 * k} y={-9 * k} width={26 * k} height={18 * k} rx={2 * k} />
      <text className="crew-count" textAnchor="middle" dy="0.36em" style={{ fontSize: 12 * k }}>
        {x.count}
      </text>
      {Array.from({ length: n }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: dots stand for counts
          key={i}
          cx={(i - (n - 1) / 2) * 7 * k}
          cy={16 * k}
          r={2.2 * k}
          fill={i < x.working ? "var(--ink-12)" : "var(--ink-8)"}
        />
      ))}
      <g className="lab">
        <text className="anote" textAnchor="middle" y={32 * k} style={{ fontSize: 10.5 * k }}>
          {fmt(w.mapCrew, { n: x.count })}
        </text>
      </g>
    </g>
  );
}

/**
 * One agent drawn alone, as the active world draws it on the map (an object of light, a satellite or comet, a train, a
 * koi), for a list beside the map: its state reads in its light and shape, as it does on the map. Still, decorative.
 */
export function AgentGlyph({
  world,
  state,
  lead = false,
  name,
  progress = 0.6,
  size = 40,
}: {
  world: WorldId;
  state: MapAgent["state"];
  lead?: boolean;
  /** Seeds the koi's pattern, so it matches its fish on the map. */
  name: string;
  progress?: number;
  size?: number;
}) {
  const { light } = useTheme();
  const id = useId().replace(/:/g, "");
  const w = WORLDS[world];
  const model: MapModel = { waiting: 0, sectors: [], agents: [], crews: [] };
  const c: WorldCtx = { model, k: 1, u: w.big ? 58 : 76, lod: "full", light, id, you: "" };
  const a: MapAgent = {
    id: name,
    label: name,
    note: "",
    state,
    lead,
    sector: 0,
    subs: 0,
    progress,
    open: { kind: "crew", project: "" },
    x: 0,
    y: 0,
    // a comet's tail streams up and to the right; a train and a koi run along the row
    angle: state === "waiting" ? 45 : 0,
    dir: 90,
  };
  return (
    <svg
      viewBox="-40 -40 80 80"
      width={size}
      height={size}
      className="attention-map glyph still shrink-0"
      data-world={world}
      aria-hidden="true"
    >
      <defs>
        <Atlas c={c} />
        {w.atlas(c)}
      </defs>
      <g className={cn("ag", state, lead && "lead")}>{w.character(a, c)}</g>
    </svg>
  );
}

/**
 * A person's hub on the Team view: their own small map in the active world, drawn still and out of the tab order (the
 * card around it is the control). On anyone's hub but yours, what waits on them is ink: only what waits on you is the
 * one colour.
 */
export function HubMap({
  projects,
  name,
  me,
  size,
  world,
  light,
  w,
}: {
  projects: readonly HubProject[];
  name: string;
  me: boolean;
  size: number;
  world: WorldId;
  light: boolean;
  w: Words;
}) {
  const model = hubModel(projects);
  return (
    <div inert aria-hidden="true" className={cn("hub-map relative", !me && "hub-theirs")} style={{ width: size, height: size }}>
      <MapSvg model={model} size={size} world={WORLDS[world]} light={light} still you={name} w={w} />
    </div>
  );
}
