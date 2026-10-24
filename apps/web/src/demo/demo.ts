/**
 * Demo mode (`?demo`): the site embeds the real dashboard on the scripted night in `night.ts`, shown at one morning.
 * Embedded, it opens a minute before the night's one call and posts `{ type: "overhand:ready" }`; the parent page posts
 * `{ type: "overhand:arrive" }` once, the question arrives, and the demo answers `{ type: "overhand:arrived" }`. A live
 * piece (`PIECE_PLAYS`) does the same with its own moment on `overhand:play`. Messages stay on this origin. Nothing
 * talks to a daemon, and every action explains that it's a demo.
 */
import {
  type Assignment,
  type Autonomy,
  AutonomySchema,
  type DashboardState,
  diagnosticLines,
  type FeedbackPreview,
  FeedbackRequestSchema,
  type Finding,
  feedbackBody,
  LEAD_WORK,
  type Lead,
  NameSchema,
  NO_PROJECT,
  planPoints,
  templateKey,
  termHits,
} from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import type { QueryClient } from "@tanstack/react-query";
import { ARRIVE_FROM, MOMENTS, MORNING, minutesOf } from "./moments";
import { clockAt, nightAt } from "./night";
import { demoReviewPost, demoReviewRound } from "./review";
import { demoSignInPost } from "./signin";
import { stressed } from "./stress";

export const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
/** `?demo=stress`: the stress night (stress.ts), the sample night at the edges real data reaches, for the sweep. */
const STRESS = DEMO && new URLSearchParams(location.search).get("demo") === "stress";

/** What the demo needs from the page it runs in: the browser's own, or a stand-in in tests. */
export interface Host {
  /** The page that frames the demo: only its messages count. */
  parent: unknown;
  /** This page's origin: only messages from it count (the site serves the demo itself). */
  origin: string;
  /** Posts to that page, on this origin only. */
  post: (message: unknown) => void;
  /** Framed by another page (the site), not opened on its own. */
  embedded: boolean;
  /** `prefers-reduced-motion: reduce`: nothing moves, the demo opens at its final state. */
  reduced: boolean;
  listen: (f: (e: { source: unknown; origin: string; data: unknown }) => void) => () => void;
}

/** The parts of a window the demo's host reads: the browser's own, or a stand-in in tests. */
type Win = {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  location: { origin: string };
  matchMedia: (query: string) => { matches: boolean };
  addEventListener: (type: "message", f: (e: MessageEvent) => void) => void;
  removeEventListener: (type: "message", f: (e: MessageEvent) => void) => void;
};

/** The demo's host in a browser window: it posts to the page that frames it, on this origin only. */
export const browserHost = (w: Win = window): Host => ({
  parent: w.parent,
  origin: w.location.origin,
  post: (m) => w.parent.postMessage(m, w.location.origin),
  embedded: !Object.is(w.parent, w),
  reduced: w.matchMedia("(prefers-reduced-motion: reduce)").matches,
  listen: (f) => {
    w.addEventListener("message", f);
    return () => w.removeEventListener("message", f);
  },
});

/** A moment the demo plays once when the parent cues it: from one minute of the night to another. */
export interface Play {
  from: number;
  to: number;
  /** The message that starts it, and the one the demo answers with when it's done. */
  cue: string;
  done: string;
  /** What a visitor would do at the moment, done for them when it plays (a moment that isn't a minute of the night). */
  act?: () => void;
  /** The page has played this one before (the piece was let go and framed again): it opens at its end. */
  settled?: boolean;
  /**
   * What a live piece's moment is about, as the piece marks it (`data-id`): the item it brings (shown first in the
   * piece's slice) or the row it changes. The piece lifts it while the rest dims, then settles.
   */
  focus?: string;
}

/** The arrival: the night's one call reaches Needs you as the morning comes. */
export const ARRIVAL: Play = { from: ARRIVE_FROM, to: MORNING, cue: "overhand:arrive", done: "overhand:arrived" };

// once played, a re-run of the effect (StrictMode, a remount) stays at its end instead of going back
let played = false;

const host0 = DEMO ? browserHost() : undefined;
// before followParent runs, the page shows the arrival's opening minute (or the morning, opened on its own)
let minutes = host0?.embedded && !host0.reduced ? ARRIVE_FROM : MORNING;
const listeners = new Set<() => void>();

/** Forgets the arrival and what the visitor did, so each test starts like a fresh page. */
export function resetDemo(): void {
  played = false;
  did.answered.clear();
  did.quietUntil = 0;
  did.autonomy.clear();
  did.plans = [];
}

/** The scripted clock: the whole dashboard reads time through `Date.now`, so the demo moves it there. */
if (DEMO) Date.now = () => clockAt(minutes);

/**
 * Pins the scripted clock at `m` minutes into the night, without moving the page: the design catalog (apps/design) shows
 * each sample at its own moment, so the times it reads ("3 min ago") match the state it shows.
 */
export function pinDemoClock(m: number): void {
  minutes = m;
}

export const demoClock = {
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  // a store's snapshot must be stable between reads: the live dashboard keeps its own clock (useNow), so this is 0 there.
  // Returning the real time made React re-render until it gave up whenever a render took longer than a millisecond.
  get: () => (DEMO ? clockAt(minutes) : 0),
};

/**
 * What the visitor did in this page's demo: questions answered, quiet mode, a project's autonomy. Kept in memory only
 * and laid over the scripted night, so a click lands like it would on a real daemon and a reload starts the night fresh.
 */
const did = {
  answered: new Set<string>(),
  quietUntil: 0,
  autonomy: new Map<string, Autonomy>(),
  /** Requests started from a sentence: each comes back at once as its agent's plan (a real one takes a pass). */
  plans: [] as { task: Assignment; plan: Finding }[],
  /** Names the visitor gave leads and work. */
  names: new Map<string, string>(),
  /** Ready-made leads the visitor started from a suggestion: on, and up with the work they were suggested for. */
  leads: [] as Lead[],
};

/**
 * The plan the demo's agent writes for a request, in the shape a real agent is asked for (PLAN_FIRST): a real one for
 * the sample request about Mobile app's invite page, and a plain one for anything else typed in the demo.
 */
const demoPlan = (project: string, text: string) =>
  (/invite/i.test(text)
    ? [
        "What changes:",
        '- The invite headline reads "Sam would love you at dinner on Saturday" instead of "You\'re invited".',
        '- The "I\'m in" button is bigger on phones, easy to tap with a thumb.',
        "- The faces of who's already coming sit right under the date, so it feels like a real get-together.",
        "What you'll see:",
        "- A preview link to try the new invite card on your phone and laptop.",
        "- Before-and-after screenshots on the pull request.",
      ]
    : [
        "What changes:",
        `- Only the screens and text in ${project} that "${text}" touches; everything else stays as it is.`,
        "What you'll see:",
        "- A preview link to try it, and before-and-after screenshots of each changed screen.",
      ]
  ).join("\n");

/** The state at the current scripted minute, with what the visitor did laid over it. */
export const demoState = (): DashboardState => {
  const s = STRESS ? stressed(nightAt(minutes)) : nightAt(minutes);
  return {
    ...s,
    clients: s.clients.map((c) => ({ ...c, autonomy: did.autonomy.get(c.name) ?? c.autonomy })),
    godmode: [
      ...s.godmode.map((l) => (did.answered.has(l.key) ? { ...l, waiting: false, inbox: null, open: false, ask: null } : l)),
      ...did.leads,
    ],
    names: Object.fromEntries(did.names),
    tickets: Object.fromEntries(
      Object.entries(s.tickets).map(([p, list]) => [
        p,
        typeof list === "string"
          ? list
          : list.map((t) => (did.answered.has(t.key) ? { ...t, labels: [...t.labels.filter((l) => l !== "needs-owner"), "agent"] } : t)),
      ]),
    ),
    governor: { ...s.governor, quietUntil: did.quietUntil > Date.now() ? did.quietUntil : s.governor.quietUntil },
    findings: [...did.plans.map((p) => p.plan), ...s.findings],
    assigned: [...did.plans.map((p) => p.task), ...s.assigned],
    // notes pinned on a preview: the PR's card says which round they became, and counts it once the agent has pushed
    prs: s.prs.map((p) => {
      const r = demoReviewRound(p.key);
      return r.round ? { ...p, reviewRound: r.round, fixes: r.pushed ? Math.max(p.fixes, r.round) : p.fixes } : p;
    }),
  };
};

/** The few actions the demo carries out (answers, quiet mode, a project's autonomy); undefined for the rest, which refuse. */
export function demoPost(url: string, body: Record<string, unknown>): unknown {
  const key = typeof body.key === "string" ? body.key : "";
  if (url === "/api/lead/answer" && key) return did.answered.add(key) && {};
  // the calls count is the sample week's (night.ts); what the page shows isn't recorded anywhere
  if (url === "/api/calls") return { fresh: 0 };
  // the app coming back into view asks for fresh reads: the sample night's are as fresh as they get
  if (body.auto === true) return { ok: true, skipped: true };
  if (url === "/api/ticket/answer" && key) {
    did.answered.add(key);
    const project = nightAt(minutes).clients.find((c) => key.startsWith(`${c.prefix}-`))?.name ?? "";
    return { done: did.autonomy.get(project) === "watch" ? "held" : "posted" };
  }
  if (url === "/api/quiet" && typeof body.hours === "number") {
    did.quietUntil = body.hours > 0 ? Date.now() + body.hours * 3_600_000 : 0;
    return { quietUntil: did.quietUntil };
  }
  // start an agent from a sentence: its plan lands in Needs you; Go ahead and Drop it take it away again
  if (url === "/api/assign" && body.plan === true && typeof body.project === "string" && typeof body.brief === "string") {
    const n = did.plans.length + 1;
    const prefix = nightAt(minutes).clients.find((c) => c.name === body.project)?.prefix ?? "TASK";
    const task: Assignment = {
      key: `${prefix}-${200 + n}`,
      project: body.project,
      title: body.brief,
      by: "dashboard",
      local: true,
      at: Date.now(),
    };
    const text = demoPlan(body.project, body.brief);
    const plan: Finding = {
      id: `demo-plan-${n}`,
      project: body.project,
      key: "",
      title: body.brief,
      text,
      post: "",
      from: "agent",
      at: Date.now(),
      task: task.key,
      plan: planPoints(text),
    };
    did.plans.unshift({ task, plan });
    return { key: task.key };
  }
  const planned = did.plans.find((p) => p.plan.id === body.id);
  if (planned && (url === "/api/assign" || url === "/api/finding/dismiss")) {
    did.plans = did.plans.filter((p) => p !== planned);
    return { ok: true, key: planned.task.key };
  }
  const named = NameSchema.safeParse(body);
  if (url === "/api/name" && named.success) {
    if (named.data.name) did.names.set(named.data.id, named.data.name);
    else did.names.delete(named.data.id);
    return {};
  }
  const kind = LEAD_WORK.find((k) => k === body.template);
  if (url === "/api/lead/template" && kind && typeof body.project === "string" && typeof body.name === "string") {
    const now = clockAt(minutes);
    did.leads.push({
      key: templateKey(body.project, kind),
      label: body.name,
      name: "",
      project: body.project,
      supervised: true,
      onDemand: true,
      watch: [kind],
      running: true,
      mine: true,
      since: now,
      stopped: false,
      reason: "",
      waiting: false,
      waitingLimit: false,
      nextAt: 0,
      account: "Sam",
      inbox: null,
      open: false,
      ask: null,
    });
    return {};
  }
  const a = AutonomySchema.safeParse(body.autonomy);
  if (url === "/api/settings/quick" && typeof body.project === "string" && a.success) return did.autonomy.set(body.project, a.data) && {};
  // review on the preview: a drawn page to pin on, the notes "sent", and the approval (the visitor is the PR's author)
  if (url.startsWith("/api/preview/") && key)
    return demoReviewPost(url, key, body, nightAt(minutes).prs.find((p) => p.key === key)?.fixes ?? 0);
  if (url === "/api/pr/ready" && key) return { ok: true, approved: false };
  // Suggest or report: the real draft, marked against the sample projects; Send refuses, so nothing leaves the demo
  if (url === "/api/feedback/preview") return demoFeedback(body);
  return demoSignInPost(url, body);
}

/** The demo's Preview: the same draft and firewall marks as the real one, on the sample night's projects and self-check. */
function demoFeedback(body: Record<string, unknown>): FeedbackPreview | undefined {
  const r = FeedbackRequestSchema.safeParse(body);
  if (!r.success) return undefined;
  const s = nightAt(minutes);
  const diag = { selfCheck: s.selfCheck, browser: "available", contract: "ok" as const, built: true, bun: "demo" };
  const d = {
    title: r.data.title,
    body: feedbackBody({
      kind: r.data.kind,
      words: plainWords,
      details: r.data.details,
      version: s.update.current || "demo",
      os: "demo",
      diagnostics: r.data.diagnostics ? diagnosticLines(diag) : undefined,
    }),
  };
  const marks = (t: string) => termHits(t, [NO_PROJECT], s.clients);
  return { ...d, hits: { title: marks(d.title), body: marks(d.body) }, via: "browser", login: "" };
}

/** The sample request the plan piece starts, as a visitor would type it in the command bar. */
export const PLAN_REQUEST = { project: "Mobile app", text: "make the invite page friendlier" } as const;

const still = (hm: string, focus?: string): Play => ({
  from: minutesOf(hm),
  to: minutesOf(hm),
  cue: "overhand:play",
  done: "overhand:played",
  focus,
});
const moment = (from: number, to: string, focus: string, act?: () => void): Play => ({ ...still(to, focus), from, act });

/**
 * Each live piece of the site (apps/web/src/piece.tsx) and the moment it plays once on `overhand:play`: the Mobile app
 * lead's question arrives, BOOK-88's red check goes green after its fix round, the plan for a sentence lands, Booking
 * app moves from Build to Drafts. The rest hold still at their minute and only lift what they're about.
 */
export const PIECE_PLAYS: Record<string, Play> = {
  needs: moment(ARRIVE_FROM, MOMENTS.call, "lead:mobile"),
  inflight: moment(minutesOf(MOMENTS.fixRound) - 1, MOMENTS.green, "BOOK-88"),
  // the request goes in the way the command bar sends it (startTask), without the toast a visitor would see
  plan: moment(minutesOf(MOMENTS.plan), MOMENTS.plan, "held:demo-plan-1", () =>
    demoPost("/api/assign", { project: PLAN_REQUEST.project, title: PLAN_REQUEST.text, brief: PLAN_REQUEST.text, plan: true }),
  ),
  rules: moment(MORNING, MOMENTS.morning, "Booking app", () =>
    demoPost("/api/settings/quick", { project: "Booking app", autonomy: "propose" }),
  ),
  cast: still(MOMENTS.started, "SHOP-142"),
  firstwin: still(MOMENTS.morning),
  // the night report's numbers count up again when it plays
  morning: still(MOMENTS.morning, "brief"),
  review: still(MOMENTS.review),
};

/**
 * A live piece's slice of a list: at most `max` items, the one its moment is about first (once it's there), then the
 * rest in the dashboard's own order. The whole list stays one click away, in the live demo.
 */
export function pieceSlice<T>(list: readonly T[], max: number, isFocus: (x: T) => boolean): T[] {
  return [...list.filter(isFocus), ...list.filter((x) => !isFocus(x))].slice(0, max);
}

/**
 * Runs the demo for its parent page: opens at `play`'s first minute (at its end, its `act` done, when reduced motion is
 * on, nothing frames it or the page has played it before), says it's ready, and plays the moment once on its cue.
 * Nothing else from the parent moves it. Embedded, it keeps the appearance "system" (its choices live in memory,
 * app/store.ts), so it is light or dark with the site around it.
 */
export function followParent(qc: QueryClient, key: readonly unknown[], play = ARRIVAL, host = browserHost()): () => void {
  // what the moment does, done once per page however often this runs
  const end = () => {
    minutes = play.to;
    if (played) return;
    played = true;
    play.act?.();
  };
  if (played || play.settled || host.reduced || !host.embedded) end();
  else minutes = play.from;
  qc.setQueryData(key, demoState());
  const stop = host.listen((e) => {
    const d = e.data;
    if (
      e.source !== host.parent ||
      e.origin !== host.origin ||
      typeof d !== "object" ||
      d === null ||
      !("type" in d) ||
      d.type !== play.cue ||
      played
    )
      return;
    const moved = minutes !== play.to;
    end();
    qc.setQueryData(key, demoState());
    if (moved) for (const f of listeners) f();
    host.post({ type: play.done });
  });
  host.post({ type: "overhand:ready" });
  return stop;
}

export const DEMO_REFUSAL = "This is a demo: install Overhand to do this for real.";
