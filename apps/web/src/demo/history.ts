/**
 * The sample accounts and their last 30 days of runs, for the demo's scorecard and its routing suggestion. Made up and
 * deterministic: every visit sees the same month.
 */
import {
  type Billing,
  clearlyBetter,
  comboOf,
  type DashboardState,
  type HistoryRun,
  type Progression,
  progressionOf,
  type RouteSuggestion,
  type Scorecard,
  scorecard,
  seasonOf,
} from "@overhand/contract";

/**
 * Sam's four accounts: a Claude subscription (a plan), the clinic's own Bedrock (billed to its AWS), a local qwen3
 * through Ollama, and Codex on a ChatGPT plan.
 */
export const ACCOUNTS: Record<string, { runtime: string; provider: string; model: string; session: string; billing: Billing }> = {
  Sam: { runtime: "claude-code", provider: "claude", model: "", session: "claude-opus-5-5", billing: "plan" },
  Bedrock: { runtime: "claude-code", provider: "bedrock", model: "", session: "claude-sonnet-5-5", billing: "cloud" },
  Local: { runtime: "claude-code", provider: "gateway", model: "qwen3-coder", session: "qwen3-coder", billing: "local" },
  Codex: { runtime: "codex", provider: "claude", model: "", session: "codex", billing: "plan" },
};

const H = 3600_000;
const DAY = 24 * H;
const NOW = new Date(2026, 9, 20, 8, 30).getTime(); // the morning the night ends on

/** Who ran tickets where: project, key prefix, account, runs, merges in every 10, cost per run, and a seed. */
const MONTH: [string, string, string, number, number, number, number][] = [
  ["Online shop", "SHOP", "Sam", 22, 8, 2.6, 1],
  ["Online shop", "SHOP", "Codex", 6, 5, 1.4, 2],
  ["Online shop", "SHOP", "Local", 3, 4, 0, 3],
  ["Booking app", "BOOK", "Bedrock", 16, 7, 3.1, 4],
  ["Booking app", "BOOK", "Sam", 3, 7, 2.4, 5],
  // Company website runs on the local model; Codex worked there before Sam pinned it, and merged far more often
  ["Company website", "WEB", "Local", 14, 3, 0, 6],
  ["Company website", "WEB", "Codex", 8, 7, 1.6, 7],
  // Mobile app joined last night (`JOINED`): a handful of runs since, their PRs still open, so its scorecard and its
  // place tell the same story
  ["Mobile app", "APP", "Codex", 4, 1, 1.5, 8],
  ["Mobile app", "APP", "Sam", 2, 1, 2.2, 9],
];

/** Projects that joined during the month, and when: their runs all fall after it. Mobile app joined at 21:30 last night. */
const JOINED: Record<string, number> = { "Mobile app": NOW - 11 * H };

function month(): HistoryRun[] {
  let n = 0;
  return MONTH.flatMap(([project, prefix, account, runs, merges, cost, seed]) =>
    Array.from({ length: runs }, (_, i): HistoryRun => {
      const id = ACCOUNTS[account] ?? { runtime: "claude-code", provider: "claude", model: "", billing: "plan" };
      const k = ((i * 37 + seed * 11) % 290) / 290;
      const since = JOINED[project];
      const start = since ? since + k * (NOW - 2 * H - since) : NOW - (0.4 + k * 29) * DAY;
      const end = start + (35 + ((i * 13) % 40)) * 60_000;
      const slot = (i * 7 + seed) % 10;
      const left = slot - merges; // the tickets that didn't merge, spread over the ways that happens
      const base = {
        project,
        key: `${prefix}-${40 + n++}`,
        kind: "ticket" as const,
        account,
        runtime: id.runtime,
        provider: id.provider,
        model: id.model,
        start,
        end,
        cost: cost * (0.7 + (slot % 4) * 0.2),
        billing: id.billing,
      };
      const pr = (state: "open" | "merged" | "closed", fixes: number, doneAt: number) => ({
        ...base,
        outcome: "pr" as const,
        pr: { url: "", state, fixes, changes: fixes, openedAt: end, doneAt },
      });
      if (left < 0) return pr("merged", slot % 3 === 2 ? 1 : 0, end + (2 + ((i * 5 + seed) % 18)) * H);
      if (left === 0) return pr("closed", 1, end + 20 * H);
      if (left === 1) return { ...base, outcome: "no-pr" };
      if (left === 2) return { ...base, outcome: "failed" };
      if (left === 3) return { ...base, outcome: "timeout" };
      return pr("open", 0, 0);
    }),
  );
}

const history = month();
const projects = [...new Set(MONTH.map(([p]) => p))];
/** Each sample project's own account (`accounts` in its config); Online shop has none and uses Sam's. */
const PINNED: Record<string, string> = {
  "Online shop": "Sam",
  "Booking app": "Bedrock",
  "Company website": "Local",
  "Mobile app": "Codex",
};

/** The demo's 7- and 30-day scorecards. */
export const SCORECARD: { week: Scorecard; month: Scorecard } = {
  week: scorecard(history, NOW, 7),
  month: scorecard(history, NOW, 30),
};

/** One merged ticket run in the sample past: done at `at`, with `fixes` fix rounds. */
function mergedRun(project: string, key: string, at: number, fixes: number): HistoryRun {
  const id = ACCOUNTS[PINNED[project] ?? "Sam"] ?? { runtime: "claude-code", provider: "claude", model: "", billing: "plan" };
  const end = at - 5 * H;
  return {
    project,
    key,
    kind: "ticket",
    account: PINNED[project] ?? "Sam",
    runtime: id.runtime,
    provider: id.provider,
    model: id.model,
    start: end - H,
    end,
    cost: 2,
    billing: id.billing,
    outcome: "pr",
    pr: { url: "", state: "merged", fixes, changes: fixes, openedAt: end, doneAt: at },
  };
}

/** When Online shop's 100th merge landed: yesterday evening, so the night report names it. */
const HUNDREDTH = new Date(2026, 9, 19, 18, 40).getTime();

/**
 * The world's memory for the demo: each sample project's past before the month, so the four places differ. Online shop
 * is long-lived (its 100th merge landed yesterday evening); Booking app has a clean week behind it; Company website's last agent
 * run failed last evening and nothing has fixed it (an open scar); Mobile app is young: it joined last night, so its
 * history (and its scorecard) is that one night.
 */
const MEMORY: HistoryRun[] = (() => {
  const honeyBefore = history.filter((r) => r.project === "Online shop" && r.pr?.state === "merged" && r.pr.doneAt < HUNDREDTH).length;
  const yearAgo = NOW - 330 * DAY;
  const honey = Array.from({ length: 99 - honeyBefore }, (_, i) =>
    mergedRun("Online shop", `SHOP-${i + 1}`, yearAgo + i * 2.9 * DAY + (i % 5) * H, i % 3 === 1 ? 1 : 0),
  );
  // Booking app: a quiet, steady spring, and one week in it where everything merged and nothing failed
  const fern = Array.from({ length: 30 }, (_, i) =>
    mergedRun("Booking app", `BOOK-${i + 1}`, NOW - (200 - i * 4) * DAY, i % 4 === 0 ? 1 : 0),
  );
  const failed = (project: string, key: string, end: number): HistoryRun => ({
    ...mergedRun(project, key, end, 0),
    end,
    start: end - H,
    outcome: "failed",
    pr: undefined,
  });
  return [
    ...honey,
    mergedRun("Online shop", "SHOP-39", HUNDREDTH, 0),
    ...fern,
    failed("Company website", "WEB-39", new Date(2026, 9, 19, 23, 10).getTime()),
    ...history,
  ];
})();

/** The demo's world memory at a moment of the night: growth, scars and milestones from the sample history. */
export function progressionAt(now: number): Progression {
  return progressionOf(MEMORY, projects, {}, now, seasonOf(new Date(now), "north"));
}

const combo = (account: string) => {
  const a = ACCOUNTS[account];
  return a ? comboOf(a.runtime, a.provider, a.model) : "";
};

/** Suggest mode on the sample month: Company website's local model against Codex. */
export const ROUTING: DashboardState["routing"] = {
  mode: "suggest",
  suggestions: projects.flatMap((project): RouteSuggestion[] => {
    const rows = SCORECARD.month.projects.find((p) => p.project === project)?.rows ?? [];
    const better = clearlyBetter(rows, combo(PINNED[project] ?? "Sam"), Object.keys(ACCOUNTS).map(combo));
    const account = better && Object.keys(ACCOUNTS).find((a) => combo(a) === better.to.combo);
    return better && account
      ? [{ project, account, from: better.from.combo, to: better.to.combo, fromRate: better.from.mergeRate, toRate: better.to.mergeRate }]
      : [];
  }),
};
