/**
 * Transit: a living metro map on paper. Each project is a line in its own muted colour, out from the interchange (you)
 * with one 45° bend, stations at the rings and a terminus bar at the end (ringed in green once something merged).
 * Agents are trains along their line: what waits on you stands at your platform in platform orange, what's working
 * runs the middle section, what's idle or done stands in the depot on sidings. Helpers are carriages coupled behind.
 * A broken project's line is cut by a disruption marker. A river crosses the map.
 */
import { type MapAgent, type MapCrew, type MapModel, polar, R } from "../model";
import type { World } from "../world";
import { Badge, YouName } from "./instrument";

/** Muted line colours: none may read as a state (orange, green, red). */
const LINE = ["#4a6a96", "#7a6a9e", "#3e8282", "#6b7380"];
const lineOf = (sector: number) => LINE[sector % LINE.length] ?? "#6b7380";
/** Where a line bends: this far out from you, then 45° toward the nearer of straight up or straight down. */
const KNEE = 190;
const bend = (mid: number) => (Math.floor((((mid % 360) + 360) % 360) / 90) % 2 ? 45 : -45);

/** A point `r` along a sector's line, and the line's heading there. */
function along(m: MapModel, sector: number, r: number): { xy: [number, number]; dir: number } {
  const s = m.sectors[sector];
  const mid = s ? s.a0 + s.span / 2 : 0;
  if (r <= KNEE) return { xy: polar(r, mid), dir: mid };
  const [x0, y0] = polar(KNEE, mid);
  const [x1, y1] = polar(r - KNEE, mid + bend(mid));
  return { xy: [x0 + x1, y0 + y1], dir: mid + bend(mid) };
}

/** Each state's stretch of line: your platform, the running section, the depot. */
const ZONE: Record<MapAgent["state"], [number, number]> = {
  waiting: [112, 168],
  working: [215, 370],
  idle: [418, 496],
  done: [418, 496],
};

/** Trains onto their lines: spaced through their zone so none bunch; in the depot, either side of the line. */
function place(m: MapModel): MapModel {
  const groups = new Map<string, MapAgent[]>();
  for (const a of m.agents) {
    const key = `${a.sector}:${a.state === "done" ? "idle" : a.state}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const agents: MapAgent[] = [];
  for (const g of groups.values())
    g.forEach((a, i) => {
      const [z0, zEnd] = ZONE[a.state];
      // a crowded platform runs a little further out rather than stacking trains on each other
      const z1 = a.state === "waiting" ? Math.min(200, Math.max(zEnd, z0 + (g.length - 1) * 30)) : zEnd;
      const step = g.length > 1 ? (z1 - z0) / (g.length - 1) : 0;
      const r = g.length === 1 ? (z0 + z1) / 2 : z0 + i * step;
      const t = along(m, a.sector, r);
      let [x, y] = t.xy;
      // in the depot, or wherever a train and its carriages would touch the next, they stand on sidings either side
      if (g.length > 1 && (z0 >= 400 || step < 64 + Math.max(...g.map((x) => Math.min(4, x.subs))) * 24)) {
        const [sx, sy] = polar(30 * (i % 2 ? 1 : -1), t.dir + 90);
        x += sx;
        y += sy;
      }
      agents.push({ ...a, x, y, dir: t.dir, angle: (Math.atan2(x, -y) * 180) / Math.PI });
    });
  const crews: MapCrew[] = m.crews.map((c) => {
    const t = along(m, c.sector, 300);
    const [sx, sy] = polar(56, t.dir - 90);
    return { ...c, x: t.xy[0] + sx, y: t.xy[1] + sy, dir: t.dir };
  });
  return { ...m, agents, crews };
}

const pt = ([x, y]: [number, number]) => `${x.toFixed(1)} ${y.toFixed(1)}`;

export const transit: World = {
  id: "transit",
  rings: "faint",
  ticks: false,
  links: "none",
  big: true,
  place,
  // a station on the project's own line colour: a terminus bar across it, ringed in green once something merged
  hub: (p) => (
    <g style={{ stroke: lineOf(p.index) }}>
      <line className="terminus" x1={-26} y1={0} x2={26} y2={0} />
      <circle className="station" r={9} />
      {p.merged ? <circle className="terminus-ring" r={22} /> : null}
    </g>
  ),
  atlas: () => null,
  ground: (c) => (
    <>
      {/* a faint street grid and the river */}
      <path
        className="streets"
        d={Array.from({ length: 15 }, (_, i) => (i - 7) * 80)
          .map((v) => `M-560 ${v}H560M${v} -560V560`)
          .join("")}
      />
      <path className="river" d="M-700 260 C-500 160 -380 400 -80 300 S 420 80 700 170" />
      {c.model.sectors.map((s, i) => {
        const col = lineOf(i);
        const knee = along(c.model, i, KNEE).xy;
        const end = along(c.model, i, 500);
        const [tx, ty] = polar(16, end.dir + 90);
        const cut = s.broken ? ([along(c.model, i, 384).xy, along(c.model, i, 420).xy] as const) : null;
        return (
          <g key={s.name} style={{ stroke: col }}>
            {cut ? (
              <>
                <path className="metro" d={`M0 0L${pt(knee)}L${pt(cut[0])}`} />
                <path className="metro cut" d={`M${pt(cut[0])}L${pt(cut[1])}`} />
                <path className="metro" d={`M${pt(cut[1])}L${pt(end.xy)}`} />
              </>
            ) : (
              <path className="metro" d={`M0 0L${pt(knee)}L${pt(end.xy)}`} />
            )}
            {/* stations where the line crosses each ring */}
            {[140, 295, 440].map((r) => {
              const [x, y] = along(c.model, i, r).xy;
              return <circle key={r} className="station" cx={x} cy={y} r={9} />;
            })}
            {/* the terminus: a bar across the line, ringed in green once something merged */}
            <line className="terminus" x1={end.xy[0] - tx} y1={end.xy[1] - ty} x2={end.xy[0] + tx} y2={end.xy[1] + ty} />
            {s.merged ? <circle className="terminus-ring" cx={end.xy[0]} cy={end.xy[1]} r={24} /> : null}
            {cut
              ? (() => {
                  const [x, y] = along(c.model, i, 402).xy;
                  return (
                    <g className="disruption" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
                      <circle r={15} />
                      <text textAnchor="middle" dy="0.36em" style={{ fontSize: 18 }}>
                        !
                      </text>
                    </g>
                  );
                })()
              : null}
          </g>
        );
      })}
    </>
  ),
  centre: (c) => (
    <g className="you">
      <circle r={R.you} className="interchange" />
      <circle r={R.you - 14} className="interchange-inner" />
      <text textAnchor="middle" dy="0.36em" className="interchange-mark" style={{ fontSize: 20 }}>
        {c.you.slice(0, 1)}
      </text>
      <Badge c={c} />
      <YouName c={c} />
    </g>
  ),
  character: (a, c) => {
    const u = c.u;
    const col = a.state === "waiting" ? "var(--you-fill)" : a.state === "working" ? lineOf(a.sector) : "#a9a8a2";
    const L = u * 0.86;
    const W = u * 0.32;
    const win = (L - W * 1.4) / 3;
    return (
      <>
        <g transform={`rotate(${((a.dir ?? a.angle) - 90).toFixed(1)})`}>
          <rect x={-L / 2 + 2} y={-W / 2 + 4} width={L} height={W} rx={W / 2} className="train-shadow" />
          <rect x={-L / 2} y={-W / 2} width={L} height={W} rx={W / 2} fill={col} className="train" />
          {[0, 1, 2].map((i) => (
            <rect key={i} x={-L / 2 + W * 0.55 + i * win} y={-W * 0.22} width={win - 3} height={W * 0.44} rx={2} className="window" />
          ))}
          <circle
            className="light"
            cx={L / 2 - W * 0.3}
            r={W * 0.16}
            fill={a.state === "idle" ? "#6e6e6a" : a.state === "done" ? "var(--ok)" : "#fff6d8"}
          />
        </g>
        {a.state === "waiting" ? <circle className="breathe-ring" r={L * 0.62} /> : null}
        {a.state === "done" ? <circle className="done-ring" r={L * 0.6} pathLength={100} /> : null}
      </>
    );
  },
  reach: (a, c) => [polar(c.u * 0.32, a.dir ?? a.angle), polar(-c.u * 0.32, a.dir ?? a.angle)],
  // carriages couple behind the train, along the line
  orbit: (a, i, c) => polar(-(c.u * 0.72 + i * c.u * 0.4), a.dir ?? a.angle),
  companion: (a, _i, c) => {
    const L = c.u * 0.36;
    const W = c.u * 0.3;
    return (
      <g transform={`rotate(${((a.dir ?? a.angle) - 90).toFixed(1)})`}>
        <rect x={-L / 2} y={-W / 2} width={L} height={W} rx={W * 0.3} fill={lineOf(a.sector)} className="train" />
        <rect x={-L * 0.3} y={-W * 0.2} width={L * 0.6} height={W * 0.4} rx={1.5} className="window" />
      </g>
    );
  },
};
