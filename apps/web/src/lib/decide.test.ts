import { expect, test } from "bun:test";
import { type BriefOption, BriefOptionSchema, BriefSchema, briefKindOf } from "@overhand/contract";
import { NOW, state } from "@overhand/contract/fixtures/state";
import { plainWords, themes } from "@overhand/themes";
import { demoBrief } from "../demo/briefs";
import { clockAt, nightAt } from "../demo/night";
import { computeAlerts } from "./alerts";
import { answerDetail, insightFor, type OptionRunner, optionLabel, runOption } from "./decide";
import { parsePlan } from "./plan";

/** One option of every kind the daemon can offer. */
const EVERY: BriefOption[] = [
  { id: "a", do: "answer", lead: "kite", text: "Keep both" },
  { id: "a2", do: "reply", key: "WEB-3", text: "Pending until it settles" },
  { id: "b", do: "assign", project: "Company website", key: "WEB-3", finding: "", title: "", brief: "" },
  { id: "b2", do: "assign", project: "Company website", key: "", finding: "f1", title: "", brief: "" },
  { id: "c", do: "ready", key: "WEB-31" },
  { id: "d", do: "link", url: "https://gh/pr/1", what: "merge" },
  { id: "e", do: "drawer", drawer: "review", key: "WEB-31", tab: "" },
  { id: "e2", do: "drawer", drawer: "settings", key: "", tab: "accounts" },
  { id: "e3", do: "drawer", drawer: "sweep", key: "", tab: "" },
  { id: "f", do: "card", card: "c1", button: "one-at-a-time" },
  { id: "g", do: "quiet", hours: 2 },
  { id: "h", do: "post", finding: "f1", key: "WEB-3" },
  { id: "i", do: "dismiss", what: "lead", target: "kite" },
  { id: "i2", do: "dismiss", what: "held", target: "f1" },
  { id: "j", do: "snooze", hours: 24 },
  { id: "k", do: "organise", suggestion: "tidy-folders", action: "preview", label: "Show the dry run" },
  { id: "replan", do: "replan", finding: "f2", project: "Mobile app", text: "make the invite friendlier" },
];

function recorder() {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const r: OptionRunner = {
    leadAnswer: rec("leadAnswer"),
    ticketAnswer: rec("ticketAnswer"),
    assign: rec("assign"),
    prReady: rec("prReady"),
    cardAct: rec("cardAct"),
    quiet: rec("quiet"),
    heldPost: rec("heldPost"),
    heldDismiss: rec("heldDismiss"),
    snooze: rec("snooze"),
    organise: rec("organise"),
    replan: rec("replan"),
    openDrawer: (d) => void calls.push(["openDrawer", d]),
    openLink: (url) => void calls.push(["openLink", url]),
  };
  return { calls, r };
}

test("every option runs one of the dashboard's real actions, and merging is never one", async () => {
  const { calls, r } = recorder();
  for (const o of EVERY) await runOption(BriefOptionSchema.parse(o), "ticket:WEB-3", r);
  expect(calls).toEqual([
    ["leadAnswer", "kite", "Keep both"],
    ["ticketAnswer", "WEB-3", "Pending until it settles"],
    ["assign", { project: "Company website", key: "WEB-3", title: undefined, brief: undefined }],
    ["assign", { project: "Company website", id: "f1" }],
    ["prReady", "WEB-31"],
    ["openLink", "https://gh/pr/1"],
    ["openDrawer", { kind: "review", key: "WEB-31" }],
    ["openDrawer", { kind: "settings", tab: "accounts" }],
    ["openDrawer", { kind: "sweep" }],
    ["cardAct", "c1", "one-at-a-time"],
    ["quiet", 2],
    ["heldPost", "f1", "WEB-3"],
    ["leadAnswer", "kite", "", "dismiss"],
    ["heldDismiss", "f1"],
    ["snooze", "ticket:WEB-3", 24],
    ["organise", "tidy-folders", "preview"],
    ["replan", "f2", "Mobile app", "make the invite friendlier"],
  ]);
});

test("every option has words in every theme, with nothing left unfilled", () => {
  for (const t of themes)
    for (const o of EVERY) {
      const label = optionLabel(o, t.words);
      expect(label.length, `${t.id} ${o.do}`).toBeGreaterThan(0);
      expect(label).not.toMatch(/\{\w+\}/);
    }
});

test("Needs you names each item so its card can find it, and leaves snoozed ones out until the snooze ends", () => {
  const s = state({
    tickets: { "Online shop": [{ key: "SHOP-2", title: "Pick", status: "Todo", priority: "", labels: ["needs-owner"], url: "" }] },
  });
  const items = computeAlerts(s, parsePlan([]), plainWords, NOW).map((a) => a.item);
  expect(items).toContain("ticket:SHOP-2");
  const snoozed = { ...s, snoozed: { "ticket:SHOP-2": NOW + 1000 } };
  expect(computeAlerts(snoozed, parsePlan([]), plainWords, NOW).map((a) => a.item)).not.toContain("ticket:SHOP-2");
  expect(computeAlerts(snoozed, parsePlan([]), plainWords, NOW + 2000).map((a) => a.item)).toContain("ticket:SHOP-2");
});

test("an empty pane gets an insight: red build first on Now, an empty queue first on Work, else all green", () => {
  const red = state({
    status: {
      at: 0,
      myPrs: [],
      reviews: [],
      ci: [{ client: "Online shop", repo: "web", branch: "main", state: "fail", failing: ["e2e"], url: "https://ci/1" }],
      deploys: [],
      sentry: [],
      calendar: [],
      errors: [],
    },
  });
  expect(insightFor("now", red, plainWords)).toEqual({
    text: "web has been red: e2e",
    go: { label: "Open the run", to: { kind: "link", url: "https://ci/1" } },
  });
  expect(insightFor("work", red, plainWords)?.go?.to).toEqual({ kind: "plan" });
  expect(
    insightFor(
      "health",
      state({
        accounts: [
          {
            name: "key",
            coolUntil: 0,
            usage: null,
            provider: "claude",
            model: "",
            runtime: "claude-code",
            billing: "pay-per-use",
            billingSure: true,
            waitsSignIn: false,
          },
          {
            name: "work",
            coolUntil: 0,
            usage: null,
            provider: "claude",
            model: "",
            runtime: "claude-code",
            billing: "plan",
            billingSure: true,
            waitsSignIn: false,
          },
        ],
        budgetUsd: 10,
        billed: 2,
        budgetSpent: 2,
        cost: 9,
        runs: [
          { name: "X-1", account: "key", cost: 1, ok: true },
          { name: "X-2", account: "key", cost: 1, ok: true },
          { name: "X-3", account: "work", cost: 7, ok: true }, // a plan's run: not billed, not in the headroom
        ],
      }),
      plainWords,
    )?.text,
  ).toBe("$2.00 of $10.00 billed today: room for about 8 more billed runs");
  // plans only: the budget caps nothing, so there's no headroom line
  expect(insightFor("health", state({ budgetUsd: 10, cost: 9 }), plainWords)?.text).not.toContain("billed");
});

test("the demo's Needs you items each have a brief whose recommendation is one of its options", () => {
  const min = 510;
  const s = nightAt(min);
  const items = computeAlerts(s, parsePlan(s.plan), plainWords, clockAt(min)).flatMap((a) => (a.item ? [a.item] : []));
  expect(items.length).toBeGreaterThan(4);
  const realNow = Date.now;
  Date.now = () => clockAt(min);
  try {
    for (const id of items) {
      expect(briefKindOf(id), id).not.toBeNull();
      const b = BriefSchema.parse(demoBrief(id, s));
      expect(
        b.options.map((o) => o.id),
        id,
      ).toContain(b.recommend.option);
    }
  } finally {
    Date.now = realNow;
  }
});

test("a paragraph-long answer gets a short button and its words beside it; a short one stays on its button", () => {
  const long = "Leave Amplify auto-build as it is, skip Slack reads this run and keep working CI fixes and the handoff backlog.";
  const def: BriefOption = { id: "answer-default", do: "answer", lead: "x", text: `Go with your default: ${long}` };
  expect(optionLabel(def, plainWords)).toBe("Go with the default");
  expect(answerDetail(def)).toBe(`Go with your default: ${long}`);
  const reply: BriefOption = { id: "a1", do: "answer", lead: "x", text: long };
  expect(optionLabel(reply, plainWords)).toBe("Send this answer");
  const short: BriefOption = { id: "a2", do: "answer", lead: "x", text: "Node 22" };
  expect(optionLabel(short, plainWords)).toBe("Answer: Node 22");
  expect(answerDetail(short)).toBeNull();
});
