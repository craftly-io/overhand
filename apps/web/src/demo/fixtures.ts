/**
 * The demo's answers to the dashboard's other GETs (settings, lead logs, disk cleanup), so drawers open on sample data
 * instead of an error. Everything here is made up, like the night itself.
 */
import { type Corner, type Summary, scopeSummary, toMarkdown } from "@overhand/contract";
import { BOOK88_CORNERS, BOOK88_TEST_DIFF } from "@overhand/contract/fixtures/trust";
import { plainWords } from "@overhand/themes";
import { demoBrief } from "./briefs";
import { samplePr } from "./links";
import { MORNING } from "./moments";
import { demoWorktrees, nightAt } from "./night";
import { demoOrganise } from "./organise";
import { demoReport } from "./proof";
import { demoReview } from "./review";
import { demoSignInState } from "./signin";

const SAMPLE_CONFIG = {
  owner: { name: "Sam", keychainAccount: "sam" },
  accounts: ["Sam", "Bedrock", "Local", "Codex"],
  providers: {
    Bedrock: { kind: "bedrock", region: "eu-west-1", profile: "clinic", model: "", smallModel: "" },
    Local: { kind: "gateway", baseUrl: "http://localhost:11434", secret: "", model: "qwen3-coder", smallModel: "" },
  },
  runtimes: { Codex: { kind: "codex", model: "" } },
  clients: [
    {
      name: "Online shop",
      dir: "shop",
      prefix: "SHOP",
      host: "github",
      tracker: { kind: "linear", secret: "overhand-linear-shop" },
    },
    {
      name: "Booking app",
      dir: "booking",
      prefix: "BOOK",
      host: "github",
      accounts: ["Bedrock"],
      tracker: { kind: "jira", secret: "overhand-jira-booking", site: "booking.atlassian.net", email: "sam@example.com", project: "BOOK" },
    },
    {
      name: "Company website",
      dir: "website",
      prefix: "WEB",
      host: "github",
      accounts: ["Local"],
      tracker: { kind: "github", repo: "example/website" },
      autonomy: "propose",
    },
    {
      name: "Mobile app",
      dir: "mobile",
      prefix: "APP",
      host: "github",
      accounts: ["Codex"],
      tracker: { kind: "github", repo: "sam/mobile-app" },
    },
  ],
  codeRoot: "~/Code",
  schedule: { planFromHour: 7, briefAtHour: 8, taskTimeoutMin: 75, maxParallel: 2, maxFixes: 3, dailyBudgetUsd: 25 },
  slack: [{ server: "slack_shop", client: "Online shop" }],
  ntfySecret: "overhand-ntfy",
  updates: [
    {
      id: "shop-client",
      name: "Online shop #dev",
      kind: "slack",
      projects: ["Online shop"],
      voice: "plain",
      include: { shipped: true, review: true, blocked: true, next: true, spend: false },
      schedule: { when: "daily", hour: 9, weekday: 5 },
    },
    {
      id: "studio-weekly",
      name: "Studio (Teams)",
      kind: "teams",
      projects: ["Booking app", "Company website"],
      voice: "plain",
      include: { shipped: true, review: true, blocked: true, next: true, spend: false },
      schedule: { when: "weekly", hour: 16, weekday: 5 },
    },
  ],
  godmode: [
    {
      key: "shop",
      name: "Keep checks green · Online shop",
      watch: ["ci"],
      label: "Online shop lead",
      dir: "shop",
      project: "Online shop",
      goal: "Keep the shop working and the PR queue moving",
      supervised: true,
    },
    {
      key: "booking",
      name: "Fix new errors · Booking app",
      watch: ["errors"],
      label: "Booking app lead",
      dir: "booking",
      project: "Booking app",
      goal: "Keep booking fast and error-free",
      supervised: true,
      onDemand: true,
    },
    {
      key: "website",
      name: "Answer review comments · Company website",
      watch: ["reviews"],
      label: "Company website lead",
      dir: "website",
      project: "Company website",
      goal: "Get the staff tools ready for the busy season",
      supervised: true,
      account: "Local",
    },
    {
      key: "mobile",
      name: "Work the backlog · Mobile app",
      watch: ["backlog"],
      label: "Mobile app lead",
      dir: "mobile",
      project: "Mobile app",
      supervised: true,
      onDemand: true,
      account: "Codex",
    },
  ],
};

const LOGS: Record<string, string> = {
  shop: [
    "Read notes.md: two PRs waiting on rebases after yesterday's merge.",
    "Spawned rebase-helper for shop#305 and shop#307.",
    "Both rebased cleanly; CI green on main.",
    "Nothing else needs me. Sleeping until the next sweep.",
  ].join("\n"),
  booking: [
    "Woken by a new production error: TimeoutError: slot lookup exceeded 5s (140 events, 37 patients).",
    "Reproduced with yesterday's 9am rush: bookings take 2.4s, all in getSlots.",
    "BOOK-88 already covers the fix; asked the ticket agent to prioritise it.",
    "Fix merged to the PR branch, regression test added, checks green.",
  ].join("\n"),
  website: ["Read notes.md.", "Exited: nothing to do. (Ops restarted me three times, then rested me for 40 minutes.)"].join("\n"),
  mobile: ["Read questions.md.", "Reminders: email or push. Asked Sam; if there's no answer, I send both."].join("\n"),
};

/** The agents' PRs as the Review drawer reads them: WEB-31 (Company website, on propose) is the draft with the full sample diff. */
const REVIEWS: Record<
  string,
  { repo: string; number: number; title: string; body: string; diff: string; draft?: boolean; corners?: Corner[] }
> = {
  "WEB-31": {
    repo: "example/website",
    number: 52,
    title: "Let staff download bookings as a spreadsheet",
    draft: true,
    body: [
      "Adds a Download spreadsheet button to the staff bookings page for the 11:00 demo (WEB-31).",
      "",
      "- `exportBookingsCsv` builds the file server-side, one row per booking, totals in the booking's currency.",
      "- Commas, quotes and newlines in traveller names are escaped (RFC 4180).",
      "- The button streams the file; nothing is stored.",
      "",
      "Verified: unit tests for escaping and totals, and an export of the seed data opened in Numbers.",
      "Review agents run: security-reviewer (no findings), ui-reviewer (button label tweak applied).",
    ].join("\n"),
    diff: [
      "diff --git a/src/bookings/export.ts b/src/bookings/export.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/bookings/export.ts",
      "@@ -0,0 +1,22 @@",
      '+import type { Booking } from "./types";',
      "+",
      "+/** One CSV field, quoted when it holds a comma, quote or newline (RFC 4180). */",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code inside a diff
      '+const field = (v: string): string => (/[",\\n]/.test(v) ? `"${v.replaceAll(\'"\', \'""\')}"` : v);',
      "+",
      '+const HEADER = ["Booking", "Traveller", "Trip", "Departs", "Total", "Currency", "Status"];',
      "+",
      "+/** Every booking as one CSV file, header first. */",
      "+export function exportBookingsCsv(bookings: Booking[]): string {",
      "+  const rows = bookings.map((b) =>",
      "+    [b.ref, b.traveller.name, b.trip.name, b.departsAt.slice(0, 10), (b.totalCents / 100).toFixed(2), b.currency, b.status]",
      "+      .map(field)",
      '+      .join(","),',
      "+  );",
      '+  return [HEADER.join(","), ...rows].join("\\r\\n");',
      "+}",
      "+",
      "+/** The download's file name, e.g. bookings-2026-10-20.csv. */",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code inside a diff
      "+export const exportName = (now: Date): string => `bookings-${now.toISOString().slice(0, 10)}.csv`;",
      "diff --git a/src/bookings/BookingsPage.tsx b/src/bookings/BookingsPage.tsx",
      "index 4f2a9c1..b81d0e7 100644",
      "--- a/src/bookings/BookingsPage.tsx",
      "+++ b/src/bookings/BookingsPage.tsx",
      "@@ -1,6 +1,7 @@",
      ' import { useBookings } from "./api";',
      '+import { exportBookingsCsv, exportName } from "./export";',
      ' import { BookingTable } from "./BookingTable";',
      ' import { PageHeader } from "../ui/PageHeader";',
      " ",
      " export function BookingsPage() {",
      "   const { data: bookings = [] } = useBookings();",
      "@@ -12,7 +13,15 @@ export function BookingsPage() {",
      "   return (",
      "     <>",
      '-      <PageHeader title="Bookings" />',
      '+      <PageHeader title="Bookings">',
      "+        <Button",
      '+          variant="outline"',
      "+          disabled={!bookings.length}",
      '+          onClick={() => download(exportName(new Date()), exportBookingsCsv(bookings), "text/csv")}',
      "+        >",
      "+          Download spreadsheet",
      "+        </Button>",
      "+      </PageHeader>",
      "       <BookingTable bookings={bookings} />",
      "     </>",
      "   );",
      "diff --git a/src/bookings/export.test.ts b/src/bookings/export.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/bookings/export.test.ts",
      "@@ -0,0 +1,12 @@",
      '+import { expect, test } from "bun:test";',
      '+import { exportBookingsCsv } from "./export";',
      '+import { booking } from "./fixtures";',
      "+",
      '+test("names with commas and quotes are escaped", () => {',
      "+  const csv = exportBookingsCsv([booking({ traveller: { name: 'Reyes, Ana \"Nan\"' } })]);",
      '+  expect(csv.split("\\r\\n")[1]).toContain(\'"Reyes, Ana ""Nan"""\');',
      "+});",
      "+",
      '+test("totals are in the booking currency with two decimals", () => {',
      '+  expect(exportBookingsCsv([booking({ totalCents: 123456 })])).toContain(",1234.56,EUR,");',
      "+});",
      "diff --git a/bun.lock b/bun.lock",
      "index 77aa001..77aa002 100644",
      "--- a/bun.lock",
      "+++ b/bun.lock",
      "@@ -40,3 +40,3 @@",
      '-    "date-fns": ["date-fns@4.1.0"],',
      '+    "date-fns": ["date-fns@4.1.1"],',
      '     "dayjs": ["dayjs@1.11.13"],',
      "",
    ].join("\n"),
  },
  "SHOP-142": {
    repo: "example/shop",
    number: 311,
    title: "Customers see a payment error when their bank is slow",
    body: "When the bank is slow, the card payment is retried once, after 800 ms, before the customer sees an error. Tests cover both outcomes.",
    diff: [
      "diff --git a/src/pay.ts b/src/pay.ts",
      "--- a/src/pay.ts",
      "+++ b/src/pay.ts",
      "@@ -18,4 +18,6 @@ export async function pay(card: Card) {",
      "   const first = await charge(card);",
      "-  return first;",
      '+  if (first.ok || first.reason !== "network") return first;',
      "+  await sleep(800);",
      "+  return charge(card);",
      " }",
    ].join("\n"),
  },
  "BOOK-88": {
    repo: "example/booking",
    number: 77,
    title: "The booking page is slow at 9am and sometimes times out",
    body: "Caches each day's free slots for a minute. Booking during the 9am rush: 2.4 s → 180 ms. Fix round 1 updated a stale fixture.",
    diff: [
      "diff --git a/api/slots.ts b/api/slots.ts",
      "--- a/api/slots.ts",
      "+++ b/api/slots.ts",
      "@@ -3,5 +3,9 @@",
      "-export const getSlots = (doctor: string) => db.slots.find(doctor);",
      "+const cache = new TtlCache<string, Slot[]>(60_000);",
      "+",
      "+/** A doctor's free slots, cached for a minute: every page view looks them up. */",
      "+export const getSlots = (doctor: string) => cache.get(doctor) ?? cache.set(doctor, db.slots.find(doctor));",
      ...BOOK88_TEST_DIFF,
    ].join("\n"),
    corners: BOOK88_CORNERS,
  },
  "APP-12": {
    repo: "sam/mobile-app",
    number: 19,
    title: "Don't lose my guest list when I get signed out",
    body: "Keeps the guest list under the device id instead of the session, and merges it into the account on sign-in.",
    diff: [
      "diff --git a/app/lists/store.ts b/app/lists/store.ts",
      "--- a/app/lists/store.ts",
      "+++ b/app/lists/store.ts",
      "@@ -9,3 +9,3 @@",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code inside a diff
      "-const key = () => `guests:${session.id}`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code inside a diff
      "+const key = () => `guests:${device.id}`;",
    ].join("\n"),
  },
};

/** The demo's summaries: the scripted night's four PRs, and a week around it. */
function demoSummary(span: Summary["span"]): Summary {
  const at = (project: string, key: string, title: string, repo: string, n: number) => ({
    project,
    key,
    title,
    url: repo ? samplePr(repo, n) : "",
  });
  const night = [
    at("Online shop", "SHOP-142", "Customers see a payment error when their bank is slow", "example/shop", 311),
    at("Booking app", "BOOK-88", "The booking page is slow at 9am and sometimes times out", "example/booking", 77),
    at("Company website", "WEB-31", "Let staff download bookings as a spreadsheet", "example/website", 52),
    at("Mobile app", "APP-12", "Don't lose my guest list when I get signed out", "sam/mobile-app", 19),
  ];
  const week = [
    ...night,
    at("Online shop", "SHOP-139", "Receipts show the wrong tax line", "example/shop", 305),
    at("Online shop", "SHOP-140", "Retry card payments once on a timeout", "example/shop", 307),
    at("Booking app", "BOOK-84", "Clinic hours on the booking page", "example/booking", 71),
    at("Company website", "WEB-29", "Trip pages load their photos lazily", "example/website", 48),
    at("Mobile app", "APP-10", "Share a potluck by link", "sam/mobile-app", 15),
  ];
  const review = night.slice(1);
  const now = Date.now();
  return {
    span,
    from: now - (span === "week" ? 7 : 1) * 864e5,
    to: now,
    // of the night's four, SHOP-142 merged on Ship; the other three wait in review
    shipped: span === "week" ? week.filter((x) => !review.includes(x)) : night.slice(0, 1),
    opened: span === "week" ? week : night,
    review,
    blocked: [at("Online shop", "SHOP-151", "Move to the new version of the card payment service", "", 0)],
    next: [
      at("Online shop", "SHOP-150", "Show when an order will be ready to pick up", "", 0),
      at("Booking app", "BOOK-90", "Send a reminder the day before an appointment", "", 0),
    ],
    spend:
      span === "week"
        ? { "Online shop": 14.6, "Booking app": 11.2, "Company website": 0, "Mobile app": 6.9 }
        : { "Online shop": 2.1, "Booking app": 3.4, "Mobile app": 2.3 },
    guides: [],
  };
}

/** Repos a GitHub sign-in could pick, as `GET /api/projects/github` lists them. */
const DEMO_REPOS = [
  { owner: "shop", name: "web", private: true, pushedAt: "2026-10-19T08:10:00Z", language: "TypeScript" },
  { owner: "shop", name: "api", private: true, pushedAt: "2026-10-18T16:40:00Z", language: "Go" },
  { owner: "shop", name: "design-tokens", private: false, pushedAt: "2026-09-02T09:00:00Z", language: "CSS" },
  { owner: "booking", name: "app", private: true, pushedAt: "2026-10-17T12:00:00Z", language: "Kotlin" },
  { owner: "sam", name: "blog", private: false, pushedAt: "2026-08-21T19:30:00Z", language: "Astro" },
];

/** The demo's answer for a GET the dashboard makes, or undefined when there's none. */
export function demoGet(url: string): unknown {
  const u = new URL(url, "http://demo");
  // Settings › Projects: the repos the demo's GitHub sign-in could pick; nothing being added
  if (u.pathname === "/api/projects/github") return { repos: DEMO_REPOS, problems: [] };
  if (u.pathname === "/api/projects/added") return { projectsDir: "/Users/sam/Code", additions: [], projects: [] };
  if (u.pathname.startsWith("/api/organise") || (u.pathname === "/api/brief" && u.searchParams.get("id")?.startsWith("organise:")))
    return demoOrganise(u.pathname, u.searchParams.get("id") ?? "");
  if (u.pathname === "/api/brief") return demoBrief(u.searchParams.get("id") ?? "");
  // the morning's worktrees, the same picture the morning's Crew shows
  if (u.pathname === "/api/worktrees") return demoWorktrees(nightAt(MORNING));
  if (u.pathname === "/api/report") {
    const d = (k: string) => new Date(`${u.searchParams.get(k) ?? ""}T00:00:00`).getTime();
    return demoReport(u.searchParams.get("project") ?? "", d("from"), d("to") + 864e5);
  }
  // the check-up of Mobile app, the project that joined last night: what else an agent could take after its first win
  if (u.pathname === "/api/checkup")
    return {
      reports: [
        {
          repo: "mobile",
          path: "/Users/sam/Code/mobile-app/mobile-app",
          stack: "TypeScript · React · pnpm",
          at: Date.parse("2026-10-20T00:00:00Z"),
          findings: [
            { id: "ci", tone: "warn", title: "No CI: nothing checks a pull request", task: { kind: "ci", title: "Add a CI workflow" } },
            {
              id: "todo",
              tone: "info",
              title: "7 TODOs in src/rsvp.ts: work left unfinished",
              task: { kind: "todo", title: "Work through the TODOs in rsvp.ts" },
            },
            { id: "prs", tone: "info", title: "2 open PRs", task: null },
            { id: "readme", tone: "ok", title: "README says how to install and run it", task: null },
          ],
        },
      ],
    };
  if (u.pathname === "/api/preview/review") return demoReview(u.searchParams.get("key") ?? "");
  if (u.pathname === "/api/pr/review") {
    const key = u.searchParams.get("key") ?? "";
    const r = REVIEWS[key];
    if (!r) return undefined;
    const green = (name: string) => ({ name, state: "SUCCESS" });
    return {
      key,
      url: samplePr(r.repo, r.number),
      repo: r.repo,
      number: r.number,
      title: r.title,
      body: r.body,
      author: "sam",
      viewer: "sam",
      draft: r.draft ?? false,
      state: "OPEN",
      checks: [green("typecheck"), green("test"), green("lint")],
      diff: r.diff,
      corners: r.corners ?? [],
      truncated: false,
    };
  }
  if (u.pathname === "/api/settings") {
    return {
      config: SAMPLE_CONFIG,
      checks: [
        { ok: true, what: "Claude Code (claude) 2.4.0" },
        { ok: true, what: "Codex (codex) 0.163.0" },
        { ok: true, what: "Account Sam: signed in to Claude Code" },
        { ok: true, what: "Account Local: gateway http://127.0.0.1:11434" },
        { ok: true, what: "GitHub CLI signed in as sam" },
        { ok: true, what: "Linear token for Online shop" },
        { ok: true, what: "Jira token for Booking app" },
        { ok: true, what: "Status update Online shop #dev: webhook URL in Keychain", secret: "status-update-shop-client" },
        { ok: true, what: "Status update Studio (Teams): webhook URL in Keychain", secret: "status-update-studio-weekly" },
        {
          ok: false,
          what: "No Sentry token for Company website",
          fix: "Add one to see Company website's errors",
          secret: "overhand-sentry-website",
          optional: true,
        },
      ],
      codeRoot: "/Users/sam/Code",
      folders: ["shop", "booking", "website", "mobile", "old-portfolio"],
    };
  }
  if (u.pathname === "/api/accounts/options") {
    // Add an agent account: Claude Code and Codex signed in here, Codex's login already used by an account
    const agent = (id: string, label: string, over: object) => ({
      id,
      label,
      installed: true,
      signedIn: false,
      suggested: id === "claude-code" ? "claude" : id,
      login: true,
      ownFolder: false,
      key: true,
      shared: "",
      ...over,
    });
    return {
      agents: [
        agent("claude-code", "Claude Code", { signedIn: true, ownFolder: true }),
        agent("codex", "Codex", { signedIn: true, ownFolder: true, shared: "work", suggested: "codex-2" }),
        agent("gemini", "Gemini CLI", { login: false }),
        agent("cursor", "Cursor Agent", { installed: false }),
        agent("opencode", "OpenCode", { key: false }),
        agent("aider", "Aider", { installed: false, login: false, key: false }),
      ],
    };
  }
  if (u.pathname === "/api/accounts/login") return demoSignInState();
  if (u.pathname === "/api/connections") {
    return {
      services: [
        { id: "github", label: "GitHub", state: "connected", via: "gh", detail: "sam", connect: false },
        { id: "linear", label: "Linear", state: "connected", via: "mcp", detail: "", connect: true },
        { id: "jira", label: "Jira", state: "agent", via: "agent", detail: "Claude Code: atlassian", connect: true },
        { id: "slack", label: "Slack", state: "agent", via: "agent", detail: "Codex: slack", connect: false },
        { id: "sentry", label: "Sentry", state: "none", via: "", detail: "", connect: true },
        { id: "vercel", label: "Vercel", state: "connected", via: "cli", detail: "", connect: false },
      ],
    };
  }
  if (u.pathname === "/api/summary") {
    const span = u.searchParams.get("span");
    return demoSummary(span === "today" || span === "week" || span === "day" ? span : "night");
  }
  if (u.pathname === "/api/updates/preview") {
    const ch = SAMPLE_CONFIG.updates.find((x) => x.id === u.searchParams.get("id"));
    if (!ch) return undefined;
    const s = scopeSummary(demoSummary(ch.schedule.when === "weekly" ? "week" : "day"), ch.projects, ch.include);
    return { markdown: toMarkdown(s, plainWords, ch.projects, { attribution: false }) };
  }
  if (u.pathname === "/api/lead/log") return { text: LOGS[u.searchParams.get("key") ?? ""] ?? "", at: Date.now() };
  if (u.pathname === "/api/cleanup") {
    const C = "/Users/sam/Code";
    const H = "/Users/sam";
    type Row = [string, string, string, string, number, boolean?];
    const rows: Row[] = [
      ["worktrees", "worktree", `${C}/shop/.worktrees/SHOP-131`, "nothing beyond main (merged, or the agent never committed)", 412_000],
      [
        "worktrees",
        "worktree",
        `${C}/booking/.worktrees/BOOK-71`,
        "branch deleted on the remote (merged or closed); the branch stays",
        230_500,
      ],
      ["worktrees", "worktree", `${C}/website/.worktrees/WEB-12`, "idle 34 days, everything pushed", 96_300],
      ["versions", "dir", `${H}/.local/share/claude/versions/2.2.1`, "Claude Code: older than the newest 2, not the one in use", 188_000],
      [
        "versions",
        "dir",
        `${H}/.local/share/cursor-agent/versions/2026.01.23-916f423`,
        "Cursor agent: older than the newest 2, not the one in use",
        131_000,
      ],
      ["caches", "contents", `${H}/.bun/install/cache`, "rebuilds itself on next use; contents only", 2_310_000],
      ["caches", "contents", `${H}/.npm/_cacache`, "rebuilds itself on next use; contents only", 1_020_000],
      ["caches", "contents", `${H}/Library/Caches/pip`, "rebuilds itself on next use; contents only", 402_000],
      [
        "caches",
        "contents",
        `${H}/Library/Caches/ms-playwright`,
        "comes back only when you reinstall it (e.g. playwright install)",
        1_240_000,
        false,
      ],
      ["caches", "command", "brew cleanup -s", "the tool's own cleanup", 0],
      ["builds", "dir", `${C}/old-portfolio/node_modules`, "project idle 58 days; git-ignored, rebuilds with an install or build", 684_000],
      ["builds", "dir", `${C}/old-portfolio/.next`, "project idle 58 days; git-ignored, rebuilds with an install or build", 212_000],
      ["docker", "command", "docker builder prune -f", "build cache", 3_100_000],
      ["simulators", "command", "xcrun simctl delete unavailable", "6 simulators for runtimes Xcode no longer has", 5_400_000],
      ["logs", "dir", `${H}/.overhand/logs/2026-09-30.log`, "older than 14 days", 18_200],
    ];
    const on = (enabled: boolean) => ({ enabled });
    return {
      status: "ready",
      at: Date.now(),
      freeGb: 18.4,
      items: rows.map(([category, kind, path, why, kb, checked = true]) => ({
        id: `${category}:${path}`,
        category,
        kind,
        path,
        why,
        kb,
        checked,
      })),
      config: {
        categories: {
          worktrees: on(true),
          versions: on(true),
          caches: on(true),
          builds: on(false),
          docker: on(false),
          simulators: on(true),
          logs: on(true),
        },
        auto: { schedule: "weekly", belowFreeGb: 20 },
        minFreeGb: 3,
      },
    };
  }
  return undefined;
}
