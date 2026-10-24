import { expect, test } from "bun:test";
import type { AgentPr, Ci, PullRequest } from "@overhand/contract";
import { NOW, state } from "@overhand/contract/fixtures/state";
import { plainWords as w } from "@overhand/themes";
import { explainCalls, explainCi, explainPr, explainRun, explainSpend, explainSystems } from "./explain";

const URL = "https://github.com/honeycrust/shop/pull/311";
const pr = (over: Partial<AgentPr> = {}): AgentPr => ({
  key: "HONEY-142",
  url: URL,
  fixes: 0,
  branch: "honey-142",
  draft: false,
  corners: [],
  preview: "",
  reviewRound: 0,
  ...over,
});
const gh = (checks: string, review = ""): PullRequest => ({
  client: "Honeycrust",
  repo: "honeycrust/shop",
  number: 311,
  title: "t",
  url: URL,
  draft: false,
  review,
  checks,
  updated: "",
});
const withPr = (checks: string, review = "", autonomy: "act" | "watch" = "act") =>
  state({
    clients: [{ name: "Honeycrust", prefix: "HONEY", host: "github", autonomy, assignedAutonomy: "act" }],
    status: { ...state().status, myPrs: [gh(checks, review)] },
  });

test("an agent PR is explained from its own facts: this key, its tests, its fix rounds, and what's left for you", () => {
  const pass = explainPr(withPr("SUCCESS"), pr({ fixes: 2, preview: "https://honey-142.preview.example.com" }), w);
  expect(pass.says).toBe(
    "HONEY-142 is finished and its automatic tests pass. The agent has already gone back to it 2 times to fix problems.",
  );
  expect(pass.todo).toBe(w.exTodoReviewPreview);
  expect(explainPr(withPr("SUCCESS", "APPROVED"), pr({ fixes: 1 }), w).says).toContain(
    "once to fix a problem. A reviewer has approved it.",
  );
  expect(explainPr(withPr("SUCCESS"), pr(), w).todo).toBe(w.exTodoReview);
});

test("a draft waits for a person; failing tests wait on the agent, unless the project's rules forbid it to push", () => {
  expect(explainPr(withPr("SUCCESS"), pr({ draft: true }), w)).toEqual({
    says: "HONEY-142 is finished, but this project's rules make it a draft: nothing more happens until a person marks it ready.",
    todo: w.exTodoDraft,
  });
  expect(explainPr(withPr("FAILURE"), pr(), w).todo).toBe(w.exTodoFailing);
  const watch = explainPr(withPr("FAILURE", "", "watch"), pr(), w);
  expect(watch.says).toContain("don't let agents push fixes");
  expect(watch.todo).toBe(w.exTodoWatch);
  expect(explainPr(withPr("PENDING", "CHANGES_REQUESTED"), pr(), w)).toEqual({
    says: `${w.exPrRunning.replace("{key}", "HONEY-142")} ${w.exChanges}`,
    todo: w.exTodoWait,
  });
  expect(explainPr(state(), pr(), w).says).toContain("no automatic tests");
});

test("a running agent, red builds and today's spend say what they mean here, never a glossary", () => {
  expect(
    explainRun({ name: "HONEY-150", account: "work", cwd: "/x", startedAt: NOW - 12 * 60000, pid: 1 }, "HONEY-150", 75, NOW, w).says,
  ).toBe(
    "An agent has been working on HONEY-150 for 12 min, on its own copy of the code, so your live code is untouched. It stops by 75 min and opens a pull request for you.",
  );
  const ci = (state: Ci["state"], failing: string[] = []): Ci => ({
    client: "Honeycrust",
    repo: "shop",
    branch: "main",
    state,
    failing,
    url: "",
  });
  expect(explainCi([ci("pass"), ci("fail", ["api tests"])], w)).toEqual({
    says: "The automatic tests on shop (main) are failing: api tests. Usually a recent change broke something.",
    todo: w.exTodoCiFail,
  });
  expect(explainCi([], w).says).toBe(w.exCiNone);
  // a row's ? covers all three dots: passing tests don't hide new errors or a failed release
  const err = { client: "Honeycrust", id: "1", title: "t", count: 3, users: 2, isNew: true, level: "error", url: "" };
  const release = { client: "Honeycrust", project: "shop", state: "ERROR", target: "production", url: "", created: 0 };
  const row = explainSystems([ci("pass")], release, [err], w);
  expect(row.says).toBe(
    `${w.exCiPass.replace("{repo}", "shop")} Its latest release (shop) failed to go live. People using it ran into 1 new error today.`,
  );
  expect(row.todo).toBe(w.exTodoErrors);
  expect(
    explainCi(
      [
        { ...ci("pass"), repo: "shop" },
        { ...ci("pass"), repo: "shop-web" },
      ],
      w,
    ).says,
  ).toBe("Every automatic test on shop and shop-web passes.");
  expect(explainSystems([ci("pass")], undefined, [{ ...err, isNew: false }], w).todo).toBe(w.exTodoErrorsKnown);
  const key = {
    name: "work",
    coolUntil: 0,
    usage: null,
    provider: "claude",
    model: "",
    runtime: "claude-code",
    billing: "pay-per-use",
    billingSure: true,
    waitsSignIn: false,
  } as const;
  expect(explainSpend({ accounts: [key], billed: 14.2, cost: 14.2, budgetUsd: 0 }, w).todo).toBe(w.exTodoSpend);
  expect(explainSpend({ accounts: [key], billed: 14.2, cost: 14.2, budgetUsd: 25 }, w).says).toContain("daily budget of $25");
});

test("the calls count explains itself on day one, then week against week", () => {
  expect(explainCalls(0, 0, w).says).toBe(w.explainCallsStart);
  expect(explainCalls(9, 14, w).says).toContain("This week 9; the week before 14");
  expect(explainCalls(9, 14, w).todo).toBe(w.explainCallsTodo);
  expect(explainCalls(20, 14, w).todo).toBe(w.explainCallsUpTodo);
});
