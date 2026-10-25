/**
 * The relay's monthly cost as a function of usage, so COST.md's numbers are computed, not typed, and a test keeps the
 * 10,000-concurrent estimate under the €100 cap. Prices checked 2026-10-20 (sources in COST.md).
 */
import { ROOM_CHECK_MS } from "./room";

/** Cloudflare list prices, USD. */
const PRICES = {
  workersBase: 5, // Workers Paid, per month
  workersIncluded: 10e6, // requests per month
  workersPerM: 0.3,
  cpuIncludedMs: 30e6,
  cpuPerMMs: 0.02,
  doIncluded: 1e6, // Durable Object requests per month
  doPerM: 0.15,
  doGbsIncluded: 400_000,
  doPerMGbs: 12.5,
  doGb: 0.125, // every object is billed at 128 MB
  wsRatio: 20, // incoming WebSocket messages per billed request; outgoing and auto-responses are free
  turnFreeGb: 1000,
  turnPerGb: 0.05, // egress only
} as const;

/** What a month of use looks like. */
export type Usage = {
  /** Daemons connected at once (each holds one hibernating WebSocket). */
  concurrent: number;
  /** Times each user opens the hosted dashboard per day (a phone glance counts). */
  opensPerDay: number;
  /** Signalling messages the Durable Object receives per open (offer, answer, ICE both ways). */
  signalsPerOpen: number;
  /** Handler time per received message or connect, ms: the only time a hibernating object is billed. */
  handlerMs: number;
  /** Daemon reconnects per day (sleep, network changes, restarts). */
  reconnectsPerDay: number;
  /** Worker requests per open (/relay/me, /relay/ice, the WebSocket upgrade). */
  workerPerOpen: number;
  /** Worker requests per daemon per day besides reconnects (entitlement refreshes, ICE). */
  daemonPerDay: number;
  /** CPU per Worker request, ms (an Ed25519 verify and a D1 read). */
  cpuMs: number;
  /** Share of opens that NAT forces through TURN. */
  turnShare: number;
  /** Dashboard data per TURN-relayed open, MB (after the channel's gzip). */
  mbPerRelayedOpen: number;
};

/** The estimate the issue asks for: 10,000 concurrent users, with deliberately generous usage. */
export const TEN_K: Usage = {
  concurrent: 10_000,
  opensPerDay: 20,
  signalsPerOpen: 14,
  handlerMs: 5,
  reconnectsPerDay: 6,
  workerPerOpen: 3,
  daemonPerDay: 10,
  cpuMs: 2,
  turnShare: 0.2,
  mbPerRelayedOpen: 0.6,
};

/** Months are 30 days here. */
const DAYS = 30;
const over = (used: number, included: number) => Math.max(0, used - included);

/** The month's bill by line, USD, with the volumes behind it. */
export function monthlyCost(u: Usage) {
  const opens = u.concurrent * u.opensPerDay * DAYS;
  const connects = opens + u.concurrent * u.reconnectsPerDay * DAYS;
  const workerRequests = opens * u.workerPerOpen + u.concurrent * (u.reconnectsPerDay + u.daemonPerDay) * DAYS;
  const doRequests = connects + (opens * u.signalsPerOpen) / PRICES.wsRatio;
  const gbs = ((connects + opens * u.signalsPerOpen) * u.handlerMs * PRICES.doGb) / 1000;
  const turnGb = (opens * u.turnShare * u.mbPerRelayedOpen) / 1000;
  const lines = {
    workers: PRICES.workersBase + (over(workerRequests, PRICES.workersIncluded) / 1e6) * PRICES.workersPerM,
    cpu: (over(workerRequests * u.cpuMs, PRICES.cpuIncludedMs) / 1e6) * PRICES.cpuPerMMs,
    doRequests: (over(doRequests, PRICES.doIncluded) / 1e6) * PRICES.doPerM,
    // Cloudflare bills duration in whole millions of GB-s past the allowance
    doDuration: Math.ceil(over(gbs, PRICES.doGbsIncluded) / 1e6) * PRICES.doPerMGbs,
    turn: over(turnGb, PRICES.turnFreeGb) * PRICES.turnPerGb,
    d1: 0, // a read per authenticated request: thousands of times inside 25 billion included rows
    auth: 0, // WorkOS AuthKit: free to 1,000,000 monthly active users
  };
  const usd = Object.values(lines).reduce((a, b) => a + b, 0);
  return { opens, workerRequests, doRequests, gbs, turnGb, lines, usd };
}

/** USD to EUR for the cap, rounded against us. */
export const EUR_PER_USD = 0.95;

/** D1 list prices past the included allowance (Workers Paid), USD. */
const D1_PRICES = { writesIncluded: 50e6, writesPerM: 1, readsIncluded: 25e9, readsPerM: 0.001 } as const;

/** What a month of Teams looks like on top of the relay (docs/teams.md). */
export type TeamUsage = {
  /** Members whose daemons hold a room socket. */
  members: number;
  /** People per team. */
  perTeam: number;
  /** Presence messages per member per day: one per real change (agents started or stopped, quiet, a claim, a view). */
  presencePerDay: number;
  /** Durable events per member per day: questions, answers, results, hand-offs, comments. */
  eventsPerDay: number;
  /** Room reconnects per member per day; each one reads the catch-up log. */
  reconnectsPerDay: number;
  /** Log rows a reconnect reads on average (at most CATCHUP_MAX). */
  catchupRows: number;
  /** Team Worker requests per member per day (roster reads after a change, admin actions). */
  workerPerDay: number;
  /** Handler time per message, ms, and the extra wall time a D1 write or read keeps the object awake, ms. */
  handlerMs: number;
  d1Ms: number;
};

/** Every relay user in a team of five, busy: the worst case for the cap. */
export const TEAM_TEN_K: TeamUsage = {
  members: 10_000,
  perTeam: 5,
  presencePerDay: 150,
  eventsPerDay: 20,
  reconnectsPerDay: 6,
  catchupRows: 60,
  workerPerDay: 5,
  handlerMs: 5,
  d1Ms: 25,
};

/** Teams' volumes for a month. */
function teamVolumes(t: TeamUsage) {
  const connects = t.members * t.reconnectsPerDay * DAYS;
  const presence = t.members * t.presencePerDay * DAYS;
  const events = t.members * t.eventsPerDay * DAYS;
  // every room's seat check (ROOM_CHECK_MS), as if every team had someone connected all day
  const checks = (t.members / t.perTeam) * (86_400_000 / ROOM_CHECK_MS) * DAYS;
  return {
    connects,
    presence,
    events,
    // the upgrade plus roster reads and admin actions
    workerRequests: connects + t.members * t.workerPerDay * DAYS,
    doRequests: connects + checks + (presence + events) / PRICES.wsRatio,
    // presence needs no I/O; an event waits on its D1 insert, a connect on its catch-up read, a check on its seat reads
    gbs: ((presence * t.handlerMs + (events + connects + checks) * (t.handlerMs + t.d1Ms)) * PRICES.doGb) / 1000,
    // insert plus its primary-key index, and the trim deleting as many again
    d1Writes: events * 4,
    // a check reads the team, its members and the plan
    d1Reads: connects * t.catchupRows + t.members * t.workerPerDay * DAYS * 20 + checks * (t.perTeam + 2),
  };
}

/**
 * The relay's month with Teams on top, by line: the volumes add to the relay's own, then the allowances apply once.
 * `perTeam` is the marginal cost of one active team at list prices, with no allowance, the honest unit cost.
 */
export function monthlyCostWithTeams(u: Usage, t: TeamUsage) {
  const base = monthlyCost(u);
  const v = teamVolumes(t);
  const workerRequests = base.workerRequests + v.workerRequests;
  const doRequests = base.doRequests + v.doRequests;
  const gbs = base.gbs + v.gbs;
  const lines = {
    ...base.lines,
    workers: PRICES.workersBase + (over(workerRequests, PRICES.workersIncluded) / 1e6) * PRICES.workersPerM,
    cpu: (over(workerRequests * u.cpuMs, PRICES.cpuIncludedMs) / 1e6) * PRICES.cpuPerMMs,
    doRequests: (over(doRequests, PRICES.doIncluded) / 1e6) * PRICES.doPerM,
    doDuration: Math.ceil(over(gbs, PRICES.doGbsIncluded) / 1e6) * PRICES.doPerMGbs,
    d1:
      (over(v.d1Writes, D1_PRICES.writesIncluded) / 1e6) * D1_PRICES.writesPerM +
      (over(v.d1Reads, D1_PRICES.readsIncluded) / 1e6) * D1_PRICES.readsPerM,
  };
  const usd = Object.values(lines).reduce((a, b) => a + b, 0);
  const one = teamVolumes({ ...t, members: t.perTeam });
  const perTeam =
    (one.workerRequests / 1e6) * PRICES.workersPerM +
    (one.workerRequests * u.cpuMs * PRICES.cpuPerMMs) / 1e6 +
    (one.doRequests / 1e6) * PRICES.doPerM +
    (one.gbs / 1e6) * PRICES.doPerMGbs +
    (one.d1Writes / 1e6) * D1_PRICES.writesPerM +
    (one.d1Reads / 1e6) * D1_PRICES.readsPerM;
  return { base, teams: v, workerRequests, doRequests, gbs, lines, usd, perTeam };
}

// ── Hosted runs: customers pay for them, with a margin on top ──

/** The one container size hosted runs start (Cloudflare Containers' standard-2). */
export const RUN_INSTANCE = { name: "standard-2", vcpu: 1, memGiB: 6, diskGB: 12 } as const;

/** Cloudflare Containers' per-second rates, USD (developers.cloudflare.com/containers/pricing, checked 2026-10-25). */
const CONTAINER_RATES = { memGiBs: 0.0000025, vcpuS: 0.00002, diskGBs: 0.00000007 } as const;

/**
 * Our cost of one run minute at full CPU, USD: 60 s × (6 GiB × $0.0000025 + 1 vCPU × $0.000020 + 12 GB × $0.00000007)
 * = 60 × $0.00003584 ≈ $0.00215. CPU is billed only while active, so an idle minute costs about $0.00095; the margin is
 * taken on the full-CPU figure. Egress past the included allowance ($0.025/GB) is a clone and a push per run: noise.
 */
export const RUN_COST_PER_MIN_USD =
  60 *
  (RUN_INSTANCE.memGiB * CONTAINER_RATES.memGiBs +
    RUN_INSTANCE.vcpu * CONTAINER_RATES.vcpuS +
    RUN_INSTANCE.diskGB * CONTAINER_RATES.diskGBs);

/** The least a run minute may sell for: our cost times this (the owner's margin on everything hosted). */
export const RUN_MARGIN = 2.5;

/**
 * The run minute packs to create in Paddle (one-time prices, custom_data `{pack: "minutes", minutes}`), in euros:
 * €6 for 1,000 (€0.0060 a minute) and €28 for 5,000 (€0.0056). The floor is $0.00215 × 2.5 × €0.95/$ ≈ €0.0051, which
 * the cost test checks for these and for whatever the catalog says.
 */
export const RUN_PACKS = [
  { minutes: 1000, eur: 6 },
  { minutes: 5000, eur: 28 },
] as const;

/** Whether a pack's price (minor units, EUR or USD) per minute keeps the margin over our cost; any other currency doesn't. */
export const keepsMargin = (amount: number, currency: string, minutes: number): boolean => {
  const perUsd = currency === "EUR" ? EUR_PER_USD : currency === "USD" ? 1 : 0;
  return perUsd > 0 && amount / 100 / minutes >= RUN_COST_PER_MIN_USD * RUN_MARGIN * perUsd;
};
