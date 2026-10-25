import { expect, test } from "bun:test";
import { blankConfig, parseConfig } from "../src/config";
import { planDue, planPrompt, usesBitbucket } from "../src/plan";

test("the daily plan is off on a new install and on an existing config that doesn't turn it on", () => {
  const base = { owner: { name: "Sam", keychainAccount: "Sam" }, accounts: [], clients: [] };
  expect(blankConfig("Sam").schedule.plan).toBe(false);
  expect(parseConfig({ ...base, schedule: { planFromHour: 7 } }).schedule.plan).toBe(false);
  expect(parseConfig({ ...base, schedule: { plan: true } }).schedule.plan).toBe(true);
});

test("the loop plans only with the plan on, once a day past its hour; asking for one always plans", () => {
  const due = { on: true, asked: false, planned: false, paused: false, hour: 8, fromHour: 7, sinceTryMin: 120 };
  expect(planDue(due)).toBe(true);
  expect(planDue({ ...due, on: false })).toBe(false);
  expect(planDue({ ...due, on: false, asked: true })).toBe(true);
  expect(planDue({ ...due, planned: true })).toBe(false);
  expect(planDue({ ...due, hour: 6 })).toBe(false);
  expect(planDue({ ...due, paused: true })).toBe(false);
  expect(planDue({ ...due, sinceTryMin: 30 })).toBe(false);
});

test("the planner's prompt assumes no one's way of working, and reads Bitbucket only when a project is on it", () => {
  const prs = { myPrs: "[]", reviews: "[]" };
  const plain = planPrompt("Sam", { Site: [] }, prs);
  expect(plain).not.toContain("client");
  expect(plain).not.toContain("BITBUCKET");
  expect(planPrompt("Sam", {}, { ...prs, bitbucket: "[]" })).toContain("MY OPEN BITBUCKET PRS: []");
  expect(usesBitbucket([{ host: "github" }])).toBe(false);
  expect(usesBitbucket([{ host: "github" }, { host: "bitbucket" }])).toBe(true);
});
