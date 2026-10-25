/**
 * The first win in plain words: the steps its card ticks through, what it took and cost, and its proof in one sentence.
 * Pure, from the facts the dashboard already has (the win's own record and its PR's proof).
 */
import { type CheckKind, type FirstWin, isBilled, type Proof, WIN_STEPS, type WinStep } from "@overhand/contract";
import type { WordKey, Words } from "@overhand/themes";
import { and, fmt, money, uptime } from "./format";

/** Each step's words on the card. */
export const STEP_WORDS = {
  read: "winStepRead",
  change: "winStepChange",
  checks: "winStepChecks",
  pr: "winStepPr",
} as const satisfies Record<WinStep, WordKey>;

/** Done: a pull request is up, or a watch project's report is in. */
export const winDone = (win: FirstWin): boolean => win.state === "pr" || win.state === "report";

/** The card's checklist: each step done, the one it's on, or still to come. A run that has just started is reading. */
export function stepStates(step: WinStep | undefined): { step: WinStep; at: "done" | "now" | "next" }[] {
  const i = WIN_STEPS.indexOf(step ?? "read");
  return WIN_STEPS.map((s, j) => ({ step: s, at: j < i ? "done" : j === i ? "now" : "next" }));
}

/** What its cost means, by how the account is paid for; "" when nothing is known. */
function costWords(win: FirstWin, w: Words): string {
  const cost = money(win.cost);
  if (win.billing === "local") return w.winCostLocal;
  if (win.billing && isBilled(win.billing)) return fmt(w.winCostBilled, { cost });
  if (win.billing === "plan") return win.cost > 0 ? fmt(w.winCostPlan, { cost }) : w.winCostIncluded;
  return win.cost > 0 ? fmt(w.runApiPrice, { cost }) : "";
}

/** "2 min · about $0.30 of your plan": how long the first win took and what it cost, from its run's record; "" before it ran. */
export function winSpent(win: FirstWin, w: Words): string {
  if (!win.since) return "";
  return [uptime(Math.max(60, (win.at - win.since) / 1000)), costWords(win, w)].filter(Boolean).join(" · ");
}

/** "1 file, +31 −0": how big the change is. */
export const changedText = (p: Proof, w: Words): string =>
  fmt(p.files === 1 ? w.proofChangedOne : w.proofChangedText, { n: p.files, add: p.added, del: p.removed });

const KIND_WORDS = {
  test: "proofKindTest",
  typecheck: "proofKindTypecheck",
  lint: "proofKindLint",
  build: "proofKindBuild",
} as const satisfies Record<CheckKind, WordKey>;

/**
 * The proof in one sentence a newcomer reads: "The tests and the type check ran and passed.", what failed, or that
 * nothing ran. "" when the run left no log to read (the proof says so itself).
 */
export function proofLine(p: Proof, w: Words): string {
  if (!p.transcript) return "";
  if (!p.checks.length) return w.proofRanNone;
  const what = (kinds: CheckKind[]) => and([...new Set(kinds)].map((k) => w[KIND_WORDS[k]]));
  const failed = p.checks.filter((c) => !c.ok).map((c) => c.kind);
  if (failed.length) return fmt(w.proofRanFailed, { what: what(failed) });
  const all = what(p.checks.map((c) => c.kind));
  return fmt(w.proofRanPassed, { what: `${all.charAt(0).toUpperCase()}${all.slice(1)}` });
}
