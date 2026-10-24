import { beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Brief, DashboardState } from "@overhand/contract";
import { state } from "@overhand/contract/fixtures/state";

import type { claude } from "../src/claude";
import { briefFacts, briefFor, factsBrief, phrase, snoozedItems, snoozeItem, withAnswer } from "../src/decide";
import { OPS } from "../src/env";
import { assembleProof } from "../src/proof";

// the agent call: what it was asked, and with which options
const calls: { prompt: string; cwd: string; opts: Record<string, unknown> }[] = [];
let reply: unknown = null;
const fakeAgent: typeof claude = async <T>(_s: unknown, prompt: string, cwd: string, _schema: string, _log: string, opts = {}) => {
  calls.push({ prompt, cwd, opts });
  return reply === null ? null : { out: reply as T, account: "work", cost: 0.001, transcript: "" };
};

const NOW = 1_792_330_000_000;
const t = (key: string, labels: string[] = []) => ({
  key,
  title: `Title of ${key}`,
  status: "Todo",
  priority: "High",
  labels,
  url: `https://x/${key}`,
});

const s = state({
  clients: [
    { name: "Honeycrust", prefix: "HONEY", host: "github", autonomy: "act", assignedAutonomy: "act", shipBlock: "" },
    { name: "Bluekite", prefix: "KITE", host: "github", autonomy: "watch", assignedAutonomy: "propose", shipBlock: "" },
  ],
  tickets: { Honeycrust: [t("HONEY-1", ["needs-owner"]), t("HONEY-2")], Bluekite: [t("KITE-3", ["needs-owner"])] },
  splits: {
    "HONEY-2": [
      { title: "Part a", scope: "" },
      { title: "Part b", scope: "" },
    ],
  },
  prs: [
    {
      key: "HONEY-4",
      url: "https://gh/h/4",
      fixes: 1,
      branch: "honey-4",
      draft: true,
      corners: [],
      proof: null,
      preview: "",
      reviewRound: 0,
      ship: null,
    },
    {
      key: "HONEY-5",
      url: "https://gh/h/5",
      fixes: 0,
      branch: "honey-5",
      draft: false,
      corners: [{ kind: "test-skipped", severity: "block", file: "a.test.ts", line: 3, sign: "+", text: "it.skip(" }],
      proof: null,
      preview: "",
      reviewRound: 0,
      ship: null,
    },
  ],
  godmode: [
    {
      key: "kite",
      label: "Bluekite lead",
      name: "",
      project: "Bluekite",
      supervised: true,
      onDemand: false,
      running: false,
      mine: false,
      since: 0,
      stopped: false,
      reason: "",
      waiting: true,
      waitingLimit: false,
      cantStart: null,
      nextAt: 0,
      account: "work",
      inbox: {
        text: "## CSV\nRemove the old CSV route?\nOptions: Remove it | Keep both\nIf there's no answer: I keep both.",
        at: NOW - 60_000,
        open: true,
      },
      open: true,
      ask: { default: "I keep both.", deadline: NOW + 3_600_000, stale: null, recheck: 0 },
    },
  ],
  findings: [
    {
      id: "f1",
      project: "Bluekite",
      key: "KITE-3",
      title: "KITE-3: feedback",
      text: "They want CSV",
      post: "CSV please",
      from: "inbox",
      at: NOW,
    },
  ],
  control: {
    sessions: [],
    requests: [],
    actions: [],
    cards: [{ id: "c1", kind: "competing", project: "", facts: { n: 3, load: 9 }, buttons: ["one-at-a-time", "keep"], auto: false }],
  },
  disk: { freeGb: 4, floorGb: 3, warnGb: 10, heavyGb: 6 },
  accounts: [
    {
      name: "work",
      coolUntil: NOW + 3_600_000,
      usage: null,
      provider: "claude",
      model: "",
      runtime: "claude-code",
      billing: "plan",
      billingSure: true,
      waitsSignIn: false,
    },
  ],
  guardrails: [{ at: 123, project: "Honeycrust", run: "HONEY-1", tool: "Bash", action: "git push --force", rule: "no-force-push" }],
  status: {
    at: 0,
    myPrs: [
      {
        client: "Honeycrust",
        repo: "h/web",
        number: 4,
        title: "Four",
        url: "https://gh/h/4",
        draft: true,
        review: "",
        checks: "SUCCESS",
        updated: "2026-10-18T10:00:00Z",
      },
    ],
    reviews: [
      {
        client: "Honeycrust",
        repo: "h/web",
        number: 9,
        title: "Nine",
        url: "https://gh/h/9",
        draft: false,
        review: "",
        checks: "SUCCESS",
        updated: "2026-10-18T10:00:00Z",
      },
    ],
    ci: [{ client: "Bluekite", repo: "kite/site", branch: "main", state: "fail", failing: ["test"], url: "https://gh/k/actions/1" }],
    deploys: [],
    sentry: [
      { client: "Honeycrust", id: "e1", title: "TypeError: x", count: 12, users: 5, isNew: true, level: "error", url: "https://sentry/e1" },
    ],
    calendar: [],
    errors: [],
  },
});

beforeEach(() => {
  rmSync(join(OPS, "briefs.json"), { force: true });
  calls.length = 0;
  reply = null;
});

const valid = (b: Brief | null) => {
  expect(b).not.toBeNull();
  if (!b) return;
  expect(b.what.length).toBeGreaterThan(0);
  expect(b.why.length).toBeGreaterThan(0);
  expect(b.options.map((o) => o.id)).toContain(b.recommend.option);
  expect(new Set(b.options.map((o) => o.id)).size).toBe(b.options.length);
  expect(b.source).toBe("facts");
};

test("every kind that reaches you gets a brief from facts alone, its recommendation one of its options", () => {
  const ids = [
    "ticket:HONEY-1",
    "ticket:HONEY-2",
    "ticket:KITE-3",
    "lead:kite",
    "pr:HONEY-4",
    "pr:HONEY-5",
    "review:https://gh/h/9",
    "ci:Bluekite/kite/site@main",
    "errors:Honeycrust",
    "held:f1",
    "card:c1",
    "disk",
    "account:work",
    "guard:123",
  ];
  for (const id of ids) valid(factsBrief(s, id, {}, NOW));
  valid(
    factsBrief(
      s,
      "checkup:web:ci",
      { checkup: { repo: "web", finding: { id: "ci", tone: "warn", title: "No CI", task: { kind: "ci", title: "Add CI" } } } },
      NOW,
    ),
  );
  expect(factsBrief(s, "ticket:NOPE-1", {}, NOW)).toBeNull();
  expect(factsBrief(s, "bogus:1", {}, NOW)).toBeNull();
});

test("a group Needs you makes per repo (reviews asked of you, your PRs with changes) has its own brief", () => {
  const pr = (n: number, extra: object = {}) => ({
    client: "Honeycrust",
    repo: "acme/dashboard",
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/dashboard/pull/${n}`,
    draft: false,
    review: "",
    checks: "SUCCESS",
    updated: "",
    ...extra,
  });
  const g = state({
    status: {
      ...state().status,
      reviews: [pr(1), pr(2)],
      myPrs: [pr(3, { review: "CHANGES_REQUESTED" }), pr(4, { review: "CHANGES_REQUESTED" })],
    },
  });
  const reviews = factsBrief(g, "reviews:dashboard", {}, NOW);
  valid(reviews);
  expect(reviews?.evidence.map((e) => e.text)).toEqual(["#1 PR 1", "#2 PR 2"]);
  expect(reviews?.options[0]).toMatchObject({
    do: "link",
    url: `https://github.com/acme/dashboard/pulls?q=${encodeURIComponent("is:pr is:open review-requested:@me")}`,
  });
  const changes = factsBrief(g, "changes:dashboard", {}, NOW);
  valid(changes);
  expect(changes?.what).toBe("2 of your PRs in dashboard have changes requested");
  expect(factsBrief(g, "reviews:elsewhere", {}, NOW)).toBeNull();
});

test("a plan for a request you started offers Go ahead, Change the plan and Drop it, and nothing happens on its own", () => {
  const planned = {
    ...s,
    assigned: [
      {
        key: "HONEY-912345678",
        project: "Honeycrust",
        title: "Make the invite friendlier",
        by: "dashboard" as const,
        local: true,
        at: NOW,
      },
    ],
    findings: [
      {
        id: "p1",
        project: "Honeycrust",
        key: "",
        title: "Make the invite friendlier",
        text: "Change the copy\nKeep the layout",
        post: "",
        from: "agent" as const,
        at: NOW,
        task: "HONEY-912345678",
      },
    ],
  };
  const b = factsBrief(planned, "held:p1", {}, NOW);
  expect(b?.what).toBe('Honeycrust: "Make the invite friendlier"');
  expect(b?.options.map((o) => [o.id, o.do])).toEqual([
    ["go", "assign"],
    ["replan", "replan"],
    ["drop", "dismiss"],
  ]);
  expect(b?.recommend.option).toBe("go");
  expect(b?.ifNothing).toEqual({ text: "Nothing is built until you say go ahead.", at: 0 });
  // an agent's free-text plan (no headings): its lines are what changes, shown in full on the card
  expect(b?.plan).toEqual({ changes: ["Change the copy", "Keep the layout"], see: [] });
});

test("a blocked ticket says what the agent asked, from its newest comment; assign only off act", () => {
  const b = factsBrief(s, "ticket:HONEY-1", { comments: ["old", "Which payment provider: Stripe or Adyen?"] }, NOW);
  expect(b?.why).toContain("Stripe or Adyen");
  expect(b?.options.some((o) => o.do === "assign")).toBe(false); // act: the daemon refuses Assign there
  expect(factsBrief(s, "ticket:KITE-3", {}, NOW)?.options.some((o) => o.do === "assign")).toBe(true);
  expect(factsBrief(s, "ticket:HONEY-2", {}, NOW)?.recommend.option).toBe("split");
});

test("a ticket's question is answerable in one click: its own options, or the agent's choices with one recommended", () => {
  const own = factsBrief(s, "ticket:HONEY-1", { comments: ["Which provider?\nOptions: Stripe | Adyen"] }, NOW);
  expect(own?.options.filter((o) => o.do === "reply")).toEqual([
    { id: "reply-1", do: "reply", key: "HONEY-1", text: "Stripe" },
    { id: "reply-2", do: "reply", key: "HONEY-1", text: "Adyen" },
  ]);
  const b = factsBrief(s, "ticket:HONEY-1", { comments: ["Pending until it settles, or refunded at once?"] }, NOW);
  if (!b) throw new Error("no brief");
  const a = withAnswer(b, {
    what: "W",
    why: "Y",
    recommend: { option: "choice-1", reason: "Matches the bank", confidence: "medium" },
    choices: ["Pending until it settles", "Refunded at once"],
  });
  expect(a.recommend.option).toBe("choice-1");
  expect(a.options[0]).toEqual({ id: "choice-1", do: "reply", key: "HONEY-1", text: "Pending until it settles" });
  // a red build recommends handing the fix to an agent where you can; someone's PR opens to review
  expect(factsBrief(s, "ci:Bluekite/kite/site@main", {}, NOW)?.recommend.option).toBe("assign");
  expect(factsBrief(s, "review:https://gh/h/9", {}, NOW)?.options[0]).toMatchObject({ do: "link", what: "review" });
});

test("a lead's question offers its own choices and default, with the deadline as if-nothing", () => {
  const b = factsBrief(s, "lead:kite", {}, NOW);
  const answers = b?.options.flatMap((o) => (o.do === "answer" ? [o.text] : []));
  expect(answers).toEqual(["Remove it", "Keep both", "Go with your default: I keep both."]);
  expect(b?.what).toContain("Remove the old CSV route?");
  expect(b?.ifNothing).toEqual({ text: "Bluekite lead goes with: I keep both.", at: NOW + 3_600_000 });
  expect(b?.recommend.option).toBe("answer-default");
});

test("PRs: a draft can be marked ready (never merged); a cut corner sends you to review", () => {
  const draft = factsBrief(s, "pr:HONEY-4", {}, NOW);
  expect(draft?.options.some((o) => o.do === "ready")).toBe(true);
  expect(draft?.options.some((o) => o.do === "link" && o.what === "merge")).toBe(false);
  const corner = factsBrief(s, "pr:HONEY-5", {}, NOW);
  expect(corner?.recommend).toMatchObject({ option: "review", confidence: "high" });
});

test("PRs: gaps in the proof reach the card, as evidence and as the reason to review", () => {
  const p = assembleProof({
    transcript: '{"type":"assistant","message":{"content":[]}}',
    numstat: "1\t1\tsrc/a.ts",
    verified: "",
    now: NOW,
  });
  const withGaps = { ...s, prs: s.prs.map((x) => (x.key === "HONEY-4" ? { ...x, proof: p } : x)) };
  const b = factsBrief(withGaps, "pr:HONEY-4", {}, NOW);
  expect(b?.what).toBe("HONEY-4's PR has gaps in its proof.");
  expect(b?.evidence.map((e) => e.text)).toContain("Proof gap: no tests ran");
  expect(b?.recommend.option).toBe("review");
});

test("options carry what the real actions need", () => {
  for (const id of ["ticket:KITE-3", "ci:Bluekite/kite/site@main", "held:f1", "lead:kite"])
    for (const o of factsBrief(s, id, {}, NOW)?.options ?? [])
      if (o.do === "assign") expect(o.project && (o.key || o.finding || o.title)).toBeTruthy();
  const card = factsBrief(s, "card:c1", {}, NOW);
  expect(card?.options[0]).toEqual({ id: "card-one-at-a-time", do: "card", card: "c1", button: "one-at-a-time" });
  expect(factsBrief(s, "disk", {}, NOW)?.recommend.option).toBe("sweep");
});

test("phrased once per facts: cached until the item changes, then phrased again", async () => {
  let n = 0;
  const fake = async () => {
    n++;
    return { what: "Phrased.", why: "Because.", recommend: { option: "open-ticket", reason: "R", confidence: "high" as const } };
  };
  const first = briefFor(s, "ticket:HONEY-1", {}, { phrase: fake, now: NOW });
  expect(first?.brief).toMatchObject({ source: "facts", pending: true });
  await first?.done;
  const again = briefFor(s, "ticket:HONEY-1", {}, { phrase: fake, now: NOW });
  expect(again?.brief).toMatchObject({ source: "agent", what: "Phrased.", pending: false });
  expect(n).toBe(1);
  const changed: DashboardState = {
    ...s,
    tickets: { ...s.tickets, Honeycrust: [{ ...t("HONEY-1", ["needs-owner"]), title: "New title" }] },
  };
  const third = briefFor(changed, "ticket:HONEY-1", {}, { phrase: fake, now: NOW });
  expect(third?.brief.source).toBe("facts");
  await third?.done;
  expect(n).toBe(2);
});

test("the daily cap, a budget pause, a failure and a timeout all fall back to the facts", async () => {
  let n = 0;
  const fake = async () => {
    n++;
    return null;
  };
  await briefFor(s, "ticket:HONEY-1", {}, { phrase: fake, cap: 1 })?.done;
  expect(briefFor(s, "ticket:HONEY-1", {}, { phrase: fake, cap: 1 })?.brief).toMatchObject({ source: "facts", pending: false });
  expect(n).toBe(1); // failed on these facts: not asked again
  expect(briefFor(s, "disk", {}, { phrase: fake, cap: 1 })?.brief.pending).toBe(false); // capped
  expect(briefFor({ ...s, paused: true }, "lead:kite", {}, { phrase: fake })?.brief.pending).toBe(false);
  expect(n).toBe(1);
  const hang = () => new Promise<null>(() => undefined);
  const slow = briefFor(s, "pr:HONEY-4", {}, { phrase: hang, timeoutMs: 5 });
  await slow?.done;
  expect(briefFor(s, "pr:HONEY-4", {}, { phrase: hang, timeoutMs: 5 })?.brief).toMatchObject({ source: "facts", pending: false });
});

test("an agent's pick that isn't an option keeps the facts' pick; its answer choices join the lead's", () => {
  const b = factsBrief(s, "lead:kite", {}, NOW);
  if (!b) throw new Error("no brief");
  const a = withAnswer(b, {
    what: "W",
    why: "Y",
    recommend: { option: "merge-it", reason: "R", confidence: "high" },
    choices: ["Keep both", "Remove it after the demo"],
  });
  expect(a.recommend).toEqual(b.recommend);
  expect(a.options.filter((o) => o.do === "answer").map((o) => (o.do === "answer" ? o.text : ""))).toContain("Remove it after the demo");
  expect(a.options.filter((o) => o.do === "answer" && o.text === "Keep both")).toHaveLength(1);
});

test("the real call is one read-only run on your own account, cheapest model, no code in reach, nothing posted", async () => {
  const b = factsBrief(s, "ticket:KITE-3", { comments: ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked?"] }, NOW);
  if (!b) throw new Error("no brief");
  reply = { what: "W", why: "Y", recommend: { option: "open-ticket", reason: "R", confidence: "low" } };
  const facts = briefFacts(b, { comments: ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked?"] });
  expect(facts).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(await phrase(b, facts, fakeAgent)).toMatchObject({ what: "W" });
  const [c] = calls;
  expect(c?.opts).toMatchObject({ model: "haiku", autonomy: "watch" });
  expect(c?.cwd).toContain("overhand-brief-");
  expect(c?.prompt).toContain("Use no tools");
  reply = { status: "failed", message: "boom" };
  expect(await phrase(b, facts, fakeAgent)).toBeNull();
  // nothing outward: the only tracker call a brief makes is the read of a ticket and its comments
  const src = readFileSync(join(import.meta.dir, "../src/decide.ts"), "utf8");
  expect(src.match(/import \{([^}]*)\} from "\.\/trackers\/index"/)?.[1]?.trim()).toBe("tickets");
  expect(src).not.toMatch(/holdFinding|comment\(|createTicket|setLabels|webPush|notify\(/);
});

test("a snooze hides an item until it runs out", () => {
  const until = snoozeItem("ticket:HONEY-1", 2, NOW);
  expect(snoozedItems(NOW + 1)).toEqual({ "ticket:HONEY-1": until });
  expect(snoozedItems(until + 1)).toEqual({});
});
