/**
 * Team status updates: on each channel's schedule (or "Send a test"), the summary of its projects, scoped and written in
 * its platform's format, posted to its incoming webhook. The URL is read from the secret store at send time and never
 * logged, stored elsewhere or shown; a failure is kept for Health with every URL taken out.
 */
import { join } from "node:path";
import {
  isDue,
  isQuiet,
  payloadFor,
  redactUrls,
  type Summary,
  scopeSummary,
  spanOf,
  toMarkdown,
  type UpdateChannel,
  type UpdateStatus,
  type UpdateWords,
  updateSecret,
} from "@overhand/contract";
import { plainWords, themes } from "@overhand/themes";
import { CFG, OPS } from "./env";
import { holdLeak, scanOutward } from "./outward";
import { readSecret } from "./platform";
import { readJson, writeJsonAtomic } from "./state";
import { summarize } from "./summary";

const FILE = () => join(OPS, "updates.json");
/** Per channel: `lastAt` the schedule's clock (a slot is spent once it passes it), `sentAt` the last post or try. */
type Sent = Record<string, { lastAt: number; sentAt?: number; error: string }>;
const loadSent = (): Sent => readJson<Sent>(FILE(), {});
/** Spends the slot; with `sent`, also records a post (or a failed one, with its error). */
function record(id: string, lastAt: number, sent?: { error: string }): void {
  const all = loadSent();
  const prev = all[id];
  writeJsonAtomic(FILE(), {
    ...all,
    [id]: sent ? { lastAt, sentAt: lastAt, error: sent.error } : { lastAt, sentAt: prev?.sentAt ?? 0, error: prev?.error ?? "" },
  });
}

/** Each channel's last send, for Health. */
export function updateStatuses(): UpdateStatus[] {
  const sent = loadSent();
  return CFG.updates.map((u) => ({
    id: u.id,
    name: u.name,
    kind: u.kind,
    sentAt: sent[u.id]?.sentAt ?? 0,
    error: sent[u.id]?.error ?? "",
    projects: u.projects,
  }));
}

/** The words a channel speaks in: plain, or its theme's voice. */
const wordsFor = (voice: string): UpdateWords => themes.find((t) => t.id === voice)?.words ?? plainWords;

/** A webhook URL Overhand will post to: https, or plain http only to this machine (a local test server). */
export function webhookOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** A channel's summary as it would go out now. */
export async function channelSummary(ch: UpdateChannel, now = Date.now()): Promise<Summary> {
  return scopeSummary(await summarize(spanOf(ch.schedule.when), now), ch.projects, ch.include);
}

/** A channel's update as Markdown ("Copy as Markdown"). */
export const channelMarkdown = (ch: UpdateChannel, s: Summary): string =>
  toMarkdown(s, wordsFor(ch.voice), ch.projects, { attribution: CFG.outward.aiAttribution });

/** What sending needs from outside: the secret store and the network. Tests swap both. */
export interface SendDeps {
  secret: (item: string) => string | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}
const live: SendDeps = { secret: (item) => readSecret(item, CFG.owner.keychainAccount), fetch: (url, init) => fetch(url, init) };

/**
 * Posts `s` to a channel's webhook and records the outcome. Resolves to "" when it went, else the error as Health shows
 * it (no URL in it). Never throws. The update goes through the outward firewall first, scoped to the channel's projects:
 * a leak is held in Needs you (Edit and post, Post anyway) and Health says so.
 */
export async function sendUpdate(ch: UpdateChannel, s: Summary, now: number, deps: SendDeps = live): Promise<string> {
  const body = JSON.stringify(payloadFor(ch.kind, s, wordsFor(ch.voice), ch.projects, { attribution: CFG.outward.aiAttribution }));
  const text = channelMarkdown(ch, s);
  const hits = scanOutward(text, ch.projects);
  if (hits.length) {
    // the stored body never keeps a secret: Post anyway sends it with each one blanked
    const safe = hits.filter((h) => h.why === "secret").reduce((b, h) => b.split(h.term).join("[secret]"), body);
    const held = { kind: "update", project: ch.projects[0] ?? "", to: ch.projects, dest: `status channel ${ch.name}` } as const;
    holdLeak(
      { ...held, title: `Status update to ${ch.name}`, text, payload: { channel: ch.id, body: safe, to: ch.projects.join("\n") } },
      hits,
    );
    const error = "Held by the outward firewall: it's waiting in Needs you.";
    record(ch.id, now, { error });
    return error;
  }
  return postBody(ch, body, now, deps);
}

/** A channel's message as plain text, in its platform's shape: what Edit and post sends after the firewall held one. */
export const plainPayload = (kind: UpdateChannel["kind"], text: string): string =>
  JSON.stringify(kind === "discord" ? { content: text.slice(0, 2000), allowed_mentions: { parse: [] } } : { text });

/** Posts a ready body to a channel's webhook and records the outcome; "" when it went, else the error. Never throws. */
export async function postBody(ch: UpdateChannel, body: string, now: number, deps: SendDeps = live): Promise<string> {
  const error = await post(ch, body, deps);
  record(ch.id, now, { error });
  return error;
}

/**
 * Posts a ready body to a channel's webhook without touching its schedule (a work report rides the channel, it isn't
 * the channel's update); "" when it went, else the error with the URL taken out. Never throws.
 */
export async function post(ch: UpdateChannel, body: string, deps: SendDeps = live): Promise<string> {
  const url = deps.secret(updateSecret(ch.id)) ?? "";
  let error = "";
  if (!url) error = `No webhook URL stored for ${ch.name}: paste it under Settings → Advanced → Status updates and work reports.`;
  else if (!webhookOk(url)) error = `The stored webhook for ${ch.name} isn't an https URL.`;
  else {
    try {
      const r = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) error = `HTTP ${r.status}: ${(await r.text().catch(() => "")).trim() || r.statusText}`;
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }
  return error && redactUrls(url ? error.split(url).join("[link hidden]") : error);
}

/**
 * Runs every minute: sends each channel whose slot is due. A channel seen for the first time starts its clock now, so
 * adding one at 10:00 doesn't post the 9:00 update at once. A quiet summary isn't posted (its slot still counts).
 */
export async function tickUpdates(
  now = Date.now(),
  deps: SendDeps & { summary: (ch: UpdateChannel, now: number) => Promise<Summary> } = { ...live, summary: channelSummary },
): Promise<void> {
  const sent = loadSent();
  for (const ch of CFG.updates) {
    const last = sent[ch.id];
    if (!last) {
      record(ch.id, now);
      continue;
    }
    if (!isDue(ch.schedule, now, last.lastAt)) continue;
    const s = await deps.summary(ch, now);
    if (isQuiet(s)) record(ch.id, now);
    else await sendUpdate(ch, s, now, deps);
  }
}
