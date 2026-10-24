import { expect, test } from "bun:test";
import type { Account } from "@overhand/contract";
import { state } from "@overhand/contract/fixtures/state";
import { plainWords as w } from "@overhand/themes";
import { explainSpend } from "./explain";
import { billingLabel, headline, perMerge, spendKind, windowOf } from "./spend";

const usage = (fiveHour: number, sevenDay: number) => ({
  fiveHour,
  fiveHourResetsAt: 0,
  sevenDay,
  sevenDayResetsAt: 0,
  status: "allowed",
  at: 0,
});
const acct = (name: string, billing: Account["billing"], over: Partial<Account> = {}): Account => ({
  name,
  coolUntil: 0,
  usage: null,
  provider: "claude",
  model: "",
  runtime: "claude-code",
  billing,
  billingSure: true,
  waitsSignIn: false,
  ...over,
});
const sam = acct("Sam", "plan", { usage: usage(0.12, 0.39) });
const aws = acct("Bedrock", "cloud", { provider: "bedrock" });
const box = acct("Local", "local", { provider: "gateway" });

test("the header says billed money where an account is billed, else the plans' busiest window, never API prices as spent", () => {
  expect(headline(state({ accounts: [sam, aws], billed: 3.1, cost: 14.2 }), w)).toEqual({ label: w.billedToday, value: "$3.10" });
  // every account on a plan: nothing was billed, so no dollar figure; the busiest window instead
  expect(headline(state({ accounts: [sam, box], billed: 0, cost: 14.2 }), w)).toEqual({ label: w.inPlansToday, value: "week 39%" });
  expect(headline(state({ accounts: [box], cost: 0 }), w)).toEqual({ label: w.localToday, value: "$0.00" });
  // plans with no reading yet: no figure at all (the clock then shows none), never a made-up one
  expect(headline(state({ accounts: [acct("x", "plan")], cost: 5 }), w)).toEqual({ label: w.inPlansToday, value: "" });
  expect(spendKind(state({ accounts: [sam, aws] }))).toBe("billed");
  expect(windowOf(acct("x", "plan", { usage: usage(0.8, 0.2) }), w)).toBe("5h 80%");
  expect(windowOf(acct("x", "plan"), w)).toBe("");
});

test("the tooltip tells a mix apart: billed (an estimate), included in plans, and API prices only as a comparison", () => {
  const s = state({ accounts: [sam, aws], billed: 3.1, cost: 14.2, budgetUsd: 10 });
  expect(explainSpend(s, w).says).toBe(
    [
      "Billed today: $3.10 (Bedrock, an estimate).",
      "Included in your plans: Sam's plan, week 39%.",
      "At API prices, today's work would be about $14.20.",
      "When billed accounts reach your daily budget of $10.00, Overhand stops them until tomorrow; plan accounts carry on.",
      "Plan accounts aren't charged per run; they follow their plan's usage limits.",
    ].join(" "),
  );
  expect(explainSpend(s, w).todo).toBe(w.exTodoNothing);
  // only plans: nothing about bills or the budget, which caps nothing here
  const plans = explainSpend(state({ accounts: [sam], cost: 14.2, budgetUsd: 10 }), w).says;
  expect(plans).not.toMatch(/[Bb]illed|budget|spent/);
  expect(plans).toContain("At API prices, today's work would be about $14.20.");
  // a billed account with no cap: the cap is the thing to do
  expect(explainSpend(state({ accounts: [aws], billed: 2, cost: 2 }), w).todo).toBe(w.exTodoSpend);
});

test("each account names how it's paid for", () => {
  expect(billingLabel(sam, w)).toBe("plan");
  expect(billingLabel(aws, w)).toBe("billed to AWS");
  expect(billingLabel(acct("v", "cloud", { provider: "vertex" }), w)).toBe("billed to Google Cloud");
  expect(billingLabel(acct("k", "pay-per-use"), w)).toBe("pay per use");
  expect(billingLabel(box, w)).toBe("local");
});

test("per merged PR: billed per merge with API prices beside it; a plan's merges are included in the plan", () => {
  expect(perMerge(state({ accounts: [aws] }), { billed: 6, cost: 9, merged: 3 }, w)).toBe("$2.00 billed · $3.00 at API prices");
  expect(perMerge(state({ accounts: [sam] }), { billed: 0, cost: 9, merged: 3 }, w)).toBe("included in plan · $3.00 at API prices");
});
