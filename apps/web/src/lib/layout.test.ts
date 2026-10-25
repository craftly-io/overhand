import { expect, test } from "bun:test";
import { dockWidth } from "./layout";

test("views dock beside Now from 3xl, and Work never leaves it less than 960px", () => {
  expect(dockWidth("crew", 2199)).toBe(0);
  expect(dockWidth("crew", 2560)).toBe(768);
  expect(dockWidth("work", 2200)).toBe(1240);
  expect(dockWidth("work", 5120)).toBe(1600);
  for (const v of [2200, 2560, 3440, 5120]) expect(v - dockWidth("work", v)).toBeGreaterThanOrEqual(960);
});
