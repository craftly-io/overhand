/**
 * The demo's scripted night: sample data (fictional people and projects) for the landing page, where scrolling sets
 * the clock. `nightAt(minutes)` is the whole dashboard state at that moment, built only from the script below, so the
 * real dashboard can run without a daemon and every screen is reproducible.
 */

import {
  type DashboardState,
  DashboardStateSchema,
  type Lead,
  type LeadWorkKind,
  MESSAGE_NOTE,
  type Session,
  sectionHeading,
  type Ticket,
  type Worktrees,
} from "@overhand/contract";
import { BOOK88_CORNERS, GUARD_BLOCKS } from "@overhand/contract/fixtures/trust";
import { plainWords } from "@overhand/themes";
import { GUIDES } from "./guides";
import { ACCOUNTS, progressionAt, ROUTING, SCORECARD } from "./history";
import { INSTRUCTIONS, RULES } from "./instructions";
import { samplePr, sampleUrl } from "./links";
import { MOMENTS } from "./moments";
import { demoPlugins } from "./plugins";
import { demoProof } from "./proof";
import { teamAt } from "./team";

/** The night runs from 23:30 to 08:30; minute 0 is 23:30. */
export const NIGHT_MINUTES = 9 * 60;
const DAY = new Date(2026, 9, 20); // the morning the night ends on

/** Epoch milliseconds for a clock time in the night ("23:40" is the evening before). */
function at(hm: string): number {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  const d = new Date(DAY);
  if (h >= 12) d.setDate(d.getDate() - 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** The clock time `minutes` into the night, as epoch milliseconds. */
export function clockAt(minutes: number): number {
  return at("23:30") + Math.max(0, Math.min(NIGHT_MINUTES, minutes)) * 60_000;
}

const CLIENTS = [
  // Online shop is on Ship: its main branch requires CI, so GitHub merges its agent PRs once they're green
  { name: "Online shop", prefix: "SHOP", repo: "example/shop", autonomy: "ship" as const },
  { name: "Booking app", prefix: "BOOK", repo: "example/booking" },
  // Company website is on propose: its agent opens draft PRs and Sam marks them ready (the Review drawer's sample is WEB-31's)
  { name: "Company website", prefix: "WEB", repo: "example/website", autonomy: "propose" as const },
  // Mobile app has no required checks on main, so Ship can't be turned on there
  { name: "Mobile app", prefix: "APP", repo: "sam/mobile-app", shipBlock: plainWords.shipNoGate.replace("{branch}", "main") },
];

/** True for a project on propose, whose agent PRs open as drafts waiting for Sam. */
const proposes = (client: string): boolean => CLIENTS.some((c) => c.name === client && c.autonomy === "propose");

/** What the activity log says and when; the dashboard's story is told from these lines. */
const LOG: [string, string][] = [
  ["23:41", "📋 plan written: 5 agent tasks ready to deploy (planner on Sam)"],
  ["23:58", "⚡ Online shop lead started headless (pid 4101, sam)"],
  [MOMENTS.started, "⚡ SHOP-142 started (Sam)"],
  ["00:47", `✅ SHOP-142 (sam, $2.10) → ${samplePr("example/shop", 311)}`],
  ["00:52", "🆕 Online shop: shop#311 opened: Customers see a payment error when their bank is slow"],
  ["00:53", `🚢 SHOP-142: auto-merge on for ${samplePr("example/shop", 311)}; GitHub merges it once every required check passes`],
  [MOMENTS.shipped, `🎉 SHOP-142 PR merged on Ship ${samplePr("example/shop", 311)}`],
  ["01:05", "⚡ Booking app lead started headless (pid 4188, bedrock)"],
  ["01:06", "⚡ BOOK-88 started (Booking app)"],
  ["01:30", "⚡ Company website lead started headless (pid 4230, local)"],
  ["01:31", "⚡ Company website lead exited (0) after 1 min"],
  ["01:36", "⚡ Company website lead started headless (pid 4244, local)"],
  ["01:37", "⚡ Company website lead exited (0) after 1 min"],
  ["01:42", "⚡ Company website lead started headless (pid 4251, local)"],
  ["01:43", "⚡ Company website lead exited (0) after 1 min"],
  ["01:44", "💤 Company website lead found nothing to do; next look in 40 min"],
  ["01:58", `✅ BOOK-88 (bedrock, $3.40) → ${samplePr("example/booking", 77)}`],
  ["02:01", "🆕 Booking app: booking#77 opened: The booking page is slow at 9am and sometimes times out"],
  ["02:20", "🔴 Booking app: booking#77 checks failing: The booking page is slow at 9am and sometimes times out"],
  [MOMENTS.fixRound, "🔧 BOOK-88 fix round 1 (Booking app): a stale fixture expected the old query count; updated it"],
  ["02:52", "⚡ Online shop lead exited (0) after 174 min"],
  ["03:10", "⚡ WEB-31 started (Local)"],
  ["04:02", `✅ WEB-31 (local, $0.00) → ${samplePr("example/website", 52)}`],
  ["04:05", "🆕 Company website: website#52 opened: Let staff download bookings as a spreadsheet"],
  ["04:40", "⚡ APP-12 started (Codex)"],
  ["05:31", `✅ APP-12 (codex, $2.30) → ${samplePr("sam/mobile-app", 19)}`],
  ["05:33", "🆕 Mobile app: mobile-app#19 opened: Don't lose my guest list when I get signed out"],
  ["05:50", "⚡ Booking app lead exited (0) after 285 min"],
  ["06:12", "⚡ Mobile app lead started headless (pid 4390, codex)"],
  [MOMENTS.call, "⚡ Mobile app lead exited (0) after 72 min"],
];

/** Ticket agent runs: which ticket, in which project, from when to when, and what it cost. */
const RUNS: { key: string; client: string; from: string; to: string; cost: number; account?: string }[] = [
  { key: "SHOP-142", client: "Online shop", from: MOMENTS.started, to: "00:47", cost: 2.1 },
  { key: "BOOK-88", client: "Booking app", from: "01:06", to: "01:58", cost: 3.4, account: "Bedrock" },
  { key: "WEB-31", client: "Company website", from: "03:10", to: "04:02", cost: 0, account: "Local" },
  { key: "APP-12", client: "Mobile app", from: "04:40", to: "05:31", cost: 2.3, account: "Codex" },
];

interface Character {
  key: string;
  label: string;
  /** What it's called on screen: its job and its project, so a visitor reads what it does at a glance. */
  name: string;
  project: string;
  /** The ready-made lead it is: the one kind of work that wakes it. */
  watch: LeadWorkKind;
  onDemand?: boolean;
  account?: string;
  /** What its runs cost at API prices, booked when the last one ends (as the daemon books a lead's exit); 1.60 if not given. */
  cost?: number;
  /** When it's running: [from, to] clock times. */
  spans: [string, string][];
  /** What it's doing from each time on, in its own words. */
  says: [string, string][];
  /** [from, to, name, description] */
  subagents: [string, string, string, string][];
  /** When it asks you something, and the question. */
  question?: [string, string];
  /** Its conversation with Sam: when, a message from Sam or the lead's reply (its run's final message), and the words. */
  chat?: [string, "message" | "reply", string][];
  /** The default its question states ("If there's no answer: …"); Overhand goes with it four hours after it asked. */
  default?: string;
  /** From when its question may be out of date, and the issues and PRs it names that closed since. */
  closed?: [string, string[]];
}

/** Who runs Overhand on the sample night: the one answering and messaging the leads. */
export const OWNER = "Sam";

/** Sam's daily cap on billed money (pay per use and cloud): only the clinic's Bedrock counts toward it. */
const BUDGET_USD = 25;

/** Leads: when each works, and what it's doing at each point, in its own words. */
const LEADS: Character[] = [
  {
    key: "shop",
    name: "Keep checks green · Online shop",
    label: "Online shop lead",
    project: "Online shop",
    watch: "ci",
    spans: [["23:58", "02:52"]],
    says: [
      ["23:58", "→ Read: notes.md"],
      ["00:05", "→ Read: questions.md"],
      ["00:20", "Two of the shop's PRs need rebasing after yesterday's merge."],
      ["01:15", "→ Bash: gh pr checks 305"],
      ["02:00", "Rebased both PRs; CI is green on main again."],
    ],
    subagents: [["00:30", "02:10", "rebase-helper", "Rebases stale branches"]],
    // Sam's message before bed: the lead wasn't running, so Overhand started it to read it; its run's last words are the reply
    chat: [
      ["23:58", "message", "Leave the payments module alone this week: I'm moving it to the new card service myself (SHOP-151)."],
      [
        "02:52",
        "reply",
        "Understood: I won't touch the payments module this week.\n\nTonight: two PRs fell behind after yesterday's merge. I rebased both, and CI is green on main again.",
      ],
    ],
  },
  {
    key: "booking",
    name: "Fix new errors · Booking app",
    label: "Booking app lead",
    project: "Booking app",
    watch: "errors",
    onDemand: true,
    account: "Bedrock",
    // billed to the clinic's AWS: with BOOK-88, $8.20 of the $25 daily cap by morning, so cost stays in hand
    cost: 4.8,
    spans: [["01:05", "05:50"]],
    says: [
      ["01:05", "A new error woke me: the booking page times out when lots of patients book at once."],
      ["02:25", "→ Bash: bun test api/slots"],
      ["03:30", "Booking is fast again, with a test so it stays that way; checks are green."],
    ],
    subagents: [
      ["01:20", "03:00", "load-tester", "Replays yesterday's traffic"],
      ["02:30", "03:20", "test-writer", "Covers the slot cache"],
    ],
  },
  {
    key: "website",
    name: "Answer review comments · Company website",
    label: "Company website lead",
    project: "Company website",
    watch: "reviews",
    account: "Local",
    spans: [
      ["01:30", "01:31"],
      ["01:36", "01:37"],
      ["01:42", "01:43"],
    ],
    says: [["01:30", "→ Read: notes.md"]],
    subagents: [],
  },
  {
    key: "mobile",
    name: "Work the backlog · Mobile app",
    label: "Mobile app lead",
    project: "Mobile app",
    watch: "backlog",
    onDemand: true,
    account: "Codex",
    spans: [["06:12", MOMENTS.call]],
    says: [
      ["06:12", "→ Read: questions.md"],
      ["06:40", "Two ways to send reminders; asking Sam which one the app should use."],
    ],
    subagents: [],
    question: [
      MOMENTS.call,
      "## Reminders\nShould the app remind guests by email, or only with a push notification? I'd do both.\nIf there's no answer: I send both, email and push.",
    ],
    default: "I send both, email and push.",
  },
];

/** Each project's open tickets: key, title, armed for the agent, priority, tracker status, extra labels. */
const TICKETS: Record<string, [string, string, boolean, string, string, string[]?][]> = {
  "Online shop": [
    ["SHOP-142", "Customers see a payment error when their bank is slow", true, "High", "Todo"],
    ["SHOP-150", "Show when an order will be ready to pick up", false, "Medium", "Todo"],
    ["SHOP-151", "Move to the new version of the card payment service", false, "High", "Todo", ["needs-owner"]],
    ["SHOP-152", "Customers can't apply discount codes on mobile", false, "Urgent", "Todo"],
    ["SHOP-155", "Offer the menu in French", false, "Low", "Backlog"],
    ["SHOP-157", "Keep a record of every refund", false, "Medium", "In Progress"],
  ],
  "Booking app": [
    ["BOOK-88", "The booking page is slow at 9am and sometimes times out", true, "Urgent", "Todo"],
    ["BOOK-90", "Send a reminder the day before an appointment", false, "High", "Todo"],
    ["BOOK-91", "Let patients reschedule without calling the front desk", false, "Medium", "Todo"],
    ["BOOK-93", "Take down the old booking form", false, "Low", "Backlog"],
  ],
  "Company website": [
    ["WEB-31", "Let staff download bookings as a spreadsheet", true, "High", "Todo"],
    ["WEB-33", "Staff sign in with their work Google accounts", false, "High", "Todo"],
    ["WEB-34", "Show trip prices in the visitor's currency", false, "Low", "Backlog"],
    ["WEB-36", "Some trips show the wrong departure day", false, "Medium", "Todo"],
    ["WEB-37", "Invite the whole team at once", false, "Medium", "In Progress"],
  ],
  "Mobile app": [
    ["APP-12", "Don't lose my guest list when I get signed out", true, "High", "Todo"],
    ["APP-14", "Tell guests when the menu changes", false, "Medium", "Todo"],
    ["APP-15", "Make the invite screen work with screen readers", false, "Medium", "Todo"],
  ],
};

/** What each ticket agent is doing, in its own words, through its run. */
const AGENT_SAYS: Record<string, [string, string][]> = {
  "SHOP-142": [
    [MOMENTS.started, "→ Read: src/checkout/pay.ts"],
    ["00:20", "A slow bank shows as a failed payment; retrying once, after 800 ms, before the error."],
    ["00:34", "→ Bash: bun test checkout"],
    ["00:42", "→ Bash: gh pr create"],
  ],
  "BOOK-88": [
    ["01:06", "→ Grep: getSlots"],
    ["01:20", "Every page view looks up the day's slots again; caching them for a minute."],
    ["01:44", "→ Bash: bun test api/slots"],
  ],
  "WEB-31": [
    ["03:10", "→ Read: src/bookings/BookingsPage.tsx"],
    ["03:28", "Building the spreadsheet as a CSV file that Excel and Numbers both open."],
    ["03:50", "→ Bash: pnpm test bookings"],
  ],
  "APP-12": [
    ["04:40", "→ Read: app/lists/store.ts"],
    ["05:02", "Keeping the guest list on the device, and merging it back in on sign-in."],
    ["05:20", "→ Bash: bun test lists"],
  ],
};

/**
 * Pull requests by people: Sam's own still open (one with changes a reviewer asked for, which a ready-made lead could
 * answer), and a teammate's waiting for Sam's review (with when they asked).
 */
const HUMAN_PRS: [string, string, number, string, string, string?][] = [
  ["Online shop", "example/shop", 298, "Count how many people leave a full basket", "19:42", "CHANGES_REQUESTED"],
  ["Booking app", "example/booking", 79, "Let patients pick their dentist when they book", "21:05"],
  ["Company website", "example/website", 47, "Draft: staff-only pages for the booking team", "18:10"],
];
const REVIEW_ASKS: [string, string, number, string, string][] = [
  ["Booking app", "example/booking-desk", 214, "The front-desk calendar remembers the last view", "22:15"],
];

/** Today's calendar, from the iCal feed. */
const CALENDAR: [string, string, string][] = [
  ["Online shop check-in", "09:30", "09:45"],
  ["Company website: spreadsheet export demo", "11:00", "11:30"],
  ["Booking app: booking page review", "14:00", "15:00"],
  ["Side project hour: Mobile app", "16:30", "17:00"],
];

/** Second repo per project, so health shows more than one line each. */
const MORE_REPOS: Record<string, string> = {
  "Online shop": "example/shop-admin",
  "Booking app": "example/booking-desk",
  "Company website": "example/website-api",
  "Mobile app": "sam/mobile-app-web",
};

/** The planner's file for the day: what's armed for agents, what's yours, the inbox, notes. */
function planAt(now: number): string[] {
  if (now < at("23:41")) return [];
  return [
    "# Plan for Tuesday 20 October",
    "## Top 3",
    "1. Answer the Mobile app lead about reminders",
    "2. Review the three agent PRs",
    "3. Demo the spreadsheet export to the Company website team at 11:00",
    "## Online shop",
    "### Agent",
    // once it merges on Ship it's done, so the plan no longer lists it as work to start
    ...(now < at(MOMENTS.shipped)
      ? ["- [x] SHOP-142 Customers see a payment error when their bank is slow — retry a network decline once before showing it (~40m)"]
      : []),
    "- [ ] SHOP-150 Show when an order will be ready to pick up — needs the kitchen's prep times first (~60m)",
    "### You",
    "- SHOP-151 Move to the new version of the card payment service — refunds work differently, needs your call",
    "## Booking app",
    "### Agent",
    "- [x] BOOK-88 The booking page is slow at 9am and sometimes times out — slot lookups take 2.4s at peak; cache them (~50m)",
    "- [ ] BOOK-90 Send a reminder the day before an appointment — a nightly job and an email template (~45m)",
    "### You",
    "- Review Priya's front-desk calendar change — she asked yesterday",
    "## Company website",
    "### Agent",
    "- [x] WEB-31 Let staff download bookings as a spreadsheet — a CSV export, for the 11:00 demo (~50m)",
    "### You",
    "- WEB-33 Staff sign in with their work Google accounts — too big for one PR; check the proposed split",
    "## Mobile app",
    "### Agent",
    "- [x] APP-12 Don't lose my guest list when I get signed out — top complaint from friends testing it (~50m)",
    "- [ ] APP-15 Make the invite screen work with screen readers (~70m)",
    "## Inbox",
    ...(now >= at("07:40") ? ["- [x] new-g1ftc4rd Gift card balance doesn't show at checkout (Online shop #orders)"] : []),
    "- ↩ Priya (the clinic's front desk) asked whether the slow booking page is fixed this week",
    "  Suggested: Yes, the fix is in review and can go out today.",
    "  https://example.com/slack/booking/p1",
    "- 💬 The Company website team moved the spreadsheet demo to 11:00",
    "## Notes",
    "- The clinic opens flu-jab bookings this week; keep Booking app PRs small.",
  ];
}

/** A clock time later in the coming day (afternoon times included), as epoch milliseconds. */
const later = (hm: string) => at(hm) + (Number(hm.slice(0, 2)) >= 12 ? 864e5 : 0);
/** Each account's agent CLI, model backend and model: Sam's subscription, the clinic's own Bedrock, a local model, Codex. */
const sessionModel = (account: string | undefined) => ACCOUNTS[account ?? "Sam"]?.session ?? "claude-opus-5-5";

/** A project name as a folder or host name: "Online shop" is online-shop. */
const slug = (name: string) => name.toLowerCase().replaceAll(" ", "-");
/** Where Overhand puts a ticket agent's worktree: inside the project's checkout, one folder per ticket (agent.ts). */
const worktreeOf = (client: string, key: string) => `/Users/sam/Code/${slug(client)}/.claude/worktrees/${key.toLowerCase()}`;

/** Sam's own session from 07:45: the gift card request in a worktree of its own, a subagent writing its tests in another. */
const SAM_FROM = "07:45";
const SAM_DIR = "/Users/sam/Code/online-shop/.claude/worktrees/gift-card";
const SAM_TESTS = "/Users/sam/Code/online-shop/.claude/worktrees/gift-card-tests";

/**
 * Every project's worktrees at a moment of the night (`GET /api/worktrees`): the checkout, each ticket agent's, and
 * Sam's own, with who is in each now (the same sessions Crew lists), its PR and whether Cleanup offers to remove it.
 */
export function demoWorktrees(s: DashboardState): Worktrees {
  const home = (p: string) => p.replace("/Users/sam", "~");
  const who = (dir: string): Worktrees["projects"][string][number]["who"] =>
    s.sessions.flatMap((x) => [
      ...(x.cwd === dir ? [{ kind: x.kind, label: x.kind === "you" ? x.name : x.label }] : []),
      ...x.subagents.filter((a) => a.cwd === home(dir)).map((a) => ({ kind: "subagent" as const, label: a.name })),
    ]);
  return {
    at: s.now,
    projects: Object.fromEntries(
      CLIENTS.map((c) => {
        const repo = c.repo.split("/")[1] ?? c.name;
        const main = `/Users/sam/Code/${slug(c.name)}`;
        const keys = [...s.running.map((r) => r.name), ...s.prs.map((p) => p.key), ...s.shipped.map((x) => x.key)].filter((k) =>
          k.startsWith(`${c.prefix}-`),
        );
        const agents = [...new Set(keys)].map((key) => {
          const pr = s.prs.find((p) => p.key === key);
          const shipped = s.shipped.find((x) => x.key === key);
          const dir = worktreeOf(c.name, key);
          return {
            path: home(dir),
            repo,
            branch: `agent/${key}`,
            main: false,
            who: who(dir),
            pr: pr?.url ?? shipped?.url ?? "",
            prState: shipped ? "MERGED" : pr?.draft ? "DRAFT" : pr ? "OPEN" : "",
            usedAt: shipped ? shipped.merged : s.now - 40 * 60_000,
            kb: 412_000 + key.length * 9_000,
            // what Cleanup's own scan says of a worktree whose PR merged (cleanup.ts worktreeVerdict)
            cleanup: shipped ? "its pull request was merged; the branch stays" : "",
          };
        });
        const sams =
          c.name === "Online shop" && s.now >= at(SAM_FROM)
            ? [
                { path: home(SAM_DIR), branch: "feat/gift-card-balance" },
                { path: home(SAM_TESTS), branch: "feat/gift-card-tests" },
              ].map((x) => ({
                ...x,
                repo,
                main: false,
                who: who(x.path.replace("~", "/Users/sam")),
                pr: "",
                prState: "",
                usedAt: s.now - 4 * 60_000,
                kb: 388_000,
                cleanup: "",
              }))
            : [];
        // one Sam's own agent made yesterday: its branch is a generated id, so its name comes from its own commit
        const made =
          c.name === "Online shop"
            ? [
                {
                  path: "~/Code/online-shop/.claude/worktrees/agent-a1b2c3d4",
                  repo,
                  branch: "worktree-agent-a1b2c3d4",
                  main: false,
                  who: [],
                  pr: "",
                  prState: "",
                  usedAt: s.now - 20 * 3600_000,
                  kb: 371_000,
                  cleanup: "",
                  words: ["fix(cart): keep the cart when a session expires"],
                },
              ]
            : [];
        return [
          c.name,
          [
            {
              path: home(main),
              repo,
              branch: "main",
              main: true,
              who: who(main),
              pr: "",
              prState: "",
              usedAt: s.now - 25 * 60_000,
              kb: 1_240_000,
              cleanup: "",
            },
            ...agents,
            ...sams,
            ...made,
          ],
        ];
      }),
    ),
  };
}

const between = (t: number, from: string, to: string) => t >= at(from) && t < at(to);
const lastBefore = (xs: [string, string][], t: number) => [...xs].reverse().find(([hm]) => at(hm) <= t);

/** The whole dashboard state at `minutes` into the night. */
export function nightAt(minutes: number): DashboardState {
  const now = clockAt(minutes);
  const reports = LOG.filter(([hm]) => at(hm) <= now).map(([hm, line]) => `- ${hm} ${line}`);
  const running = RUNS.filter((r) => between(now, r.from, r.to)).map((r, i) => ({
    name: r.key,
    account: r.account ?? "Sam",
    cwd: worktreeOf(r.client, r.key),
    startedAt: at(r.from),
    pid: 5100 + i,
    model: sessionModel(r.account),
    mode: "auto",
  }));
  const finished = RUNS.filter((r) => at(r.to) <= now);
  // SHOP-142 is on Ship: once GitHub merges it, it leaves the open PRs for the shipped list (with its Undo)
  const shippedNow = now >= at(MOMENTS.shipped);
  const done = finished.filter((r) => !(r.key === "SHOP-142" && shippedNow));
  const prOpen = (key: string) => done.some((r) => r.key === key);

  const leadsDone = LEADS.filter((g) => g.spans.every(([, b]) => at(b) <= now));
  const leadCost = (g: Character) => g.cost ?? 1.6;
  const spentBy = (account: string) =>
    [...finished, ...leadsDone.map((g) => ({ account: g.account, cost: leadCost(g) }))]
      .filter((r) => (r.account ?? "Sam") === account)
      .reduce((n, r) => n + r.cost, 0);
  const spent = finished.reduce((n, r) => n + r.cost, 0) + leadsDone.reduce((n, g) => n + leadCost(g), 0);
  // the daily cap holds billed accounts only, until the next local midnight (billing.ts budgetUntil)
  const capped = spentBy("Bedrock") >= BUDGET_USD;
  const midnight = at("00:00") + 864e5;

  const godmode: Lead[] = LEADS.map((g) => {
    const live = g.spans.find(([a, b]) => between(now, a, b));
    const last = [...g.spans].reverse().find(([, b]) => at(b) <= now);
    const asked = g.question !== undefined && at(g.question[0]) <= now;
    // its questions file so far, written as Overhand writes it: Sam's messages and its replies, then its question
    const said = (g.chat ?? [])
      .filter(([t]) => at(t) <= now)
      .map(([t, kind, text]): [number, string] => [
        at(t),
        `${sectionHeading(kind === "message" ? `Answer from ${OWNER}` : "Reply", kind === "message" ? MESSAGE_NOTE : "", new Date(at(t)))}\n\n${text}`,
      ]);
    const file: [number, string][] = [...said, ...(asked && g.question ? [[at(g.question[0]), g.question[1]] as [number, string]] : [])];
    return {
      key: g.key,
      label: g.label,
      name: g.name,
      project: g.project,
      supervised: true,
      onDemand: g.onDemand ?? false,
      watch: [g.watch],
      running: Boolean(live),
      mine: Boolean(live),
      since: live ? at(live[0]) : 0,
      stopped: false,
      reason: "",
      waiting: asked,
      // its only account is billed and past today's cap: held until midnight, and its status says the cap is why
      ...(capped && g.account === "Bedrock" && !live
        ? { waitingLimit: true, cantStart: null, limitAccount: "Bedrock", limitBack: midnight, capHeld: true }
        : { waitingLimit: false }),
      nextAt: last ? at(last[1]) + 40 * 60_000 : 0,
      account: g.account ?? "Sam",
      inbox: file.length ? { text: file.map(([, t]) => t).join("\n\n"), at: file.at(-1)?.[0] ?? 0, open: asked } : null,
      open: asked,
      // a run in Claude Code reads a message at its next step (its hook hands it over); any other CLI when its run ends
      hears: live ? (ACCOUNTS[g.account ?? OWNER]?.runtime === "claude-code" ? "now" : "after-run") : "starts",
      ask:
        asked && g.question
          ? {
              default: g.default ?? "",
              deadline: g.default ? at(g.question[0]) + 4 * 60 * 60_000 : 0,
              stale: g.closed && now >= at(g.closed[0]) ? { closed: g.closed[1], hours: 0 } : null,
              recheck: g.default ? 0 : at(g.question[0]) + 4 * 60 * 60_000,
            }
          : null,
    };
  });

  const sessions: Session[] = [
    ...LEADS.flatMap((g, i): Session[] => {
      const live = g.spans.find(([a, b]) => between(now, a, b));
      if (!live) return [];
      return [
        {
          pid: 4100 + i,
          kind: "lead",
          label: g.label,
          client: g.project,
          cwd: `/Users/sam/Code/${slug(g.project)}`,
          branch: "main",
          upSec: Math.round((now - at(live[0])) / 1000),
          active: true,
          name: "",
          model: sessionModel(g.account),
          mode: "auto",
          lastAction: lastBefore(g.says, now)?.[1] ?? "",
          subagents: g.subagents
            .filter(([a]) => at(a) <= now)
            .map(([a, b, name, description]) => ({
              name,
              description,
              color: "",
              active: between(now, a, b),
              lastAt: Math.min(now, at(b)),
              model: "claude-sonnet-5-5",
              mode: "auto",
            })),
        },
      ];
    }),
    ...(now >= at(SAM_FROM)
      ? [
          {
            pid: 6200,
            kind: "you" as const,
            label: "Your session",
            client: "Online shop",
            cwd: SAM_DIR,
            branch: "feat/gift-card-balance",
            upSec: Math.round((now - at(SAM_FROM)) / 1000),
            active: true,
            name: "",
            model: sessionModel("Sam"),
            mode: "default",
            lastAction: "The balance is on the order, not the card; reading it from the card at checkout.",
            subagents: [
              {
                name: "test-writer",
                description: "Covers the gift card balance at checkout",
                color: "",
                active: true,
                lastAt: now,
                model: "claude-sonnet-5-5",
                mode: "acceptEdits",
                cwd: SAM_TESTS.replace("/Users/sam", "~"),
                client: "Online shop",
                branch: "feat/gift-card-tests",
              },
            ],
          },
        ]
      : []),
    ...running.map(
      (r): Session => ({
        pid: r.pid,
        kind: "agent",
        label: r.name,
        client: CLIENTS.find((c) => r.name.startsWith(c.prefix))?.name ?? "",
        cwd: r.cwd,
        branch: `agent/${r.name}`,
        upSec: Math.round((now - r.startedAt) / 1000),
        active: true,
        name: "",
        model: r.model ?? "",
        mode: "auto",
        lastAction: lastBefore(AGENT_SAYS[r.name] ?? [], now)?.[1] ?? "",
        subagents: [],
      }),
    ),
  ];

  const tickets: Record<string, Ticket[]> = Object.fromEntries(
    Object.entries(TICKETS).map(([client, list]) => [
      client,
      // the tracker lists open tickets: once SHOP-142 merges it's closed, so nothing counts it as still to start
      list
        .filter(([key]) => !(key === "SHOP-142" && shippedNow))
        .map(([key, title, agent, priority, status, extra = []]): Ticket => {
          const labels = !agent
            ? extra
            : prOpen(key)
              ? ["agent-review"]
              : running.some((r) => r.name === key)
                ? ["agent-working"]
                : ["agent"];
          const moved = prOpen(key) ? "In Review" : running.some((r) => r.name === key) ? "In Progress" : status;
          return { key, title, status: moved, priority, labels, url: `https://example.com/${key}` };
        }),
    ]),
  );

  const prNumber: Record<string, number> = { "SHOP-142": 311, "BOOK-88": 77, "WEB-31": 52, "APP-12": 19 };
  const human = ([client, repo, number, title, hm, review = ""]: [string, string, number, string, string, string?]) => ({
    client,
    repo,
    number,
    title,
    url: samplePr(repo, number),
    draft: title.startsWith("Draft"),
    review,
    checks: "SUCCESS",
    updated: new Date(at(hm)).toISOString(),
  });
  const agentPrs = done.map((r) => {
    const c = CLIENTS.find((x) => x.name === r.client) ?? CLIENTS[0];
    const red = r.key === "BOOK-88" && between(now, "02:20", MOMENTS.fixRound);
    return {
      client: r.client,
      repo: c?.repo ?? "",
      number: prNumber[r.key] ?? 1,
      title: TICKETS[r.client]?.find(([k]) => k === r.key)?.[1] ?? r.key,
      url: samplePr(c?.repo ?? "", prNumber[r.key] ?? 1),
      draft: proposes(r.client),
      review: "",
      checks: red ? "FAILURE" : r.key === "BOOK-88" && between(now, MOMENTS.fixRound, MOMENTS.green) ? "PENDING" : "SUCCESS",
      updated: new Date(at(r.to)).toISOString(),
    };
  });
  const myPrs = [...agentPrs, ...HUMAN_PRS.map(human)];
  const reviews = REVIEW_ASKS.filter(([, , , , hm]) => at(hm) <= now).map(human);

  // a Slack request waits out the veto window before it's filed as a ticket
  const pending =
    now >= at("07:40")
      ? [
          {
            id: "new-g1ftc4rd",
            client: "Online shop",
            title: "Gift card balance doesn't show at checkout",
            details: "A customer paid with a gift card and couldn't see what was left on it until the receipt came.",
            permalink: "https://example.com/slack/shop/c1",
            from: "Dana (the shop's front counter)",
            createAfter: at("08:10"),
            ...(now >= at("08:10") ? { created: "SHOP-158" } : {}),
          },
        ]
      : [];

  // each account's 5-hour window fills with the work it carried in the last five hours
  const busyMin = (account: string) => {
    const spans: [number, number][] = [
      ...RUNS.filter((r) => (r.account ?? "Sam") === account).map((r): [number, number] => [at(r.from), at(r.to)]),
      ...LEADS.filter((g) => (g.account ?? "Sam") === account).flatMap((g) => g.spans.map(([a, b]): [number, number] => [at(a), at(b)])),
    ];
    return spans.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, now) - Math.max(a, now - 5 * 3600_000)) / 60_000, 0);
  };
  const usage = (account: string, base: number) => ({
    fiveHour: Math.min(0.95, 0.04 + busyMin(account) / 520),
    fiveHourResetsAt: now + (300 - (minutes % 300)) * 60_000,
    sevenDay: base + spentBy(account) / 220,
    sevenDayResetsAt: at("09:00") + 3 * 864e5,
    status: "allowed",
    at: now - 4 * 60_000,
  });
  const runs = [
    ...(now >= at("23:41") ? [{ name: "planner", account: "Sam", start: at("23:36"), end: at("23:41"), cost: 0.4, ok: true }] : []),
    ...finished.map((r) => ({ name: r.key, account: r.account ?? "Sam", start: at(r.from), end: at(r.to), cost: r.cost, ok: true })),
  ];
  const days = Array.from({ length: 7 }, (_, n) => {
    const d = new Date(DAY.getTime() - (6 - n) * 864e5).toLocaleDateString("sv-SE");
    return {
      date: d,
      cost: n === 6 ? spent : ([14.2, 9.8, 16.4, 0, 0, 11.6][n] ?? 0),
      // the clinic's Bedrock is the only billed account: its share of each earlier day
      billed: n === 6 ? spentBy("Bedrock") : ([3.8, 2.6, 4.4, 0, 0, 3.2][n] ?? 0),
      done: n === 6 ? finished.length : ([3, 2, 4, 0, 0, 3][n] ?? 0),
      failed: 0,
    };
  });

  return DashboardStateSchema.parse({
    now,
    today: new Date(now).toLocaleDateString("sv-SE"),
    // Sam's week: defaults and the rules Sam added took over, so fewer calls than the week before
    calls: { week: 14, last: 23 },
    paused: false,
    pauseReason: "",
    daemon: true,
    setup: false,
    running,
    accounts: [
      // Sam's own subscription has usage windows; Bedrock is billed to the clinic's AWS, Local is free, Codex is a plan
      ...Object.entries(ACCOUNTS).map(([name, a]) => ({
        name,
        coolUntil: capped && a.billing === "cloud" ? midnight : 0,
        usage: name === "Sam" ? usage("Sam", 0.38) : null,
        runtime: a.runtime,
        provider: a.provider,
        model: a.model,
        billing: a.billing,
      })),
    ],
    prs: done.map((r) => ({
      key: r.key,
      // the same URL as its entry in myPrs, so In flight shows its title and checks
      url: samplePr(CLIENTS.find((c) => c.name === r.client)?.repo ?? "", prNumber[r.key] ?? 1),
      fixes: r.key === "BOOK-88" && now >= at(MOMENTS.fixRound) ? 1 : 0,
      branch: `agent/${r.key}`,
      draft: proposes(r.client),
      corners: r.key === "BOOK-88" && now >= at(MOMENTS.fixRound) ? BOOK88_CORNERS : [],
      // on Ship, armed until GitHub merges it
      ship: CLIENTS.find((c) => c.name === r.client)?.autonomy === "ship" ? { on: true, why: "" } : null,
      proof: r.key === "BOOK-88" && now < at(MOMENTS.fixRound) ? demoProof("") : demoProof(r.key),
      // its preview deploy, the same one Health lists, once that deploy is up
      preview:
        now >= at(r.to) + 180_000 && !(r.key === "BOOK-88" && between(now, "02:20", MOMENTS.fixRound))
          ? `https://${r.key.toLowerCase()}.preview.example.com`
          : "",
    })),
    shipped: shippedNow
      ? [
          {
            key: "SHOP-142",
            project: "Online shop",
            url: samplePr("example/shop", 311),
            merged: at(MOMENTS.shipped),
            revert: "",
          },
        ]
      : [],
    guardrails: GUARD_BLOCKS.filter((b) => at(b.hm) <= now).map(({ hm, ...b }) => ({ ...b, at: at(hm) })),
    plugins: demoPlugins(now),
    pending,
    // Slack was read twelve minutes ago: Needs you says so in place of a button
    slackReadAt: now - 12 * 60_000,
    splits:
      now >= at("04:20")
        ? {
            "WEB-33": [
              { title: "Sign in with Google, behind a switch", scope: "Login button and callback; password login stays as it is." },
              { title: "Give each Google group its staff role", scope: "Role mapping table and an admin screen." },
              { title: "Require Google sign-in for all staff", scope: "A setting, a migration, and a way back in for the owner." },
            ],
          }
        : {},
    plan: planAt(now),
    reports,
    cost: spent,
    billed: spentBy("Bedrock"),
    budgetSpent: spentBy("Bedrock"),
    budgetUsd: BUDGET_USD,
    sessions,
    tickets,
    clients: CLIENTS.map((c) => ({
      name: c.name,
      prefix: c.prefix,
      host: "github",
      autonomy: c.autonomy ?? "act",
      shipBlock: c.shipBlock ?? "",
    })),
    godmode,
    labels: { queue: "agent", working: "agent-working", review: "agent-review", blocked: "needs-owner", fromSlack: "from-slack" },
    opsBehind: 0,
    taskTimeoutMin: 75,
    owner: OWNER,
    runs,
    week: {
      opened: 12 + finished.length,
      merged: shippedNow ? 10 : 9,
      failed: 0,
      questions: godmode.filter((g) => g.open).length,
      fixes: 1,
      successRate: 0.86,
      cost: 52 + spent,
      billed: 14 + spentBy("Bedrock"),
      byAccount: { Sam: 30 + spentBy("Sam"), Bedrock: 14 + spentBy("Bedrock"), Codex: 8 + spentBy("Codex"), Local: 0 },
      byClient: { "Online shop": 18, "Booking app": 14, "Company website": 12, "Mobile app": 8 + spent },
      days,
    },
    scorecard: SCORECARD,
    instructions: INSTRUCTIONS,
    rules: RULES,
    guides: GUIDES,
    // Mobile app joined last night: its first win, a test for an untested pure function, ran right after setup
    firstWin: {
      state: between(now, "00:00", "00:18") ? "running" : "pr",
      kind: "test",
      title: "Add tests for splitting the bill",
      project: "Mobile app",
      repo: "mobile",
      key: "APP-0",
      url: samplePr("sam/mobile-app", 58),
      message: "5 tests now check how the bill splits, from an even split to a guest who ate nothing. All pass, and so do the other 48.",
      at: at("00:18"),
    },
    routing: ROUTING,
    progression: progressionAt(now),
    // Sam's team (team.ts): teammates online, the Team view on Now and their faces in the header
    team: teamAt(now, at, running.length),
    status: {
      at: now,
      myPrs,
      reviews,
      ci: CLIENTS.flatMap((c) => [
        { client: c.name, repo: c.repo, branch: "main", state: "pass", failing: [], url: sampleUrl(c.repo, "actions") },
        {
          client: c.name,
          repo: MORE_REPOS[c.name] ?? c.repo,
          branch: "main",
          state: c.name === "Company website" && between(now, "04:02", "04:14") ? "running" : "pass",
          failing: [],
          url: "",
        },
      ]),
      deploys: [
        ...CLIENTS.map((c, i) => ({
          client: c.name,
          project: c.repo.split("/")[1] ?? c.name,
          state: "READY",
          target: "production",
          url: `https://${slug(c.name)}.example.com`,
          created: at("17:20") - i * 2400_000,
        })),
        ...done.map((r) => ({
          client: r.client,
          project: `${(CLIENTS.find((c) => c.name === r.client)?.repo ?? "").split("/")[1] ?? r.client}#${prNumber[r.key] ?? ""}`,
          state: r.key === "BOOK-88" && between(now, "02:20", MOMENTS.fixRound) ? "ERROR" : "READY",
          target: "preview",
          url: `https://${r.key.toLowerCase()}.preview.example.com`,
          created: at(r.to) + 180_000,
        })),
      ],
      sentry: [
        ...(between(now, "00:58", "03:30")
          ? [
              {
                client: "Booking app",
                id: "g1",
                title: "TimeoutError: slot lookup exceeded 5s",
                count: Math.round(40 + Math.min(100, (now - at("00:58")) / 60_000)),
                users: 37,
                isNew: true,
                level: "error",
                url: "https://example.com/err",
              },
            ]
          : []),
        {
          client: "Online shop",
          id: "a1",
          title: "ChunkLoadError: Loading chunk 412 failed",
          count: 12,
          users: 9,
          // first seen at dawn: new work a ready-made lead could take, and nothing wakes Online shop's CI lead for it
          isNew: now >= at("06:00"),
          level: "error",
          url: "",
        },
        {
          client: "Mobile app",
          id: "u1",
          title: "NetworkError: /lists refresh aborted",
          count: 4,
          users: 3,
          isNew: false,
          level: "warning",
          url: "",
        },
      ],
      // the shop's Dependabot alerts: work no lead there watches yet, so "Keep dependencies safe" is offered with its count
      advisories: (
        [
          ["axios", "high", "Server-side request forgery when a path is protocol-relative", "1.12.0", 3],
          ["cookie", "low", "Cookie name could be used to set other fields", "0.7.0", 4],
        ] as const
      ).map(([pkg, severity, summary, fix, n]) => ({
        client: "Online shop",
        repo: "shop",
        number: n,
        package: pkg,
        ecosystem: "npm",
        severity,
        summary,
        fix,
        url: sampleUrl("example/shop", "security", "dependabot", String(n)),
      })),
      // the shop's own `bun outdated`: two updates "Keep dependencies current" would take, and a major it only lists
      outdated: (
        [
          ["zod", "4.1.5", "4.1.12", "patch"],
          ["react-hook-form", "7.54.0", "7.62.0", "minor"],
          ["next", "15.5.4", "16.0.1", "major"],
        ] as const
      ).map(([pkg, current, next, update]) => ({
        client: "Online shop",
        repo: "shop",
        manager: "bun",
        package: pkg,
        current,
        next,
        update,
      })),
      // the booking app's busiest files this month that no test names: "Test what's untested"
      untested: (
        [
          ["src/slots/availability.ts", 14],
          ["src/booking/reschedule.ts", 9],
          ["src/api/calendar-sync.ts", 6],
        ] as const
      ).map(([path, n]) => ({ client: "Booking app", repo: "booking", path, n })),
      // Mobile app's TODO notes, counted as its check-up counts them (its hot spot is rsvp.ts's 7): "Clear the TODOs"
      todos: (
        [
          ["src/rsvp.ts", 7],
          ["src/lists/sync.ts", 2],
        ] as const
      ).map(([path, n]) => ({ client: "Mobile app", repo: "mobile", path, n })),
      calendar: CALENDAR.map(([title, a, b]) => ({ title, start: later(a), end: later(b), allDay: false })),
      errors: [],
    },
  });
}
