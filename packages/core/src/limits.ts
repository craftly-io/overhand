/**
 * An agent account out of usage: the one detector for every CLI's limit wording, the reset time it gives, and the one
 * bench (OPS/control/benched.json) every lead, ticket, brief and test run reads, so a restart keeps it.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { controlDir } from "./control";
import { CFG, MIN, OPS } from "./env";
import { readJson, writeJsonAtomic } from "./state";
import { type AccountUsage, exhaustedUntil } from "./usage";

/**
 * What an agent CLI itself says when its account is out of capacity, read only from its own result or error (never the
 * transcript, where a project's own tests can print "429" or "rate limit"): Claude Code ("You've hit your session limit ·
 * resets 3am", "weekly limit", "Claude AI usage limit reached|<epoch>"), Cursor ("ActionRequiredError: You've hit your
 * usage limit"), Codex ("You've hit your usage limit … try again at …", "last status: 429 Too Many Requests"), Gemini
 * ("Quota exceeded", "RESOURCE_EXHAUSTED"), OpenCode and Aider (the provider's "Rate limit exceeded", "RateLimitError",
 * "insufficient_quota"), Anthropic's overload. A bare "rate limit" or "429" is not one.
 */
const LIMIT_RE =
  /hit your [\w ]{0,24}limit|usage limit|session limit|weekly limit|rate.?limit (?:reached|exceeded)|ratelimiterror|rate_limit_error|insufficient_quota|quota exceeded|resource.?exhausted|overloaded_error|status:? 429\b/i;

/**
 * What an agent CLI says when its sign-in has expired or was revoked: Claude Code ("Failed to authenticate. API Error:
 * 401 … authentication_error … Please run /login", "OAuth token has expired"), Codex ("Please log in again", "sign in
 * again"), Cursor ("Please run 'cursor-agent login'"), Gemini ("API key not valid"), any provider's "invalid x-api-key".
 */
const AUTH_RE =
  /please run \/login|authentication_error|failed to authenticate|oauth token (?:has )?expired|(?:log|sign) ?in again|run [`'"]?[\w-]+ login\b|not (?:logged|signed) in|api key not valid|invalid (?:x-)?api[ _-]key/i;

/** Whether a failed run's own result or error says its account is signed out, from the same text `outOfUsage` reads. */
export const signedOut = (output: string): boolean => AUTH_RE.test(output);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "resets 3am (Europe/Helsinki)", "resets Oct 27 at 4am", "try again at 3:45 PM", "try again at Oct 27th, 2026 4:00 AM"
const RESET_RE =
  /(?:resets?|try again at)\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/** A moment's wall clock in `tz` (undefined: this computer's zone), months from 0. */
function wall(t: number, tz: string | undefined): [number, number, number, number, number] {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return [p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0];
}

/** The moment a wall clock in `tz` shows this time (Date.UTC carries an overflowing day into the next month). */
function at(y: number, mo: number, d: number, h: number, mi: number, tz: string | undefined): number {
  const want = Date.UTC(y, mo, d, h, mi);
  let t = want;
  // twice: the second pass settles a guess that landed across a DST change
  for (let i = 0; i < 2; i++) t += want - Date.UTC(...wall(t, tz));
  return t;
}

/** When a limit message says the account is back (epoch ms, the next such time after `now`); 0 when it doesn't say. */
export function resetAt(text: string, now = Date.now()): number {
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = RESET_RE.exec(text);
  if (!m) return 0;
  const [, mon, day, year, hour, min, ap, zone] = m;
  if (!ap && min === undefined) return 0; // a bare number isn't a time
  const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
  if (mon && month < 0) return 0;
  let tz = zone?.trim();
  try {
    wall(now, tz);
  } catch {
    tz = undefined; // a zone this runtime doesn't know: read it as this computer's
  }
  const h = ap ? (Number(hour) % 12) + (ap.toLowerCase() === "pm" ? 12 : 0) : Number(hour);
  const mi = Number(min ?? 0);
  if (h > 23 || mi > 59) return 0;
  const [y, mo, d] = wall(now, tz);
  if (mon) {
    const t = at(year ? Number(year) : y, month, Number(day), h, mi, tz);
    return t > now || year ? t : at(y + 1, month, Number(day), h, mi, tz);
  }
  const t = at(y, mo, d, h, mi, tz);
  return t > now ? t : at(y, mo, d + 1, h, mi, tz);
}

/**
 * Until when a failed run's account is out of usage, from the CLI's own result or error and stderr (never the transcript)
 * and the usage it reported (Claude Code's rate_limit_event): the reset the message gives, else the full window's reset, else the configured cooldown. 0 when the
 * run didn't hit a limit.
 */
export function outOfUsage(output: string, usage: AccountUsage | null = null, now = Date.now()): number {
  if (usage?.status !== "rejected" && !LIMIT_RE.test(output)) return 0;
  return resetAt(output, now) || exhaustedUntil(usage ?? undefined, now) || now + CFG.limits.cooldownMin * MIN;
}

const benchFile = (ops: string): string => join(controlDir(ops), "benched.json");

/** Accounts out of usage right now, and until when; an entry past its reset is gone, so nothing needs clearing. */
export function benched(ops = OPS, now = Date.now()): Record<string, number> {
  return Object.fromEntries(Object.entries(readJson<Record<string, number>>(benchFile(ops), {})).filter(([, t]) => t > now));
}

/** Until when `account` is out of usage; 0 when it isn't. */
export const benchedUntil = (account: string, ops = OPS): number => benched(ops)[account] ?? 0;

/** Benches `account` for every run until `until`: the latest word on it wins (a test's reset time over a cooldown guess). */
export function bench(account: string, until: number, ops = OPS): void {
  mkdirSync(controlDir(ops), { recursive: true });
  writeJsonAtomic(benchFile(ops), { ...benched(ops), [account]: until });
}

const signedOutFile = (ops: string): string => join(controlDir(ops), "signed-out.json");

/** Accounts whose sign-in expired, and since when: passed over by every run until they sign in again. */
export const signedOutAccounts = (ops = OPS): Record<string, number> => readJson<Record<string, number>>(signedOutFile(ops), {});

/** Marks `account` signed out (`out`), or signed in again: kept in a file, so a restart keeps it, as the bench is. */
export function markSignedOut(account: string, out: boolean, ops = OPS): void {
  const all = signedOutAccounts(ops);
  if (!out && !(account in all)) return;
  if (out) all[account] = Date.now();
  else delete all[account];
  mkdirSync(controlDir(ops), { recursive: true });
  writeJsonAtomic(signedOutFile(ops), all);
}

/** "03:00" for a time within a day, else "Oct 27 04:00": when a benched account is back, in log lines. */
export function backAt(t: number, now = Date.now()): string {
  const hm = new Date(t).toTimeString().slice(0, 5);
  return t - now < 86_400_000 ? hm : [new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }), hm].join(" ");
}
