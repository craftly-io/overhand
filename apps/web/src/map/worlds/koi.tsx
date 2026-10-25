/**
 * Koi Pond: a pond at dusk. Lily pads are the projects (a lotus opens on a pad for each merge; a broken project's
 * water turns murky). Agents are koi, each with a pattern seeded by its name: working ones swim round the pond (their
 * tails wag), idle ones drift by the pads, and one that needs you has come to your stone, lit in lantern gold. Helpers
 * are fry, following their parent. The water's living light is the GPU atmosphere layer (`atmosphere.ts`); without
 * it, the 2D water and caustics here show instead.
 */
import { type MapAgent, polar, R } from "../model";
import { hash, seed, type World } from "../world";
import { Badge, LIGHT, YouName } from "./instrument";

const pick = <T,>(key: string, list: readonly T[]): T | undefined => list[Math.floor(seed(key) * list.length)];

/** Which way a koi faces: one that needs you faces your stone; the working swim round; the idle drift. */
const heading = (a: MapAgent) =>
  a.state === "waiting" ? a.angle + 180 : a.state === "idle" ? a.angle + 140 + seed(a.id) * 80 : a.angle + 90;

export const koi: World = {
  id: "koi",
  rings: "dash",
  ticks: false,
  links: "trail",
  big: true,
  atmosphere: "water",
  atlas: (c) => (
    <>
      <radialGradient id={`${c.id}water`} cx="0.5" cy="0.45" r="0.6">
        {/* by day clear green water, its edge the page's paper */}
        <stop offset="0" stopColor={c.light ? "#7fb2aa" : "#1e4a4c"} />
        <stop offset="0.6" stopColor={c.light ? "#a9cfc7" : "#0f2e31"} />
        <stop offset={c.light ? 0.8 : 1} stopColor={c.light ? "#f1f6f4" : "#071a1c"} />
      </radialGradient>
      <radialGradient id={`${c.id}stone`} cx="0.4" cy="0.35" r="0.8">
        <stop offset="0" stopColor="#9aa29e" />
        <stop offset="0.7" stopColor="#6b7470" />
        <stop offset="1" stopColor="#4a524f" />
      </radialGradient>
      <radialGradient id={`${c.id}murk`}>
        <stop offset="0" stopColor="#6b5a3a" stopOpacity="0.55" />
        <stop offset="1" stopColor="#6b5a3a" stopOpacity="0" />
      </radialGradient>
    </>
  ),
  ground: (c) => (
    <>
      <g className="ground-2d">
        <rect x={-600} y={-600} width={1200} height={1200} fill={`url(#${c.id}water)`} />
        <g filter={`url(#${c.id}blur14)`} opacity={0.22}>
          {Array.from({ length: 46 }, (_, i) => {
            const [x, y] = [hash(i) * 1100 - 550, hash(i + 50) * 1100 - 550];
            return (
              <ellipse
                // biome-ignore lint/suspicious/noArrayIndexKey: the caustics never move
                key={i}
                cx={x}
                cy={y}
                rx={30 + hash(i + 9) * 60}
                ry={8 + hash(i + 3) * 14}
                transform={`rotate(${(hash(i + 7) * 180).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})`}
                fill={c.light ? "#ffffff" : "#bfe3d9"}
              />
            );
          })}
        </g>
      </g>
      {/* murky water where something is broken */}
      {c.model.sectors.map((s) => {
        if (!s.broken) return null;
        const [x, y] = polar(330, s.a0 + s.span / 2);
        return <ellipse key={s.name} cx={x} cy={y} rx={190} ry={140} fill={`url(#${c.id}murk)`} />;
      })}
      {/* stepping stones round your seat */}
      {Array.from({ length: 9 }, (_, i) => {
        const [x, y] = polar(R.you + 26 + hash(i) * 10, i * 40 + 10);
        // biome-ignore lint/suspicious/noArrayIndexKey: the stones never move
        return <ellipse key={i} className="step" cx={x} cy={y} rx={15 + hash(i + 2) * 8} ry={11 + hash(i + 4) * 6} />;
      })}
      {/* lily pads are the projects: three each, a lotus on a pad for each merge */}
      {c.model.sectors.flatMap((s, si) =>
        [0, 1, 2].map((k) => {
          const ang = s.a0 + 14 + (k * (s.span - 28)) / 2;
          const [x, y] = polar(420 + (k % 2 ? -26 : 18), ang);
          const r = 34 + hash(si * 7 + k) * 20;
          const notch = hash(si + k) * 360;
          const [ax, ay] = polar(r, notch - 14);
          const [bx, by] = polar(r, notch + 14);
          return (
            <g key={`${s.name}${k}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
              <path
                className={s.broken ? "pad murky" : "pad"}
                d={`M0 0L${ax.toFixed(1)} ${ay.toFixed(1)}A${r} ${r} 0 1 0 ${bx.toFixed(1)} ${by.toFixed(1)}Z`}
              />
              {k < s.merged ? (
                <g className="lotus">
                  {Array.from({ length: 8 }, (_, p) => {
                    const [px, py] = polar(9, p * 45);
                    return (
                      <ellipse
                        // biome-ignore lint/suspicious/noArrayIndexKey: petals never move
                        key={p}
                        cx={px}
                        cy={py}
                        rx={10}
                        ry={5}
                        transform={`rotate(${p * 45 + 90} ${px.toFixed(1)} ${py.toFixed(1)})`}
                      />
                    );
                  })}
                  <circle r={5} className="lotus-heart" />
                </g>
              ) : null}
            </g>
          );
        }),
      )}
    </>
  ),
  centre: (c) => (
    <g className="you">
      <ellipse cx={3} cy={6} rx={R.you + 4} ry={R.you - 2} className="shadow" />
      <ellipse rx={R.you + 4} ry={R.you - 2} fill={`url(#${c.id}stone)`} />
      <path d="M-26 -20 q10 -12 26 -10" className="moss" />
      <Badge c={c} />
      <YouName c={c} />
    </g>
  ),
  character: (a, c) => {
    const u = c.u;
    const base = pick(`${a.id}b`, ["#f4f1ea", "#e9e4d8", "#c9cccb", "#f6f0e2"]);
    const patch = pick(`${a.id}p`, ["#2b2b2b", "#4a4f52", "#8c8f8d", "#2b2b2b"]);
    const L = u * 1.15;
    const W = u * 0.3;
    return (
      <>
        {a.state === "waiting" ? <circle r={u * 0.75} fill={`url(#${c.id}h-waiting)`} /> : null}
        <g transform={`rotate(${(heading(a) - 90).toFixed(1)})`} opacity={a.state === "idle" ? 0.55 : 1}>
          <ellipse cx={3} cy={6} rx={L * 0.45} ry={W * 0.5} className="shadow" />
          <g className="koitail" style={{ transformOrigin: `${(-L * 0.38).toFixed(1)}px 0px` }}>
            <path d={`M${-L * 0.38} 0L${-L * 0.62} ${-W * 0.55}Q${-L * 0.52} 0 ${-L * 0.62} ${W * 0.55}Z`} fill={base} opacity={0.85} />
          </g>
          <path
            className="koi-body"
            d={`M${L * 0.5} 0C${L * 0.4} ${-W * 0.62} ${-L * 0.2} ${-W * 0.55} ${-L * 0.42} 0C${-L * 0.2} ${W * 0.55} ${L * 0.4} ${W * 0.62} ${L * 0.5} 0Z`}
            fill={base}
          />
          {[-1, 1].map((s) => (
            <ellipse
              key={s}
              cx={L * 0.1}
              cy={W * 0.475 * s}
              rx={L * 0.1}
              ry={W * 0.18}
              fill={base}
              opacity={0.7}
              transform={`rotate(${30 * s} ${L * 0.1} ${W * 0.475 * s})`}
            />
          ))}
          {/* the pattern, seeded by the name: the same koi tomorrow */}
          {[0, 1, 2].map((p) => (
            <ellipse
              key={p}
              cx={(seed(`${a.id}${p}`) - 0.45) * L * 0.6}
              cy={(seed(`${a.id}y${p}`) - 0.5) * W * 0.5}
              rx={L * (0.1 + seed(`${a.id}w${p}`) * 0.12)}
              ry={W * 0.32}
              fill={patch}
              opacity={0.9}
            />
          ))}
          <circle className="light" cx={L * 0.38} r={W * 0.13} fill={a.state === "idle" ? "#5e6a68" : LIGHT[a.state]} />
        </g>
        {a.state === "done" ? <circle className="done-ring" r={u * 0.7} pathLength={100} /> : null}
      </>
    );
  },
  reach: (a, c) => [polar(c.u * 0.38, heading(a)), polar(-c.u * 0.45, heading(a))],
  // fry fall in behind their parent, a little either side
  orbit: (a, i, c) => {
    const hd = heading(a);
    const [x, y] = polar(-(c.u * 0.75 + i * c.u * 0.32), hd);
    const [sx, sy] = polar(c.u * 0.14 * (i % 2 ? 1 : -1), hd + 90);
    return [x + sx, y + sy];
  },
  companion: (a, _i, c) => {
    const u = c.u;
    return (
      <g transform={`rotate(${(heading(a) - 90).toFixed(1)})`} className="fry">
        <ellipse rx={u * 0.16} ry={u * 0.055} fill="#efeae0" opacity={0.9} />
        <ellipse cx={u * 0.02} rx={u * 0.05} ry={u * 0.035} fill="#4a4f52" opacity={0.8} />
        <path d={`M${-u * 0.15} 0l${-u * 0.08} ${-u * 0.05}l0 ${u * 0.1}Z`} fill="#efeae0" opacity={0.75} />
      </g>
    );
  },
};
