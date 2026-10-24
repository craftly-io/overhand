/** The daemon's state.json and the JSON file helpers. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Corner,
  type CurrentRun,
  CurrentRunSchema,
  type Proof,
  type SplitPart,
  type Ticket,
  type PendingTicket as WirePendingTicket,
  wasId,
} from "@overhand/contract";
import { OPS } from "./env";
import { report } from "./notify";

export interface TrackedPr {
  url: string;
  host: "github" | "bitbucket";
  repo: string;
  number: number;
  branch: string;
  mainRepo: string;
  repoPath: string;
  seen: string;
  fixes: number;
  extra?: string; // feedback that arrived via Slack or the Review drawer, consumed by the next fix round
  draft?: boolean; // opened as a draft (propose), until someone marks it ready from the dashboard
  openedAt?: number; // for the scorecard's time to merge; PRs tracked before it have none
  changes?: number; // fix rounds that answered a "changes requested" review
  base?: string; // the branch it targets; PRs tracked before it have none
  corners?: Corner[]; // corners its diff may have cut, as of the last push (corners.ts)
  cornersPosted?: string[]; // fingerprints of the findings already listed in a PR comment
  proof?: Proof; // what the agent ran and checked, as of the last push (proof.ts)
  preview?: string; // where to see it running: its deploy preview (preview.ts)
  previewSha?: string; // the head commit that preview was found for
  /** On a Ship project: GitHub's auto-merge is on, or why it waits for your merge, as of head commit `head` (ship.ts). */
  ship?: { on: boolean; why: string; head: string; final: boolean };
  /** The lead that opened it (lead-prs.ts): its lead answers its reviews and checks, so Overhand runs no fix rounds on it. */
  lead?: string;
  /** A lead PR's head commit when its proof was read: a different head has no proof until a later run vouches for it. */
  proofHead?: string;
  /** When a lead PR's proof was cleared (its auto-merge went off for a lead to start, or its head moved on). */
  proofOff?: number;
}

/** A pending ticket as stored: the dashboard's PendingTicket without its id, which is the key it's stored under. */
type PendingTicket = Omit<WirePendingTicket, "id">;

export interface State {
  attempts: Record<string, number>;
  prs: Record<string, TrackedPr>;
  nextAccount: number;
  slackCursor: number;
  /** The Slack inbox's last read found these projects' Slack signed out, on this account's folder; gone once it reads again. */
  slackSignIn?: { clients: string[]; account: string };
  seen: string[];
  pending: Record<string, PendingTicket>;
}

/** state.json, with defaults for anything missing. */
export function loadState(): State {
  const p = join(OPS, "state.json");
  const empty: State = { attempts: {}, prs: {}, nextAccount: 0, slackCursor: 0, seen: [], pending: {} };
  return { ...empty, ...readJson<Partial<State>>(p, {}) };
}

/** Writes state.json atomically. */
/** Open tickets per client (or the tracker's error), refreshed by the dashboard; leads read it to decide when to wake. */
export const ticketCache: { at: number; data: Record<string, Ticket[] | string> } = { at: 0, data: {} };

// Proposed splits live in their own file: the work loop holds State in memory for a whole pass, and saving it would
// bring back a split the dashboard had just accepted.
const SPLITS_FILE = join(OPS, "splits.json");
/** Ticket splits the agent proposed, by ticket key. */
export const loadSplits = (): Record<string, SplitPart[]> => readJson<Record<string, SplitPart[]>>(SPLITS_FILE, {});
/** Saves the proposed splits atomically. */
export function saveSplits(s: Record<string, SplitPart[]>): void {
  writeJsonAtomic(SPLITS_FILE, s);
}

// Names you gave leads and work (contract leadId/workId) live in their own file: they win over every name Overhand
// makes, for as long as you keep them.
const NAMES_FILE = join(OPS, ".names.json");
/** Your own names for leads and work, by id. */
export const loadNames = (): Record<string, string> => readJson<Record<string, string>>(NAMES_FILE, {});
/**
 * Keeps your name for `id`; an empty name goes back to Overhand's. Your previous name joins its short history under
 * wasId(id), so log lines written under it still name the same thing (its label and config name always do).
 */
export function saveName(id: string, name: string): void {
  const { [id]: old = "", [wasId(id)]: was = "", ...rest } = loadNames();
  const history = [old, ...was.split("\n")].filter((n, i, all) => n && n !== name && all.indexOf(n) === i).slice(0, 5);
  writeJsonAtomic(NAMES_FILE, {
    ...rest,
    ...(name ? { [id]: name } : {}),
    ...(history.length ? { [wasId(id)]: history.join("\n") } : {}),
  });
}

// What you did in the Review drawer waits in its own file for the same reason: notes for the next fix round, and PRs you
// marked ready. The work pass takes both into State.
const REVIEW_FILE = join(OPS, ".pr-review.json");
/** Review notes by ticket key, and the keys of drafts marked ready, not yet taken by a work pass. */
export interface PrReviewQueue {
  notes: Record<string, string>;
  ready: string[];
}
/** The review queue as it stands (the dashboard reads it so a draft you marked ready stops asking for you at once). */
export const loadPrReview = (): PrReviewQueue => ({ notes: {}, ready: [], ...readJson<Partial<PrReviewQueue>>(REVIEW_FILE, {}) });
/** Saves the review queue atomically. */
export const savePrReview = (q: PrReviewQueue): void => writeJsonAtomic(REVIEW_FILE, q);
/** The review queue, emptied: the work pass applies it to State once. */
export function takePrReview(): PrReviewQueue {
  const q = loadPrReview();
  if (Object.keys(q.notes).length || q.ready.length) savePrReview({ notes: {}, ready: [] });
  return q;
}

const CURRENT_FILE = join(OPS, ".current.json");
/** Headless runs in progress, from .current.json; runs whose process is gone (a crashed daemon) are dropped. */
export function currentRuns(): CurrentRun[] {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // before parallel runs the file held one run, not a list
  const raw = [readJson<unknown>(CURRENT_FILE, [])].flat();
  return raw.flatMap((r) => {
    const p = CurrentRunSchema.safeParse(r);
    return p.success && alive(p.data.pid) ? [p.data] : [];
  });
}
/** Saves the runs in progress atomically. */
export function saveCurrentRuns(runs: CurrentRun[]): void {
  writeJsonAtomic(CURRENT_FILE, runs);
}

export function saveState(s: State): void {
  writeJsonAtomic(join(OPS, "state.json"), s);
}

/** Parsed JSON file, or `fallback` when it's missing or corrupt (reported, so a bad file never stops the daemon). */
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    report(`⚠ ${path} is unreadable (${e instanceof Error ? e.message : String(e)}); using defaults`);
    return fallback;
  }
}

/** Write then rename, so a crash mid-write leaves the previous file instead of half a file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
