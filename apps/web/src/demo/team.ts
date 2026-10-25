/**
 * The demo's sample team (fictional people): Sam's workspace with three teammates, as the daemon hands a team to the
 * dashboard (`DashboardState.team`). Everyone works on the sample projects; Robin and Kai both have BOOK-88's pull
 * request open; Noor is away. Built only from the script below, like the rest of the night, so the Team view, its map
 * and the header's facepile render on sample data in the demo and the design catalog.
 */
import type { Presence, TeamEvent, TeamState } from "@overhand/contract";

/** The people, by user id: their email names them on screen ("robin@…" is Robin). */
const PEOPLE = [
  { user: "sam", email: "sam@example.com", role: "owner" },
  { user: "robin", email: "robin@example.com", role: "admin" },
  { user: "kai", email: "kai@example.com", role: "member" },
  { user: "noor", email: "noor@example.com", role: "member" },
] as const;

/** Who owns each sample project and who backs them up. */
const OWNERS = [
  { project: "Online shop", owner: "sam", backup: "robin" },
  { project: "Booking app", owner: "robin", backup: "sam" },
  { project: "Company website", owner: "kai", backup: "sam" },
  { project: "Mobile app", owner: "sam", backup: null },
];

const BOOK88 = { item: "pr:BOOK-88", label: "PR BOOK-88" };

/** What each online person's dashboard says about them. Noor is away: no presence. */
const presence = (sam: number): Record<string, Presence> => ({
  sam: {
    k: "presence",
    agents: sam,
    quiet: false,
    viewing: null,
    claims: [],
    projects: [
      { name: "Online shop", state: "needs", agents: Math.min(sam, 1) },
      { name: "Mobile app", state: "idle", agents: 0 },
    ],
  },
  robin: {
    k: "presence",
    agents: 2,
    quiet: false,
    viewing: BOOK88,
    claims: [BOOK88],
    projects: [
      { name: "Booking app", state: "working", agents: 2 },
      { name: "Online shop", state: "idle", agents: 0 },
    ],
  },
  kai: {
    k: "presence",
    agents: 1,
    quiet: true,
    viewing: BOOK88,
    claims: [],
    projects: [
      { name: "Company website", state: "working", agents: 1 },
      { name: "Booking app", state: "red", agents: 0 },
    ],
  },
});

/** The team's durable feed through the night, at its clock times. */
const LOG = (at: (hm: string) => number): TeamEvent[] => [
  {
    k: "result",
    project: "Company website",
    title: "Staff-only pages for the booking team",
    outcome: "opened",
    pr: null,
    by: "kai",
    at: at("23:52"),
    seq: 1,
  },
  {
    k: "question",
    id: "q-book-slots",
    project: "Booking app",
    lead: "Booking app agent",
    text: "Should slow slot lookups show a retry button, or wait quietly?",
    fallback: "Waits quietly",
    by: "robin",
    at: at("01:20"),
    seq: 2,
  },
  { k: "answer", id: "q-book-slots", text: "A retry button, please.", by: "sam", at: at("01:34"), seq: 3 },
  {
    k: "handoff",
    id: "h-shop-receipts",
    to: "sam",
    project: "Online shop",
    title: "Receipts show the wrong currency for EU orders",
    key: "SHOP-151",
    note: "Yours if you have a minute; my agents are on Booking app tonight.",
    by: "robin",
    at: at("05:10"),
    seq: 4,
  },
  {
    k: "comment",
    id: "c-fern88",
    item: BOOK88.item,
    text: "The fixes look right; @Sam can you merge in the morning?",
    mentions: ["sam"],
    by: "kai",
    at: at("06:40"),
    seq: 5,
  },
  {
    k: "result",
    project: "Booking app",
    title: "Booking times out with many slots",
    outcome: "opened",
    pr: null,
    by: "robin",
    at: at("01:58"),
    seq: 6,
  },
];

/** The team at `now`: what has happened by then, with Sam's own agent count (`agents`). */
export function teamAt(now: number, at: (hm: string) => number, agents: number): TeamState {
  const live = presence(agents);
  return {
    roster: {
      team: { id: "team-sample", name: "Sam's studio" },
      me: "sam",
      role: "owner",
      seats: 4,
      over: null,
      members: PEOPLE.map((p) => ({ ...p, joinedAt: at("21:00") - 30 * 864e5, seated: true })),
      invites: [],
      projects: OWNERS,
    },
    connected: true,
    online: Object.fromEntries(Object.entries(live).map(([user, p]) => [user, { at: now, presence: p }])),
    log: LOG(at)
      .filter((e) => e.at <= now)
      .sort((a, b) => a.at - b.at),
    problem: "",
    sharePrs: false,
  };
}
