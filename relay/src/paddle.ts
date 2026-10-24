/**
 * Paddle Billing for the relay: webhook signatures, the catalog read at runtime and selected by each price's
 * custom_data tag (never by ID, so the owner changes prices in Paddle without a release), and the entitlement record
 * per workspace that webhooks keep (D1: see README.md for why not KV).
 */
import { CYCLES, type Cycle, PLANS, type Plan } from "@overhand/contract";
import { z } from "zod";

/** The Paddle API for an environment. Only "production" reaches the live API; anything else is the sandbox. */
export const paddleBase = (env: string): string => (env === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com");

/** Paddle's SDKs reject a signature older than this. */
const SIGNATURE_TOLERANCE_S = 5;

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** Equal without an early exit, so the timing says nothing about where two hex strings differ. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** HMAC-SHA256 hex, as Paddle signs: over `${ts}:${rawBody}` with the notification destination's secret. */
export async function paddleHmac(secret: string, ts: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${rawBody}`)));
}

/**
 * Verifies a `Paddle-Signature: ts=…;h1=…` header against the raw body. Any h1 may match (Paddle sends two while a
 * secret rotates). A timestamp outside the tolerance fails, so a captured delivery can't be replayed later; within it,
 * the event id dedupes (applyEvent).
 */
export async function verifyPaddleSignature(header: string | null, rawBody: string, secret: string, nowMs: number): Promise<boolean> {
  if (!header || !secret) return false;
  let ts = "";
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.split("=", 2).map((x) => x.trim());
    if (k === "ts" && v) ts = v;
    if (k === "h1" && v) h1.push(v.toLowerCase());
  }
  const at = Number(ts);
  if (!/^\d+$/.test(ts) || !h1.length || Math.abs(nowMs / 1000 - at) > SIGNATURE_TOLERANCE_S) return false;
  const want = await paddleHmac(secret, ts, rawBody);
  return h1.some((h) => sameHex(h, want));
}

// ── Webhook source addresses ──────────────────────────────────────────────────────────────────────────────────────

/** An IPv4 address as an unsigned 32-bit number, or null for anything else (IPv6 included). */
function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.some((o) => o > 255) ? null : octets.reduce((n, o) => n * 256 + o, 0);
}

/** Whether an IPv4 address falls inside an IPv4 CIDR block (`a.b.c.d/n`; no prefix means /32). */
export function inCidr(ip: string, cidr: string): boolean {
  const [net = "", bits = "32"] = cidr.split("/");
  const a = ipv4(ip);
  const b = ipv4(net);
  if (a === null || b === null || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return false;
  // compare the network parts by division: JS bitwise ops are signed 32-bit and would trip on the top bit
  const block = 2 ** (32 - Number(bits));
  return Math.floor(a / block) === Math.floor(b / block);
}

/** One isolate's last good copy of Paddle's address list, per API base. */
export type IpCache = { value: { base: string; at: number; cidrs: string[] } | null };
const ipCache: IpCache = { value: null };
/** How long a fetched list is trusted before it's fetched again. */
export const IPS_MS = 60 * 60_000;

/**
 * The CIDR blocks Paddle sends webhooks from, read from Paddle's public /ips endpoint (never hard-coded, so Paddle can
 * change them), cached for an hour. When the fetch fails it falls back to the last good list; null means there has
 * never been one, and the caller fails closed.
 */
export async function paddleIps(base: string, now: number, cache: IpCache = ipCache): Promise<string[] | null> {
  const c = cache.value?.base === base ? cache.value : null;
  if (c && now - c.at < IPS_MS) return c.cidrs;
  try {
    const r = await fetch(`${base}/ips`);
    if (!r.ok) throw new Error(`Paddle ${r.status} listing IPs`);
    const cidrs = z.object({ data: z.object({ ipv4_cidrs: z.array(z.string()).min(1) }) }).parse(await r.json()).data.ipv4_cidrs;
    cache.value = { base, at: now, cidrs };
    return cidrs;
  } catch (e) {
    console.error("paddle ips: fetch failed,", c ? "using the last good list" : "no list yet", e);
    return c?.cidrs ?? null;
  }
}

// ── The catalog ───────────────────────────────────────────────────────────────────────────────────────────────────

const PriceSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  unit_price: z.object({ amount: z.string(), currency_code: z.string() }),
  billing_cycle: z.object({ interval: z.string(), frequency: z.number() }).nullable().optional(),
  quantity: z.object({ minimum: z.number(), maximum: z.number() }).optional(),
  custom_data: z.record(z.string(), z.unknown()).nullable().optional(),
  product: z.object({ name: z.string() }).optional(),
});

/** One price as the pricing page and the upgrade screen show it. `amount` is in minor units (cents). */
export type PriceInfo = { id: string; amount: number; currency: string; min: number; max: number; product: string };
/** The catalog by tag: plan → cycle → price. */
export type Catalog = { [P in Plan]: { [C in Cycle]?: PriceInfo } };

/**
 * Picks the prices tagged custom_data `{plan, cycle}` out of Paddle's list. Untagged, archived, malformed or one-time
 * prices are skipped; when two share a tag, the first wins (Paddle lists newest first).
 */
export function selectPrices(list: unknown[]): Catalog {
  const out: Catalog = { pro: {}, team: {} };
  for (const raw of list) {
    const p = PriceSchema.safeParse(raw);
    if (!p.success || (p.data.status && p.data.status !== "active") || !p.data.billing_cycle) continue;
    const plan = PLANS.find((x) => x === p.data.custom_data?.plan);
    const cycle = CYCLES.find((x) => x === p.data.custom_data?.cycle);
    if (!plan || !cycle || out[plan][cycle]) continue;
    const amount = Number(p.data.unit_price.amount);
    if (!Number.isFinite(amount)) continue;
    out[plan][cycle] = {
      id: p.data.id,
      amount,
      currency: p.data.unit_price.currency_code,
      min: p.data.quantity?.minimum ?? 1,
      max: p.data.quantity?.maximum ?? 1,
      product: p.data.product?.name ?? "",
    };
  }
  return out;
}

/** One authenticated Paddle API call; throws with Paddle's error detail on failure. */
export async function paddle(base: string, apiKey: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const r = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j: unknown = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = z.object({ error: z.object({ detail: z.string() }) }).safeParse(j);
    throw new Error(`Paddle ${r.status}: ${detail.success ? detail.data.error.detail : "request failed"}`);
  }
  return z.object({ data: z.unknown() }).parse(j).data;
}

/** Every active price with its product, across pages. */
export async function listPrices(base: string, apiKey: string, signal?: AbortSignal): Promise<unknown[]> {
  const out: unknown[] = [];
  let next: string | null = `${base}/prices?status=active&include=product&per_page=200`;
  // ponytail: a handful of prices today; ten pages (2,000 prices) is a hard stop, not a real limit
  for (let i = 0; next && i < 10; i++) {
    const r: Response = await fetch(next, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!r.ok) throw new Error(`Paddle ${r.status} listing prices`);
    const page = z
      .object({
        data: z.array(z.unknown()),
        meta: z.object({ pagination: z.object({ next: z.string().nullable(), has_more: z.boolean() }) }),
      })
      .parse(await r.json());
    out.push(...page.data);
    next = page.meta.pagination.has_more ? page.meta.pagination.next : null;
  }
  return out;
}

// ── Entitlements ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The D1 subset used here (and faked over bun:sqlite in tests). */
export type D1Stmt = {
  bind(...values: (string | number | null)[]): D1Stmt;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{ meta: { changes: number } }>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
};
export type D1 = { prepare(sql: string): D1Stmt; batch(statements: D1Stmt[]): Promise<{ meta: { changes: number } }[]> };

/** The scheduled changes the billing page tells apart (Paddle's third, resume, is for a paused one coming back). */
const SCHEDULED = ["cancel", "pause"] as const;

/** A workspace's subscription, as the last webhook left it. */
const EntitlementSchema = z.object({
  workspace: z.string(),
  plan: z.enum(PLANS),
  cycle: z.string().nullable(),
  seats: z.number(),
  status: z.string(),
  subscription_id: z.string(),
  customer_id: z.string(),
  price_id: z.string(),
  period_end: z.string().nullable(),
  occurred_at: z.string(),
  // the cancel or pause Paddle makes at scheduled_at (the period's end), or none; nullish too for a row from before them
  scheduled_change: z.enum(SCHEDULED).nullish(),
  scheduled_at: z.string().nullish(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/** Statuses that keep hosted features on. past_due keeps them while Paddle retries the card; a cancel lands at period end. */
const PAID = new Set(["active", "trialing", "past_due"]);
const PAID_SQL = [...PAID].map((st) => `'${st}'`).join(", ");

/** The workspace's entitlement when it's paid for, else null. */
export async function activeEntitlement(db: D1, workspace: string): Promise<Entitlement | null> {
  const row = await db.prepare("SELECT * FROM entitlements WHERE workspace = ?").bind(workspace).first();
  const e = EntitlementSchema.safeParse(row);
  return e.success && PAID.has(e.data.status) ? e.data : null;
}

/** The workspace's record whatever its status (the portal and seat changes need canceled ones too), or null. */
export async function entitlementOf(db: D1, workspace: string): Promise<Entitlement | null> {
  const e = EntitlementSchema.safeParse(await db.prepare("SELECT * FROM entitlements WHERE workspace = ?").bind(workspace).first());
  return e.success ? e.data : null;
}

const SubscriptionEvent = z.object({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  data: z.object({
    id: z.string(),
    status: z.string(),
    customer_id: z.string(),
    custom_data: z.record(z.string(), z.unknown()).nullable().optional(),
    current_billing_period: z.object({ ends_at: z.string() }).nullable().optional(),
    scheduled_change: z.object({ action: z.string(), effective_at: z.string() }).nullable().optional(),
    items: z
      .array(
        z.object({
          quantity: z.number(),
          price: z.object({ id: z.string(), custom_data: z.record(z.string(), z.unknown()).nullable().optional() }),
        }),
      )
      .min(1),
  }),
});

/** The workspace a subscription event is for, or null. */
export function eventWorkspace(event: unknown): string | null {
  const ws = SubscriptionEvent.safeParse(event).data?.data.custom_data?.workspace;
  return typeof ws === "string" && ws ? ws : null;
}

/** What a webhook did: applied, a duplicate (replayed or retried event id), ignored (not a subscription event), or bad. */
export type Applied = "applied" | "duplicate" | "ignored" | "stale" | "bad";

/**
 * Applies one verified webhook. Subscription events upsert the workspace's entitlement (the workspace rides in
 * custom_data, set server-side on the checkout's transaction and copied by Paddle to the subscription). The event id is
 * recorded in the same transaction, so a replay or retry is a no-op, an event older than the stored one never
 * overwrites it (Paddle doesn't promise order), and an event for another subscription never turns a paid one off.
 */
export async function applyEvent(db: D1, event: unknown, now: number): Promise<Applied> {
  const head = z.object({ event_id: z.string(), event_type: z.string() }).safeParse(event);
  if (!head.success) return "bad";
  const seen = await db.prepare("SELECT 1 AS hit FROM paddle_events WHERE event_id = ?").bind(head.data.event_id).first();
  if (seen) return "duplicate";
  if (!head.data.event_type.startsWith("subscription.")) {
    await db.prepare("INSERT OR IGNORE INTO paddle_events (event_id, received_at) VALUES (?, ?)").bind(head.data.event_id, now).run();
    return "ignored";
  }
  const e = SubscriptionEvent.safeParse(event);
  if (!e.success) return "bad";
  const s = e.data.data;
  const workspace = eventWorkspace(event);
  const item = s.items[0];
  const plan = PLANS.find((p) => p === item?.price.custom_data?.plan);
  if (!workspace || !item || !plan) return "bad";
  const cycle = CYCLES.find((c) => c === item.price.custom_data?.cycle) ?? null;
  // only a cancel or pause changes what billing says; Paddle sends null once the customer undoes it, which clears it
  const change = SCHEDULED.find((a) => a === s.scheduled_change?.action) ?? null;
  const [mark, upsert] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO paddle_events (event_id, received_at) VALUES (?, ?)").bind(e.data.event_id, now),
    db
      .prepare(
        `INSERT INTO entitlements (workspace, plan, cycle, seats, status, subscription_id, customer_id, price_id, period_end, occurred_at,
           scheduled_change, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace) DO UPDATE SET plan = excluded.plan, cycle = excluded.cycle, seats = excluded.seats,
           status = excluded.status, subscription_id = excluded.subscription_id, customer_id = excluded.customer_id,
           price_id = excluded.price_id, period_end = excluded.period_end, occurred_at = excluded.occurred_at,
           scheduled_change = excluded.scheduled_change, scheduled_at = excluded.scheduled_at
         WHERE excluded.occurred_at > entitlements.occurred_at
           AND (excluded.subscription_id = entitlements.subscription_id OR excluded.status IN (${PAID_SQL})
             OR entitlements.status NOT IN (${PAID_SQL}))`,
      )
      .bind(
        workspace,
        plan,
        cycle,
        item.quantity,
        s.status,
        s.id,
        s.customer_id,
        item.price.id,
        s.current_billing_period?.ends_at ?? null,
        e.data.occurred_at,
        change,
        change && (s.scheduled_change?.effective_at ?? null),
      ),
  ]);
  if (!mark?.meta.changes) return "duplicate"; // a concurrent delivery of the same event got there first
  return upsert?.meta.changes ? "applied" : "stale";
}
