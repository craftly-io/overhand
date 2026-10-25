/**
 * The stress night (`?demo=stress`): the sample night pushed to the edges real data reaches, for the responsive sweep
 * (`bun run shots`). It's built from the demo's own state, not a copy of it: long project, lead, branch and owner names,
 * long ticket titles and reasons with unbreakable identifiers, paths and URLs, many cards in one column while others
 * are empty, numbers with many digits, and lists with nothing in them. Every name and title is invented.
 */
import { type DashboardState, DashboardStateSchema, type Ticket } from "@overhand/contract";

/** Long tails for a name: a project (and so its lead), as long as the contract allows, and a branch. */
const LONG_NAME = " for the northern region's weekend markets";
const LONG_BRANCH = "-and-the-follow-up-that-renames-every-checkout-handler-to-match-the-new-payments-module";

/** Titles the way real tickets read: long sentences, and tokens a line can't break inside. */
const TITLES = [
  "Move every settings screen under `@/features/preferences/screens/*` and keep the old import paths working for one release",
  "Rename useFetchLoyaltyPointsBalanceForCurrentCustomerAccount so a new teammate understands what it returns",
  "Check the role with z.enum(STAFF_ROLE_NAMES) on the invite form instead of accepting any string",
  "Fix https://example.com/stores/northern-region/opening-hours/holiday-schedule?week=52&format=printable on phones",
  "Tidy",
  "orderSummaryPanelCurrencyFormattingRegressionAfterLocaleSwitch",
];
const WHY = "picked because src/features/checkout/payment-retry/handlers.ts changed last week and nothing covers it yet";
/** What a "You" item says: long, with a path. */
const YOURS = "Decide whether docs/architecture/decisions/0042-split-the-orders-service.md still holds before agents touch it";
const SUFFIX = ", and the follow-up in src/features/orders/OrderSummaryPanel.tsx";

/**
 * A lead question the way agents really write them: a Markdown table with bold status codes, hashes and a long URL,
 * the question after it. No phrasing exists for it, so its card shows the facts-only sentence, the table under Details.
 */
export const TABLE_QUESTION = [
  "## Release check for the Acme storefront",
  "| Pull request | Status | Checks | Note |",
  "|----|--------|--------|------|",
  "| #123 | **CHANGES_REQUESTED** | `a1b2c3d4e5f6a7b8` passing | The reviewer asks to split the database migration from the UI change before it can merge |",
  "| #124 | APPROVED | `0f9e8d7c6b5a4f3e` failing | A flaky checkout test on https://example.com/checkout?step=payment&retry=3&locale=en-GB |",
  "Should I split #123 into two pull requests now, or wait for the reviewer to reply?",
  "Options: Split it now | Wait for the reviewer",
  "If there's no answer: I wait for the reviewer until tomorrow morning.",
].join("\n");

/** A number with many digits, from a small one. */
const big = (n: number): number => Math.round(n * 9_871 + 12_345);

/**
 * The sample state `s` at its most demanding: names and titles long, Planned full while Running and the other lists
 * are empty, and every count and cost many digits long. Still a valid DashboardState.
 */
export function stressed(s: DashboardState): DashboardState {
  // a project's name appears everywhere it's mentioned (keys, money by project, sessions): lengthen it everywhere at once
  const renamed = s.clients.reduce(
    (json, c) => json.split(JSON.stringify(c.name).slice(1, -1)).join(`${c.name}${LONG_NAME}`),
    JSON.stringify(s),
  );
  const r = DashboardStateSchema.parse(JSON.parse(renamed));
  const extra = (prefix: string, i: number) => `${prefix}-${9000 + i}`;
  // each project's agent list gets every title (the first armed), and its own list a long item
  let prefix = "";
  const plan = r.plan.flatMap((line) => {
    prefix = r.clients.find((c) => line === `## ${c.name}`)?.prefix ?? (line.startsWith("## ") ? "" : prefix);
    if (!prefix) return [line];
    if (line === "### Agent") return [line, ...TITLES.map((t, i) => `- [${i === 0 ? "x" : " "}] ${extra(prefix, i)} ${t} — ${WHY} (~45m)`)];
    return line === "### You" ? [line, `- ${YOURS}`] : [line];
  });
  const tickets = Object.fromEntries(
    Object.entries(r.tickets).map(([project, list]) => {
      const p = r.clients.find((c) => c.name === project)?.prefix ?? "";
      if (typeof list === "string") return [project, list];
      const more = TITLES.map(
        (title, i): Ticket => ({
          key: extra(p, i),
          title,
          status: "Todo",
          priority: "Medium",
          labels: ["agent"],
          url: `https://example.com/${extra(p, i)}`,
        }),
      );
      return [project, [...list.map((t) => ({ ...t, title: `${t.title}${SUFFIX}` })), ...more]];
    }),
  );
  // one more lead, asking in a table
  const asker = r.godmode.find((g) => g.inbox);
  const godmode = asker?.inbox
    ? [
        ...r.godmode,
        {
          ...asker,
          key: "release-check",
          label: `Release check agent${LONG_NAME}`,
          inbox: { ...asker.inbox, text: TABLE_QUESTION },
          ask: { default: "I wait for the reviewer until tomorrow morning.", deadline: 0, stale: null, recheck: 0 },
        },
      ]
    : r.godmode;
  return DashboardStateSchema.parse({
    ...r,
    godmode,
    owner: "Alexandra Montgomery-Fitzgerald",
    plan,
    tickets,
    // nothing running and no reviews asked: empty columns and lists beside full ones
    running: [],
    guardrails: [],
    pending: [],
    sessions: r.sessions.map((x) => ({ ...x, branch: `${x.branch}${LONG_BRANCH}` })),
    calls: { week: big(r.calls.week), last: big(r.calls.last) },
    cost: big(r.cost),
    billed: big(r.billed),
    week: {
      ...r.week,
      opened: big(r.week.opened),
      merged: big(r.week.merged),
      questions: big(r.week.questions),
      fixes: big(r.week.fixes),
      cost: big(r.week.cost),
      billed: big(r.week.billed),
      byClient: Object.fromEntries(Object.entries(r.week.byClient).map(([k, v]) => [k, big(v)])),
      days: r.week.days.map((d) => ({ ...d, cost: big(d.cost), done: big(d.done) })),
    },
    status: {
      ...r.status,
      reviews: [],
      myPrs: r.status.myPrs.map((p) => ({ ...p, title: `${p.title}${SUFFIX}` })),
    },
  });
}
