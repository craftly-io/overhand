import { expect, test } from "bun:test";
import { state } from "@overhand/contract/fixtures/state";
import { pipeline, resumesAt, yours } from "./pipeline";
import { parsePlan } from "./plan";

const plan = parsePlan([
  "## Honeycrust",
  "### Agent",
  "- [x] HONEY-1 Armed with a PR already",
  "- [x] HONEY-2 Armed, running now",
  "- [x] HONEY-3 Armed, waiting",
  "- [ ] HONEY-4 Planned only",
  "- [ ] A line with no key",
  "### You",
  "- HONEY-9 Decide pricing — needs a call",
]);
const pr = (key: string) => ({
  key,
  url: `https://x/${key}`,
  client: "Honeycrust",
  fixes: 0,
  branch: key,
  draft: false,
  corners: [],
  preview: "",
  reviewRound: 0,
});

test("one card per ticket key, at its furthest stage; nothing unmatched is dropped", () => {
  const s = state({
    running: [
      { name: "HONEY-2 fix", account: "work", cwd: "/x", startedAt: 0, pid: 1 },
      { name: "planner", account: "work", cwd: "/x", startedAt: 0, pid: 2 },
    ],
    prs: [pr("HONEY-1"), pr("HONEY-7")],
    reports: ["- 07:00 🎉 HONEY-5 PR merged", "- 07:01 🎉 HONEY-7 PR merged"],
  });
  const p = pipeline(s, plan);
  const ids = (k: keyof typeof p) => p[k].map((c) => c.id);
  expect(ids("planned")).toEqual(["HONEY-4", "line-6"]);
  expect(ids("queued")).toEqual(["HONEY-3"]);
  expect(ids("running")).toEqual(["HONEY-2"]);
  // HONEY-7 has no plan line and is still open: its own card, in review, not merged
  expect(ids("review")).toEqual(["HONEY-1", "HONEY-7"]);
  expect(ids("merged")).toEqual(["HONEY-5"]);
  expect(p.review[0]?.line).toBe(2);
  expect(yours(plan).map((y) => `${y.client} ${y.key}`)).toEqual(["Honeycrust HONEY-9"]);
});

test("a PR being fixed stays in Running", () => {
  const s = state({ running: [{ name: "HONEY-1 fix round", account: "work", cwd: "/x", startedAt: 0, pid: 1 }], prs: [pr("HONEY-1")] });
  const p = pipeline(s, plan);
  expect(p.running.map((c) => [c.id, Boolean(c.pr)])).toEqual([["HONEY-1", true]]);
});

test("a task whose attempts are used up leaves Queued (it waits in Needs you); work resumes when the first account is back", () => {
  const at = { project: "Honeycrust", title: "t", by: "dashboard" as const, local: true, at: 0 };
  const s = state({
    assigned: [
      { key: "HONEY-20", ...at },
      { key: "HONEY-21", ...at, stopped: true },
    ],
  });
  expect(pipeline(s, parsePlan([])).queued.map((c) => c.id)).toEqual(["HONEY-20"]);
  const acc = s.accounts[0];
  if (!acc) throw new Error("the fixture has an account");
  const cool = (...until: number[]) => ({ ...s, accounts: until.map((coolUntil, i) => ({ ...acc, name: `a${i}`, coolUntil })) });
  expect(resumesAt(cool(s.now + 5000, s.now + 2000))).toBe(s.now + 2000);
  expect(resumesAt(cool(s.now + 5000, 0))).toBe(0); // one account can still run
  expect(resumesAt(cool())).toBe(0);
});
