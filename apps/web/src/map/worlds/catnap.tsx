/**
 * Catnap: a sunny flat. The rug is the map, and you are the armchair cushion at its centre. Agents are cats, their
 * coats seeded by their names: one with nothing to do sleeps curled at the rug's edge, a working one sits up, and one
 * that needs you has come close, its eyes lit in the world's one colour and its tail a question mark. A finished one is
 * a loaf with a green tag. Helpers are kittens beside their cat. The room (planks, sofa, bookshelf, a plant, the window's
 * light by day or the lamp's at night) is the quiet ground under it all.
 */
import { type MapAgent, polar, R } from "../model";
import { hash, seed, type World, type WorldCtx } from "../world";
import { Badge, YouName } from "./instrument";

/** Coats: fur and its shade. Ginger, cream, grey, black, tabby brown. */
const COATS: readonly (readonly [string, string])[] = [
  ["#d59a63", "#b97a44"],
  ["#eadac1", "#cdb89a"],
  ["#a9a9a6", "#878784"],
  ["#4c4541", "#36302d"],
  ["#9c7656", "#7b5a3f"],
];
const coat = (key: string) => COATS[Math.floor(seed(`${key}coat`) * COATS.length)] ?? ["#d59a63", "#b97a44"];

/** The room's materials by day and at night. */
const ROOM = {
  day: {
    floor: "#efe3cf",
    plank: "#e2d3ba",
    sofa: ["#c7ae8c", "#d7bf9c", "#e3cfaf"],
    shelf: "#b89a73",
    pot: "#b98d6a",
    leaf: "#86996c",
    pouf: "#d9c6a6",
  },
  night: {
    floor: "#211a15",
    plank: "#2a221c",
    sofa: ["#3a2e27", "#45372e", "#4e3f34"],
    shelf: "#33291f",
    pot: "#3b2e25",
    leaf: "#2e3a26",
    pouf: "#2b231d",
  },
} as const;
const RUG = {
  day: { base: "#e7d6bb", fringe: "#d9c4a2", outer: "#e0cba8", middle: "#ead9bc", inner: "#f1e2c6", weave: "#b79e7a" },
  night: { base: "#3b2f27", fringe: "#4a3c32", outer: "#45372d", middle: "#4e3e32", inner: "#5a4535", weave: "#000000" },
} as const;
const BOOKS = ["#8c6a4f", "#7c8b6e", "#a98466", "#6f7d8c", "#b5937a"];

/** The rug's fringe: a short thread every two degrees, as one path. */
const FRINGE = Array.from({ length: 180 }, (_, i) => {
  const [x0, y0] = polar(R.r3 + 26, i * 2);
  const [x1, y1] = polar(R.r3 + 40, i * 2);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}`;
}).join("");

/** The rug's weave: a fine ring every 9 units. */
const WEAVE = Array.from({ length: Math.ceil((R.r3 + 20 - R.r0) / 9) }, (_, i) => R.r0 + i * 9);

/** The floor's planks and their staggered joints, as one path. */
const PLANKS = Array.from({ length: 25 }, (_, n) => {
  const j = n - 12;
  const off = (j % 2) * 230 + hash(j) * 400 - 200;
  return `M-1400 ${j * 64}H1400M${off.toFixed(0)} ${j * 64}v64`;
}).join("");

interface Pose {
  id: string;
  state: MapAgent["state"];
  lead: boolean;
  /** Where the eyes look, left (-1) to right (1). */
  look: number;
}

/** A cat about `u` across: curled asleep (idle, done) or sitting up (working, waiting), with its coat. */
function Cat({ p, u, c }: { p: Pose; u: number; c: WorldCtx }) {
  const [fur, shade] = coat(p.id);
  if (p.state === "idle" || p.state === "done") {
    const hx = -u * 0.3;
    const hy = u * 0.16;
    return (
      <g className="cat asleep">
        <ellipse cy={u * 0.5} rx={u * 0.5} ry={u * 0.1} className="shadow" />
        <path
          className="fur"
          fill={fur}
          d={`M${-u * 0.55} ${u * 0.45}C${-u * 0.6} ${u * 0.05} ${-u * 0.1} ${-u * 0.08} ${u * 0.25} ${u * 0.05}C${u * 0.6} ${u * 0.18} ${u * 0.62} ${u * 0.48} ${u * 0.3} ${u * 0.5}Z`}
        />
        <path
          className="tail"
          stroke={shade}
          d={`M${-u * 0.5} ${u * 0.44}C${-u * 0.2} ${u * 0.58} ${u * 0.3} ${u * 0.56} ${u * 0.5} ${u * 0.38}`}
        />
        <path
          fill={shade}
          d={`M${hx - u * 0.17} ${hy - u * 0.04}L${hx - u * 0.2} ${hy - u * 0.26}L${hx - u * 0.04} ${hy - u * 0.14}L${hx + u * 0.08} ${hy - u * 0.2}L${hx + u * 0.14} ${hy - u * 0.02}Z`}
        />
        <ellipse className="fur" cx={hx} cy={hy} rx={u * 0.2} ry={u * 0.16} fill={fur} />
        {/* closed eyes */}
        <path
          className="lids"
          d={`M${hx - u * 0.11} ${hy}q${u * 0.04} ${u * 0.03} ${u * 0.08} 0M${hx + u * 0.03} ${hy}q${u * 0.04} ${u * 0.03} ${u * 0.08} 0`}
        />
        {p.lead ? <circle cx={hx + u * 0.16} cy={hy + u * 0.1} r={u * 0.04} className="bell" /> : null}
        {p.state === "done" ? <circle className="tag" cx={hx + u * 0.02} cy={hy + u * 0.2} r={u * 0.05} /> : null}
      </g>
    );
  }
  const asks = p.state === "waiting";
  const look = p.look * u * 0.05;
  // waiting, the tail curls into a question mark; working, it swishes
  const tail = asks
    ? `M${u * 0.3} ${u * 0.45}C${u * 0.62} ${u * 0.4} ${u * 0.58} ${-u * 0.02} ${u * 0.42} ${-u * 0.12}C${u * 0.3} ${-u * 0.2} ${u * 0.22} ${-u * 0.08} ${u * 0.3} ${-u * 0.02}`
    : `M${u * 0.3} ${u * 0.45}C${u * 0.7} ${u * 0.48} ${u * 0.72} ${u * 0.2} ${u * 0.6} ${u * 0.1}`;
  return (
    <g className="cat">
      <ellipse cy={u * 0.5} rx={u * 0.42} ry={u * 0.09} className="shadow" />
      {asks ? <circle cy={-u * 0.1} r={u * 0.8} fill={`url(#${c.id}h-waiting)`} /> : null}
      <path
        className={asks ? "tail ask" : "tail swish"}
        stroke={shade}
        d={tail}
        style={{ transformOrigin: `${u * 0.3}px ${u * 0.45}px` }}
      />
      <path
        className="fur"
        fill={fur}
        d={`M${-u * 0.36} ${u * 0.5}C${-u * 0.42} ${u * 0.12} ${-u * 0.22} ${-u * 0.02} 0 ${-u * 0.02}C${u * 0.22} ${-u * 0.02} ${u * 0.42} ${u * 0.12} ${u * 0.36} ${u * 0.5}Z`}
      />
      <path className="paws" d={`M${-u * 0.12} ${u * 0.5}L${-u * 0.1} ${u * 0.3}M${u * 0.12} ${u * 0.5}L${u * 0.1} ${u * 0.3}`} />
      <path
        className="fur"
        fill={shade}
        d={`M${-u * 0.24} ${-u * 0.22}L${-u * 0.22} ${-u * 0.52}L${-u * 0.04} ${-u * 0.36}ZM${u * 0.24} ${-u * 0.22}L${u * 0.22} ${-u * 0.52}L${u * 0.04} ${-u * 0.36}Z`}
      />
      <ellipse className="fur" cy={-u * 0.2} rx={u * 0.27} ry={u * 0.23} fill={fur} />
      {[-1, 1].map((sx) => (
        <g key={sx}>
          <ellipse className={asks ? "eye light" : "eye"} cx={sx * u * 0.1 + look} cy={-u * 0.22} rx={u * 0.045} ry={u * 0.055} />
          <circle cx={sx * u * 0.1 + look + u * 0.015} cy={-u * 0.24} r={u * 0.012} className="glint" />
        </g>
      ))}
      <path className="nose" d={`M${look - u * 0.03} ${-u * 0.13}L${look + u * 0.03} ${-u * 0.13}L${look} ${-u * 0.1}Z`} />
      {p.lead ? (
        <>
          <path className="collar" d={`M${-u * 0.2} ${u * 0.02}Q0 ${u * 0.1} ${u * 0.2} ${u * 0.02}`} />
          <circle cy={u * 0.08} r={u * 0.045} className="bell" />
        </>
      ) : null}
    </g>
  );
}

/** Which way a cat's eyes turn: one that needs you looks at you. */
const lookOf = (a: MapAgent) => (a.state === "waiting" ? -Math.sin((a.angle * Math.PI) / 180) : 0);

export const catnap: World = {
  id: "catnap",
  rings: "faint",
  ticks: false,
  links: "trail",
  // a project is a cushion on the rug (its colour from its name), flat and dim where it's broken
  hub: (p, c) => {
    const tone = c.light ? ROOM.day.pouf : ROOM.night.pouf;
    const fur = coat(p.name)[0];
    return (
      <g opacity={p.broken ? 0.5 : 1}>
        <ellipse cy={8} rx={30} ry={11} fill="#000" opacity={0.14} />
        <ellipse rx={29} ry={17} fill={tone} />
        <ellipse cy={-3} rx={21} ry={10} fill={fur} opacity={0.55} />
        {p.merged ? <circle cx={16} cy={-6} r={3.2} fill="var(--ok)" /> : null}
      </g>
    );
  },
  atlas: (c) => (
    <>
      <radialGradient id={`${c.id}lamp`}>
        <stop offset="0" stopColor="#f6c88a" stopOpacity="0.22" />
        <stop offset="1" stopColor="#f6c88a" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${c.id}fade`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="520">
        <stop offset="0.9" stopColor="#fff" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <mask id={`${c.id}floorfade`} maskUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200">
        <rect x={-600} y={-600} width={1200} height={1200} fill={`url(#${c.id}fade)`} />
      </mask>
    </>
  ),
  ground: (c) => {
    const room = c.light ? ROOM.day : ROOM.night;
    const rug = c.light ? RUG.day : RUG.night;
    return (
      <>
        {/* the floor round the rug, fading into the page before the map's edge, so the room has no hard frame */}
        <g mask={`url(#${c.id}floorfade)`}>
          <circle r={540} fill={room.floor} />
          <path d={PLANKS} stroke={room.plank} strokeWidth={2} fill="none" />
        </g>
        {/* the room's corners: a sofa, the bookshelf, a plant and a pouf, each facing the rug */}
        <g transform="translate(-408 -408) rotate(-45)">
          <rect x={-100} y={-48} width={200} height={96} rx={28} fill={room.sofa[0]} />
          <rect x={-90} y={-48} width={180} height={38} rx={18} fill={room.sofa[1]} />
          <rect x={-78} y={-4} width={74} height={40} rx={14} fill={room.sofa[2]} />
          <rect x={4} y={-4} width={74} height={40} rx={14} fill={room.sofa[2]} />
        </g>
        <g transform="translate(402 -402) rotate(45)">
          <rect x={-120} y={-37} width={240} height={66} fill={room.shelf} />
          {BOOKS.concat(BOOKS).map((b, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: the books never move
              key={i}
              x={-112 + i * 22}
              y={-31 + (i % 3) * 4}
              width={16}
              height={54 - (i % 3) * 4}
              fill={b}
              opacity={c.light ? 0.85 : 0.55}
            />
          ))}
        </g>
        <circle cx={455} cy={455} r={46} fill={room.pot} />
        {Array.from({ length: 9 }, (_, l) => {
          const [x, y] = polar(46, l * 40);
          return (
            <ellipse
              // biome-ignore lint/suspicious/noArrayIndexKey: the leaves never move
              key={l}
              cx={455 + x}
              cy={455 + y}
              rx={40}
              ry={15}
              transform={`rotate(${l * 40 + 90} ${(455 + x).toFixed(1)} ${(455 + y).toFixed(1)})`}
              fill={room.leaf}
              opacity={0.9}
            />
          );
        })}
        <circle cx={-450} cy={450} r={42} fill={room.pouf} opacity={0.9} />
        {/* the rug is the map: its fringe, its three bands for the rings, its weave */}
        <circle r={R.r3 + 26} fill={rug.base} />
        <path d={FRINGE} stroke={rug.fringe} strokeWidth={2} />
        <circle r={(R.r2 + R.r3) / 2} fill="none" stroke={rug.outer} strokeWidth={R.r3 - R.r2} />
        <circle r={(R.r1 + R.r2) / 2} fill="none" stroke={rug.middle} strokeWidth={R.r2 - R.r1} />
        <circle r={(R.r0 + R.r1) / 2} fill="none" stroke={rug.inner} strokeWidth={R.r1 - R.r0 + 2} />
        <g fill="none" stroke={rug.weave} strokeOpacity={0.08}>
          {WEAVE.map((r) => (
            <circle key={r} r={r} />
          ))}
        </g>
        {/* light: the window's by day, a lamp's at night, fading out with the floor so neither shows the map's edge */}
        <g mask={`url(#${c.id}floorfade)`}>
          {c.light ? (
            <g opacity={0.42} filter={`url(#${c.id}blur40)`}>
              <path d="M-1000 -900L-300 -900L640 900L-60 900Z" fill="#fff8e6" />
              <path d="M-690 -900L-650 -900L290 900L250 900Z" fill="#e3d2b4" opacity={0.7} />
            </g>
          ) : (
            <circle cx={-360} cy={-300} r={700} fill={`url(#${c.id}lamp)`} />
          )}
        </g>
        {c.light ? null : <circle cx={-300} cy={-478} r={34} className="lampshade" />}
      </>
    );
  },
  centre: (c) => (
    <g className="you">
      <circle cy={5} r={R.you + 4} className="shadow" />
      <circle r={R.you} fill={c.light ? "#b9846a" : "#7a5442"} />
      <circle r={R.you - 8} fill={c.light ? "#c8957a" : "#8a604c"} />
      {[
        [-14, -12],
        [14, -12],
        [0, 14],
      ].map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r={2.6} className="tuft" />
      ))}
      <Badge c={c} />
      <YouName c={c} />
    </g>
  ),
  character: (a, c) => <Cat p={{ id: a.id, state: a.state, lead: a.lead, look: lookOf(a) }} u={c.u} c={c} />,
  reach: (_a, c) => [
    [c.u * 0.6, c.u * 0.2],
    [-c.u * 0.5, c.u * 0.4],
  ],
  // kittens sit at their cat's feet, either side
  orbit: (_a, i, c) => [(i % 2 ? 1 : -1) * c.u * (0.62 + Math.floor(i / 2) * 0.32), c.u * 0.42],
  companion: (a, i, c) => (
    <Cat p={{ id: `${a.id}k${i}`, state: a.state === "working" ? "working" : "idle", lead: false, look: 0 }} u={c.u * 0.38} c={c} />
  ),
};
