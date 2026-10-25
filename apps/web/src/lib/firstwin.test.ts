import { expect, test } from "bun:test";
import type { FirstWin, Proof } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { proofLine, stepStates, winSpent } from "./firstwin";

const WIN: FirstWin = {
  state: "pr",
  kind: "readme",
  title: "Add install and run steps to the README",
  project: "Tips",
  repo: "tip-splitter",
  key: "TIPS-0",
  url: "",
  message: "",
  at: 200_000,
  since: 80_000,
  cost: 0.3,
  billing: "plan",
};

test("the checklist ticks over: steps before the run's are done, its own is now, the rest are next", () => {
  expect(stepStates(undefined).map((s) => s.at)).toEqual(["now", "next", "next", "next"]);
  expect(stepStates("checks").map((s) => s.at)).toEqual(["done", "done", "now", "next"]);
  expect(stepStates("pr").map((s) => s.step)).toEqual(["read", "change", "checks", "pr"]);
});

test("a done first win says how long it took and what that means for the money, from its run's record", () => {
  expect(winSpent(WIN, w)).toBe("2 min · about $0.30 of your plan");
  expect(winSpent({ ...WIN, cost: 0 }, w)).toBe("2 min · included in your plan");
  expect(winSpent({ ...WIN, billing: "pay-per-use" }, w)).toBe("2 min · about $0.30, billed");
  expect(winSpent({ ...WIN, billing: "local", at: 90_000 }, w)).toBe("1 min · free: it ran on this computer"); // under a minute reads as 1
  expect(winSpent({ ...WIN, billing: undefined }, w)).toBe("2 min · $0.30 at API prices");
  expect(winSpent({ ...WIN, since: 0 }, w)).toBe(""); // never ran: nothing to say
});

const PROOF: Proof = {
  at: 0,
  transcript: true,
  checks: [
    { kind: "test", command: "npm test", ok: true, summary: "", skipped: 0 },
    { kind: "typecheck", command: "npm run typecheck", ok: true, summary: "", skipped: 0 },
  ],
  files: 1,
  added: 31,
  removed: 0,
  areas: ["(root)"],
  ui: false,
  docsOnly: true,
  verified: "",
  shots: { before: false, after: false, note: "" },
  gaps: [],
};

test("the proof reads as one sentence a newcomer understands", () => {
  expect(proofLine(PROOF, w)).toBe("The tests and the type check ran and passed.");
  const failed = {
    ...PROOF,
    checks: [...PROOF.checks, { kind: "lint" as const, command: "npm run lint", ok: false, summary: "", skipped: 0 }],
  };
  expect(proofLine(failed, w)).toBe("Not everything passed: the lint check failed.");
  expect(proofLine({ ...PROOF, checks: [] }, w)).toBe(w.proofRanNone);
  expect(proofLine({ ...PROOF, transcript: false }, w)).toBe(""); // no log: the proof says so itself
});
