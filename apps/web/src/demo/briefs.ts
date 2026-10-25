/**
 * The demo's decision cards: the same facts-only brief the daemon builds, phrased the way an agent account would for the
 * items the night puts in Needs you. Everything else shows its facts alone, as it does when no account is free.
 */
import { type Brief, type DashboardState, factsBrief, type MoreFacts, withChoices } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { demoState } from "./demo";
import { samplePr } from "./links";

/** What the tracker says beyond the dashboard: the agent's question on the ticket. */
const MORE: Record<string, MoreFacts> = {
  "ticket:SHOP-151": {
    description: "The card payment service's v2 API is retired on 30 November. Move checkout and refunds to v3.",
    comments: [
      "Checkout moved to v3 on the branch; tests pass.",
      "In v3 a partial refund settles in 1–3 days instead of at once. Should the order page show it as pending until it settles, or as refunded straight away like today?",
    ],
  },
};

type Phrased = Pick<Brief, "what" | "why" | "recommend"> & { choices?: string[] };

/** How an agent account phrased each one from its facts. */
const PHRASED: Record<string, Phrased> = {
  "ticket:SHOP-151": {
    what: "SHOP-151 needs your call on how partial refunds look after the payment upgrade.",
    why: "In v3 partial refunds settle in 1–3 days; the agent won't choose what customers see on its own.",
    recommend: {
      option: "choice-1",
      reason: "Pending until it settles matches the bank statement, so fewer customers write to support.",
      confidence: "medium",
    },
    choices: ["Show it as pending until it settles", "Show it as refunded straight away"],
  },
  "pr:BOOK-88": {
    what: "BOOK-88's fix for the 9am slowdown skips the test that proves the slot cache expires.",
    why: "The test that checks old time slots expire is switched off, so one slot could be booked twice.",
    recommend: {
      option: "review",
      reason: "Send it back unless switching the test off was on purpose.",
      confidence: "high",
    },
  },
  "lead:mobile": {
    what: "The Mobile app lead asks whether guest reminders go by email, push, or both.",
    why: "It's a product call it won't make alone; if you don't answer, it builds both.",
    recommend: {
      option: "answer-default",
      reason: "Both reaches guests who never installed the app; email can be turned off later.",
      confidence: "medium",
    },
    choices: ["Push only for now", "Email only"],
  },
  "pr:WEB-31": {
    what: "WEB-31's draft PR adds the bookings spreadsheet download; every check passes.",
    why: "Company website runs on propose: the PR stays a draft until you mark it ready.",
    recommend: { option: "review", reason: "A 3-file change with tests: a quick read, then Mark ready.", confidence: "high" },
  },
  [`review:${samplePr("example/booking-desk", 214)}`]: {
    what: "A teammate's PR makes the front-desk calendar remember its last view.",
    why: "It's been waiting on your review since 22:15; it can't merge without one.",
    recommend: { option: "open-pr", reason: "Small UI change, checks green: a five-minute review unblocks it.", confidence: "medium" },
  },
  "errors:Booking app": {
    what: "Slot lookups time out on Booking app's booking page for 37 people.",
    why: "Booking a slot takes over 5 seconds and gives up; new since 00:58.",
    recommend: {
      option: "open-error-0",
      reason: "BOOK-88 already fixes this: it's the same slow slot lookup.",
      confidence: "medium",
    },
  },
};

/**
 * `GET /api/brief?id=` in the demo: the facts at the scripted minute; with `explain` (Explain pressed), phrased where
 * the night has a phrasing.
 */
export function demoBrief(id: string, s: DashboardState = demoState(), explain = false): Brief | undefined {
  const b = factsBrief(s, id, MORE[id] ?? {}, Date.now(), plainWords);
  if (!b) return undefined;
  const p = explain ? PHRASED[id] : undefined;
  if (!p) return b;
  const options = withChoices(b, p.choices ?? []);
  const recommend = options.some((o) => o.id === p.recommend.option) ? p.recommend : b.recommend;
  return { ...b, what: p.what, why: p.why, recommend, options, source: "agent", hash: "demo" };
}
