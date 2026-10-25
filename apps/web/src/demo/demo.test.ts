import { beforeEach, expect, test } from "bun:test";
import type { DashboardState } from "@overhand/contract";
import { QueryClient } from "@tanstack/react-query";
import {
  browserHost,
  demoClock,
  demoPost,
  demoState,
  followParent,
  type Host,
  PIECE_PLAYS,
  type Play,
  pieceSlice,
  resetDemo,
} from "./demo";
import { demoGet } from "./fixtures";
import { samplePr } from "./links";
import { ARRIVE_FROM, MORNING } from "./moments";
import { NIGHT_MINUTES, nightAt } from "./night";

const KEY = ["state"] as const;
const ORIGIN = "https://overhand.test";
const asks = (s: unknown) => JSON.stringify(s).includes("remind guests by email");

/** A stand-in for the page the demo runs in: what it posts to its parent, and a way to post to it as the parent. */
function page(over: Partial<Pick<Host, "embedded" | "reduced">> = {}, play?: Play) {
  const posted: unknown[] = [];
  const parent = {};
  let heard: (e: { source: unknown; origin: string; data: unknown }) => void = () => {};
  const host: Host = {
    parent,
    origin: ORIGIN,
    post: (m) => void posted.push(m),
    embedded: true,
    reduced: false,
    listen: (f) => {
      heard = f;
      return () => {};
    },
    ...over,
  };
  const qc = new QueryClient();
  const stop = followParent(qc, KEY, play, host);
  return { qc, posted, stop, send: (data: unknown, origin = ORIGIN) => heard({ source: parent, origin, data }) };
}

beforeEach(resetDemo);

test("embedded, the demo opens a minute before the question", () => {
  const p = page();
  expect(p.qc.getQueryData(KEY)).toEqual(nightAt(ARRIVE_FROM));
  expect(asks(p.qc.getQueryData(KEY))).toBe(false);
  expect(p.posted).toEqual([{ type: "overhand:ready" }]);
});

test("arrive moves it to the morning, once", () => {
  const p = page();
  let heard = 0;
  const off = demoClock.subscribe(() => void heard++);
  p.send({ type: "overhand:arrive" });
  p.send({ type: "overhand:arrive" });
  off();
  expect(p.qc.getQueryData(KEY)).toEqual(nightAt(MORNING));
  expect(asks(p.qc.getQueryData(KEY))).toBe(true);
  expect(heard).toBe(1);
  expect(p.posted.filter((m) => JSON.stringify(m) === '{"type":"overhand:arrived"}')).toHaveLength(1);
});

test("a cue from another origin is ignored", () => {
  const p = page();
  p.send({ type: "overhand:arrive" }, "https://evil.example");
  expect(asks(p.qc.getQueryData(KEY))).toBe(false);
  expect(p.posted).toEqual([{ type: "overhand:ready" }]);
});

test("in a browser the host posts to its parent on this origin only, and the height report goes the same way", () => {
  const sent: [unknown, string][] = [];
  const parent = { postMessage: (m: unknown, to: string) => void sent.push([m, to]) };
  const w = {
    parent,
    location: { origin: ORIGIN },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const host = browserHost(w);
  expect(host.origin).toBe(ORIGIN);
  host.post({ type: "overhand:piece", p: "needs", h: 640 });
  expect(sent).toEqual([[{ type: "overhand:piece", p: "needs", h: 640 }, ORIGIN]]);
});

test("reduced motion opens at the morning", () => {
  const p = page({ reduced: true });
  expect(p.qc.getQueryData(KEY)).toEqual(nightAt(MORNING));
});

test("opened on its own, the demo shows the morning", () => {
  const p = page({ embedded: false });
  expect(p.qc.getQueryData(KEY)).toEqual(nightAt(MORNING));
});

test("clock and theme messages do nothing", () => {
  const p = page({ reduced: true });
  const before = p.qc.getQueryData(KEY);
  p.send({ type: "overhand:clock", minutes: 0 });
  p.send({ type: "overhand:theme", id: "catnap", appearance: "dark" });
  expect(p.qc.getQueryData(KEY)).toBe(before);
});

test("the demo carries out answers, quiet mode and autonomy, and refuses the rest", () => {
  expect(demoPost("/api/pr/close", { key: "BOOK-88" })).toBeUndefined();
  expect(demoPost("/api/settings/quick", { project: "Booking app", autonomy: "watch" })).toEqual({});
  expect(demoState().clients.find((c) => c.name === "Booking app")?.autonomy).toBe("watch");
  expect(demoPost("/api/ticket/answer", { key: "BOOK-90", text: "yes" })).toEqual({ done: "held" });
  const book = demoState().tickets["Booking app"];
  expect(typeof book === "string" ? [] : book?.find((t) => t.key === "BOOK-90")?.labels).toContain("agent");
  expect(demoPost("/api/quiet", { hours: 3 })).toEqual({ quietUntil: demoState().governor.quietUntil });
  expect(demoState().governor.quietUntil).toBeGreaterThan(Date.now());
});

test("what a visitor sends a lead joins its conversation as the daemon writes it: an answer, or a message", () => {
  const lead = (key: string) => demoState().godmode.find((g) => g.key === key);
  expect(lead("mobile")?.open).toBe(true);
  expect(demoPost("/api/lead/answer", { key: "mobile", text: "Push only" })).toEqual({});
  expect(lead("mobile")?.open).toBe(false);
  expect(lead("mobile")?.inbox?.text).toContain("## Reminders");
  expect(lead("mobile")?.inbox?.text).toMatch(/## Answer from Sam \(\d{4}-\d\d-\d\d \d\d:\d\d\)\n\nPush only$/);
  // nothing open now: the next one is a message, after the shop lead's own conversation
  expect(demoPost("/api/lead/answer", { key: "shop", text: "Thanks" })).toEqual({});
  expect(lead("shop")?.inbox?.text).toContain("## Reply (");
  expect(lead("shop")?.inbox?.text).toMatch(/## Answer from Sam \(message, \d{4}-\d\d-\d\d \d\d:\d\d\)\n\nThanks$/);
  resetDemo();
  expect(lead("mobile")?.open).toBe(true);
});

/** Each piece's moment, as the state shows it: what a visitor sees change when the piece plays. */
const BOOK_88 = samplePr("example/booking", 77);
const MOMENT: Record<string, (s: DashboardState) => boolean> = {
  // the night's one call arrives in Needs you
  needs: (s) => asks(s),
  // BOOK-88's red check is green after its fix round
  inflight: (s) =>
    s.status.myPrs.find((p) => p.url === BOOK_88)?.checks === "SUCCESS" && s.prs.some((p) => p.url === BOOK_88 && p.fixes === 1),
  // the plan for the sample request lands, once
  plan: (s) => s.findings.filter((f) => f.title === "make the invite page friendlier").length === 1,
  // Booking app moves from Build to Drafts
  rules: (s) => s.clients.find((c) => c.name === "Booking app")?.autonomy === "propose",
};
const state = (p: ReturnType<typeof page>) => p.qc.getQueryData<DashboardState>(KEY);

for (const [name, has] of Object.entries(MOMENT)) {
  const play = PIECE_PLAYS[name];
  test(`the ${name} piece plays its moment once, on play`, () => {
    if (!play) throw new Error(`no play for ${name}`);
    const p = page({}, play);
    const before = state(p);
    expect(before && has(before)).toBe(false);
    p.send({ type: "overhand:play" });
    p.send({ type: "overhand:play" });
    const after = state(p);
    expect(after && has(after)).toBe(true);
    expect(p.posted.filter((m) => JSON.stringify(m) === '{"type":"overhand:played"}')).toHaveLength(1);
  });
  test(`the ${name} piece opens at its moment under reduced motion, and when the page has played it before`, () => {
    if (!play) throw new Error(`no play for ${name}`);
    const reduced = state(page({ reduced: true }, play));
    expect(reduced && has(reduced)).toBe(true);
    resetDemo();
    const settled = state(page({}, { ...play, settled: true }));
    expect(settled && has(settled)).toBe(true);
  });
  test(`the ${name} piece that never plays stays usable`, () => {
    if (!play) throw new Error(`no play for ${name}`);
    const p = page({}, play);
    expect(p.posted).toEqual([{ type: "overhand:ready" }]);
    expect(demoPost("/api/quiet", { hours: 1 })).toEqual({ quietUntil: demoState().governor.quietUntil });
  });
}

/** Each focus names something real at the moment's end, the way its piece marks it (`data-id`). */
const FOCUS: Record<string, (s: DashboardState, id: string) => boolean> = {
  needs: (s, id) => s.godmode.some((g) => `lead:${g.key}` === id && g.inbox !== null),
  inflight: (s, id) => s.prs.some((p) => p.key === id),
  plan: (s, id) => s.findings.some((f) => f.task && `held:${f.id}` === id),
  rules: (s, id) => s.clients.some((c) => c.name === id),
  cast: (s, id) => s.running.some((r) => r.name === id),
};
for (const [name, real] of Object.entries(FOCUS))
  test(`the ${name} piece's focus is a real item once its moment has played`, () => {
    const play = PIECE_PLAYS[name];
    if (!play?.focus) throw new Error(`no focus for ${name}`);
    const end = state(page({ reduced: true }, play));
    expect(end && real(end, play.focus)).toBe(true);
  });

test("a piece's slice: at most max items, what its moment is about first, the rest in the dashboard's order", () => {
  const list = ["a", "b", "c", "new", "d"];
  expect(pieceSlice(list, 3, (x) => x === "new")).toEqual(["new", "a", "b"]);
  // before it arrives, the first few
  expect(pieceSlice(["a", "b", "c", "d"], 3, (x) => x === "new")).toEqual(["a", "b", "c"]);
  expect(pieceSlice(list, 10, () => false)).toEqual(list);
});

test("cast, the first win, the morning and the review hold still at their minute", () => {
  for (const name of ["cast", "firstwin", "morning", "review"]) {
    const play = PIECE_PLAYS[name];
    expect(play?.from).toBe(play?.to);
    expect(play?.act).toBeUndefined();
  }
});

test("every link in the demo goes to example.com or a local service, never a real account", () => {
  const night = Array.from({ length: NIGHT_MINUTES / 15 + 1 }, (_, i) => nightAt(i * 15));
  const gets = [
    "/api/projects/github",
    "/api/summary?span=night",
    "/api/summary?span=week",
    "/api/report?project=Online%20shop&from=2026-10-13&to=2026-10-19",
    "/api/settings",
    "/api/connections",
    "/api/checkup",
    ...["WEB-31", "SHOP-142", "BOOK-88", "APP-12"].flatMap((k) => [`/api/pr/review?key=${k}`, `/api/preview/review?key=${k}`]),
    ...nightAt(MORNING).godmode.map((g) => `/api/brief?id=lead:${g.key}`),
  ].map(demoGet);
  const hosts = [...JSON.stringify([night, gets]).matchAll(/https?:\/\/([\w.-]*\w)/g)].map((m) => m[1] ?? "");
  expect(hosts.length).toBeGreaterThan(0);
  const allowed = (h: string) => /^(?:[\w-]+\.)*example\.com$|^localhost$|^127\.0\.0\.1$/.test(h);
  expect([...new Set(hosts.filter((h) => !allowed(h)))]).toEqual([]);
});
