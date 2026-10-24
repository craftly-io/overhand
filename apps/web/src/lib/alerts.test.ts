import { expect, test } from "bun:test";
import { factsBrief } from "@overhand/contract";
import { NOW, state } from "@overhand/contract/fixtures/state";
import { plainWords, worldById } from "@overhand/themes";
import { askNotes, brokenCount, computeAlerts } from "./alerts";
import { briefing } from "./briefing";
import { parsePlan } from "./plan";

const ci = (repo: string, state: "pass" | "fail") => ({
  client: "Online shop",
  repo,
  branch: "main",
  state,
  failing: ["test"],
  url: `https://ci/${repo}`,
});

test("alerts: blocked tickets, tracker errors and an offline daemon, most urgent first; red CI is Health's", () => {
  const s = state({
    daemon: false,
    tickets: {
      "Online shop": [{ key: "SHOP-2", title: "Pick a colour", status: "Todo", priority: "", labels: ["needs-owner"], url: "" }],
      Beta: "tracker timed out",
    },
    status: {
      at: 0,
      myPrs: [],
      reviews: [],
      ci: [ci("web", "fail"), ci("api", "pass")],
      deploys: [],
      sentry: [],
      calendar: [],
      errors: [],
    },
  });
  const a = computeAlerts(s, parsePlan([]), plainWords, NOW);
  expect(a.map((x) => [x.sev, x.title])).toEqual([
    [3, "SHOP-2 needs your answer"],
    [3, "Overhand is offline"],
    [2, "Beta tracker isn't responding"],
  ]);
  expect(a[0]?.target).toEqual({ kind: "ticket", key: "SHOP-2" });
  // a red build is a fact, not a decision: Health counts it
  expect(brokenCount(s)).toBe(1);
});

test("red builds and new errors never reach Needs you; Health counts them and Brief me says the count once", () => {
  const issue = (title: string) => ({
    client: "Online shop",
    id: title,
    title,
    url: `https://e/${title}`,
    count: 500,
    users: 1,
    isNew: true,
    level: "error",
  });
  const s = state({
    status: {
      ...state().status,
      ci: ["a", "b", "c"].map((r) => ci(r, "fail")),
      sentry: [issue("a"), issue("b")],
    },
  });
  const a = computeAlerts(s, parsePlan([]), plainWords, NOW);
  expect(a).toEqual([]);
  expect(brokenCount(s)).toBe(5);
  expect(briefing(s, parsePlan([]), a, plainWords, new Date(NOW), () => 0)).toContain(
    "Red in Health: five, builds or new errors, for when you want a look.",
  );
});

test("review requests and changes asked of you collapse to one item per repo", () => {
  const pr = (n: number, extra: object = {}) => ({
    client: "Online shop",
    repo: "acme/dashboard",
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/dashboard/pull/${n}`,
    checks: "SUCCESS",
    review: "",
    draft: false,
    updated: "",
    ...extra,
  });
  const s = state({
    status: {
      ...state().status,
      reviews: [pr(1), pr(2), pr(3), { ...pr(9), repo: "acme/api", url: "https://github.com/acme/api/pull/9" }],
      myPrs: [pr(4, { review: "CHANGES_REQUESTED" }), pr(5, { review: "CHANGES_REQUESTED" })],
    },
  });
  const a = computeAlerts(s, parsePlan([]), plainWords, NOW);
  expect(a.map((x) => x.title)).toEqual([
    "Changes requested on 2 of your PRs in dashboard",
    "3 reviews requested in dashboard",
    "Review requested: api #9",
  ]);
  expect(a[1]?.sub).toBe("#1 PR 1 · #2 PR 2 · #3 PR 3");
  expect(a[1]?.target).toEqual({
    kind: "link",
    url: `https://github.com/acme/dashboard/pulls?q=${encodeURIComponent("is:pr is:open review-requested:@me")}`,
  });
  expect(a[0]?.item).toBe("changes:dashboard");
  // every item Needs you names opens a decision card: its brief must exist (a 404 there is a card that never loads)
  for (const x of a) if (x.item) expect(factsBrief(s, x.item, {}, NOW)).not.toBeNull();
});

test("alerts: a meeting within 15 minutes, a lead's question, planner notes", () => {
  const s = state({
    status: {
      at: 0,
      myPrs: [],
      reviews: [],
      ci: [],
      deploys: [],
      sentry: [],
      errors: [],
      calendar: [{ title: "Standup", start: NOW + 5 * 60000, end: NOW + 20 * 60000, allDay: false }],
    },
    godmode: [
      {
        key: "shop",
        label: "Online shop lead",
        name: "",
        project: "Online shop",
        supervised: true,
        onDemand: false,
        running: false,
        mine: true,
        since: 0,
        stopped: false,
        reason: "",
        waiting: true,
        waitingLimit: false,
        nextAt: 0,
        account: "work",
        inbox: { text: "# Questions\nShip on Friday?", at: NOW, open: true },
        open: true,
        ask: null,
      },
    ],
  });
  const a = computeAlerts(s, parsePlan(["## Notes", "Drift: SHOP-9"]), plainWords, NOW);
  expect(a.map((x) => x.title)).toEqual(["Question from Online shop lead", "Standup in 5 min", "Planner flagged risks and tracker drift"]);
  expect(a[0]?.sub).toBe("Ship on Friday?");
  // a lead you renamed goes by your name in Needs you too
  const renamed = computeAlerts({ ...s, names: { "lead:shop": "Night watch" } }, parsePlan([]), plainWords, NOW);
  expect(renamed[0]?.title).toBe("Question from Night watch");
});

test("a lead question says when it goes with its default, or that it waits, and why it may be out of date", () => {
  const at = new Date(2026, 9, 20, 10, 30).getTime();
  expect(askNotes({ default: "I start #12", deadline: at, stale: null, recheck: 0 }, plainWords, at - 1)).toEqual([
    "Goes with its default at 10:30: I start #12",
  ]);
  expect(askNotes({ default: "", deadline: 0, stale: null, recheck: at + 60_000 }, plainWords, at)).toEqual([
    "No default yet: at 10:31 Overhand asks the lead to re-check and give one",
  ]);
  expect(askNotes({ default: "", deadline: 0, stale: null, recheck: at - 1 }, plainWords, at)).toEqual([
    "No default yet: Overhand has asked the lead for one",
  ]);
  expect(askNotes({ default: "I start #12", deadline: 0, stale: { closed: ["#12"], hours: 26 }, recheck: 0 }, plainWords, at)).toEqual([
    "May be out of date: #12 closed since; asked 26 h ago",
    "Its default: I start #12. It waits for you.",
  ]);
  // a paragraph-long default is said once, beside its button: the note only says when
  const long = "Skip Slack reads this run, keep working CI fixes and the handoff backlog, and re-check MCP next run.";
  expect(askNotes({ default: long, deadline: at, stale: null, recheck: 0 }, plainWords, at - 1)).toEqual([
    "Goes with its default at 10:30 (its words are below)",
  ]);
});

test("alerts say the same words in every world; only the greeting's flavour lines change", () => {
  const s = state({
    tickets: { "Online shop": [{ key: "SHOP-2", title: "", status: "", priority: "", labels: ["needs-owner"], url: "" }] },
  });
  const say = (id: string) => {
    const t = worldById(id);
    return briefing(s, parsePlan([]), computeAlerts(s, parsePlan([]), t.words, NOW), t.words, new Date(2026, 9, 18, 10), () => 0);
  };
  expect(say("catnap")).toBe("Morning, Sam. Heads up: Online shop needs an answer from you. Everyone's asleep in the sun. That's the lot.");
});

test("a PR with a block-worthy cut corner is one Needs-you item that opens Review; a warn-only one stays quiet", () => {
  const corner = (severity: "warn" | "block", kind: "test-skipped" | "check-loosened") => ({
    kind,
    severity,
    file: "api/tenants.test.ts",
    line: 19,
    sign: "+" as const,
    text: 'test.skip("expires", () => {',
  });
  const pr = { url: "https://x/1", client: "Online shop", fixes: 1, branch: "b", draft: true, preview: "", reviewRound: 0 };
  const s = state({
    prs: [
      { ...pr, key: "SHOP-1", corners: [corner("block", "test-skipped"), corner("warn", "check-loosened")] },
      { ...pr, key: "SHOP-2", url: "https://x/2", draft: false, corners: [corner("warn", "check-loosened")] },
    ],
    guardrails: [
      {
        at: NOW,
        project: "Online shop",
        run: "SHOP-1",
        tool: "Bash",
        action: "git push origin main",
        rule: "push only the agent's own feature branch",
      },
    ],
  });
  const all = computeAlerts(s, parsePlan([]), plainWords, NOW);
  const a = all.filter((x) => x.target.kind === "review");
  expect(a.map((x) => [x.sev, x.title, x.sub])).toEqual([[3, "Check before merging: SHOP-1", "Test skipped · api/tenants.test.ts"]]);
  expect(briefing(s, parsePlan([]), all, plainWords, new Date(NOW), () => 0)).toContain("Actions the guardrails blocked: one.");
});

test("an installed copy behind the latest release gets one calm note", () => {
  const behind = computeAlerts(
    state({ update: { latest: "0.3.0", current: "0.2.0", command: "overhand update" } }),
    parsePlan([]),
    plainWords,
    NOW,
  );
  expect(behind.map((x) => [x.sev, x.title, x.sub])).toEqual([
    [1, "Overhand 0.3.0 is out", "Run overhand update in a terminal. You have 0.2.0."],
  ]);
  // each install kind is told its own way to update
  const brew = computeAlerts(
    state({ update: { latest: "0.3.0", current: "0.2.0", command: "brew upgrade overhand" } }),
    parsePlan([]),
    plainWords,
    NOW,
  );
  expect(brew[0]?.sub).toBe("Run brew upgrade overhand in a terminal. You have 0.2.0.");
  // after the update the daemon runs the new version, and the note is gone
  expect(
    computeAlerts(state({ update: { latest: "0.2.0", current: "0.2.0", command: "overhand update" } }), parsePlan([]), plainWords, NOW),
  ).toEqual([]);
  expect(computeAlerts(state(), parsePlan([]), plainWords, NOW)).toEqual([]);
});

test("a reached daily budget waits in Needs you, counted in billed money only", () => {
  const titles = (over: Parameters<typeof state>[0]) => computeAlerts(state(over), parsePlan([]), plainWords, NOW).map((a) => a.title);
  const key = {
    name: "key",
    coolUntil: 0,
    usage: null,
    provider: "claude",
    model: "",
    runtime: "claude-code",
    billing: "pay-per-use",
    billingSure: true,
    waitsSignIn: false,
  } as const;
  const plan = {
    name: "work",
    coolUntil: 0,
    usage: null,
    provider: "claude",
    model: "",
    runtime: "claude-code",
    billing: "plan",
    billingSure: true,
    waitsSignIn: false,
  } as const;
  expect(titles({ accounts: [key, plan], budgetUsd: 10, billed: 10.4, budgetSpent: 10.4, cost: 30 })).toContain(
    "Daily budget of $10 reached",
  );
  expect(titles({ accounts: [key, plan], budgetUsd: 10, billed: 2, budgetSpent: 2, cost: 30 })).not.toContain(
    "Daily budget of $10 reached",
  );
  // plans only: $30 at API prices was never billed, so the budget isn't reached
  expect(titles({ accounts: [plan], budgetUsd: 10, billed: 0, cost: 30 })).not.toContain("Daily budget of $10 reached");
  expect(titles({ accounts: [key], budgetUsd: 0, billed: 12, budgetSpent: 12, cost: 12 }).some((t) => t.startsWith("Daily budget"))).toBe(
    false,
  );
});

test("an account whose billing isn't known is asked about once in Needs you, until the person picks", () => {
  const acc = (billingSure: boolean) => ({
    name: "work",
    coolUntil: 0,
    usage: null,
    provider: "claude",
    model: "",
    runtime: "claude-code",
    billing: "plan" as const,
    billingSure,
    waitsSignIn: false,
  });
  const titles = (sure: boolean) => computeAlerts(state({ accounts: [acc(sure)] }), parsePlan([]), plainWords, NOW).map((a) => a.title);
  expect(titles(false).filter((t) => t === "Is work billed per use or part of a plan?")).toHaveLength(1);
  expect(titles(true)).not.toContain("Is work billed per use or part of a plan?");
});

test("day one gets one calm line while a project is on propose", () => {
  const dayOne = (over: Parameters<typeof state>[0]) =>
    computeAlerts(state(over), parsePlan([]), plainWords, NOW).filter((a) => a.title === plainWords.alDayOne);
  const propose = [
    { name: "Online shop", prefix: "SHOP", host: "github" as const, autonomy: "propose" as const, assignedAutonomy: "act" as const },
  ];
  expect(dayOne({ dayOne: true, clients: propose }).map((a) => a.sev)).toEqual([1]);
  expect(dayOne({ dayOne: false, clients: propose })).toEqual([]);
  expect(dayOne({ dayOne: true })).toEqual([]); // the fixture's project acts
});

test("a rule learned from review is one calm item that says how often you asked and where it would go", () => {
  const rule = {
    id: "Acme:x",
    project: "Acme",
    repo: "web",
    rule: "Log the request id",
    keys: ["AC-1", "AC-2"],
    file: "AGENTS.md",
    standing: false,
  };
  const items = (times: number) =>
    computeAlerts(state({ rules: [{ ...rule, times }] }), parsePlan([]), plainWords, NOW).filter((a) => a.target.kind === "rule");
  expect(items(2).map((a) => [a.sev, a.title, a.sub])).toEqual([
    [1, "You've asked for this twice: Log the request id", "Add it to AGENTS.md so every agent knows?"],
  ]);
  expect(items(3)[0]?.title).toBe("You've asked for this 3 times: Log the request id");
  const standing = computeAlerts(state({ rules: [{ ...rule, times: 1, standing: true }] }), parsePlan([]), plainWords, NOW);
  expect(standing.find((a) => a.target.kind === "rule")?.title).toBe("From your answer: Log the request id");
});

test("the demo offers Booking app's repeated ask and not Online shop's, which its CLAUDE.md already says", async () => {
  const { RULES } = await import("@/demo/instructions");
  expect(RULES.map((r) => [r.project, r.rule, r.file])).toEqual([["Booking app", "Log the request ID with handler errors", "CLAUDE.md"]]);
});

test("on watch, what's held for you is in Needs you with Assign an agent; an act project builds on its own and offers none", () => {
  const watch = [{ name: "Online shop", prefix: "SHOP", host: "github", autonomy: "watch" as const, assignedAutonomy: "act" as const }];
  const finding = {
    id: "f1",
    project: "Online shop",
    key: "SHOP-7",
    title: "SHOP-7: Fix login",
    text: "Investigation, nothing changed yet:\n\nThe token expires early.",
    post: "Investigation, nothing changed yet",
    from: "agent" as const,
    at: NOW,
  };
  const held = (over: Parameters<typeof state>[0]) =>
    computeAlerts(state(over), parsePlan([]), plainWords, NOW).filter((a) => a.target.kind === "held");
  const [a] = held({ clients: watch, findings: [finding] });
  expect(a).toMatchObject({
    sev: 2,
    title: "Held for you: SHOP-7: Fix login",
    assign: { project: "Online shop", id: "f1" },
    target: { kind: "held", id: "f1", key: "SHOP-7", post: true },
  });
  expect(a?.sub).toContain("Investigation");
  // already assigned: no second offer
  const assigned = [{ key: "SHOP-7", project: "Online shop", title: "", by: "dashboard" as const, local: false, at: NOW }];
  expect(held({ clients: watch, findings: [finding], assigned })[0]?.assign).toBeUndefined();
  // a project on act: nothing to assign
  expect(held({ findings: [finding] })[0]?.assign).toBeUndefined();
});

test("an account the sandbox keeps off your own sign-in gets a Sign in card: amber while others carry its work, red alone", () => {
  const acc = (name: string, waitsSignIn: boolean) => ({
    name,
    coolUntil: 0,
    usage: null,
    provider: "claude",
    model: "",
    runtime: "claude-code",
    billing: "plan" as const,
    billingSure: true,
    waitsSignIn,
  });
  const signIns = (accounts: ReturnType<typeof acc>[]) =>
    computeAlerts(state({ accounts }), parsePlan([]), plainWords, NOW).filter((a) => a.target.kind === "signin");
  const one = signIns([acc("claude", true), acc("work", false)]);
  expect(one.map((a) => [a.title, a.sev, a.broken ?? false])).toEqual([["Sign in claude once", 2, false]]);
  expect(one[0]?.target).toEqual({ kind: "signin", account: "claude", tool: "Claude Code" });
  expect(signIns([acc("claude", true)]).map((a) => [a.sev, a.broken])).toEqual([[3, true]]);
  expect(signIns([acc("work", false)])).toEqual([]);
});

test("every problem's card carries its fix: restart when offline, start a crashed lead, raise a spent budget, reconnect a tracker", () => {
  const base = state({});
  const targets = (s: typeof base) => computeAlerts(s, parsePlan([]), plainWords, NOW).map((a) => a.target);
  expect(targets({ ...base, daemon: false })).toContainEqual({ kind: "restart" });
  const billed = base.accounts.map((x) => ({ ...x, billing: "pay-per-use" as const }));
  expect(targets({ ...base, accounts: billed, budgetUsd: 10, budgetSpent: 12 })).toContainEqual({ kind: "raise", usd: 20 });
  const tracker = computeAlerts({ ...base, tickets: { Acme: "401 Unauthorized" } }, parsePlan([]), plainWords, NOW).find(
    (a) => a.title === "Acme tracker isn't responding",
  );
  expect(tracker?.target).toEqual({ kind: "settings", tab: "integrations", project: "Acme" });
  expect(tracker?.go).toBe("Reconnect");
  // no card can be left with nothing to click: AlertTarget has no "none" (tsc fails on one); each kind has its button
});

test("a sandbox that can't run, a failed plan and blocked git each come with their fix", () => {
  const base = state({});
  const by = (s: typeof base) => computeAlerts(s, parsePlan([]), plainWords, NOW);
  const sb = by({ ...base, sandboxRefuse: "sandbox-exec is missing" }).find((a) => a.title === plainWords.alSandboxRefuse);
  expect([sb?.sub, sb?.target]).toEqual(["sandbox-exec is missing", { kind: "settings", tab: "system" }]);
  const failed = ["08:00 📋 plan written: 3 agent tasks ready", "09:00 ✗ plan failed (no capacity)"];
  expect(by({ ...base, reports: failed }).some((a) => a.target.kind === "replan")).toBe(true);
  expect(by({ ...base, reports: [...failed, "10:00 📋 plan written: 2 agent tasks ready"] }).some((a) => a.target.kind === "replan")).toBe(
    false,
  );
  const git = by({ ...base, gitBlocked: ["/code/app"] }).find((a) => a.target.kind === "git");
  expect([git?.title, git?.target]).toEqual(["Git is stopped in /code/app", { kind: "git", dir: "/code/app" }]);
});

test("a new release offers Update and restart; a meeting soon offers quiet mode for the call", () => {
  const base = state({});
  const upd = computeAlerts(
    { ...base, update: { ...base.update, latest: "9.0.0", current: "1.0.0" } },
    parsePlan([]),
    plainWords,
    NOW,
  ).find((a) => a.target.kind === "update");
  expect(upd?.go).toBe(plainWords.confirmUpdateGo);
  const call = { title: "Standup", start: NOW + 10 * 60_000, end: NOW + 25 * 60_000, allDay: false };
  const meeting = computeAlerts({ ...base, status: { ...base.status, calendar: [call] } }, parsePlan([]), plainWords, NOW).find(
    (a) => a.target.kind === "quiet",
  );
  expect(meeting?.target).toEqual({ kind: "quiet", hours: 1 });
});
