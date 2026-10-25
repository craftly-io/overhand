import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CATALOG, SKIP } from "./src/catalog";

/**
 * The catalog keeps up with the dashboard: every ui primitive and every component exported from the folders below has
 * an entry (or a SKIP with its reason), every control shows its states, and every screen its five.
 */
const WEB = join(import.meta.dir, "../web/src");
const FOLDERS = ["now", "work", "drawers", "team", "health", "share"];
const scan = (g: string) => [...new Bun.Glob(g).scanSync({ cwd: WEB })].filter((f) => !f.endsWith(".test.tsx")).sort();
/** The components a file exports: `export function Name`, capitalised. */
const exportsOf = (f: string) => [...readFileSync(join(WEB, f), "utf8").matchAll(/^export function ([A-Z]\w*)/gm)].map((m) => m[1] ?? "");

const PRIMITIVES = scan("components/ui/*.tsx").map((f) => basename(f, ".tsx"));
const LISTED = FOLDERS.flatMap((d) => scan(`components/${d}/**/*.tsx`).flatMap(exportsOf));
const ANY = new Set(scan("components/**/*.tsx").flatMap(exportsOf));
const covered = new Set(CATALOG.flatMap((e) => [e.id, ...(e.covers ?? [])]));

test("every ui primitive has a components entry", () => {
  expect(PRIMITIVES.length).toBeGreaterThan(10);
  const ids = new Set(CATALOG.filter((e) => e.group === "components").map((e) => e.id));
  expect(PRIMITIVES.filter((p) => !ids.has(p) && !(p in SKIP))).toEqual([]);
});

test("every component exported from now, work, drawers, team, health and share is shown or skipped with a reason", () => {
  expect(LISTED.length).toBeGreaterThan(40);
  expect(LISTED.filter((n) => !covered.has(n) && !(n in SKIP))).toEqual([]);
});

test("the SKIP list is honest: real names, a reason each, nothing both skipped and shown", () => {
  for (const [name, why] of Object.entries(SKIP)) {
    expect(ANY.has(name) || PRIMITIVES.includes(name), name).toBe(true);
    expect(why.length, name).toBeGreaterThan(15);
    expect(covered.has(name), name).toBe(false);
  }
});

test("an entry only claims components that exist", () => {
  const claims = CATALOG.flatMap((e) => e.covers ?? []);
  expect(claims.filter((n) => !ANY.has(n))).toEqual([]);
});

test("every control shows default, hover, focus and disabled; a passive one says why it has no states", () => {
  for (const e of CATALOG.filter((x) => x.group === "components")) {
    if (e.passive) expect(e.passive.length, e.id).toBeGreaterThan(15);
    else for (const s of ["default", "hover", "focus", "disabled"]) expect(Object.keys(e.states), e.id).toContain(s);
  }
});

test("Now, Work, Agents, Health and Settings each show loading, empty, busy, broken and phone", () => {
  const screens = CATALOG.filter((e) => e.group === "screens");
  expect(screens.map((e) => e.id).sort()).toEqual(["crew", "health", "now", "settings", "work"]);
  for (const e of screens) expect(Object.keys(e.states).sort(), e.id).toEqual(["broken", "busy", "empty", "loading", "phone"]);
});

test("every entry has a unique address and at least one state", () => {
  const keys = CATALOG.map((e) => `${e.group}/${e.id}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const e of CATALOG) {
    expect(Object.keys(e.states).length, e.id).toBeGreaterThan(0);
    expect(e.id).toMatch(/^[a-z0-9-]+$/);
  }
});

test("the team's parts have entries of their own, in more than one state, on the demo's sample team", () => {
  for (const name of ["TeamView", "TeamMap", "Facepile"]) {
    const e = CATALOG.find((x) => x.covers?.includes(name));
    expect(e, name).toBeDefined();
    expect(Object.keys(e?.states ?? {}).length, name).toBeGreaterThan(1);
  }
  expect(Object.keys(CATALOG.find((x) => x.id === "team-map")?.states ?? {})).toEqual([
    "on your own",
    "several people",
    "someone away",
    "following Robin",
  ]);
});
