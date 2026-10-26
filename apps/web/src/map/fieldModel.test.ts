import { expect, test } from "bun:test";
import { arrange, type Box, slots } from "./fieldModel";

const area: Box = { x: 0, y: 0, w: 1100, h: 640 };
const cards: Box = { x: 0, y: 0, w: 380, h: 420 };
const names = [
  "Mobile app",
  "Online shop",
  "Booking app",
  "Company website",
  "Payments",
  "Admin panel",
  "Docs site",
  "Data pipeline",
  "Support bot",
  "Design system",
];

test("ten projects each get a place of their own, clear of the panes and apart from each other", () => {
  const at = arrange(
    names.map((name, i) => ({ name, weight: 10 - i })),
    area,
    [cards],
  );
  const ps = [...at.values()];
  expect(new Set(ps.map((p) => `${p.x},${p.y}`)).size).toBe(names.length);
  for (const p of ps) expect(p.x > cards.x + cards.w + 90 || p.y > cards.y + cards.h + 70).toBe(true);
  const gaps = ps.flatMap((a, i) => ps.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)));
  expect(Math.min(...gaps)).toBeGreaterThan(110);
});

test("the busiest project takes the middle, and the places don't change with the weights' order of arrival", () => {
  const list = names.map((name, i) => ({ name, weight: i === 4 ? 99 : 1 }));
  const a = arrange(list, area, []);
  const b = arrange([...list].reverse(), area, []);
  const first = slots(names.length, area, [])[0];
  expect(a.get("Payments")).toEqual(first);
  expect(b.get("Payments")).toEqual(first);
});

test("with the cards gone the field takes their side too", () => {
  const busy = slots(10, area, [cards]);
  const clear = slots(10, area, []);
  expect(Math.min(...clear.map((p) => p.x))).toBeLessThan(Math.min(...busy.map((p) => p.x)));
});

test("no room, no places: a field squeezed to nothing places none", () => {
  expect(arrange([{ name: "x", weight: 1 }], { x: 0, y: 0, w: 100, h: 80 }, [{ x: 0, y: 0, w: 100, h: 80 }]).size).toBe(0);
});
