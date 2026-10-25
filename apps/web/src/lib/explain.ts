/**
 * Explain: an engineering fact on the dashboard (an agent PR's status, a running agent, a red build, today's spend) as one
 * plain sentence about this case, and what, if anything, to do. Built from the facts the dashboard already has, so it
 * needs no model call and works the same on the demo's sample morning.
 */
import {
  type Account,
  type AgentPr,
  type Ci,
  type CurrentRun,
  type DashboardState,
  type Deploy,
  type ErrorIssue,
  isBilled,
} from "@overhand/contract";
import type { Words } from "@overhand/themes";
import { and, fmt, money } from "./format";
import { budgetApplies, windowOf } from "./spend";

/** What a fact means, and what to do about it. */
export interface Explained {
  says: string;
  todo: string;
}

/** An agent PR's status line: its tests, draft state, fix rounds and review, and what's left for you. */
export function explainPr(s: Pick<DashboardState, "clients" | "status">, p: AgentPr, w: Words): Explained {
  const gh = s.status.myPrs.find((x) => x.url === p.url);
  const checks = gh?.checks ?? "";
  // a watch project's agents never push, not even a fix to their own PR (core agent.ts)
  const watch = s.clients.find((c) => p.key.startsWith(`${c.prefix}-`))?.autonomy === "watch";
  const failing = /FAILURE|ERROR/.test(checks);
  const running = /PENDING|EXPECTED/.test(checks);
  const changes = gh?.review === "CHANGES_REQUESTED";
  const v = { key: p.key, n: p.fixes };
  const lead = p.draft
    ? w.exPrDraft
    : failing
      ? watch
        ? w.exPrFailingWatch
        : w.exPrFailing
      : running
        ? w.exPrRunning
        : checks
          ? w.exPrPass
          : w.exPrNoChecks;
  const says = [
    lead,
    p.fixes === 1 ? w.exFixesOne : p.fixes > 1 ? w.exFixesMany : "",
    changes ? w.exChanges : gh?.review === "APPROVED" ? w.exApproved : "",
  ]
    .filter(Boolean)
    .map((x) => fmt(x, v))
    .join(" ");
  const todo = p.draft
    ? w.exTodoDraft
    : failing
      ? watch
        ? w.exTodoWatch
        : w.exTodoFailing
      : running || changes
        ? w.exTodoWait
        : p.preview
          ? w.exTodoReviewPreview
          : w.exTodoReview;
  return { says, todo };
}

/** A running agent: how long it has worked, that it works on its own copy, and when it stops. */
export function explainRun(r: CurrentRun, key: string, timeoutMin: number, now: number, w: Words): Explained {
  const min = Math.max(0, Math.floor((now - r.startedAt) / 60000));
  return { says: fmt(w.exRun, { key: key || r.name, min, max: timeoutMin }), todo: w.exTodoWait };
}

/** One project's builds: what the worst state means, naming each failing repo and what failed in it. */
export function explainCi(ci: Ci[], w: Words): Explained {
  const fail = ci.filter((c) => c.state === "fail");
  if (fail.length)
    return {
      says: fail
        .map((c) => fmt(w.exCiFail, { repo: c.repo, branch: c.branch, what: c.failing.length ? `: ${c.failing.join(", ")}` : "" }))
        .join(" "),
      todo: w.exTodoCiFail,
    };
  const running = ci.find((c) => c.state === "running");
  if (running) return { says: fmt(w.exCiRunning, { repo: running.repo }), todo: w.exTodoWait };
  const pass = ci.filter((c) => c.state === "pass").map((c) => c.repo);
  if (pass.length) return { says: fmt(w.exCiPass, { repo: and(pass) }), todo: w.exTodoNothing };
  return { says: w.exCiNone, todo: w.exTodoNothing };
}

/**
 * One project's row on Systems, all three of its dots: its builds, its latest release and the errors people hit. The
 * worst one decides what to do.
 */
export function explainSystems(ci: Ci[], deploy: Deploy | undefined, errs: ErrorIssue[], w: Words): Explained {
  const tests = explainCi(ci, w);
  const fresh = errs.filter((e) => e.isNew).length;
  const failed = deploy && /ERROR|CANCELED/.test(deploy.state);
  const says = [
    tests.says,
    failed ? fmt(w.exReleaseFailed, { project: deploy.project }) : "",
    errs.length === 1
      ? fresh
        ? w.exErrorOneNew
        : w.exErrorOne
      : errs.length
        ? fmt(fresh ? w.exErrorsNew : w.exErrors, { n: errs.length, new: fresh })
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  const todo = ci.some((c) => c.state === "fail")
    ? tests.todo
    : fresh
      ? w.exTodoErrors
      : failed
        ? w.exTodoRelease
        : errs.length
          ? w.exTodoErrorsKnown
          : tests.todo;
  return { says, todo };
}

/**
 * Today's money, each kind named for what it is: billed (an estimate, by account), included in plans (with each plan's
 * busiest window), on this computer, and what the work would cost at API prices as a comparison. Then what stops it:
 * the daily budget, which only ever applies to billed accounts.
 */
export function explainSpend(s: Pick<DashboardState, "accounts" | "billed" | "cost" | "budgetUsd">, w: Words): Explained {
  const names = (b: (a: Account) => boolean) => s.accounts.filter(b);
  const billed = names((a) => isBilled(a.billing));
  const plans = names((a) => a.billing === "plan");
  const local = names((a) => a.billing === "local");
  const caps = budgetApplies(s);
  const plan = (a: Account) => {
    const window = windowOf(a, w);
    return window ? fmt(w.exPlanOne, { name: a.name, window }) : fmt(w.exPlanUnread, { name: a.name });
  };
  const says = [
    billed.length ? fmt(w.exBilled, { money: money(s.billed), accounts: and(billed.map((a) => a.name)) }) : "",
    plans.length ? fmt(w.exInPlans, { plans: and(plans.map(plan)) }) : "",
    local.length ? fmt(w.exLocal, { accounts: and(local.map((a) => a.name)) }) : "",
    s.cost > 0 ? fmt(w.exApiPrice, { money: money(s.cost) }) : "",
    caps ? (s.budgetUsd > 0 ? fmt(w.exSpendBudget, { budget: money(s.budgetUsd) }) : w.exSpendNoBudget) : "",
    plans.length ? w.plansLimit : "",
  ];
  return { says: says.filter(Boolean).join(" "), todo: caps && !s.budgetUsd ? w.exTodoSpend : w.exTodoNothing };
}

/** A plan an agent wrote for a request you started from a sentence: it only read the project, and waits for you. */
export const explainPlan = (project: string, w: Words): Explained => ({ says: fmt(w.explainPlan, { project }), todo: w.explainPlanTodo });

/** The calls count under Needs you: what counts as a call, and why the number should fall. */
export const explainCalls = (week: number, last: number, w: Words): Explained => ({
  says: week || last ? fmt(w.explainCalls, { n: week, last }) : w.explainCallsStart,
  todo: last && week > last ? w.explainCallsUpTodo : w.explainCallsTodo,
});
