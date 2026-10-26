import { expect, test } from "bun:test";
import { dayScale } from "./dayScale";

const day = new Date(2026, 9, 26).getTime();
const h = (n: number) => day + n * 3_600_000;

test("a day with nothing in it is an even track", () => {
  const s = dayScale(day, [], h(30));
  expect(s.x(h(12))).toBeCloseTo(50, 5);
  expect(s.x(h(6))).toBeCloseTo(25, 5);
});

test("busy hours get more room than quiet ones, and the night folds", () => {
  const runs = [11, 12, 13].flatMap((at) => [0, 1, 2, 3].map(() => ({ start: h(at), end: h(at + 1) })));
  const s = dayScale(day, runs, h(14.3));
  expect(s.x(h(14)) - s.x(h(11))).toBeGreaterThan(40);
  expect(s.x(h(7))).toBeLessThan(15);
  expect(s.quiet[0]).toEqual({ from: day, to: h(11) });
});

test("a place on the track turns back into its time", () => {
  const s = dayScale(day, [{ start: h(9), end: h(10.5) }], h(14));
  for (const t of [h(3), h(9.25), h(13.75), h(20)]) expect(Math.abs(s.at(s.x(t)) - t)).toBeLessThan(1000);
});
