/**
 * The demo's proof and work reports: what each agent PR's run log showed (BOOK-88's fix round skipped a test, so its
 * proof says so), and a week's report for whichever project is asked. Shapes from the contract; numbers made up.
 */
import { ESTIMATE_METHOD, type Proof, type WorkReport } from "@overhand/contract";
import { samplePr } from "./links";

const base: Proof = {
  at: 0,
  transcript: true,
  checks: [
    { kind: "test", command: "pnpm test", ok: true, summary: "Tests  48 passed (48)", skipped: 0 },
    { kind: "typecheck", command: "pnpm tsc --noEmit", ok: true, summary: "", skipped: 0 },
    { kind: "lint", command: "pnpm lint", ok: true, summary: "", skipped: 0 },
  ],
  files: 4,
  added: 86,
  removed: 12,
  areas: ["api", "web"],
  ui: false,
  docsOnly: false,
  verified: "Ran the booking tests and booked a slot against the local API.",
  shots: { before: false, after: false, note: "" },
  gaps: [],
};

/** The first win's: one new test file, and the repo's tests run and passing. */
const firstWin: Proof = {
  ...base,
  checks: [{ kind: "test", command: "npm test", ok: true, summary: "Tests  53 passed (53)", skipped: 0 }],
  files: 1,
  added: 38,
  removed: 0,
  areas: ["src"],
  verified: "Ran the whole test suite: the 5 new tests and the 48 already there pass.",
};

/** A demo PR's proof; BOOK-88's fix round skipped a test, so it carries that gap. */
export function demoProof(key: string): Proof {
  if (key === "APP-0") return firstWin;
  if (key !== "BOOK-88") return base;
  return {
    ...base,
    checks: [{ kind: "test", command: "pnpm test api/slots.test.ts", ok: true, summary: "Tests  6 passed | 1 skipped (7)", skipped: 1 }],
    files: 2,
    added: 14,
    removed: 9,
    areas: ["api"],
    verified: "Reran the slot tests.",
    gaps: ["tests skipped: 1 (pnpm test api/slots.test.ts)"],
  };
}

const day = (from: number, n: number, h: number) => from + n * 864e5 + h * 3_600_000;

/** A week of work for any project, from the range the dashboard asked for. */
export function demoReport(project: string, from: number, to: number): WorkReport {
  const prefix = project.slice(0, 4).toUpperCase();
  const url = (n: number) => samplePr(`${project.toLowerCase()}/app`, n);
  return {
    project,
    from,
    to,
    ticketsDone: [`${prefix}-81`, `${prefix}-84`, `${prefix}-88`],
    prs: [
      { key: `${prefix}-81`, url: url(212), state: "merged", openedAt: day(from, 0, 10), doneAt: day(from, 1, 9), fixes: 0, estMin: 64 },
      { key: `${prefix}-84`, url: url(215), state: "merged", openedAt: day(from, 2, 3), doneAt: day(from, 2, 15), fixes: 1, estMin: 112 },
      { key: `${prefix}-88`, url: url(219), state: "merged", openedAt: day(from, 3, 2), doneAt: day(from, 4, 11), fixes: 1, estMin: 38 },
      { key: `${prefix}-90`, url: url(223), state: "open", openedAt: day(from, 5, 4), doneAt: 0, fixes: 0, estMin: 0 },
    ],
    opened: 4,
    merged: 3,
    runs: 11,
    agentMinutes: 197,
    cost: 14.62,
    // the sample project runs on Sam's plan and the clinic's Bedrock: the Bedrock share is the billed part
    billed: 4.18,
    billings: ["plan", "cloud"],
    fixRounds: 2,
    estimate: { minutes: 214, method: ESTIMATE_METHOD },
    failures: [
      {
        key: `${prefix}-84`,
        at: day(from, 1, 23),
        outcome: "failed",
        reason: "the dev database wasn't seeded, so the tests couldn't start",
        fixedBy: "a later run opened a pull request that merged",
      },
      { key: `${prefix}-92`, at: day(from, 6, 1), outcome: "timeout", reason: "", fixedBy: "" },
    ],
    open: [
      { key: `${prefix}-90`, url: url(223), what: "Pull request open, waiting for review" },
      { key: `${prefix}-92`, url: "", what: "failed, not fixed yet" },
    ],
    byTicket: [],
  };
}
