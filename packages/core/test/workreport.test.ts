import { expect, test } from "bun:test";
import {
  costLines,
  estimateMinutes,
  localDay,
  type Run,
  rangeText,
  reportCsv,
  reportMarkdown,
  UpdateChannelSchema,
  workReport,
} from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { buildHistory, type Outcome } from "../src/history";
import { failureReasons, lastSlot, prSizes, reportHtml, sendReport } from "../src/workreport";

const at = (s: string) => new Date(s).getTime();
const MIN = 60_000;
const id = { runtime: "claude-code", provider: "claude", model: "" };
const run = (name: string, key: string, kind: Run["kind"], start: string, min: number, cost: number, more: Partial<Run> = {}): Run => ({
  name,
  account: "work",
  start: at(start),
  end: at(start) + min * MIN,
  cost,
  ok: true,
  kind,
  key,
  project: "Fernway",
  ...id,
  ...more,
});

/** A week of Fernway, plus a PR from earlier that merged in it and another project's run. */
const RUNS: Run[] = [
  run("FERN-0", "FERN-0", "ticket", "2026-10-01T10:00:00", 30, 1),
  run("FERN-1", "FERN-1", "ticket", "2026-10-13T10:00:00", 30, 1),
  run("FERN-1-fix", "FERN-1", "fix", "2026-10-13T15:00:00", 10, 0.2),
  run("FERN-2", "FERN-2", "ticket", "2026-10-14T09:00:00", 20, 0.5, { ok: false }),
  run("FERN-2", "FERN-2", "ticket", "2026-10-15T11:00:00", 40, 0.8),
  run("FERN-3", "FERN-3", "ticket", "2026-10-16T13:00:00", 60, 1.5, { ok: false, timedOut: true }),
  run("FERN-4", "FERN-4", "ticket", "2026-10-17T09:00:00", 15, 0.4),
  run("lead-fern", "", "lead", "2026-10-13T08:00:00", 30, 0.3, { account: "sam" }), // on a plan: never billed
  run("KITE-1", "KITE-1", "ticket", "2026-10-13T10:00:00", 50, 9, { project: "Kite" }),
];
const pr = (n: number) => `https://github.com/fern/app/pull/${n}`;
const OUTCOMES: Outcome[] = [
  { at: at("2026-10-01T10:31:00"), key: "FERN-0", event: "pr", url: pr(0), added: 700, removed: 300, docsOnly: false },
  { at: at("2026-10-13T12:00:00"), key: "FERN-0", event: "merged", fixes: 0 },
  { at: at("2026-10-13T10:31:00"), key: "FERN-1", event: "pr", url: pr(1), added: 100, removed: 20, docsOnly: false },
  { at: at("2026-10-14T16:00:00"), key: "FERN-1", event: "merged", fixes: 1 },
  { at: at("2026-10-14T09:20:00"), key: "FERN-2", event: "failed" },
  { at: at("2026-10-15T11:41:00"), key: "FERN-2", event: "pr", url: pr(2), added: 10, removed: 0, docsOnly: true },
  { at: at("2026-10-16T10:00:00"), key: "FERN-2", event: "merged", fixes: 0 },
  { at: at("2026-10-17T09:16:00"), key: "FERN-4", event: "pr", url: pr(4) },
];
const LOG = ["- 09:20 ✗ FERN-2 (work, $0.50) attempt 1: tests wouldn't start: missing env", "- 11:41 ✅ FERN-2 (work, $0.80) → x"];
const FROM = at("2026-10-12T00:00:00");
const TO = at("2026-10-19T00:00:00");
const NOW = at("2026-10-20T09:00:00");

const history = buildHistory(
  RUNS,
  OUTCOMES,
  (account) => ({ ...id, billing: account === "sam" ? "plan" : "pay-per-use" }),
  () => "Fernway",
  NOW,
);
const r = workReport(history, "Fernway", FROM, TO, prSizes(OUTCOMES), failureReasons(LOG));

test("the estimate: 20 min + 30 s per changed line, capped at 4 h, docs at half, unknown size at the base", () => {
  expect(estimateMinutes({ added: 100, removed: 20, docsOnly: false })).toBe(80);
  expect(estimateMinutes({ added: 700, removed: 300, docsOnly: false })).toBe(240);
  expect(estimateMinutes({ added: 10, removed: 0, docsOnly: true })).toBe(13);
  expect(estimateMinutes(undefined)).toBe(20);
});

test("a week's numbers from a fixture history", () => {
  expect(r.ticketsDone).toEqual(["FERN-0", "FERN-1", "FERN-2"]); // FERN-0 opened before the week, merged in it
  expect([r.opened, r.merged]).toEqual([3, 3]);
  expect(r.runs).toBe(7); // Kite's run and FERN-0's old run stay out
  expect(r.agentMinutes).toBe(30 + 10 + 20 + 40 + 60 + 15 + 30);
  expect(r.cost).toBe(4.7); // at API prices: every run
  expect(r.billed).toBe(4.4); // billed: the pay-per-use account's runs only
  expect(r.fixRounds).toBe(1);
  expect(r.estimate.minutes).toBe(240 + 80 + 13); // merged PRs only; the open FERN-4 counts nothing
  expect(r.failures).toEqual([
    {
      key: "FERN-2",
      at: at("2026-10-14T09:00:00"),
      outcome: "failed",
      reason: "tests wouldn't start: missing env",
      fixedBy: "a later run opened a pull request that merged",
    },
    { key: "FERN-3", at: at("2026-10-16T13:00:00"), outcome: "timeout", reason: "", fixedBy: "" },
  ]);
  expect(r.open).toEqual([
    { key: "FERN-4", url: pr(4), what: "Pull request open, waiting for review" },
    { key: "FERN-3", url: "", what: "failed, not fixed yet" },
  ]);
  expect(r.byTicket.find((t) => t.key === "(other)")).toEqual({ key: "(other)", runs: 1, minutes: 30, cost: 0.3, billed: 0 });
});

test("a plan's merges are included in the plan; its API-price cost is only a comparison", () => {
  // in the dashboard's own words (plainWords), never a second copy of them
  expect(costLines({ cost: 3, billed: 0, billings: ["plan"], merged: 2 }, plainWords)).toEqual([
    `- ${plainWords.reportBilled}: $0.00. ${plainWords.billedEstimate}`,
    `- ${plainWords.reportApi}: $3.00. ${plainWords.apiPriceNote}.`,
    "- Per merged PR: included in plan · $1.50 at API prices",
  ]);
  expect(costLines({ cost: 0, billed: 0, billings: ["local"], merged: 1 }, plainWords).at(-1)).toBe(
    "- Per merged PR: $0.00 billed · $0.00 at API prices",
  );
});

test("a PR merged after the range is still open in it", () => {
  const early = workReport(history, "Fernway", FROM, at("2026-10-14T00:00:00"), prSizes(OUTCOMES));
  expect(early.merged).toBe(1); // FERN-0 on the 13th
  expect(early.open.map((o) => o.key)).toEqual(["FERN-1"]); // merged on the 14th, after this range
});

test("exports: Markdown states the method and leaves cost out on request; CSV has a row per ticket and a total", () => {
  const md = reportMarkdown(r, { cost: plainWords });
  expect(md).toContain("# Work report: Fernway");
  expect(md).toContain("2026-10-12 to 2026-10-18");
  expect(md).toContain("- Estimated human time saved: about 5 h 33 min (estimate, method below)");
  expect(md).toContain("- Billed (est.): $4.40. Estimated from token counts; your provider's bill is the final word.");
  expect(md).toContain("- At API prices: $4.70. What it would cost at API prices, for comparison.");
  expect(md).toContain("- Per merged PR: $1.47 billed · $1.57 at API prices");
  expect(md).toContain("- FERN-2 failed 2026-10-14: tests wouldn't start: missing env → a later run opened a pull request that merged");
  expect(md).toContain("Only merged pull requests count.");
  expect(reportMarkdown(r, { cost: false })).not.toMatch(/Billed|API prices/);
  // the reader's date format in the header when the dashboard says which; YYYY-MM-DD when it's unknown or bogus
  expect(reportMarkdown(r, { cost: plainWords, day: localDay("de-DE") })).toContain("12.10.2026 to 18.10.2026");
  expect(rangeText(r, localDay("not a locale!"))).toBe("2026-10-12 to 2026-10-18");
  const csv = reportCsv(r).split("\n");
  expect(csv[0]).toBe("project,ticket,pr_url,pr_state,opened,merged,runs,agent_minutes,api_price_usd,billed_usd,est_human_minutes");
  expect(csv).toContain(`Fernway,FERN-1,${pr(1)},merged,2026-10-13,2026-10-14,2,40,1.20,1.20,80`);
  expect(csv).toContain(`Fernway,FERN-0,${pr(0)},merged,2026-10-01,2026-10-13,0,0,0.00,0.00,240`);
  expect(csv.at(-1)).toBe("Fernway,TOTAL,,,,,7,205,4.70,4.40,333");
  const html = reportHtml(r);
  expect(html).toContain("<title>Work report: Fernway</title>");
  expect(html).toContain("@media print");
});

test("sending: only to a channel that carries the project, cost left out, the webhook from the secret store", async () => {
  const posted: { url: string; body: string }[] = [];
  const deps = {
    secret: () => "https://hooks.example.test/x",
    fetch: async (url: string, init: RequestInit) => {
      posted.push({ url, body: String(init.body) });
      return new Response("ok");
    },
  };
  const channel = UpdateChannelSchema.parse({ id: "fern", name: "Fern", kind: "slack", projects: ["Fernway"] });
  expect(await sendReport(channel, r, deps)).toBe("");
  const text = (JSON.parse(posted[0]?.body ?? "{}") as { text?: string }).text ?? "";
  expect(text).toContain("# Work report: Fernway");
  expect(text).not.toContain("Cost");
  expect(await sendReport({ ...channel, projects: ["Kite"] }, r, deps)).toContain("doesn't carry Fernway");
  expect(posted).toHaveLength(1);
});

test("the weekly slot is the last weekday-at-hour at or before now", () => {
  expect(lastSlot(1, 9, at("2026-10-20T08:00:00"))).toBe(at("2026-10-19T09:00:00")); // Tuesday → Monday
  expect(lastSlot(1, 9, at("2026-10-19T08:59:00"))).toBe(at("2026-10-12T09:00:00")); // Monday, before the hour
  expect(lastSlot(1, 9, at("2026-10-19T09:00:00"))).toBe(at("2026-10-19T09:00:00"));
});
