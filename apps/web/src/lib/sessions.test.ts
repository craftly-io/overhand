import { expect, test } from "bun:test";
import type { Lead } from "@overhand/contract";
import { NOW } from "@overhand/contract/fixtures/state";
import { plainWords } from "@overhand/themes";
import { parseCommand, parseVoice } from "./commands";
import { leadName, leadNamed, leadState, modelName, runKind, runsOn, saying, withNames } from "./sessions";

test("model names and modes read as words", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-sonnet-4-6[1m]")).toBe("Sonnet 4.6");
  expect(modelName("gpt-x")).toBe("gpt-x");
  expect(runsOn({ model: "claude-haiku-4-5", mode: "acceptEdits" })).toBe("Haiku 4.5 · accepts edits");
  expect(runsOn({ model: "", mode: "" })).toBe("");
});

test("runKind names a run from its log name", () => {
  expect(runKind("plan")).toBe("runPlanner");
  expect(runKind("inbox-2")).toBe("runTriage");
  expect(runKind("route")).toBe("runRouting");
  expect(runKind("HONEY-12")).toBe("runTicket");
  expect(runKind("lead-honeycrust")).toBe("runOther");
});

const honeycrust: Lead = {
  key: "honeycrust",
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
  account: "work",
  inbox: null,
  open: false,
  ask: null,
};

test("leadState says what a lead is doing", () => {
  const g = honeycrust;
  expect(leadState(g, plainWords, NOW)).toBe("Starting within a minute");
  expect(leadState({ ...g, supervised: false }, plainWords, NOW)).toBe("Off");
  expect(leadState({ ...g, stopped: true, reason: "crashed 3×" }, plainWords, NOW)).toBe("Stopped: crashed 3×");
  expect(leadState({ ...g, running: true, mine: false }, plainWords, NOW)).toBe("Running (opened by hand)");
  // a usage limit is a wait, not a stop: whose limit and when it's back
  const back = new Date(NOW + 3_600_000);
  const hhmm = `${String(back.getHours()).padStart(2, "0")}:${String(back.getMinutes()).padStart(2, "0")}`;
  expect(leadState({ ...g, limitAccount: "cursor", limitBack: NOW + 3_600_000 }, plainWords, NOW)).toBe(
    `Waiting for cursor's limit, back at ${hhmm}`,
  );
  expect(leadState({ ...g, waitingLimit: true }, plainWords, NOW)).toBe("Waiting for a usage limit to reset");
  // held by today's spend cap: it says the cap, and when it resumes, never a usage limit at midnight
  const capped = { ...g, waitingLimit: true, cantStart: null, limitAccount: "aws", limitBack: NOW + 3_600_000, capHeld: true };
  expect(leadState(capped, plainWords, NOW)).toBe(plainWords.leadWaitingCap);
  expect(plainWords.leadWaitingCap).toContain("tomorrow");
});

test("command bar and voice parse into commands", () => {
  expect(parseCommand("honey-12")).toEqual({ name: "open", key: "HONEY-12" });
  expect(parseCommand("queue honey-12")).toEqual({ name: "queue", key: "HONEY-12" });
  expect(parseCommand("lead Fernway")).toEqual({ name: "lead", key: "fernway" });
  expect(parseCommand("unleash")).toEqual({ name: "overdrive" });
  expect(parseCommand("dance")).toEqual({ name: "unknown", text: "dance" });
  expect(parseCommand("  ")).toBeNull();
  expect(parseVoice("hand HONEY 12 to the agent")).toEqual({ name: "queue", key: "HONEY-12" });
  expect(parseVoice("open honey 12")).toEqual({ name: "open", key: "HONEY-12" });
  expect(parseVoice("what's going on")).toEqual({ name: "brief" });
  expect(parseVoice("pause everything")).toEqual({ name: "pause" });
});

test("saying turns tool calls into what a character is doing, and messages into their first sentence", () => {
  expect(saying("→ Write: /Users/n/fernway/docs/decisions/0079-owner.md")).toBe("writing 0079-owner.md");
  expect(saying('→ Bash: until grep -q "^exit=" /tmp/x')).toBe("running grep");
  expect(saying("→ Grep: deploy")).toBe("searching the code");
  expect(saying("Recorded the owner's answers in decision 0079. Next I open the PR.")).toBe(
    "Recorded the owner's answers in decision 0079.",
  );
});

test("a lead is named by your rename, else its config name, else its label; never an invented character", () => {
  const lead = (key: string, label: string, name = "") => ({ ...honeycrust, key, label, name });
  const all = [lead("a", "Honeycrust lead"), lead("b", "Honeycrust v2 lead", "Nyx"), lead("c", "Keep CI green · Beta")];
  const names = { "lead:c": "Night watch" };
  expect(all.map((g) => leadName(g, names))).toEqual(["Honeycrust lead", "Nyx", "Night watch"]);
  expect(withNames("Honeycrust v2 lead woke up; Keep CI green · Beta finished", all, names)).toBe("Nyx woke up; Night watch finished");
});

test("a rename that contains the label isn't doubled, and older lines under an earlier name still name the lead", () => {
  const g = { ...honeycrust, key: "h", label: "Honeycrust", name: "" };
  const names = { "lead:h": "Honeycrust web" };
  expect(withNames("Honeycrust web started", [g], names)).toBe("Honeycrust web started"); // the daemon logs the new name
  expect(withNames("Honeycrust exited", [g], names)).toBe("Honeycrust web exited"); // a line from before the rename
  const renamedTwice = { "lead:h": "Day watch", "lead:h#was": "Night watch\nHoneycrust web" };
  expect(withNames("Night watch exited; Honeycrust web started", [g], renamedTwice)).toBe("Day watch exited; Day watch started");
  expect(leadNamed([g], renamedTwice, "Night watch")?.key).toBe("h");
  expect(leadNamed([g], renamedTwice, "Day watch")?.key).toBe("h");
  expect(leadNamed([g], renamedTwice, "Someone else")).toBeUndefined();
});
