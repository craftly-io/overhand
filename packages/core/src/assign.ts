/**
 * Assigning an agent on a watch or propose project, and what Overhand holds for you there instead of posting: tickets
 * you assigned (assigned.json) run at the project's `assignedAutonomy`; findings (findings.json) are reports and comments
 * an agent or the Slack inbox would have posted on a watch project, shown on the dashboard until you act on them.
 */
import { join } from "node:path";
import { type Assignment, buildsItself, type Finding } from "@overhand/contract";
import { runAs } from "./autonomy";
import type { Client } from "./config";
import { CLIENTS, OPS } from "./env";
import { readJson, writeJsonAtomic } from "./state";

/**
 * An assignment as stored: a task with no ticket keeps its brief, and `queued` until a work pass picks it up. `plan`: a
 * task you started from a sentence, whose next pass only plans (read-only) until you go ahead.
 */
export interface StoredAssignment extends Assignment {
  brief: string;
  queued: boolean;
  plan?: boolean;
}

/** What a planning pass is told on top of the request: plan it in plain words, change nothing. */
export const PLAN_FIRST = [
  "Plan first, change nothing. Write for someone who doesn't read code, in exactly this shape:",
  "What changes:",
  "- 2 to 4 short points, one change each",
  "What you'll see:",
  "- 1 or 2 short points: what they can check when it's done",
].join("\n");

const ASSIGNED_FILE = (): string => join(OPS, "assigned.json");
const FINDINGS_FILE = (): string => join(OPS, "findings.json");

/** Assignments by key. */
export const loadAssignments = (): Record<string, StoredAssignment> => readJson<Record<string, StoredAssignment>>(ASSIGNED_FILE(), {});

/** Rewrites assignments in one synchronous step (the dashboard and the work pass both write them). */
export function editAssignments(edit: (a: Record<string, StoredAssignment>) => void): void {
  const a = loadAssignments();
  edit(a);
  writeJsonAtomic(ASSIGNED_FILE(), a);
}

/**
 * A task with no ticket in a tracker: the prefix and a nine-digit number starting with 9, a ticket key everywhere keys are
 * read (plan, Work, spend) that no tracker hands out in practice.
 */
export const isTaskKey = (key: string): boolean => /^[A-Z][A-Z0-9]*-9\d{8}$/.test(key);

/**
 * The client a ticket runs under: for one you assigned an agent to, at the project's assignedAutonomy (autonomy.ts); a
 * task still being planned runs read-only (watch), whatever the project allows.
 */
export const runClient = (c: Client, key: string, assigned = loadAssignments()): Client =>
  assigned[key]?.plan ? { ...c, autonomy: "watch" } : runAs(c, Boolean(assigned[key]));

/** What to assign: a ticket by key, or (no key) a task from a finding or a lead's report, with the brief the agent gets. */
export interface AssignInput {
  project: string;
  key?: string;
  title: string;
  brief?: string;
  by: Assignment["by"];
  /** A teammate's hand-off: assigning it is how it runs, even on a project that acts on its own. */
  allowAct?: boolean;
  /** Started from a sentence: plan it first (read-only), on any project. False (going ahead) builds it. */
  plan?: boolean;
}

/**
 * Assigns an agent to build a ticket (or a task with no ticket) on a watch or propose project. Throws on an unknown
 * project, on `act` (it builds already) and on a key of another project. Assigning the same thing twice keeps one
 * assignment; once a pass has run it, assigning again queues it once more.
 */
export function assign(input: AssignInput, clients: readonly Client[] = CLIENTS, now = Date.now()): StoredAssignment {
  const c = clients.find((x) => x.name === input.project);
  if (!c) throw new Error(`no project named ${input.project}`);
  if (buildsItself(c.autonomy) && !input.allowAct && !input.plan)
    throw new Error(`${c.name} builds on its own already: arm the ticket in the plan`);
  const title = input.title.trim().slice(0, 200);
  const brief = (input.brief ?? "").trim().slice(0, 8000);
  const given = (input.key ?? "").trim().toUpperCase();
  if (given && !given.startsWith(`${c.prefix}-`)) throw new Error(`${given} isn't a ${c.name} ticket`);
  if (!given && !title) throw new Error("say what to build");
  const key = given || `${c.prefix}-${900_000_000n + (BigInt(Bun.hash([c.name, title, brief].join("\n"))) % 100_000_000n)}`;
  let out: StoredAssignment | undefined;
  editAssignments((all) => {
    const was = all[key];
    // going ahead with a plan adds the plan you approved to what the agent is told
    const told = was && brief && !was.brief.includes(brief) ? `${was.brief}\n\n${brief}`.trim() : was?.brief;
    out = was
      ? { ...was, brief: told ?? was.brief, queued: true, plan: input.plan ?? false }
      : { key, project: c.name, title: title || key, by: input.by, local: !given, at: now, brief, queued: true, plan: input.plan ?? false };
    all[key] = out;
  });
  if (!out) throw new Error("couldn't save the assignment");
  return out;
}

/** Drops an assignment (its PR was merged or closed). */
export function unassign(key: string): void {
  if (loadAssignments()[key]) editAssignments((a) => delete a[key]);
}

interface FindingsFile {
  items: Finding[];
  /** Findings you dismissed, so the same one isn't filed again. */
  dismissed: string[];
}

const loadFindingsFile = (): FindingsFile => ({ items: [], dismissed: [], ...readJson<Partial<FindingsFile>>(FINDINGS_FILE(), {}) });

/** What's held for you, newest first. */
export const loadFindings = (): Finding[] => loadFindingsFile().items;

/**
 * Holds something for you instead of posting it. The same finding (project, ticket and text) is kept once, and one you
 * dismissed isn't filed again. Returns its id.
 */
export function holdFinding(f: Omit<Finding, "id" | "at">, now = Date.now()): string {
  const id = findingId(f);
  const file = loadFindingsFile();
  if (file.dismissed.includes(id) || file.items.some((x) => x.id === id)) return id;
  file.items = [{ ...f, id, at: now }, ...file.items].slice(0, 200);
  writeJsonAtomic(FINDINGS_FILE(), file);
  return id;
}

/** A finding's id: the same project, ticket, finder and text (and a stopped run's task) are the same finding. */
export const findingId = (f: Pick<Finding, "project" | "key" | "from" | "text"> & Pick<Partial<Finding>, "failed">): string =>
  Bun.hash([f.project, f.key, f.from, f.text, ...(f.failed ? [f.failed.task] : [])].join("\n")).toString(36);

/** Removes a finding: done with (posted or assigned), or dismissed so it isn't filed again. */
export function dropFinding(id: string, dismissed: boolean): Finding | undefined {
  const file = loadFindingsFile();
  const f = file.items.find((x) => x.id === id);
  if (!f) return undefined;
  file.items = file.items.filter((x) => x.id !== id);
  if (dismissed) file.dismissed = [...file.dismissed, id].slice(-500);
  writeJsonAtomic(FINDINGS_FILE(), file);
  return f;
}
