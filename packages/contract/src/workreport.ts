/**
 * Per-project work reports: what agents did for one project over a date range (tickets done, PRs, time, an estimate of
 * human time saved, cost, failures and what fixed them, what's still open), and its Markdown and CSV exports. Built from
 * the run history; pure. The daemon reads the history and posts it (packages/core/src/workreport.ts).
 */
import { z } from "zod";
import { type Billing, BillingSchema, isBilled } from "./billing";
import type { HistoryRun } from "./scorecard";

/** A PR's diff size as the proof recorded it, for the estimate. */
export interface PrSize {
  added: number;
  removed: number;
  docsOnly: boolean;
}

/**
 * The time-saved estimate, kept deliberately low. A merged PR counts `baseMin` (reading the ticket, branching, opening
 * the PR) plus `perLineMin` per changed line (lock files left out), at most `capMin`; docs-only PRs count `docsFactor`
 * of that; one with no recorded diff counts `baseMin`. Open, closed and fix-round work counts nothing.
 */
export const ESTIMATE = { baseMin: 20, perLineMin: 0.5, capMin: 240, docsFactor: 0.5 } as const;

/** The estimate's method in one paragraph, shown with every number it produces. */
export const ESTIMATE_METHOD =
  "Estimate, not a measurement. Only merged pull requests count. Each counts 20 min (reading the task, branching, opening the pull request) plus 30 s per changed line (lock files left out), at most 4 h; a docs-only pull request counts half; a pull request with no recorded diff counts 20 min. Open or closed pull requests, rounds of fixes and reviews count nothing. Real time saved is likely higher.";

/** Estimated human minutes for one merged PR (see ESTIMATE). */
export function estimateMinutes(size: PrSize | undefined): number {
  if (!size) return ESTIMATE.baseMin;
  const raw = Math.min(ESTIMATE.capMin, ESTIMATE.baseMin + ESTIMATE.perLineMin * (size.added + size.removed));
  return Math.round(size.docsOnly ? raw * ESTIMATE.docsFactor : raw);
}

const PrRowSchema = z.object({
  key: z.string(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  openedAt: z.number(),
  /** When it merged or closed; 0 while open. */
  doneAt: z.number(),
  fixes: z.number(),
  /** Estimated human minutes; 0 unless merged in the range. */
  estMin: z.number(),
});

export const WorkReportSchema = z.object({
  project: z.string(),
  /** The range, [from, to) in ms. */
  from: z.number(),
  to: z.number(),
  /** Tickets whose PR merged in the range. */
  ticketsDone: z.array(z.string()),
  /** PRs opened or merged in the range. */
  prs: z.array(PrRowSchema),
  opened: z.number(),
  merged: z.number(),
  /** Every run in the range (tickets, fix rounds, plans, leads). */
  runs: z.number(),
  agentMinutes: z.number(),
  /** Every run at API prices: what it would cost at API prices, a comparison. */
  cost: z.number(),
  /** Of `cost`, what pay-per-use and cloud accounts were billed (an estimate from token counts). */
  billed: z.number().default(0),
  /** The billing types of the accounts that ran here, so a plan's merges read "included in plan". */
  billings: z.array(BillingSchema).default([]),
  /** Fix rounds: CI or review feedback the agent worked through. */
  fixRounds: z.number(),
  estimate: z.object({ minutes: z.number(), method: z.string() }),
  failures: z.array(
    z.object({
      key: z.string(),
      at: z.number(),
      outcome: z.enum(["failed", "timeout"]),
      /** What the agent said blocked it, from the activity log; "" when not logged. */
      reason: z.string(),
      /** What fixed it ("a later run opened a PR"); "" while it isn't. */
      fixedBy: z.string(),
    }),
  ),
  open: z.array(z.object({ key: z.string(), url: z.string(), what: z.string() })),
  /** Per ticket: runs, agent minutes, cost (the CSV's rows). `(other)` holds plans, triage and leads. */
  byTicket: z.array(z.object({ key: z.string(), runs: z.number(), minutes: z.number(), cost: z.number(), billed: z.number().default(0) })),
});
export type WorkReport = z.infer<typeof WorkReportSchema>;

const inRange = (t: number, from: number, to: number) => t >= from && t < to;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * One project's report for [from, to). `runs` is the history (it should start well before `from`, so a PR merged this
 * week that opened last month is still found); `sizes` the PR diff sizes by URL; `reasons` the last failure message
 * logged per ticket key.
 */
export function workReport(
  runs: HistoryRun[],
  project: string,
  from: number,
  to: number,
  sizes: Readonly<Record<string, PrSize>> = {},
  reasons: Readonly<Record<string, string>> = {},
): WorkReport {
  const mine = runs.filter((r) => r.project === project);
  const here = mine.filter((r) => inRange(r.start, from, to));
  const prRuns = mine.filter((r) => r.pr);
  const prs = prRuns.flatMap((r) => {
    const p = r.pr;
    if (!p) return [];
    const mergedHere = p.state === "merged" && inRange(p.doneAt, from, to);
    if (!inRange(p.openedAt, from, to) && !mergedHere) return [];
    const estMin = mergedHere ? estimateMinutes(sizes[p.url]) : 0;
    return [{ key: r.key, url: p.url, state: p.state, openedAt: p.openedAt, doneAt: p.doneAt, fixes: p.fixes, estMin }];
  });
  const merged = prs.filter((p) => p.state === "merged" && inRange(p.doneAt, from, to));
  const later = (key: string, at: number) => prRuns.find((r) => r.key === key && r.start > at);
  const failures = here
    .filter((r) => r.kind === "ticket" && (r.outcome === "failed" || r.outcome === "timeout"))
    .map((r) => {
      const fix = later(r.key, r.start);
      return {
        key: r.key,
        at: r.start,
        outcome: r.outcome === "timeout" ? ("timeout" as const) : ("failed" as const),
        reason: reasons[r.key] ?? "",
        fixedBy: fix ? `a later run opened a pull request${fix.pr?.state === "merged" ? " that merged" : ""}` : "",
      };
    });
  // what's still open as of the range's end: PRs not merged or closed by then, and failures nothing fixed
  const open = [
    ...prRuns
      .filter((r) => r.pr && r.pr.openedAt < to && (r.pr.state === "open" || r.pr.doneAt >= to))
      .map((r) => ({ key: r.key, url: r.pr?.url ?? "", what: "Pull request open, waiting for review" })),
    ...[...new Set(failures.filter((f) => !f.fixedBy).map((f) => f.key))].map((key) => ({
      key,
      url: "",
      what: "failed, not fixed yet",
    })),
  ];
  const groups = new Map<string, { key: string; runs: number; minutes: number; cost: number; billed: number }>();
  const billedOf = (r: HistoryRun) => (isBilled(r.billing) ? r.cost : 0);
  for (const r of here) {
    const key = r.key || "(other)";
    const g = groups.get(key) ?? { key, runs: 0, minutes: 0, cost: 0, billed: 0 };
    g.runs += 1;
    g.minutes += Math.max(0, r.end - r.start) / 60_000;
    g.cost += r.cost;
    g.billed += billedOf(r);
    groups.set(key, g);
  }
  const byTicket = [...groups.values()]
    .map((g) => ({ ...g, minutes: Math.round(g.minutes), cost: round(g.cost), billed: round(g.billed) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    project,
    from,
    to,
    ticketsDone: [...new Set(merged.map((p) => p.key))],
    prs: prs.sort((a, b) => a.openedAt - b.openedAt),
    opened: prs.filter((p) => inRange(p.openedAt, from, to)).length,
    merged: merged.length,
    runs: here.length,
    agentMinutes: Math.round(here.reduce((n, r) => n + Math.max(0, r.end - r.start), 0) / 60_000),
    cost: round(here.reduce((n, r) => n + r.cost, 0)),
    billed: round(here.reduce((n, r) => n + billedOf(r), 0)),
    billings: [...new Set<Billing>(here.map((r) => r.billing))],
    fixRounds: here.filter((r) => r.kind === "fix").length,
    estimate: { minutes: merged.reduce((n, p) => n + p.estMin, 0), method: ESTIMATE_METHOD },
    failures,
    open,
    byTicket,
  };
}

/** Minutes as `3 h 05 min` / `40 min`. */
export function hoursMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** A day as YYYY-MM-DD: the CSV's form, and the default where no reader's locale is known. */
const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

/** A day in `locale`'s own format (the dashboard's, so a header matches its date inputs); YYYY-MM-DD when unknown. */
export function localDay(locale: string): (ms: number) => string {
  try {
    return locale && Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? (ms) => new Date(ms).toLocaleDateString(locale) : day;
  } catch {
    return day; // not a language tag (it comes from a query string)
  }
}

/** The range as people read it: the last day is the one before `to`. */
export const rangeText = (r: Pick<WorkReport, "from" | "to">, d: (ms: number) => string = day): string => `${d(r.from)} to ${d(r.to - 1)}`;

/**
 * The report as Markdown (a status update, an invoice attachment). `cost` off leaves the money out (a client channel);
 * `day` formats the range in the header (YYYY-MM-DD by default).
 */
export function reportMarkdown(r: WorkReport, opts: { cost: CostWords | false; day?: (ms: number) => string }): string {
  const lines = [
    `# Work report: ${r.project}`,
    "",
    rangeText(r, opts.day),
    "",
    `- Tasks done: ${r.ticketsDone.length}`,
    `- Pull requests opened: ${r.opened}, merged: ${r.merged}`,
    `- Agent time: ${hoursMin(r.agentMinutes)} over ${r.runs} run${r.runs === 1 ? "" : "s"}`,
    `- Estimated human time saved: about ${hoursMin(r.estimate.minutes)} (estimate, method below)`,
    ...(opts.cost ? costLines(r, opts.cost) : []),
  ];
  if (r.prs.length)
    lines.push(
      "",
      "## Pull requests",
      ...r.prs.map((p) => `- ${p.key}: ${p.state}${p.fixes ? `, ${p.fixes} round${p.fixes === 1 ? "" : "s"} of fixes` : ""} — ${p.url}`),
    );
  if (r.failures.length)
    lines.push(
      "",
      "## Failures and what fixed them",
      ...r.failures.map(
        (f) =>
          `- ${f.key} ${f.outcome === "timeout" ? "timed out" : "failed"} ${day(f.at)}${f.reason ? `: ${f.reason}` : ""} → ${f.fixedBy || "not fixed yet"}`,
      ),
    );
  if (r.fixRounds) lines.push("", `Rounds of fixes on review or check feedback: ${r.fixRounds}`);
  if (r.open.length) lines.push("", "## Open items", ...r.open.map((o) => `- ${o.key}: ${o.what}${o.url ? ` — ${o.url}` : ""}`));
  lines.push("", "## How time saved is estimated", "", r.estimate.method);
  return lines.join("\n");
}

/** The dashboard's words the report's money is told in (the themes' plainWords). */
export interface CostWords {
  reportBilled: string;
  reportApi: string;
  billedEstimate: string;
  apiPriceNote: string;
  weekPerMerge: string;
  perMergeBilled: string;
  perMergeInPlan: string;
}

/**
 * The report's money as plain lines, in the dashboard's words: what was billed (an estimate), what it would cost at API
 * prices (a comparison), and both per merged PR; a report whose runs were all on plans says its merges were included.
 */
export function costLines(r: Pick<WorkReport, "cost" | "billed" | "billings" | "merged">, w: CostWords): string[] {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const fill = (word: string, v: Record<string, string>) => word.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
  const api = usd(r.cost / r.merged);
  const perMerge =
    r.billings.some(isBilled) || !r.billings.includes("plan")
      ? fill(w.perMergeBilled, { billed: usd(r.billed / r.merged), api })
      : fill(w.perMergeInPlan, { api });
  return [
    `- ${w.reportBilled}: ${usd(r.billed)}. ${w.billedEstimate}`,
    `- ${w.reportApi}: ${usd(r.cost)}. ${w.apiPriceNote}.`,
    ...(r.merged ? [`- ${w.weekPerMerge}: ${perMerge}`] : []),
  ];
}

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The report as CSV, one row per ticket (and `(other)`), then a TOTAL row: for an invoice or a spreadsheet. */
export function reportCsv(r: WorkReport): string {
  // api_price_usd sits where cost_usd was (it is the same figure, now named for what it is); billed_usd follows it
  const head = [
    "project",
    "ticket",
    "pr_url",
    "pr_state",
    "opened",
    "merged",
    "runs",
    "agent_minutes",
    "api_price_usd",
    "billed_usd",
    "est_human_minutes",
  ];
  const rows = r.byTicket.map((t) => {
    const p = r.prs.findLast((x) => x.key === t.key);
    return [
      r.project,
      t.key,
      p?.url ?? "",
      p?.state ?? "",
      p ? day(p.openedAt) : "",
      p?.state === "merged" ? day(p.doneAt) : "",
      t.runs,
      t.minutes,
      t.cost.toFixed(2),
      t.billed.toFixed(2),
      r.prs.filter((x) => x.key === t.key).reduce((n, x) => n + x.estMin, 0),
    ];
  });
  // a PR merged in the range from runs before it has no runs here, but still counts
  for (const p of r.prs.filter((x) => !r.byTicket.some((t) => t.key === x.key)))
    rows.push([
      r.project,
      p.key,
      p.url,
      p.state,
      day(p.openedAt),
      p.state === "merged" ? day(p.doneAt) : "",
      0,
      0,
      "0.00",
      "0.00",
      p.estMin,
    ]);
  rows.push([r.project, "TOTAL", "", "", "", "", r.runs, r.agentMinutes, r.cost.toFixed(2), r.billed.toFixed(2), r.estimate.minutes]);
  return [head, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}
