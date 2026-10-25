import { expect, test } from "bun:test";
import { recordRun, survivingRuns } from "../src/control";
import { stopSurvivors } from "../src/daemon";
import { OPS } from "../src/env";
import { loadInterrupted, saveInterrupted } from "../src/state";

test("a start stops the agents a stopped Overhand left running, and holds their task for Try again", async () => {
  saveInterrupted({});
  const agent = Bun.spawn(["sleep", "30"]);
  const helper = Bun.spawn(["sleep", "30"]);
  recordRun(OPS, agent.pid, { run: "HONEY-7", autonomy: "act", project: "Honeycrust" });
  recordRun(OPS, helper.pid, { run: "plan", autonomy: "act", project: "" });
  expect(await stopSurvivors()).toEqual(["HONEY-7"]);
  await Promise.all([agent.exited, helper.exited]);
  expect(agent.killed || agent.signalCode !== null).toBe(true);
  expect(survivingRuns(OPS)).toEqual([]);
  // only a project's task waits for Try again; the planner just runs again at its time
  expect(Object.keys(loadInterrupted())).toEqual(["HONEY-7"]);
  expect(await stopSurvivors()).toEqual([]);
  saveInterrupted({});
});
