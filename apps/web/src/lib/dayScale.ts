/**
 * The day as an elastic track: every quarter hour gets room by how much ran in it, so a busy afternoon spreads out
 * and a quiet night folds into a sliver. A day with nothing in it stays even. Pure, and both ways: a time to a place
 * on the track (0…100) and back.
 */

const BIN = 15 * 60_000;
const BINS = 96;
/** The room an empty quarter hour keeps: enough to see that time passed. */
const FLOOR = 0.22;

export interface DayScale {
  /** A time (epoch ms) to its place on the track, in percent. */
  x: (ms: number) => number;
  /** A place on the track (percent) back to its time. */
  at: (pct: number) => number;
  /** Stretches of two hours or more where nothing ran, to mark as quiet. */
  quiet: { from: number; to: number }[];
}

/** The track for the day that starts at `start` (local midnight), from its runs; `now` gets a little extra room. */
export function dayScale(start: number, runs: readonly { start: number; end: number }[], now: number): DayScale {
  const busy = Array.from({ length: BINS }, (_, i) => {
    const a = start + i * BIN;
    return runs.filter((r) => r.start < a + BIN && r.end > a).length;
  });
  const w = busy.map((n, i) => FLOOR + Math.sqrt(n) + (now >= start + i * BIN && now < start + (i + 1) * BIN ? 1 : 0));
  const cum = [0];
  for (const v of w) cum.push((cum.at(-1) ?? 0) + v);
  const total = cum.at(-1) ?? 1;
  const x = (ms: number) => {
    const f = Math.max(0, Math.min(BINS, (ms - start) / BIN));
    const i = Math.min(BINS - 1, Math.floor(f));
    return (((cum[i] ?? 0) + (f - i) * (w[i] ?? FLOOR)) / total) * 100;
  };
  const at = (pct: number) => {
    const target = (Math.max(0, Math.min(100, pct)) / 100) * total;
    let i = 0;
    while (i < BINS - 1 && (cum[i + 1] ?? 0) < target) i++;
    return start + (i + (target - (cum[i] ?? 0)) / (w[i] ?? FLOOR)) * BIN;
  };
  const quiet: { from: number; to: number }[] = [];
  for (let i = 0; i < BINS; ) {
    let j = i;
    while (j < BINS && busy[j] === 0 && start + j * BIN < now) j++;
    if (j - i >= 8) quiet.push({ from: start + i * BIN, to: start + j * BIN });
    i = Math.max(j, i + 1);
  }
  return { x, at, quiet };
}
