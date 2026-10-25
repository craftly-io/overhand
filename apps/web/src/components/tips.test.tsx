import { beforeEach, expect, test } from "bun:test";
import type { Feature } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { closed, firstSight, localDay, shown, type TipsSeen, tipAt } from "@/app/tips";
import { render, withDom } from "./render.test-util";

/**
 * Tips about new features: one quiet line beside a new feature's control, at most one a day, never on the first day,
 * never again once shown, gone for good once closed, and none with Settings' switch off.
 */
withDom();
beforeEach(() => localStorage.clear());

const feature = (id: string, since: string, where: string): Feature => ({
  id,
  name: id,
  line: `${id} does a thing.`,
  area: "overhand",
  since,
  source: "x.ts",
  docs: "docs/everyday.html#new",
  tip: { text: `New: ${id}.`, where },
});
const LIST = [feature("a", "2026-10-23", "here"), feature("b", "2026-10-24", "here"), feature("c", "2026-10-23", "there")];
const rec = (over: Partial<TipsSeen> = {}): TipsSeen => ({ first: "2026-10-20", from: "2026-10-22", seen: [], today: null, ...over });
const on = (today: string) => ({ today, dayOne: false, off: false });
const tip = (where: string, r: TipsSeen | null, today = "2026-10-25") => tipAt(where, r, on(today), LIST)?.id ?? null;

test("a tip shows beside its control for a feature newer than what was seen, the oldest first", () => {
  expect(tip("here", rec())).toBe("a");
  expect(tip("there", rec())).toBe("c");
  expect(tip("here", rec({ from: "2026-10-23" }))).toBe("b");
  expect(tip("here", rec({ from: "2026-10-24" }))).toBeNull();
  expect(tip("nowhere", rec())).toBeNull();
});

test("never on the install's first day, nor this browser's, nor with no record yet", () => {
  expect(tipAt("here", rec(), { today: "2026-10-25", dayOne: true, off: false }, LIST)).toBeNull();
  expect(tip("here", rec({ first: "2026-10-25" }))).toBeNull();
  expect(tip("here", null)).toBeNull();
  // a new install counts everything so far as seen; an install in use, what shipped since the beta isn't
  expect(firstSight("2026-10-25", true).from).toBe("2026-10-25");
  expect(firstSight("2026-10-25", false).from).toBe("2026-10-22");
});

test("one a day: once a tip shows, no other shows that day, and it never shows again", () => {
  const day = shown(rec(), "a", "2026-10-25");
  expect(tip("here", day)).toBe("a");
  expect(tip("there", day)).toBeNull();
  // showing again the same day changes nothing
  expect(shown(day, "c", "2026-10-25")).toEqual(day);
  // the next day, the next one
  expect(tip("here", day, "2026-10-26")).toBe("b");
  expect(tip("there", day, "2026-10-26")).toBe("c");
});

test("closing it hides it for good, and Settings' switch turns every tip off", () => {
  const day = closed(shown(rec(), "a", "2026-10-25"), "2026-10-25");
  expect(tip("here", day)).toBeNull();
  expect(tip("here", day, "2026-10-26")).toBe("b");
  expect(tipAt("here", rec(), { today: "2026-10-25", dayOne: false, off: true }, LIST)).toBeNull();
});

test("rendered: the menu shows today's one tip beside its row, the × closes it for good, and Settings off hides it", async () => {
  const { MenuDrawer } = await import("./drawers/MenuDrawer");
  const menu = () => render((m) => <MenuDrawer m={m} />, false, true);
  const tips = (el: HTMLElement) => [...el.querySelectorAll("[data-tip]")].map((t) => t.getAttribute("data-tip"));
  // a browser that has opened Overhand before today, on an install in use
  localStorage.setItem("overhand-tips", JSON.stringify(rec({ first: "2026-10-01" })));
  const first = await menu();
  expect(tips(first)).toHaveLength(1);
  expect(first.textContent).toContain(w.whatsNew);
  const saved = JSON.parse(localStorage.getItem("overhand-tips") ?? "{}");
  expect(saved.today.day).toBe(localDay());
  // the × closes it, and it stays closed
  const { act } = await import("react");
  const x = first.querySelector<HTMLButtonElement>(`[aria-label="${w.tipClose}"]`);
  await act(async () => x?.click());
  expect(tips(first)).toEqual([]);
  expect(tips(await menu())).toEqual([]);
  // with tips off, a fresh day's tip doesn't show either
  localStorage.setItem("overhand-tips", JSON.stringify(rec({ first: "2026-10-01" })));
  localStorage.setItem("overhand-tips-off", "1");
  expect(tips(await menu())).toEqual([]);
});
