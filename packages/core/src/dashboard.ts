/** Everything /api/state returns, plus the dashboard's ticket cache. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Billing,
  BillingSchema,
  type DashboardState,
  isBilled,
  RunSchema,
  type Scar,
  type Ticket,
  type Week,
} from "@overhand/contract";
import { loadAssignments, loadFindings } from "./assign";
import { accountBilling, billingOf, budgetSpend, budgetUntil, refreshBilling, spendOnDay } from "./billing";
import { callCounts } from "./calls";
import type { Config } from "./config";
import { loadRequests, quietEnd } from "./control";
import { snoozedItems } from "./decide";
import { ACCOUNTS, BUNDLED, CFG, CLIENTS, HOME, INSTALL, LABEL, MIN, needsSetup, OPS, OWNER, SLACK_MCP, today } from "./env";
import { firstWinState } from "./firstwin";
import { gate, holders, readMachine } from "./governor";
import { guardBlocks } from "./guard";
import { guides, refreshGuides } from "./guide";
import { identityOf, progression, routeSuggestions, scorecards } from "./history";
import { inboxReadAt } from "./inbox";
import { instructions, refreshInstructions } from "./instructions";
import {
  blankLead,
  heldByCap,
  leadAsk,
  leadFreeAt,
  leadInbox,
  leadNameByLabel,
  leadPid,
  limitBack,
  loadLeads,
  lockHolder,
  openRefs,
  restartDelayMin,
} from "./leads";
import { ruleOffers } from "./learn";
import { benchedUntil } from "./limits";
import { menubarHelper } from "./menubar";
import { diskFree, report } from "./notify";
import { reviewRound } from "./onpreview";
import { loadActions, room, toCard, toSession } from "./room";
import { gitFlagged, projectSandbox, waitsForSignIn } from "./sandbox";
import { lastSelfCheck } from "./selfcheck";
import { latestRelease, opsBehind, updateRoute, VERSION } from "./selfupdate";
import { type LiveSession, liveSessions } from "./sessions";
import { recentShips, refreshShipBlocks, shipBlock } from "./ship";
import { currentRuns, loadNames, loadPrReview, loadSplits, loadState, ticketCache } from "./state";
import { status } from "./status/index";
import { type Gauge, gauges, memoryInUse, STRAIN, worst } from "./strain";
import { teamState } from "./team";
import { myAndQueued, setLabels, tickets } from "./trackers/index";
import { updateStatuses } from "./updates";
import { exhaustedUntil, loadUsage, streamEvents } from "./usage";

let ticketRefresh: Promise<Record<string, Ticket[] | string>> | null = null;

/** Tickets for the dashboard: stale data is returned at once while one background refresh runs (trackers can take 20 s+). */
export async function uiTickets(): Promise<Record<string, Ticket[] | string>> {
  if (Date.now() - ticketCache.at < 120_000) return ticketCache.data;
  ticketRefresh ??= fetchTickets().finally(() => {
    ticketRefresh = null;
  });
  return Object.keys(ticketCache.data).length ? ticketCache.data : ticketRefresh;
}

async function fetchTickets(): Promise<Record<string, Ticket[] | string>> {
  const data: Record<string, Ticket[] | string> = {};
  await Promise.all(
    CLIENTS.map(async (c) => {
      try {
        data[c.name] = (await myAndQueued(c)).map((t) => ({
          key: t.key,
          title: t.title,
          status: t.status,
          priority: t.priority,
          labels: t.labels,
          url: t.url,
        }));
      } catch (e) {
        data[c.name] = String(e);
      }
    }),
  );
  ticketCache.at = Date.now();
  ticketCache.data = data;
  return data;
}

/** PRs, merges, failures and spend (billed, and at API prices) over the last 7 days, read from the daily reports. */
export function weekStats(): Week {
  const days: { date: string; cost: number; billed: number; done: number; failed: number }[] = [];
  const byAccount: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  let opened = 0,
    merged = 0,
    failed = 0,
    questions = 0,
    fixes = 0;
  for (let n = 6; n >= 0; n--) {
    const date = new Date(Date.now() - n * 864e5).toLocaleDateString("sv-SE");
    const file = join(OPS, "reports", `${date}.md`);
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
    let cost = 0,
      billed = 0,
      done = 0,
      bad = 0;
    const spend = (account: string, usd: number, label: string, billing?: Billing) => {
      const key = label.match(/\b([A-Z][A-Z0-9]+)-\d+/)?.[1];
      const lead = CFG.godmode.find((g) => label === `lead-${g.key}`);
      const client = CLIENTS.find((c) => c.prefix === key)?.name ?? lead?.project ?? "Planning and inbox";
      cost += usd;
      if (isBilled(billing ?? billingOf(account))) billed += usd;
      byAccount[account] = (byAccount[account] ?? 0) + usd;
      byClient[client] = (byClient[client] ?? 0) + usd;
    };
    // spend: the runs file when that day has one (it includes leads), else the costs written in the report
    const runsFile = join(OPS, "runs", `${date}.jsonl`);
    if (existsSync(runsFile)) {
      for (const r of streamEvents(readFileSync(runsFile, "utf8"))) {
        if (typeof r === "string") continue;
        const billing = BillingSchema.safeParse(r.billing);
        spend(String(r.account ?? "?"), Number(r.cost ?? 0), String(r.name ?? ""), billing.success ? billing.data : undefined);
      }
    }
    for (const l of lines) {
      const m = existsSync(runsFile) ? null : l.match(/\((?:planner on )?([a-z0-9-]+), \$(\d+\.\d+)\)/);
      if (m?.[1] && m[2]) spend(m[1], Number(m[2]), l);
      if (l.includes("✅")) {
        opened++;
        done++;
      }
      if (l.includes("🎉")) merged++;
      if (l.includes("✗")) {
        failed++;
        bad++;
      }
      if (l.includes("❓")) questions++;
      if (l.includes("🔧")) fixes++;
    }
    days.push({ date, cost, billed, done, failed: bad });
  }
  const tries = opened + failed + questions;
  return {
    opened,
    merged,
    failed,
    questions,
    fixes,
    successRate: tries ? opened / tries : null,
    cost: days.reduce((s, d) => s + d.cost, 0),
    billed: days.reduce((s, d) => s + d.billed, 0),
    byAccount,
    byClient,
    days,
  };
}

/** A fresh install's first day: no run log from an earlier day (runs/<date>.jsonl). */
export function firstDay(dir = join(OPS, "runs"), day = today()): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).every((f) => !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f.slice(0, 10) >= day);
}

// when each red build was first seen, so its scar keeps its "since" from poll to poll (reset by a daemon restart)
const redSince = new Map<string, number>();

/** Scars from outside the run history, by project: a red default branch, a lead stopped after crashing. */
function openScars(leads: ReturnType<typeof loadLeads>, now = Date.now()): Record<string, Scar[]> {
  const out: Record<string, Scar[]> = {};
  const add = (project: string, scar: Scar) => {
    out[project] = [...(out[project] ?? []), scar];
  };
  const red = new Set(status.ci.filter((k) => k.state === "fail").map((k) => k.client));
  for (const k of [...redSince.keys()]) if (!red.has(k)) redSince.delete(k);
  for (const client of red) {
    if (!redSince.has(client)) redSince.set(client, now);
    add(client, { kind: "ci", since: redSince.get(client) ?? now });
  }
  for (const g of CFG.godmode) {
    const st = leads[g.key];
    if (st?.stopped && st.reason.startsWith("crashed")) add(g.project, { kind: "lead", since: st.crashes.at(-1) ?? st.lastExit });
  }
  return out;
}

// ---------- what costs a process to read: refreshed in the background, served from memory ----------

// Building the state never runs a process or touches the network: on 2026-10-23 it ran ps, lsof, git, find and the key
// store inline (0.2 s every call, 2-5 s whenever a cache expired) and every open tab felt it. Each part below has its
// own schedule; the state shows what was last read, and the open tabs get the change on the next push (2 s).
// - sessions: every 3 s (ps; lsof once per new process)       - control room: every 10 s, and at once after a button
// - machine (battery, heat, memory): every 30 s              - instructions and guides: every minute (local git)
// - tickets: every 2 min (trackers)                           - sign-ins' billing: every 5 min; Ship gates: every 30 min
let sessionsNow: LiveSession[] = [];
let machineAt = 0;
let machineHolding = "";
let gaugesNow: Gauge[] = [];
let roomAt = 0;
let roomNow: ReturnType<typeof room> = { rows: [], cards: [] };
let refreshing: Promise<void> | null = null;

const readRoom = (now: number) => {
  roomAt = now;
  roomNow = room(OPS, CFG, sessionsNow, HOME, now, leadNameByLabel);
};

/** Reads whatever is due of the parts above; one read at a time however often it's asked. */
export function refreshState(): Promise<void> {
  refreshing ??= (async () => {
    sessionsNow = await liveSessions();
    const now = Date.now();
    if (now - roomAt > 10_000) readRoom(now);
    if (now - machineAt > 30_000) {
      machineAt = now;
      const m = readMachine(diskFree());
      machineHolding = gate(CFG.governor, m, 0, now) ?? "";
      gaugesNow = gauges({ ...m, at: now, mem: memoryInUse() }, CFG.governor);
    }
    refreshBilling(ACCOUNTS, now);
    refreshShipBlocks(CLIENTS, now);
    // the slow reads run on their own (each one at a time), so sessions keep their 3 s however long git takes
    void uiTickets().catch(() => {});
    void refreshInstructions(now).catch(() => {});
    void refreshGuides(now).catch(() => {});
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Keeps the parts fresh for as long as the daemon runs. */
export function startStateRefresh(): void {
  void refreshState().catch(() => {});
  setInterval(() => void refreshState().catch(() => {}), 3000);
}

/**
 * Quiet mode, the heavy jobs in a slot, why new ones would wait, and the strain gauges (the machine as last read); the
 * 3-hour line and who's causing strain come from the daemon's sampler.
 */
function governorState(): DashboardState["governor"] {
  const until = quietEnd(OPS, CFG.control); // quiet mode, or a quiet window from the house rules
  return {
    quietUntil: until,
    holding: until ? "" : machineHolding,
    jobs: holders(OPS).map((h) => ({ kind: h.kind, run: h.run, cmd: h.cmd.slice(0, 200), since: h.since })),
    strain: {
      level: worst(gaugesNow.map((g) => g.level)),
      gauges: gaugesNow,
      history: STRAIN.history,
      groups: STRAIN.groups,
      other: STRAIN.other,
      cause: STRAIN.cause,
    },
  };
}

/** The control room: every session, the action cards, requests and what Overhand did (the room as last read). */
function controlState(): DashboardState["control"] {
  return {
    sessions: roomNow.rows.map(toSession),
    cards: roomNow.cards.map(toCard),
    requests: loadRequests(OPS).slice(-50),
    actions: loadActions(OPS),
  };
}

/** Reads the room again now, so the next state shows what a button just did. */
export function roomChanged(): void {
  readRoom(Date.now());
}

/** Everything the dashboard shows, as /api/state returns it. */
export async function dashboardState(): Promise<DashboardState> {
  const state = loadState();
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const leads = loadLeads();
  // a draft waits for you until GitHub says it's ready, or you marked it ready here and the work pass hasn't seen it yet
  const markedReady = new Set(loadPrReview().ready);
  const isDraft = (key: string, url: string, draft = false): boolean =>
    draft && !markedReady.has(key) && (status.myPrs.find((p) => p.url === url)?.draft ?? true);
  const reports = read(join(OPS, "reports", `${today()}.md`))
    .split("\n")
    .filter(Boolean);
  const heartbeat = Number(read(join(OPS, ".heartbeat")) || 0);
  const sessions = sessionsNow;
  const spend = spendOnDay();
  const budgeted = budgetSpend();
  return {
    now: Date.now(),
    today: today(),
    paused: existsSync(join(OPS, "PAUSE")),
    pauseReason: read(join(OPS, "PAUSE")),
    daemon: Date.now() - heartbeat < 30_000,
    setup: needsSetup(),
    running: currentRuns(),
    accounts: ACCOUNTS.map((name) => {
      const usage = loadUsage(OPS)[name] ?? null;
      const id = identityOf(name);
      const coolUntil = Math.max(
        benchedUntil(name),
        exhaustedUntil(usage ?? undefined, Date.now(), CFG.limits.paceWeekly),
        budgetUntil(name, Date.now(), budgeted),
      );
      const b = accountBilling(name);
      const { provider, model, runtime } = id;
      return {
        name,
        coolUntil,
        usage,
        provider,
        model,
        runtime,
        billing: b.billing,
        billingSure: b.sure,
        waitsSignIn: waitsForSignIn(name, ""),
      };
    }),
    prs: Object.entries(state.prs).map(([key, p]) => ({
      key,
      url: p.url,
      fixes: p.fixes,
      branch: p.branch,
      draft: isDraft(key, p.url, p.draft),
      corners: p.corners ?? [],
      proof: p.proof ?? null,
      preview: p.preview ?? "",
      reviewRound: reviewRound(key),
      ship: p.ship ? { on: p.ship.on, why: p.ship.why } : null,
    })),
    shipped: recentShips().map((x) => ({ key: x.key, project: x.project, url: x.url, merged: x.merged ?? 0, revert: x.revert ?? "" })),
    pending: Object.entries(state.pending).map(([id, p]) => ({ id, ...p })),
    slackReadAt: existsSync(SLACK_MCP) ? inboxReadAt() : 0,
    splits: loadSplits(),
    plan: read(join(OPS, "plans", `${today()}.md`)).split("\n"),
    reports,
    cost: spend.apiPrice,
    billed: spend.billed,
    budgetSpent: budgeted, // what the daily budget checks: billed, and accounts whose billing isn't known yet
    budgetUsd: CFG.limits.dailyBudgetUsd,
    paceWeekly: CFG.limits.paceWeekly,
    gitBlocked: gitFlagged(),
    sandboxRefuse: projectSandbox("").refuse ? projectSandbox("").why || "the OS sandbox can't run here" : "",
    menubar: menubarHelper() ? CFG.menubar : null,
    dayOne: firstDay(),
    sessions,
    tickets: ticketCache.data,
    clients: CLIENTS.map((c) => ({
      name: c.name,
      prefix: c.prefix,
      host: c.host,
      autonomy: c.autonomy,
      assignedAutonomy: c.assignedAutonomy,
      shipBlock: shipBlock(c),
      aliases: [...new Set([...c.aliases, basename(c.dir)])],
    })),
    godmode: CFG.godmode.map((g) => {
      const st = leads[g.key] ?? blankLead();
      const pid = leadPid(g, st);
      const box = leadInbox(g);
      const free = leadFreeAt(g);
      return {
        key: g.key,
        label: g.label,
        name: g.name,
        project: g.project,
        supervised: g.supervised,
        onDemand: g.onDemand,
        watch: g.watch,
        running: !!(pid || lockHolder(g)),
        mine: !!pid,
        since: pid ? st.startedAt : 0,
        stopped: st.stopped,
        reason: st.reason,
        waiting: !!st.waiting,
        waitingLimit: !!st.waitingLimit,
        cantStart: st.cantStart ?? null,
        // when every account it may use is benched, the one back first, so Crew says whose limit it waits on and until when
        ...limitBack(free),
        // today's spend cap is what holds it: its status says so, and that it resumes tomorrow or once you raise the cap
        capHeld: heldByCap(free, (a) => budgetUntil(a, Date.now(), budgeted)),
        // when the supervisor starts it next; at or before now means on its next tick (within a minute)
        nextAt: st.startNow ? 0 : st.lastExit + restartDelayMin(g, st) * MIN,
        account: st.account ?? "",
        inbox: box,
        open: !!box?.open,
        ask: leadAsk(g, st, box, openRefs(g.project)),
      };
    }),
    labels: LABEL,
    opsBehind,
    disk: {
      freeGb: Math.min(diskFree(), 1e6),
      floorGb: CFG.cleanup.minFreeGb,
      warnGb: CFG.governor.warnFreeGb,
      heavyGb: CFG.governor.pauseHeavyBelowGb,
    },
    governor: governorState(),
    control: controlState(),
    update: { latest: BUNDLED ? latestRelease() : "", current: VERSION, command: updateRoute(INSTALL).say },
    taskTimeoutMin: CFG.limits.taskTimeoutMin,
    owner: OWNER,
    runs: read(join(OPS, "runs", `${today()}.jsonl`))
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const r = RunSchema.safeParse(JSON.parse(l));
          return r.success ? [r.data] : [];
        } catch {
          return []; // a partial line from a run still writing
        }
      }),
    week: weekStats(),
    status,
    scorecard: scorecards(),
    routing: { mode: CFG.routing.mode, suggestions: routeSuggestions() },
    instructions: instructions(),
    guardrails: guardBlocks(Date.now() - 864e5),
    updates: updateStatuses(),
    rules: ruleOffers(),
    firstWin: firstWinState(),
    progression: progression(openScars(leads)),
    guides: guides(),
    findings: loadFindings(),
    selfCheck: lastSelfCheck(),
    snoozed: snoozedItems(),
    calls: callCounts(),
    assigned: Object.values(loadAssignments()).map(({ key, project, title, by, local, at }) => ({ key, project, title, by, local, at })),
    team: teamState(),
    names: loadNames(),
  };
}

/** Moves open tickets from renamed labels to the new names in every project's tracker, so nothing in flight is lost. */
export async function migrateLabels(before: Config["labels"], after: Config["labels"]): Promise<void> {
  const renames = (Object.keys(after) as (keyof Config["labels"])[])
    .filter((k) => before[k] !== after[k])
    .map((k) => [before[k], after[k]] as const);
  if (!renames.length) return;
  let moved = 0;
  for (const c of CLIENTS) {
    for (const [from, to] of renames) {
      const list = await tickets(c, { label: from }).catch((e: unknown) => {
        report(`⚠ ${c.name}: couldn't list tickets labelled ${from}: ${String(e)}`);
        return [];
      });
      for (const tk of list) {
        await setLabels(tk, [to], [from])
          .then(() => moved++)
          .catch((e: unknown) => report(`⚠ ${tk.key}: relabel failed: ${String(e)}`));
      }
    }
  }
  ticketCache.at = 0;
  report(`🏷 labels renamed (${renames.map(([a, b]) => `${a} → ${b}`).join(", ")}): ${moved} open ticket(s) moved`);
}
