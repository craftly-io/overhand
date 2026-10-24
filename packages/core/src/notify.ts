/** Desktop notifications, the daily report and the daily budget's notice. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { budgetNotice } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { accountBilling, budgetSpend } from "./billing";
import { diskGuard, freeGb } from "./cleanup";
import { ACCOUNTS, CFG, CODE, OPS, secret, today, UI_PORT } from "./env";
import { desktopNotify } from "./platform";
import { hostedActive, relayUrl } from "./relay";
import type { NtfyAction } from "./replies";
import { webPushAll } from "./webpush";

/**
 * A desktop notification that opens the dashboard when clicked, also pushed to the phone when ntfySecret is set, with
 * `actions` as the push's buttons.
 */
export function notify(title: string, body: string, actions: NtfyAction[] = []): void {
  if (process.env.NODE_ENV === "test") return; // bun test sets it; no desktop popups from tests
  desktopNotify(title, body, `http://127.0.0.1:${UI_PORT}`);
  if (CFG.ntfySecret) void push(title, body, actions);
  // Web Push to browsers subscribed through the hosted page: sent from here, a hosted feature (Pro or Team)
  if (hostedActive()) void webPushAll(title, body, relayUrl()).catch(() => {});
}

/**
 * Posts to the ntfy topic (the ntfySecret's URL unless `topic` names one); a failure is logged, never thrown, so the Mac
 * notification still counts. True when ntfy took it.
 */
export async function push(title: string, body: string, actions: NtfyAction[] = [], topic = ""): Promise<boolean> {
  try {
    // query parameters rather than headers: fetch rejects non-Latin-1 header values, and titles can hold emoji
    const url = new URL(topic || secret(CFG.ntfySecret));
    url.searchParams.set("title", title);
    const click = CFG.dashboardOrigins[0];
    if (click) url.searchParams.set("click", click);
    if (actions.length) url.searchParams.set("actions", JSON.stringify(actions));
    const r = await fetch(url, { method: "POST", body: body || title, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) console.error(`ntfy push failed: HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error(`ntfy push failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** When each line last went into the report, so a repeating error doesn't fill the day's log. */
const lastReported = new Map<string, number>();
const REPEAT_MS = 30 * 60_000;
/** Warning and failure lines (⚠, ✗) reported since start, so a one-shot CLI step can exit non-zero when it hit one. */
export let problems = 0;

/** What went wrong, as a report line says it: an error's own message, never "Error: …". */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Appends a line to today's report (reports/YYYY-MM-DD.md) and logs it. The same line again within 30 minutes is
 * dropped: a failing loop would otherwise write it every pass.
 */
export function report(line: string, now = Date.now()): void {
  if (/^(⚠|✗)/u.test(line)) problems++;
  const last = lastReported.get(line);
  if (last !== undefined && now - last < REPEAT_MS) return;
  lastReported.set(line, now);
  // ponytail: the map grows with distinct lines; a day holds a few hundred, so it's pruned only when it gets big
  if (lastReported.size > 2000) for (const [l, at] of lastReported) if (now - at >= REPEAT_MS) lastReported.delete(l);
  mkdirSync(join(OPS, "reports"), { recursive: true });
  appendFileSync(join(OPS, "reports", `${today()}.md`), `- ${new Date(now).toTimeString().slice(0, 5)} ${line}\n`, { mode: 0o600 });
  console.log(line);
}

let stampedDay = "";
/** `line` with the local time in front (HH:MM:SS), and the date before it on the first line of each day. */
export function stamped(line: string, now = new Date()): string {
  const day = now.toLocaleDateString("sv-SE");
  const time = now.toTimeString().slice(0, 8);
  const head = day === stampedDay ? time : `${day} ${time}`;
  stampedDay = day;
  return `${head} ${line}`;
}

/**
 * Puts the local time in front of everything the daemon prints (console.log, warn, error): its log, logs/daemon.log, is
 * the service's stdout and stderr. The day's report keeps its own HH:MM, so the dashboard's feed is unchanged.
 */
export function stampConsole(): void {
  for (const k of ["log", "warn", "error"] as const) {
    const write = console[k].bind(console);
    console[k] = (...args: unknown[]) => write(stamped(format(...args)));
  }
}

let budgetSaid = "";
/**
 * Says once (per day and cap) that today's billed spend reached limits.dailyBudgetUsd. The cap itself holds only billed
 * accounts (`budgetUntil`): pay-per-use and cloud agents wait until tomorrow, plan and local accounts carry on.
 */
export function enforceBudget(): void {
  const cap = CFG.limits.dailyBudgetUsd;
  const key = `${today()} ${cap}`;
  if (!cap || budgetSaid === key) return;
  if (budgetSpend() < cap) return;
  budgetSaid = key;
  const unknown = ACCOUNTS.some((a) => !accountBilling(a).sure);
  const why = [`${plainWords.alBudget.replace("{cap}", `$${cap}`)}.`, budgetNotice(plainWords, unknown)].join(" ");
  report(`🛑 ${why}`);
  notify(plainWords.alBudgetTitle, why);
}

/** Free GB on the fuller of the volumes holding Overhand's state and the Code root; Infinity when it can't be read. */
export function diskFree(): number {
  try {
    return Math.min(freeGb(OPS), freeGb(CODE || OPS));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

let diskLowSince = 0;
/**
 * The low-disk guard: why new agents and leads mustn't start (free space under cleanup.minFreeGb), or null. Running ones
 * carry on. Notifies once when it trips; Needs you offers the cleanup.
 */
export function diskLow(): string | null {
  const why = diskGuard(diskFree(), CFG.cleanup.minFreeGb);
  if (why && !diskLowSince) {
    report(`💾 not starting new agents: ${why}`);
    notify("Disk almost full", `New agents wait: ${why}. Clean up in Overhand.`);
  }
  diskLowSince = why ? diskLowSince || Date.now() : 0;
  return why;
}
