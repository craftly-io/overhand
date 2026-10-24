import { type Lead, leadId, plainLine, type Run, type Session, wasId } from "@overhand/contract";
import type { WordKey, Words } from "@overhand/themes";
import { fmt, hm, until } from "./format";

/** claude-opus-5-5 → "Opus 5.5"; anything it doesn't recognise comes back unchanged. */
export function modelName(m: string): string {
  const x = m.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  if (!x?.[1]) return m;
  return `${x[1].charAt(0).toUpperCase()}${x[1].slice(1).toLowerCase()} ${x[2]}.${x[3]}`;
}

/** Claude Code permission modes, in words. */
const MODES: Record<string, string> = {
  auto: "auto",
  default: "asks first",
  acceptEdits: "accepts edits",
  plan: "plan only",
  bypassPermissions: "no checks",
  dontAsk: "allowlist only",
};

/** "Opus 5.5 · auto": the model and permission mode something runs with, or "" when neither is known. */
export function runsOn(x: { model?: string; mode?: string }): string {
  return [x.model && modelName(x.model), x.mode && (MODES[x.mode] ?? x.mode)].filter(Boolean).join(" · ");
}

/** What a headless ops run is, from the name it logs under ("plan", "inbox", "route", or a ticket key). */
export function runKind(name: string): WordKey {
  if (/^plan/.test(name)) return "runPlanner";
  if (/^inbox/.test(name)) return "runTriage";
  if (/^route/.test(name)) return "runRouting";
  if (/[A-Z][A-Z0-9]+-\d+/.test(name)) return "runTicket";
  return "runOther";
}

/** A session's headline: the lead or ticket label, or for your own sessions their name or folder. */
export function sessionTitle(x: Session): string {
  if (x.kind !== "you") return x.label;
  return x.name || (x.client === "Other" ? x.cwd : x.client);
}

/** What a lead is doing, in a sentence. */
export function leadState(g: Lead, w: Words, now: number): string {
  if (g.running) return g.mine ? fmt(w.leadRunningSince, { t: hm(g.since), account: g.account }) : w.leadRunningByHand;
  if (!g.supervised) return w.leadOff;
  if (g.stopped) return fmt(w.leadStopped, { reason: g.reason });
  if (g.waiting) return w.leadWaiting;
  if (g.capHeld) return w.leadWaitingCap; // the daemon's heldByCap: the cap, not a usage limit, is what it waits on
  const back = g.limitBack ?? 0;
  if (back > now) return fmt(w.leadWaitingLimitUntil, { account: g.limitAccount ?? g.account, t: until(back, now) });
  if (g.waitingLimit) return w.leadWaitingLimit;
  if (g.onDemand) return w.leadAsleep; // ops wakes it when its project has work
  if (g.nextAt > now) return fmt(w.leadRestarts, { t: hm(g.nextAt) });
  return w.leadStarting;
}

/** Dollars a lead's runs cost today. */
export function leadCost(g: Lead, runs: readonly Run[]): number {
  return runs.filter((r) => r.name === `lead-${g.key}`).reduce((n, r) => n + r.cost, 0);
}

/** The leads worth listing: switched on, or holding questions. */
export function listedLeads(godmode: readonly Lead[]): Lead[] {
  return godmode.filter((g) => g.supervised || g.inbox);
}

/** Shell keywords and wrappers; the command worth naming comes after them. */
const SHELL_WORDS = new Set([
  "until",
  "while",
  "for",
  "if",
  "then",
  "do",
  "cd",
  "timeout",
  "env",
  "sudo",
  "time",
  "nohup",
  "sleep",
  "echo",
]);

const base = (p: string) => p.trim().split(/\s/)[0]?.split("/").filter(Boolean).pop() ?? "";

/**
 * What a session is doing, as a character would say it: a tool call ("→ Write: …/0079.md") becomes "writing 0079.md";
 * a message the agent wrote is its first sentence.
 */
export function saying(lastAction: string): string {
  const x = lastAction.match(/^→ (\w+):?\s*(.*)$/s);
  if (!x?.[1]) return plainLine(lastAction, 200);
  const arg = x[2] ?? "";
  switch (x[1]) {
    case "Bash":
      return `running ${arg.split(/[\s;&|()]+/).find((w) => /^[a-z][\w.-]*$/.test(w) && !SHELL_WORDS.has(w)) ?? "a command"}`;
    case "Read":
      return `reading ${base(arg)}`;
    case "Write":
      return `writing ${base(arg)}`;
    case "Edit":
    case "MultiEdit":
      return `editing ${base(arg)}`;
    case "Grep":
    case "Glob":
      return "searching the code";
    case "WebFetch":
    case "WebSearch":
      return "reading the web";
    case "Task":
    case "Agent":
      return "briefing a subagent";
    default:
      return `using ${x[1]}`;
  }
}

/**
 * A lead's name: yours from the dashboard (one click, kept for good), else the one in its config, else its label, which
 * a ready-made lead gets as its job and place ("Keep checks green · Online shop"). No invented character names.
 */
export function leadName(g: Pick<Lead, "key" | "name" | "label">, names: Readonly<Record<string, string>>): string {
  return names[leadId(g.key)] || g.name || g.label;
}

/** Every other name a lead has gone by: its label, its config name and the names you gave it before. */
function formerNames(g: Pick<Lead, "key" | "name" | "label">, names: Readonly<Record<string, string>>): string[] {
  const now = leadName(g, names);
  return [g.label, g.name, ...(names[wasId(leadId(g.key))] ?? "").split("\n")].filter((n) => n && n !== now);
}

/** The lead a log line names: by the name it goes by now, or any it went by when the line was written. */
export function leadNamed(all: readonly Lead[], names: Readonly<Record<string, string>>, who: string): Lead | undefined {
  return all.find((g) => leadName(g, names) === who || formerNames(g, names).includes(who));
}

/**
 * A sentence from the log with each lead under the name it goes by now ("Shop lead woke up" → "Night watch woke up").
 * A line that already says the current name is left as it is, so a rename that contains the label isn't doubled.
 */
export function withNames(text: string, all: readonly Lead[], names: Readonly<Record<string, string>>): string {
  return all.reduce((t, g) => {
    const now = leadName(g, names);
    if (t.includes(now)) return t;
    return formerNames(g, names)
      .sort((a, b) => b.length - a.length)
      .reduce((x, old) => x.replaceAll(old, now), t);
  }, text);
}
