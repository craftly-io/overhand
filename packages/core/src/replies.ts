/**
 * Answering a lead from the phone: the push for a lead's question carries quick replies as ntfy http actions. Each push
 * gets one random token that allows exactly one of the replies it offered, once, for a day, and only while the question
 * is still the one it was sent for. The phone can't send the dashboard's Origin, so this token is the whole of the auth.
 */
import { randomBytes } from "node:crypto";
import { CFG } from "./env";

/** An ntfy action button (https://docs.ntfy.sh/publish/#action-buttons). */
export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | { action: "http"; label: string; url: string; method: "POST"; clear: boolean };

/** How long a reply button works. */
export const REPLY_TTL_MS = 24 * 60 * 60_000;
/** ntfy shows three buttons at most: two replies and Open. */
const MAX_REPLIES = 2;

interface Pending {
  key: string;
  /** The questions file's mtime when the push went out; a different one means the question changed or was answered. */
  at: number;
  replies: string[];
  expires: number;
}
// ponytail: in memory, so a daemon restart voids the buttons (they answer 410 and Open still works); persist if that bites
const pending = new Map<string, Pending>();

/**
 * The replies a question offers: its newest "## " section's `Options: a | b` line (also split on " / " or " or "), when
 * it names two; else "go with your recommendation" when the lead made one. Empty for a report or a free-form question.
 */
export function quickReplies(text: string): string[] {
  const section = text.split(/^(?=## )/m).at(-1) ?? "";
  if (/^## (Report|Answer from|Reply\b)/.test(section)) return [];
  const line = section.match(/^\s*(?:[-*]\s*)?\**options?\**:\**\s*(.+)$/im)?.[1] ?? "";
  const options = line
    .split(/\s+\|\s+|\s+\/\s+|\s+or\s+/i)
    .map((o) => o.replace(/[.?]$/, "").trim())
    .filter(Boolean);
  if (options.length >= 2 && options.length <= MAX_REPLIES) return options;
  return /recommend/i.test(section) ? ["Go with your recommendation."] : [];
}

/**
 * The buttons for a lead's question push: its quick replies (each a single-use POST to the daemon) and Open. Empty when
 * there is no phone push, or no dashboard address the phone can reach (dashboardOrigins[0]).
 */
export function replyActions(key: string, at: number, text: string, now = Date.now()): NtfyAction[] {
  const origin = CFG.dashboardOrigins[0];
  if (!CFG.ntfySecret || !origin) return [];
  for (const [t, p] of pending) if (p.expires <= now || p.key === key) pending.delete(t); // a newer question replaces the old buttons
  const replies = quickReplies(text);
  const token = randomBytes(24).toString("base64url");
  if (replies.length) pending.set(token, { key, at, replies, expires: now + REPLY_TTL_MS });
  return [
    ...replies.map(
      (label, i): NtfyAction => ({
        action: "http",
        label: label.length > 40 ? `${label.slice(0, 39)}…` : label,
        url: new URL(`/api/lead/reply?t=${token}&c=${i}`, origin).href,
        method: "POST",
        clear: true,
      }),
    ),
    { action: "view", label: "Open", url: origin },
  ];
}

/**
 * Spends a reply token: the lead and the reply text it allows, or why not. Any outcome but `expired` for an unknown
 * token burns it, so a token can be tried once. `currentAt` is the questions file's mtime now (0 when it's empty).
 */
export function takeReply(
  token: string,
  choice: number,
  currentAt: (key: string) => number,
  now = Date.now(),
): { key: string; text: string } | { error: string; status: number } {
  const p = pending.get(token);
  if (!p) return { error: "this reply has expired or was already used; answer in Overhand", status: 410 };
  pending.delete(token);
  if (p.expires <= now) return { error: "this reply has expired; answer in Overhand", status: 410 };
  if (currentAt(p.key) !== p.at) return { error: "the question changed since; answer in Overhand", status: 409 };
  const text = p.replies[choice];
  if (text === undefined) return { error: "no such reply", status: 400 };
  return { key: p.key, text };
}
