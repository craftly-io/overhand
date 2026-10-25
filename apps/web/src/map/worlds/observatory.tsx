/**
 * Observatory: a night sky through a dome. Each project is a constellation (DiceBear Constellation, CC0, picked and
 * turned by the project's name); agents are satellites with solar panels holding their orbits; one that needs you is
 * a comet falling inward, its tail streaming away from you; helpers are small moons. You are the dome, its slit open.
 * The sky's depth (nebula, slow stars) is the GPU atmosphere layer (`atmosphere.ts`); without it, the 2D sky here shows.
 */
import { polar, R } from "../model";
import { dots, hash, seed, type World } from "../world";
import { CONSTELLATIONS } from "./constellations";
import { Badge, LIGHT, YouName } from "./instrument";

/** The 2D sky's stars, as three paths by brightness. */
const STARS = (() => {
  const b: [number, number, number][][] = [[], [], []];
  for (let s = 0; s < 340; s++) {
    const sz = hash(s + 77);
    b[sz > 0.93 ? 2 : sz > 0.6 ? 1 : 0]?.push([hash(s) * 1100 - 550, hash(s + 999) * 1100 - 550, sz > 0.96 ? 2 : sz > 0.8 ? 1.3 : 0.8]);
  }
  return b.map((l, i) => ({ d: dots(l), o: [0.2, 0.38, 0.55][i] ?? 0.3 }));
})();

export const observatory: World = {
  id: "observatory",
  rings: "dash",
  ticks: true,
  links: "trail",
  atmosphere: "sky",
  atlas: (c) => (
    <>
      <radialGradient id={`${c.id}sky`} cx="0.5" cy="0.45" r="0.7">
        {/* by day a star chart on paper: the same sky, inked pale */}
        <stop offset="0" stopColor={c.light ? "#dbe3ef" : "#0b1830"} />
        <stop offset="0.78" stopColor={c.light ? "#eef1f6" : "#04070d"} />
        <stop offset="1" stopColor={c.light ? "#eef1f6" : "#04070d"} stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}dome`} cx="0.35" cy="0.25" r="0.85">
        <stop offset="0" stopColor="#9c9c9a" />
        <stop offset="0.55" stopColor="#5c5c5a" />
        <stop offset="1" stopColor="#2e2e2d" />
      </radialGradient>
      <linearGradient id={`${c.id}tail`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="var(--you-fill)" stopOpacity="0.75" />
        <stop offset="1" stopColor="var(--you-fill)" stopOpacity="0" />
      </linearGradient>
    </>
  ),
  ground: (c) => (
    <>
      <g className="ground-2d">
        <circle r={560} fill={`url(#${c.id}sky)`} />
        <ellipse rx={900} ry={150} transform="rotate(-32)" fill="#9fb8da" opacity={0.07} filter={`url(#${c.id}blur40)`} />
        {STARS.map((s) => (
          <path key={s.o} d={s.d} fill={c.light ? "#313d56" : "#e6eef8"} opacity={s.o} />
        ))}
      </g>
      {/* each project is a constellation in its sector, picked and turned by its name */}
      {c.model.sectors.map((s) => {
        const pick = CONSTELLATIONS[Math.floor(seed(s.name) * CONSTELLATIONS.length)];
        if (!pick) return null;
        const [x, y] = polar(392, s.a0 + s.span / 2);
        const turn = Math.round(seed(`${s.name}turn`) * 60 - 30);
        return (
          <g
            key={s.name}
            className="constellation"
            transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${turn}) scale(1.9) translate(-50 -50)`}
            opacity={s.broken ? 0.3 : 0.5}
          >
            <path d={pick.lines} className="c-lines" />
            {pick.stars.map(([cx, cy, r]) => (
              <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} className="c-star" />
            ))}
            {pick.rings.map(([cx, cy, r]) => (
              <circle key={`r${cx},${cy}`} cx={cx} cy={cy} r={r} className="c-ring" />
            ))}
          </g>
        );
      })}
    </>
  ),
  centre: (c) => (
    <g className="you">
      <circle r={R.you * 2.4} fill={`url(#${c.id}halo)`} />
      <circle r={R.you} fill={`url(#${c.id}dome)`} className="dome" />
      {/* the slit, open on the sky, a little starlight in it */}
      <rect x={-7} y={-R.you + 4} width={14} height={R.you - 4} rx={2} fill="#04070d" />
      <rect x={-3} y={-R.you + 8} width={6} height={R.you - 14} fill="#e6eef8" opacity={0.5} />
      <Badge c={c} />
      <YouName c={c} />
    </g>
  ),
  character: (a, c) => {
    const u = c.u;
    if (a.state === "waiting") {
      // a comet falling inward: its tail streams away from you, brightest at the head
      const len = u * 1.25;
      return (
        <g className="comet" transform={`rotate(${a.angle - 90})`}>
          <path d={`M0 ${-u * 0.16} L${len} ${-u * 0.03} L${len} ${u * 0.03} L0 ${u * 0.16} Z`} fill={`url(#${c.id}tail)`} opacity={0.6} />
          <path d={`M0 ${-u * 0.07} L${len * 0.7} 0 L0 ${u * 0.07} Z`} fill={`url(#${c.id}tail)`} />
          <circle r={u * 0.45} fill={`url(#${c.id}h-waiting)`} />
          <circle className="light" r={u * 0.14} fill="#fff4dc" />
        </g>
      );
    }
    const dim = a.state === "idle";
    const pw = dim ? u * 0.24 : u * 0.44;
    return (
      <g className={dim ? "satellite dim" : "satellite"}>
        {[-1, 1].map((sx) => {
          const x0 = sx > 0 ? u * 0.16 : -u * 0.16 - pw;
          return (
            <g key={sx}>
              <rect className="panel" x={x0} y={-u * 0.09} width={pw} height={u * 0.18} />
              <path className="panel-cells" d={`M${x0 + pw / 3} ${-u * 0.09}v${u * 0.18}M${x0 + (pw * 2) / 3} ${-u * 0.09}v${u * 0.18}`} />
              <line className="strut" x1={sx * u * 0.1} y1={0} x2={sx * u * 0.16} y2={0} />
            </g>
          );
        })}
        <rect
          className="sat-body"
          x={-u * 0.11}
          y={-u * 0.14}
          width={u * 0.22}
          height={u * 0.28}
          rx={u * 0.03}
          fill={`url(#${c.id}dome)`}
        />
        {a.lead ? <line className="strut" x1={0} y1={-u * 0.14} x2={0} y2={-u * 0.3} /> : null}
        {dim ? null : <circle r={u * 0.16} fill={`url(#${c.id}h-${a.state})`} cy={-u * 0.02} />}
        <circle className="light" cy={-u * 0.02} r={u * 0.055} fill={dim ? "#4a5f7e" : LIGHT[a.state]} />
        {a.state === "done" ? <circle className="done-ring" r={u * 0.6} pathLength={100} /> : null}
      </g>
    );
  },
  // a comet's tail, so its name sits on the side away from it
  reach: (a, c) => (a.state === "waiting" ? [polar(c.u * 0.5, a.angle), polar(c.u * 1, a.angle)] : []),
  orbit: (_a, i, c) => polar(c.u * 0.85, -55 + i * 38),
  companion: (_a, _i, c) => <circle r={c.u * 0.1} fill={`url(#${c.id}planet)`} className="moon" />,
};
