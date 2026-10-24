import { expect, test } from "bun:test";
import type { Lead } from "@overhand/contract";
import { state } from "@overhand/contract/fixtures/state";
import { clientOf, leadsIn, newestBeat } from "./world";

const lead = (over: Partial<Lead>): Lead => ({
  key: "a",
  label: "Honeycrust lead",
  name: "",
  project: "Honeycrust",
  supervised: true,
  onDemand: false,
  running: false,
  mine: true,
  since: 0,
  stopped: false,
  reason: "",
  waiting: false,
  waitingLimit: false,
  cantStart: null,
  nextAt: 0,
  account: "",
  inbox: null,
  open: false,
  ask: null,
  ...over,
});
test("a client's leads: its project in config, else its name in the label", () => {
  const all = [
    lead({}),
    lead({ key: "b", label: "Other lead", project: "Beta" }),
    lead({ key: "c", label: "honeycrust docs", project: "" }),
  ];
  expect(leadsIn(all, "Honeycrust").map((g) => g.key)).toEqual(["a", "c"]);
});

test("the newest beat names the client it happened in", () => {
  const s = state({ reports: ["- 09:00 ⚡ Honeycrust lead started headless (pid 1, work)"] });
  expect(newestBeat(s)).toMatchObject({ text: "Honeycrust lead woke up on work", client: "Honeycrust" });
  expect(newestBeat(state())).toBeNull();
});

test("a sentence belongs to the client it names first", () => {
  const clients = [{ name: "Ops" }, { name: "Honeycrust" }];
  expect(clientOf(clients, "Ops lead woke up on work")).toBe("Ops");
  expect(clientOf(clients, "Slack checked")).toBeNull();
});
