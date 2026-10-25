import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { limitStop, runGrouped } from "../src/agent";
import { OPS } from "../src/env";
import { currentRuns, loadState, saveCurrentRuns } from "../src/state";

/** Runs jobs that each take `ms`, recording when they start and end and how many overlap. */
function recorder(ms = 20) {
  const log: string[] = [];
  let live = 0;
  let peak = 0;
  const run = async (item: { g: string; id: string }) => {
    live++;
    peak = Math.max(peak, live);
    log.push(`start ${item.id}`);
    await Bun.sleep(ms);
    log.push(`end ${item.id}`);
    live--;
    return true;
  };
  return { log, run, peak: () => peak };
}

const items = [
  { g: "honeycrust", id: "A1" },
  { g: "honeycrust", id: "A2" },
  { g: "beta", id: "B1" },
  { g: "gamma", id: "C1" },
];

test("different clients run at the same time, one client never twice at once", async () => {
  const r = recorder();
  await runGrouped(items, (i) => i.g, 2, r.run);
  expect(r.peak()).toBe(2);
  // A1 and B1 start together; A2 waits for A1 even though C1 is free to start
  expect(r.log.slice(0, 2)).toEqual(["start A1", "start B1"]);
  expect(r.log.indexOf("start A2")).toBeGreaterThan(r.log.indexOf("end A1"));
  expect(r.log.filter((l) => l.startsWith("end"))).toHaveLength(4);
});

test("maxParallel 1 keeps the old one-at-a-time order", async () => {
  const r = recorder(5);
  await runGrouped(items, (i) => i.g, 1, r.run);
  expect(r.peak()).toBe(1);
  expect(r.log.filter((l) => l.startsWith("start"))).toEqual(["start A1", "start A2", "start B1", "start C1"]);
});

test("returning false lets started runs finish and starts nothing new", async () => {
  const started: string[] = [];
  await runGrouped(
    items,
    (i) => i.g,
    2,
    async (i) => {
      started.push(i.id);
      await Bun.sleep(i.id === "B1" ? 5 : 20);
      return i.id !== "B1"; // e.g. every account is cooling down
    },
  );
  expect(started).toEqual(["A1", "B1"]);
});

test("a throw waits for the other runs, then surfaces", async () => {
  let finished = false;
  const pass = runGrouped(
    items,
    (i) => i.g,
    2,
    async (i) => {
      if (i.id === "B1") throw new Error("boom");
      await Bun.sleep(20);
      finished = true;
      return true;
    },
  );
  await expect(pass).rejects.toThrow("boom");
  expect(finished).toBe(true); // the work pass's lock outlives every run it started
});

test("currentRuns reads the old single-run file and drops runs whose process is gone", () => {
  const run = { name: "HONEY-1", account: "work", cwd: "/x", startedAt: 1, pid: process.pid, model: "", mode: "auto" };
  writeFileSync(join(OPS, ".current.json"), JSON.stringify(run));
  expect(currentRuns()).toEqual([run]);
  saveCurrentRuns([run, { ...run, name: "BETA-2", pid: 2 ** 22 + 1 }]); // above macOS and Linux pid limits
  expect(currentRuns()).toEqual([run]);
  saveCurrentRuns([]);
});

test("a task stopped by its account's limit waits for free, but every second stop in a row uses an attempt", () => {
  const state = loadState();
  limitStop(state, "AC-1", true);
  expect(state.attempts["AC-1"]).toBeUndefined(); // the first: it only waits
  limitStop(state, "AC-1", true);
  expect(state.attempts["AC-1"]).toBe(1); // the same task at the limit again: it can't loop forever
  limitStop(state, "AC-1", true);
  expect(state.attempts["AC-1"]).toBe(1);
  limitStop(state, "AC-1", false); // a run that ended another way starts the count again
  limitStop(state, "AC-1", true);
  expect(state.attempts["AC-1"]).toBe(1);
});
