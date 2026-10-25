import { type BriefOption, type CardButton, type DashboardState, isBilled } from "@overhand/contract";
import type { WordKey, Words } from "@overhand/themes";
import type { AssignOffer } from "./assign";
import { fmt } from "./format";
import { budgetApplies } from "./spend";

/** Each card button's words; Allow until names the time. */
export const BUTTON_WORDS: Record<CardButton, WordKey> = {
  stop: "cardStop",
  "allow-until": "cardAllowUntil",
  "always-allow": "cardAlwaysAllow",
  connect: "cardConnect",
  "one-at-a-time": "cardOneAtATime",
  "close-pr": "cardClosePr",
  keep: "cardKeep",
  pause: "cardPause",
  show: "cardShow",
  "more-time": "cardMoreTime",
  resend: "cardResend",
  drop: "cardDrop",
  quiet: "cardQuietMode",
};

const LINK: Record<Extract<BriefOption, { do: "link" }>["what"], WordKey> = {
  ticket: "openTicket",
  pr: "decOpenPr",
  review: "decOpenToReview",
  merge: "decOpenToMerge",
  ci: "decOpenCi",
  error: "decOpenError",
};

const DRAWER: Record<Extract<BriefOption, { do: "drawer" }>["drawer"], WordKey> = {
  ticket: "decReviewSplit",
  review: "review",
  lead: "decWrite",
  sweep: "decOpenSweep",
  settings: "decOpenSettings",
  crew: "decOpenCrew",
  health: "decOpenHealth",
};

/** Longer than this, an answer is too long for a button: it gets a short label and its words show beside it. */
const ANSWER_LABEL_MAX = 48;

/** An answer whose words are too long for its button: the words, to show as text beside it; null when they fit. */
export function answerDetail(o: BriefOption): string | null {
  return (o.do === "answer" || o.do === "reply") && o.text.length > ANSWER_LABEL_MAX ? o.text : null;
}

/** The words on an option's button; an action card's buttons are filled from its facts. */
export function optionLabel(o: BriefOption, w: Words, s?: Pick<DashboardState, "control">): string {
  switch (o.do) {
    case "answer":
    case "reply":
      // a paragraph-long default or reply makes a blob of a button: say what it does, and show the words beside it
      if (answerDetail(o)) return o.id === "answer-default" ? w.decGoDefault : w.decSendThis;
      return fmt(w.decAnswer, { text: o.text });
    case "assign":
      // a plan goes ahead; a stopped run tries again; a ticket or a held finding is assigned as it is; a task made from a
      // red build or an error is a fix
      return o.id === "go" ? w.planGo : o.id === "retry" ? w.signInRetry : o.key || o.finding ? w.assignAgent : w.decAssignFix;
    case "ready":
      return w.reviewMarkReady;
    case "link":
      return w[LINK[o.what]];
    case "drawer":
      // a held finding's or a guard block's ticket opens like any other ticket; a signed-out run's account signs in there
      if (o.id === "signin") return w.setupSignIn;
      return o.drawer === "ticket" && o.id !== "split" ? w.openTicket : w[DRAWER[o.drawer]];
    case "card":
      return fmt(w[BUTTON_WORDS[o.button]], s?.control.cards.find((c) => c.id === o.card)?.facts ?? {});
    case "quiet":
      return fmt(w.decQuiet, { h: o.hours });
    case "post":
      return w.heldPost;
    case "dismiss":
      return o.what === "lead" ? w.dismissQuestion : o.id === "drop" ? w.planDrop : o.id === "close" ? w.close : w.heldDismiss;
    case "snooze":
      return fmt(w.decSnooze, { h: o.hours });
    case "replan":
      return o.id === "detail" ? w.failedMoreDetail : w.planChange;
    case "reopen":
      return w.failedReopen;
    case "organise":
      return o.label;
  }
}

/** What running an option needs: the dashboard's own actions, nothing else (merging is never one of them). */
export interface OptionRunner {
  leadAnswer: (key: string, text: string, kind?: "answer" | "elsewhere" | "dismiss") => Promise<void>;
  ticketAnswer: (key: string, text: string) => Promise<void>;
  assign: (offer: AssignOffer) => Promise<void>;
  prReady: (key: string) => Promise<void>;
  cardAct: (card: string, button: CardButton) => Promise<void>;
  quiet: (hours: number) => Promise<void>;
  heldPost: (id: string, key: string) => Promise<void>;
  heldDismiss: (id: string) => Promise<void>;
  snooze: (item: string, hours: number) => Promise<void>;
  /** Drops a plan and opens the command bar with its request, to say it differently. */
  replan: (finding: string, project: string, text: string) => Promise<void>;
  /** Opens a stopped run's pull request from its pushed branch. */
  reopenPr: (finding: string) => Promise<void>;
  /** Acts on an organising suggestion (its id without `organise:`). */
  organise: (suggestion: string, action: "apply" | "dismiss" | "preview") => Promise<void>;
  openDrawer: (
    d: { kind: "ticket" | "review" | "lead"; key: string } | { kind: "sweep" | "crew" | "health" } | { kind: "settings"; tab: string },
  ) => void;
  openLink: (url: string) => void;
}

/** Runs one option of the brief on `item` with the dashboard's actions. */
export function runOption(o: BriefOption, item: string, r: OptionRunner): Promise<void> | undefined {
  switch (o.do) {
    case "answer":
      return r.leadAnswer(o.lead, o.text);
    case "reply":
      return r.ticketAnswer(o.key, o.text);
    case "assign":
      return r.assign(
        o.finding
          ? { project: o.project, id: o.finding }
          : { project: o.project, key: o.key || undefined, title: o.title || undefined, brief: o.brief || undefined },
      );
    case "ready":
      return r.prReady(o.key);
    case "link":
      r.openLink(o.url);
      return undefined;
    case "drawer":
      if (o.drawer === "ticket" || o.drawer === "review" || o.drawer === "lead") r.openDrawer({ kind: o.drawer, key: o.key });
      else if (o.drawer === "settings") r.openDrawer({ kind: "settings", tab: o.tab });
      else r.openDrawer({ kind: o.drawer });
      return undefined;
    case "card":
      return r.cardAct(o.card, o.button);
    case "quiet":
      return r.quiet(o.hours);
    case "post":
      return r.heldPost(o.finding, o.key);
    case "dismiss":
      return o.what === "lead" ? r.leadAnswer(o.target, "", "dismiss") : r.heldDismiss(o.target);
    case "snooze":
      return r.snooze(item, o.hours);
    case "replan":
      return r.replan(o.finding, o.project, o.text);
    case "reopen":
      return r.reopenPr(o.finding);
    case "organise":
      return r.organise(o.suggestion, o.action);
  }
}

/** Where an insight's next step goes. */
type InsightGo =
  | { kind: "link"; url: string }
  | { kind: "drawer"; drawer: "overdrive" }
  | { kind: "work"; project: string }
  | { kind: "settings"; tab: string }
  | { kind: "plan" };

/** One thing worth knowing where a pane would otherwise be empty, and the one next step it suggests. */
export interface Insight {
  text: string;
  go: { label: string; to: InsightGo } | null;
}

/** The place an empty pane sits in. */
export type Surface = "now" | "work" | "crew" | "health";

type InsightKind = "red" | "idle" | "noQueue" | "quiet" | "budget" | "green";

/** Which insights each place prefers, best first. */
const ORDER: Record<Surface, readonly InsightKind[]> = {
  now: ["red", "idle", "quiet", "budget", "green"],
  work: ["noQueue", "idle", "quiet", "red"],
  crew: ["idle", "noQueue", "quiet", "budget"],
  health: ["red", "budget", "green"],
};

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The insight for an empty pane in `surface`: a red build, agents idle with work queued, nothing queued, a quiet
 * project, the day's budget headroom, or all green. Null when none applies. Pure.
 */
export function insightFor(surface: Surface, s: DashboardState, w: Words): Insight | null {
  const tickets = Object.values(s.tickets).flatMap((t) => (Array.isArray(t) ? t : []));
  const queued = tickets.filter((t) => t.labels.includes(s.labels.queue)).length;
  const moving = [s.labels.queue, s.labels.working, s.labels.review];
  const busy = new Set(
    Object.entries(s.tickets).flatMap(([c, ts]) =>
      Array.isArray(ts) && ts.some((t) => moving.some((l) => t.labels.includes(l))) ? [c] : [],
    ),
  );
  for (const r of s.runs) if (r.project) busy.add(r.project);
  const make: Record<InsightKind, () => Insight | null> = {
    red: () => {
      const c = s.status.ci.find((x) => x.state === "fail");
      if (!c) return null;
      return {
        text: fmt(w.insRed, { repo: c.repo, failing: c.failing.join(", ") || c.branch }),
        go: c.url ? { label: w.insRedGo, to: { kind: "link", url: c.url } } : null,
      };
    },
    idle: () =>
      !s.running.length && queued
        ? { text: fmt(w.insAgentsIdle, { n: queued }), go: { label: w.insAgentsIdleGo, to: { kind: "drawer", drawer: "overdrive" } } }
        : null,
    noQueue: () => (!queued && !s.running.length ? { text: w.insNoQueue, go: { label: w.insNoQueueGo, to: { kind: "plan" } } } : null),
    quiet: () => {
      const c = s.clients.find((x) => !busy.has(x.name));
      return c ? { text: fmt(w.insQuiet, { project: c.name }), go: { label: w.insQuietGo, to: { kind: "work", project: c.name } } } : null;
    },
    budget: () => {
      // the budget caps billed money only: with every account on a plan or this computer there's no headroom to tell
      if (!budgetApplies(s)) return null;
      if (s.budgetUsd <= 0)
        return {
          text: fmt(w.insBudgetNone, { spent: money(s.budgetSpent) }),
          go: { label: w.insBudgetGo, to: { kind: "settings", tab: "safety" } },
        };
      const billedBy = new Set(s.accounts.filter((a) => isBilled(a.billing) || !a.billingSure).map((a) => a.name));
      const paid = s.runs.filter((r) => r.cost > 0 && billedBy.has(r.account ?? ""));
      const avg = paid.length ? s.budgetSpent / paid.length : 0;
      if (!avg || s.budgetSpent >= s.budgetUsd) return null;
      return {
        text: fmt(w.insBudget, {
          spent: money(s.budgetSpent),
          cap: money(s.budgetUsd),
          n: Math.floor((s.budgetUsd - s.budgetSpent) / avg),
        }),
        go: null,
      };
    },
    green: () =>
      s.status.ci.some((c) => c.state === "fail") || (Array.isArray(s.status.sentry) && s.status.sentry.some((e) => e.isNew))
        ? null
        : { text: w.insAllGreen, go: null },
  };
  for (const k of ORDER[surface]) {
    const i = make[k]();
    if (i) return i;
  }
  return null;
}
