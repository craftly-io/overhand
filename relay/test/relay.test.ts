import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  daemonProof,
  ENTITLEMENT_TTL_MS,
  entitlementState,
  GRACE_MS,
  newKeyPair,
  PLAN_COPY,
  PLAN_TAX,
  PLANS,
  readToken,
  type Signal,
  sign,
  signingKey,
  signToken,
  verifyingKey,
} from "@overhand/contract";
import { INSTALL_COMMAND, PERMISSIONS, SETUP_PROMPT } from "@overhand/contract/links";
import { plainWords } from "@overhand/themes/words";
import { BILLING_FAILED, billingPage, CHECKOUT_SETTINGS, ON_A_PLAN, publicPage } from "../src/billing";
import { EUR_PER_USD, monthlyCost, TEN_K } from "../src/cost";
import {
  activeEntitlement,
  applyEvent,
  type D1,
  type Entitlement,
  entitlementOf,
  IPS_MS,
  type IpCache,
  inCidr,
  paddleHmac,
  paddleIps,
  selectPrices,
  verifyPaddleSignature,
} from "../src/paddle";
import { MAX_PEERS, type Who, Workspace } from "../src/signal";
import worker, { type Env, relayKeys, route, safeNext, TURN_GRANTS } from "../src/worker";
import { fakeD1, socket as newSocket, fakeState as newState } from "./fakes";

// ── fakes ──

const socket = () => newSocket<Signal>();
const fakeState = () => newState<Signal>();

const PEER_A = "11111111-1111-4111-8111-111111111111";
const PEER_B = "22222222-2222-4222-8222-222222222222";
const daemonWho: Who = { role: "daemon", pub: "PUB", name: "Mac" };

describe("signalling", () => {
  test("a browser's offer reaches its workspace's daemon, stamped; the answer goes back to that browser only", () => {
    const st = fakeState();
    const room = new Workspace(st, {});
    const d = socket();
    const a = socket();
    const b = socket();
    room.accept(d, daemonWho);
    room.accept(a, { role: "peer", id: PEER_A });
    room.accept(b, { role: "peer", id: PEER_B });
    expect(a.sent[0]).toEqual({ type: "daemon", online: true, pub: "PUB", name: "Mac" });
    room.webSocketMessage(a, JSON.stringify({ type: "offer", sdp: "v=0 offer", from: "spoofed" }));
    expect(d.sent).toEqual([{ type: "offer", sdp: "v=0 offer", from: PEER_A }]);
    room.webSocketMessage(d, JSON.stringify({ type: "answer", sdp: "v=0 answer", sig: "s", to: PEER_A }));
    expect(a.sent.at(-1)).toEqual({ type: "answer", sdp: "v=0 answer", sig: "s", to: PEER_A });
    expect(b.sent.filter((m) => m.type === "answer")).toEqual([]);
  });

  test("browsers can't send answers or address each other; the daemon can't broadcast by tag", () => {
    const st = fakeState();
    const room = new Workspace(st, {});
    const d = socket();
    const a = socket();
    const b = socket();
    room.accept(d, daemonWho);
    room.accept(a, { role: "peer", id: PEER_A });
    room.accept(b, { role: "peer", id: PEER_B });
    room.webSocketMessage(a, JSON.stringify({ type: "answer", sdp: "x", sig: "s", to: PEER_B }));
    room.webSocketMessage(a, JSON.stringify({ type: "ice", candidate: "c", mid: "0", to: PEER_B }));
    expect(b.sent.length).toBe(1); // only its "daemon online" greeting
    expect(d.sent).toEqual([{ type: "ice", candidate: "c", mid: "0", from: PEER_A }]);
    room.webSocketMessage(d, JSON.stringify({ type: "ice", candidate: "c", mid: "0", to: "peer" }));
    expect(a.sent.length + b.sent.length).toBe(2);
  });

  test("two workspaces are two objects: nothing crosses", () => {
    const one = new Workspace(fakeState(), {});
    const two = new Workspace(fakeState(), {});
    const d1 = socket();
    const p2 = socket();
    one.accept(d1, daemonWho);
    two.accept(p2, { role: "peer", id: PEER_A });
    expect(p2.sent[0]).toMatchObject({ type: "daemon", online: false });
    two.webSocketMessage(p2, JSON.stringify({ type: "offer", sdp: "x" }));
    expect(d1.sent).toEqual([]);
    expect(p2.sent.at(-1)).toMatchObject({ type: "daemon", online: false });
  });

  test("hibernation-friendly: a fresh instance (woken by a message) routes from tags and attachments alone", () => {
    const st = fakeState();
    const d = socket();
    const a = socket();
    new Workspace(st, {}).accept(d, daemonWho);
    new Workspace(st, {}).accept(a, { role: "peer", id: PEER_A });
    const woken = new Workspace(st, {});
    woken.webSocketMessage(a, JSON.stringify({ type: "offer", sdp: "o" }));
    expect(d.sent).toEqual([{ type: "offer", sdp: "o", from: PEER_A }]);
    new Workspace(st, {}).webSocketClose(a, 1000, "", true);
    expect(d.sent.at(-1)).toEqual({ type: "bye", from: PEER_A });
  });

  test("a new daemon connection replaces the old; its leaving tells browsers; browsers are capped", () => {
    const st = fakeState();
    const room = new Workspace(st, {});
    const old = socket();
    const d = socket();
    const a = socket();
    room.accept(old, daemonWho);
    room.accept(a, { role: "peer", id: PEER_A });
    room.accept(d, { ...daemonWho, name: "Mac 2" });
    expect(old.closed).toBe(4000);
    expect(a.sent.at(-1)).toMatchObject({ online: true, name: "Mac 2" });
    d.closed = 1000;
    room.webSocketClose(d, 1000, "", true);
    expect(a.sent.at(-1)).toMatchObject({ type: "daemon", online: false });
    for (let i = 1; i < MAX_PEERS; i++) expect(room.accept(socket(), { role: "peer", id: crypto.randomUUID() })).toBe(true);
    expect(room.accept(socket(), { role: "peer", id: crypto.randomUUID() })).toBe(false);
  });

  test("oversized and malformed messages are dropped", () => {
    const st = fakeState();
    const room = new Workspace(st, {});
    const d = socket();
    const a = socket();
    room.accept(d, daemonWho);
    room.accept(a, { role: "peer", id: PEER_A });
    room.webSocketMessage(a, JSON.stringify({ type: "offer", sdp: "x".repeat(40_000) }));
    room.webSocketMessage(a, "not json");
    room.webSocketMessage(a, new ArrayBuffer(8));
    expect(d.sent).toEqual([]);
  });
});

// ── the Worker ──

const keys = await newKeyPair();
let db: D1;
const forwarded: { ws: string; headers: Headers }[] = [];
const env = (): Env => ({
  WORKSPACE: {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (req) => {
        forwarded.push({ ws: String(id), headers: req.headers });
        return new Response("forwarded");
      },
    }),
  },
  TEAM: {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (req) => {
        forwarded.push({ ws: String(id), headers: req.headers });
        return new Response(null, { status: 204 });
      },
    }),
  },
  DB: db,
  SIGNING_KEY: keys.priv,
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  TURN_KEY_ID: "turn",
  TURN_KEY_API_TOKEN: "token",
  PADDLE_ENV: "sandbox",
  PADDLE_CLIENT_TOKEN: "test_token",
  PADDLE_API_KEY: "pdl_sdbx",
  PADDLE_WEBHOOK_SECRET: "pdl_ntfset_secret",
  SITE_ORIGIN: "https://www.example",
  DEV_LOGIN: "1",
});
const APP = "https://app.example";

beforeEach(() => {
  db = fakeD1();
  forwarded.length = 0;
});

async function sessionCookie(ws: string): Promise<string> {
  const token = await signToken((await relayKeys(env())).sign, {
    typ: "session",
    ws,
    email: `${ws}@x`,
    iat: Date.now(),
    exp: Date.now() + 60_000,
  });
  return `hl_session=${token}`;
}

async function linkedDaemon(ws: string) {
  const dk = await newKeyPair();
  const cert = await signToken((await relayKeys(env())).sign, { typ: "link", ws, email: "e", pub: dk.pub, name: "Mac", iat: Date.now() });
  const headers = async (method: string, path: string, ts = Date.now()) => ({
    "x-overhand-cert": cert,
    "x-overhand-ts": String(ts),
    "x-overhand-sig": await sign(await signingKey(dk.priv), daemonProof(method, path, ts)),
  });
  return { dk, cert, headers };
}

/** A subscription webhook body, as Paddle sends one. */
function subscriptionEvent(
  o: {
    id?: string;
    sub?: string;
    ws?: string;
    status?: string;
    plan?: string;
    qty?: number;
    at?: string;
    type?: string;
    scheduled?: string;
  } = {},
) {
  return {
    event_id: o.id ?? `evt_${crypto.randomUUID()}`,
    event_type: o.type ?? "subscription.created",
    occurred_at: o.at ?? "2026-10-20T10:00:00.000000Z",
    notification_id: "ntf_1",
    data: {
      id: o.sub ?? "sub_1",
      status: o.status ?? "active",
      customer_id: "ctm_1",
      custom_data: { workspace: o.ws ?? "user_A" },
      current_billing_period: { starts_at: "2026-10-20T10:00:00Z", ends_at: "2026-11-20T10:00:00Z" },
      scheduled_change: o.scheduled ? { action: o.scheduled, effective_at: "2026-11-20T10:00:00Z", resume_at: null } : null,
      items: [{ quantity: o.qty ?? 1, price: { id: "pri_x", custom_data: { plan: o.plan ?? "pro", cycle: "month" } } }],
    },
  };
}

/** Runs `fn` with `fetch` replaced by `fake`, restoring the real one after. */
async function withFetch<T>(
  fake: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(fake, { preconnect: real.preconnect });
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** Paddle's sandbox /ips answer, as the mocked fetch returns it. */
const PADDLE_IPS = { data: { ipv4_cidrs: ["34.194.127.46/32", "54.234.237.108/32", "10.20.0.0/16"] } };
const PADDLE_IP = "34.194.127.46";
const ipsFetch = async (input: string | URL | Request) =>
  String(input instanceof Request ? input.url : input) === "https://sandbox-api.paddle.com/ips"
    ? Response.json(PADDLE_IPS)
    : new Response(null, { status: 404 });

async function webhook(body: object, opts: { secret?: string; ts?: number; ip?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor((opts.ts ?? Date.now()) / 1000));
  const h1 = await paddleHmac(opts.secret ?? "pdl_ntfset_secret", ts, raw);
  const headers = { "paddle-signature": `ts=${ts};h1=${h1}`, "cf-connecting-ip": opts.ip ?? PADDLE_IP };
  return withFetch(ipsFetch, () => route(new Request(`${APP}/relay/paddle/webhook`, { method: "POST", headers, body: raw }), env()));
}

describe("auth and pairing within a workspace", () => {
  test("a daemon's socket goes to its own workspace's object, with the role set by the Worker", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const d = await linkedDaemon("user_A");
    const r = await route(
      new Request(`${APP}/relay/ws`, { headers: { upgrade: "websocket", "x-role": "peer", ...(await d.headers("GET", "/relay/ws")) } }),
      env(),
    );
    expect(await r.text()).toBe("forwarded");
    expect(forwarded[0]?.ws).toBe("user_A");
    expect(forwarded[0]?.headers.get("x-role")).toBe("daemon");
    expect(forwarded[0]?.headers.get("x-pub")).toBe(d.dk.pub);
  });

  test("a browser joins only its own session's workspace, only from the hosted page, only with a paid plan", async () => {
    const up = { upgrade: "websocket", origin: APP };
    const noPlan = await route(new Request(`${APP}/relay/ws`, { headers: { ...up, cookie: await sessionCookie("user_B") } }), env());
    expect(noPlan.status).toBe(402);
    await webhook(subscriptionEvent({ ws: "user_B" }));
    const other = await route(
      new Request(`${APP}/relay/ws`, { headers: { ...up, origin: "https://evil.example", cookie: await sessionCookie("user_B") } }),
      env(),
    );
    expect(other.status).toBe(403);
    const ok = await route(new Request(`${APP}/relay/ws`, { headers: { ...up, cookie: await sessionCookie("user_B") } }), env());
    expect(ok.status).toBe(200);
    expect(forwarded.map((f) => [f.ws, f.headers.get("x-role")])).toEqual([["user_B", "peer"]]);
    const anon = await route(new Request(`${APP}/relay/ws`, { headers: up }), env());
    expect(anon.status).toBe(401);
  });

  test("a daemon proof fails when stale, for another path, or under a forged certificate", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const d = await linkedDaemon("user_A");
    const ws = (h: Record<string, string>) => route(new Request(`${APP}/relay/ws`, { headers: { upgrade: "websocket", ...h } }), env());
    expect((await ws(await d.headers("GET", "/relay/ws", Date.now() - 10 * 60_000))).status).toBe(401);
    expect((await ws(await d.headers("POST", "/relay/entitlement"))).status).toBe(401);
    const rogue = await newKeyPair();
    const forged = await signToken(await signingKey(rogue.priv), {
      typ: "link",
      ws: "user_A",
      email: "e",
      pub: d.dk.pub,
      name: "x",
      iat: 0,
    });
    expect((await ws({ ...(await d.headers("GET", "/relay/ws")), "x-overhand-cert": forged })).status).toBe(401);
  });

  test("a session token can't stand in for a link certificate, nor the reverse", async () => {
    const k = await relayKeys(env());
    const session = await signToken(k.sign, { typ: "session", ws: "user_A", email: "e", iat: Date.now(), exp: Date.now() + 1e6 });
    expect(await readToken(k.verify, session, "link")).toBeNull();
    expect(await readToken(k.verify, session, "session")).toMatchObject({ ws: "user_A" });
  });

  test("linking: confirmation needs a session; the POST needs the hosted origin; the cert returns to 127.0.0.1 only", async () => {
    const q = new URLSearchParams({ pub: (await newKeyPair()).pub, name: "Mac", port: "4317", nonce: "n".repeat(22) });
    const anon = await route(new Request(`${APP}/relay/link?${q}`), env());
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toStartWith("/relay/login?next=");
    const page = await route(new Request(`${APP}/relay/link?${q}`, { headers: { cookie: await sessionCookie("user_A") } }), env());
    expect(await page.text()).toContain("Link Mac to user_A@x?");
    // under no-referrer Chrome sends `Origin: null` on the form's POST and the Origin check refuses every real link
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(readFileSync(join(import.meta.dir, "..", "wrangler.jsonc"), "utf8")).not.toContain("no-referrer");
    const post = (origin: string) =>
      route(new Request(`${APP}/relay/link`, { method: "POST", headers: { origin, cookie: "" }, body: q }), env());
    expect((await post(APP)).status).toBe(403); // no session
    const csrf = await route(
      new Request(`${APP}/relay/link`, {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: await sessionCookie("user_A") },
        body: q,
      }),
      env(),
    );
    expect(csrf.status).toBe(403);
    const ok = await route(
      new Request(`${APP}/relay/link`, { method: "POST", headers: { origin: APP, cookie: await sessionCookie("user_A") }, body: q }),
      env(),
    );
    const to = new URL(ok.headers.get("location") ?? "");
    expect(to.origin).toBe("http://127.0.0.1:4317");
    const cert = await readToken((await relayKeys(env())).verify, to.searchParams.get("cert") ?? "", "link");
    expect(cert).toMatchObject({ ws: "user_A", name: "Mac" });
  });

  test("sign-in returns only to a path on this site; dev login is localhost-only", async () => {
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/?upgrade=pro")).toBe("/?upgrade=pro");
    // browsers drop tabs and newlines from URLs, and read a backslash as a slash: each would leave the site
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\\evil.com", "//evil.com", "%2F%2Fevil.com"]) expect(safeNext(bad)).toBe("/");
    expect(safeNext("/relay/billing?plan=pro-year")).toBe("/relay/billing?plan=pro-year");
    expect((await route(new Request(`${APP}/relay/dev-login`), env())).status).toBe(404);
    const dev = await route(new Request("http://localhost:8787/relay/dev-login?ws=w1"), env());
    expect(dev.headers.get("set-cookie")).toContain("hl_session=");
  });
});

describe("entitlements", () => {
  test("a webhook with a valid signature grants; the daemon then gets a short-lived token", async () => {
    const r = await webhook(subscriptionEvent({ ws: "user_A", plan: "team", qty: 3 }));
    expect(await r.json()).toMatchObject({ result: "applied" });
    const d = await linkedDaemon("user_A");
    const res = await route(
      new Request(`${APP}/relay/entitlement`, { method: "POST", headers: await d.headers("POST", "/relay/entitlement") }),
      env(),
    );
    const { token } = (await res.json()) as { token: string };
    const claim = await readToken(await verifyingKey((await relayKeys(env())).pub), token, "ent");
    expect(claim).toMatchObject({ ws: "user_A", plan: "team", seats: 3 });
    expect((claim?.exp ?? 0) - (claim?.iat ?? 0)).toBe(ENTITLEMENT_TTL_MS);
  });

  test("a plan change for a team's paying workspace makes its room check who stays connected", async () => {
    await db.prepare("INSERT INTO teams (id, name, billing_ws, created_at, over_since) VALUES ('org_1', 'Crew', 'user_A', 0, NULL)").run();
    forwarded.length = 0;
    await webhook(subscriptionEvent({ ws: "user_A", plan: "team", qty: 3, status: "canceled" }));
    expect(forwarded.map((f) => [f.ws, f.headers.get("x-room")])).toEqual([["org_1", "check"]]);
    // a workspace with no team tells no room
    forwarded.length = 0;
    await webhook(subscriptionEvent({ ws: "user_B", plan: "team" }));
    expect(forwarded).toEqual([]);
  });

  test("invalid signatures, wrong secrets and stale timestamps are refused", async () => {
    expect((await webhook(subscriptionEvent(), { secret: "wrong" })).status).toBe(401);
    expect((await webhook(subscriptionEvent(), { ts: Date.now() - 60_000 })).status).toBe(401);
    const raw = JSON.stringify(subscriptionEvent());
    expect(await verifyPaddleSignature("ts=1;h1=", raw, "s", Date.now())).toBe(false);
    expect(await verifyPaddleSignature(null, raw, "s", Date.now())).toBe(false);
    const ts = String(Math.floor(Date.now() / 1000));
    const good = await paddleHmac("s", ts, raw);
    expect(await verifyPaddleSignature(`ts=${ts};h1=deadbeef;h1=${good}`, raw, "s", Date.now())).toBe(true); // secret rotation
    expect(await verifyPaddleSignature(`ts=${ts};h1=${good}`, `${raw} `, "s", Date.now())).toBe(false); // body changed
  });

  test("a replayed event id is a no-op; an older event never overwrites a newer one", async () => {
    const created = subscriptionEvent({ id: "evt_1", at: "2026-10-20T10:00:00.000000Z" });
    expect(await applyEvent(db, created, 0)).toBe("applied");
    expect(await applyEvent(db, created, 0)).toBe("duplicate");
    const canceled = subscriptionEvent({
      id: "evt_3",
      type: "subscription.canceled",
      status: "canceled",
      at: "2026-10-22T10:00:00.000000Z",
    });
    expect(await applyEvent(db, canceled, 0)).toBe("applied");
    const late = subscriptionEvent({ id: "evt_2", type: "subscription.updated", at: "2026-10-21T10:00:00.000000Z" });
    expect(await applyEvent(db, late, 0)).toBe("stale");
    const d = await linkedDaemon("user_A");
    const res = await route(
      new Request(`${APP}/relay/entitlement`, { method: "POST", headers: await d.headers("POST", "/relay/entitlement") }),
      env(),
    );
    expect(res.status).toBe(402);
    expect(await applyEvent(db, { event_id: "evt_9", event_type: "transaction.completed", data: {} }, 0)).toBe("ignored");
    expect(await applyEvent(db, subscriptionEvent({ id: "evt_10", ws: "" }), 0)).toBe("bad");
  });

  test("an event for another subscription never turns a paid one off; the same one still can", async () => {
    const at = (d: number) => `2026-10-2${d}T10:00:00.000000Z`;
    expect(await applyEvent(db, subscriptionEvent({ sub: "sub_pro", at: at(0) }), 0)).toBe("applied");
    expect(await applyEvent(db, subscriptionEvent({ sub: "sub_team", plan: "team", qty: 3, at: at(1) }), 0)).toBe("applied");
    const pro = { sub: "sub_pro", type: "subscription.canceled", status: "canceled", at: at(2) };
    expect(await applyEvent(db, subscriptionEvent(pro), 0)).toBe("stale");
    expect(await activeEntitlement(db, "user_A")).toMatchObject({ plan: "team", subscription_id: "sub_team" });
    const team = { sub: "sub_team", type: "subscription.canceled", status: "canceled", plan: "team", at: at(3) };
    expect(await applyEvent(db, subscriptionEvent(team), 0)).toBe("applied");
    expect(await activeEntitlement(db, "user_A")).toBeNull();
  });

  test("a cancel or pause at period end says until, never renewing; undoing it says renewing again", async () => {
    const status = async () => {
      const entitlement = await entitlementOf(db, "user_A");
      const html = billingPage({
        session: { typ: "session", ws: "user_A", email: "user_A@x", iat: Date.now(), exp: Date.now() + 60_000 },
        catalog: null,
        entitlement,
        active: true,
        linked: true,
        clientToken: "",
        environment: "sandbox",
        picked: "",
        site: "",
        nonce: "n",
      });
      return html.match(/<p>You're on [\s\S]*?<\/p>/)?.[0] ?? "";
    };
    const at = (d: number) => `2026-10-2${d}T10:00:00.000000Z`;
    expect(await applyEvent(db, subscriptionEvent({ at: at(0) }), 0)).toBe("applied");
    expect(await status()).toBe("<p>You're on <b>Pro</b>, renewing 2026-11-20.</p>");
    expect(await applyEvent(db, subscriptionEvent({ type: "subscription.updated", at: at(1), scheduled: "cancel" }), 0)).toBe("applied");
    expect(await status()).toBe("<p>You're on <b>Pro</b> until 2026-11-20; it won't renew. To keep it, choose Manage billing.</p>");
    expect(await applyEvent(db, subscriptionEvent({ type: "subscription.updated", at: at(2) }), 0)).toBe("applied");
    expect(await status()).toBe("<p>You're on <b>Pro</b>, renewing 2026-11-20.</p>");
    expect(await applyEvent(db, subscriptionEvent({ type: "subscription.updated", at: at(3), scheduled: "pause" }), 0)).toBe("applied");
    expect(await status()).toContain("until 2026-11-20; then it pauses.");
    expect(await applyEvent(db, subscriptionEvent({ type: "subscription.updated", at: at(4), scheduled: "resume" }), 0)).toBe("applied");
    expect(await status()).toContain(", renewing 2026-11-20.");
  });

  test("webhooks only from Paddle's listed addresses, checked before the signature", async () => {
    expect((await webhook(subscriptionEvent({ ws: "user_A" }))).status).toBe(200);
    expect((await webhook(subscriptionEvent(), { ip: "10.20.255.1" })).status).toBe(200); // inside the /16
    expect((await webhook(subscriptionEvent(), { ip: "34.194.127.47" })).status).toBe(403);
    expect((await webhook(subscriptionEvent(), { ip: "10.21.0.1" })).status).toBe(403);
    expect((await webhook(subscriptionEvent(), { ip: "" })).status).toBe(403);
    expect((await webhook(subscriptionEvent(), { ip: "34.194.127.47", secret: "wrong" })).status).toBe(403);
  });

  test("CIDR matching", () => {
    expect(inCidr("192.168.1.77", "192.168.1.0/24")).toBe(true);
    expect(inCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(inCidr("255.255.255.255", "255.255.255.255/32")).toBe(true);
    expect(inCidr("255.255.255.254", "255.255.255.255/32")).toBe(false);
    expect(inCidr("200.1.2.3", "128.0.0.0/1")).toBe(true); // the top bit, where signed bitwise ops go wrong
    expect(inCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(inCidr("1.2.3.4", "1.2.3.4")).toBe(true);
    expect(inCidr("1.2.3.4", "1.2.3.4/33")).toBe(false);
    expect(inCidr("1.2.3.256", "1.2.3.0/24")).toBe(false);
    expect(inCidr("::1", "1.2.3.0/24")).toBe(false);
  });

  test("the address list is cached; a failed fetch uses the last good list, and with none the webhook fails closed", async () => {
    const base = "https://sandbox-api.paddle.com";
    const cache: IpCache = { value: null };
    let calls = 0;
    const counted = async (input: string | URL | Request) => {
      calls++;
      return ipsFetch(input);
    };
    const down = async () => new Response(null, { status: 503 });
    expect(await withFetch(counted, () => paddleIps(base, 0, cache))).toEqual(PADDLE_IPS.data.ipv4_cidrs);
    expect(await withFetch(counted, () => paddleIps(base, IPS_MS - 1, cache))).toEqual(PADDLE_IPS.data.ipv4_cidrs);
    expect(calls).toBe(1);
    // expired and Paddle is down: the last good list still answers
    expect(await withFetch(down, () => paddleIps(base, IPS_MS * 5, cache))).toEqual(PADDLE_IPS.data.ipv4_cidrs);
    // never a good list (an error status, a malformed body, a network error): null
    expect(await withFetch(down, () => paddleIps(base, 0, { value: null }))).toBeNull();
    expect(
      await withFetch(
        async () => Response.json({ data: {} }),
        () => paddleIps(base, 0, { value: null }),
      ),
    ).toBeNull();
    const offline = async (): Promise<Response> => {
      throw new Error("offline");
    };
    expect(await withFetch(offline, () => paddleIps(base, 0, { value: null }))).toBeNull();
    // and the route answers 503 so Paddle retries (another base than the warm sandbox cache; fetch is mocked)
    const r = await withFetch(down, () =>
      route(new Request(`${APP}/relay/paddle/webhook`, { method: "POST", headers: { "cf-connecting-ip": PADDLE_IP }, body: "{}" }), {
        ...env(),
        PADDLE_ENV: "production",
      }),
    );
    expect(r.status).toBe(503);
  });

  test("tokens: active until expiry, then a grace period, then nothing", () => {
    const claim = { typ: "ent" as const, ws: "w", plan: "pro" as const, seats: 1, iat: 0, exp: 1000 };
    expect(entitlementState(null, 0)).toBe("none");
    expect(entitlementState(claim, 999)).toBe("active");
    expect(entitlementState(claim, 1000)).toBe("grace");
    expect(entitlementState(claim, 1000 + GRACE_MS - 1)).toBe("grace");
    expect(entitlementState(claim, 1000 + GRACE_MS)).toBe("none");
  });
});

describe("prices", () => {
  const price = (id: string, data: Record<string, unknown> | null, extra: object = {}) => ({
    id,
    status: "active",
    unit_price: { amount: "400", currency_code: "EUR" },
    billing_cycle: { interval: "month", frequency: 1 },
    quantity: { minimum: 1, maximum: 1 },
    custom_data: data,
    product: { name: "Overhand Pro" },
    ...extra,
  });

  test("selected by the {plan, cycle} tag, never by ID; untagged, archived and one-time prices skipped", () => {
    const c = selectPrices([
      price("pri_untagged", null),
      price("pri_archived", { plan: "pro", cycle: "month" }, { status: "archived" }),
      price("pri_once", { plan: "pro", cycle: "year" }, { billing_cycle: null }),
      price("pri_pm", { plan: "pro", cycle: "month" }),
      price("pri_pm_dup", { plan: "pro", cycle: "month" }),
      price("pri_py", { plan: "pro", cycle: "year" }, { unit_price: { amount: "4000", currency_code: "EUR" } }),
      price("pri_tm", { plan: "team", cycle: "month" }, { quantity: { minimum: 2, maximum: 500 } }),
      price("pri_bogus", { plan: "enterprise", cycle: "month" }),
      { junk: true },
    ]);
    expect(c.pro.month?.id).toBe("pri_pm");
    expect(c.pro.year).toMatchObject({ id: "pri_py", amount: 4000, currency: "EUR" });
    expect(c.team.month).toMatchObject({ id: "pri_tm", min: 2, max: 500 });
    expect(c.team.year).toBeUndefined();
  });
});

describe("checkout", () => {
  test("the billing page needs a session; checkout picks the tagged price and sets the workspace server-side", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const real = globalThis.fetch;
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/prices"))
        return Response.json({
          data: [
            {
              id: "pri_team_m",
              status: "active",
              unit_price: { amount: "800", currency_code: "EUR" },
              billing_cycle: { interval: "month", frequency: 1 },
              quantity: { minimum: 2, maximum: 500 },
              custom_data: { plan: "team", cycle: "month" },
            },
          ],
          meta: { pagination: { next: null, has_more: false } },
        });
      return Response.json({ data: { id: "txn_1" } }, { status: 201 });
    };
    globalThis.fetch = Object.assign(fake, { preconnect: real.preconnect });
    try {
      expect((await route(new Request(`${APP}/relay/billing?plan=team-month`), env())).status).toBe(302);
      const page = await route(
        new Request(`${APP}/relay/billing?plan=team-month`, { headers: { cookie: await sessionCookie("user_A") } }),
        env(),
      );
      const text = await page.text();
      expect(text).toContain("€8");
      expect(page.headers.get("content-security-policy")).toContain("frame-src https://*.paddle.com");
      expect(page.headers.get("cross-origin-embedder-policy")).toBeNull();
      const r = await route(
        new Request(`${APP}/relay/checkout`, {
          method: "POST",
          headers: { origin: APP, cookie: await sessionCookie("user_A") },
          body: JSON.stringify({ plan: "team", cycle: "month", seats: 1 }),
        }),
        env(),
      );
      expect(await r.json()).toEqual({ transactionId: "txn_1", email: "user_A@x" });
      expect(calls.at(-1)).toEqual({
        url: "https://sandbox-api.paddle.com/transactions",
        body: { items: [{ price_id: "pri_team_m", quantity: 2 }], custom_data: { workspace: "user_A" } },
      });
      expect(calls.every((c) => !c.url.startsWith("https://api.paddle.com"))).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("checkout while on a plan", () => {
  test("is refused with one plain line and never reaches Paddle, so a stale tab can't start a second subscription", async () => {
    expect(await applyEvent(db, subscriptionEvent({ ws: "user_A" }), 0)).toBe("applied");
    const urls: string[] = [];
    const r = await withFetch(
      async (input) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return new Response(null, { status: 500 });
      },
      async () =>
        route(
          new Request(`${APP}/relay/checkout`, {
            method: "POST",
            headers: { origin: APP, cookie: await sessionCookie("user_A") },
            body: JSON.stringify({ plan: "team", cycle: "month", seats: 2 }),
          }),
          env(),
        ),
    );
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: ON_A_PLAN });
    expect(urls).toEqual([]);
  });
});

describe("billing actions when Paddle refuses", () => {
  test("the page gets one plain line, never Paddle's own error", async () => {
    const prices = {
      data: [
        {
          id: "pri_team_m",
          status: "active",
          unit_price: { amount: "800", currency_code: "EUR" },
          billing_cycle: { interval: "month", frequency: 1 },
          quantity: { minimum: 2, maximum: 500 },
          custom_data: { plan: "team", cycle: "month" },
        },
      ],
      meta: { pagination: { next: null, has_more: false } },
    };
    const refusing = async (input: string | URL | Request) =>
      String(input instanceof Request ? input.url : input).includes("/prices")
        ? Response.json(prices)
        : Response.json({ error: { detail: "customer ctm_01x not found" } }, { status: 404 });
    const r = await withFetch(refusing, async () =>
      route(
        new Request(`${APP}/relay/checkout`, {
          method: "POST",
          headers: { origin: APP, cookie: await sessionCookie("user_A") },
          body: JSON.stringify({ plan: "team", cycle: "month", seats: 2 }),
        }),
        env(),
      ),
    );
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: BILLING_FAILED });
  });
});

describe("billing page signed out", () => {
  test("Paddle's payment link (?_ptxn=) opens its checkout signed out; anything else still goes to the public page", async () => {
    const res = await route(new Request(`${APP}/relay/billing?_ptxn=txn_01abc`), env());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("https://cdn.paddle.com/paddle/v2/paddle.js");
    expect(text).toContain("Paddle.Initialize");
    expect(text).toContain(`checkout: { settings: ${CHECKOUT_SETTINGS} }`);
    const nonce = /script-src 'nonce-([a-f0-9]+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(0);
    expect(text).toContain(`nonce="${nonce}"`);
    // nothing of an account on it
    expect(text).not.toContain("Sign out everywhere");
    for (const bad of ["txn_", "TXN_01ABC", "txn_01abc<script>", "ctm_01abc"])
      expect((await route(new Request(`${APP}/relay/billing?_ptxn=${encodeURIComponent(bad)}`), env())).status).toBe(302);
  });

  test("redirects to the one public page, /; signed in on sandbox the test-card note still shows", async () => {
    const anon = await route(new Request(`${APP}/relay/billing?plan=team-month`), env());
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/?plan=team-month");
    // without a known plan (Phone's bare link, Team settings' ?plan=team) the way back to billing still travels along
    for (const bad of ["", "?plan=team", "?plan=https://evil.example", "?plan=//evil.example", "?plan=/relay/link", "?plan=pro-week"])
      expect((await route(new Request(`${APP}/relay/billing${bad}`), env())).headers.get("location")).toBe("/?billing");
    const text = await withFetch(ipsFetch, async () =>
      (await route(new Request(`${APP}/relay/billing`, { headers: { cookie: await sessionCookie("user_A") } }), env())).text(),
    );
    expect(text).toContain("4242");
  });
});

describe("front page", () => {
  const assets = {
    fetch: async () => new Response("<!doctype html><title>app index</title>", { headers: { "content-type": "text/html" } }),
  };
  const list = [
    { plan: "pro", cycle: "month", amount: "900" },
    { plan: "team", cycle: "month", amount: "1200" },
  ].map((p) => ({
    id: `pri_${p.plan}`,
    status: "active",
    unit_price: { amount: p.amount, currency_code: "EUR" },
    billing_cycle: { interval: p.cycle, frequency: 1 },
    quantity: { minimum: 1, maximum: 500 },
    custom_data: { plan: p.plan, cycle: p.cycle },
  }));
  const catalogFetch = async () => Response.json({ data: list, meta: { pagination: { next: null, has_more: false } } });

  test("signed out, GET / is real HTML: what Overhand is, plans and prices, the policies, Sign in; no test-mode note", async () => {
    // the catalog may be cached by an earlier test, so only the shape and one known price are checked
    const res = await withFetch(catalogFetch, () => worker.fetch(new Request(`${APP}/`), { ...env(), ASSETS: assets }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    for (const want of [plainWords.hostedPublicLine, "Pro", "Team", "€", "Sign in", "Get the free app", PLAN_TAX])
      expect(text).toContain(want);
    for (const page of ["terms", "privacy", "refund", "contact"]) expect(text).toContain(`href="https://www.example/${page}"`);
    expect(text).not.toContain("app index");
    expect(text).not.toContain("4242");
    expect(text.toLowerCase()).not.toContain("dashboard");
  });

  test("the front page reads each plan's prices per cycle, Team per seat", async () => {
    const price = (amount: number) => ({ id: "pri", amount, currency: "EUR", min: 1, max: 500, product: "pro" });
    const text = await publicPage(
      { pro: { month: price(900), year: price(9000) }, team: { month: price(1200), year: price(12000) } },
      "",
    ).text();
    for (const want of ["€9 / month", "€90 / year", "€12 per seat / month", "€120 per seat / year"]) expect(text).toContain(want);
    // every plan line is the plans module's (packages/contract/src/plans.ts), nothing typed here
    const lines = [...text.matchAll(/<li><b>(\w+)<\/b>[\s\S]*?<br><small>(.*?)<\/small><ul>(.*?)<\/ul><\/li>/g)].map(
      ([, name, promise, items]) => ({
        name,
        promise,
        includes: [...(items ?? "").matchAll(/<li><small>(.*?)<\/small><\/li>/g)].map((m) => m[1]),
      }),
    );
    expect(lines).toEqual(
      PLANS.map((k) => ({ name: PLAN_COPY[k].name, promise: PLAN_COPY[k].promise, includes: [...PLAN_COPY[k].includes] })),
    );
    expect(text).toContain(PLAN_TAX);
  });

  test("every relay page is on the design system: its tokens, the hosted fonts, the mark, an ink primary", async () => {
    const res = publicPage(null, "");
    const text = await res.text();
    expect(text).toContain('<link rel="stylesheet" href="/fonts/instrument.css">');
    expect(text).toContain('<link rel="stylesheet" href="/relay/page.css">');
    expect(text).toContain("<svg");
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    // the styles are one file, so the page's HTML is its content
    const css = await (await worker.fetch(new Request(`${APP}/relay/page.css`), { ...env(), ASSETS: assets })).text();
    expect(css).toContain("--ink-12:");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("background:var(--ink-12)");
  });

  test("signed out, the front page says what Overhand is, how it works, who makes it and how to reach them", async () => {
    const text = await publicPage(null, "").text();
    expect(text).toContain("<title>Overhand: Hosted access to the Overhand on your computer</title>");
    expect(text).toMatch(/<meta name="description" content="Stop babysitting your coding agents\./);
    expect(text).toContain("<h2>How it works</h2>");
    expect(text).toContain("Overhand is made by Craftly Oy.");
    expect(text).toContain('href="mailto:hello@overhand.dev"');
  });

  test("when prices can't be read, the front page points at the site's pricing page", async () => {
    const text = await publicPage(null, "https://www.example").text();
    expect(text).toContain('href="https://www.example/pricing"');
    expect(text).toContain("See prices at overhand.dev/pricing");
  });

  test("Sign in is a plain link back to billing (the plan only when known), never a form the CSP would block", async () => {
    const page = (q: string) =>
      withFetch(catalogFetch, async () => (await worker.fetch(new Request(`${APP}/${q}`), { ...env(), ASSETS: assets })).text());
    const signIn = (html: string) => html.match(/<a class="button primary" href="([^"]*)">Sign in<\/a>/)?.[1];
    const home = await page("");
    expect(signIn(home)).toBe("/relay/login");
    expect(home).not.toMatch(/<form[^>]*\/relay\/login/);
    expect(signIn(await page("?plan=pro-year"))).toBe(`/relay/login?next=${encodeURIComponent("/relay/billing?plan=pro-year")}`);
    expect(signIn(await page("?billing"))).toBe(`/relay/login?next=${encodeURIComponent("/relay/billing")}`);
    for (const bad of ["?plan=team", "?plan=https://evil.example", "?plan=//evil.example", "?plan=%22%3E%3Cscript%3E"])
      expect(signIn(await page(bad))).toBe(`/relay/login?next=${encodeURIComponent("/relay/billing")}`);
    // the existing sign-in flow lands the buyer there (dev-login stands in for WorkOS's callback; both use safeNext)
    const landed = await route(new Request("http://localhost:8787/relay/dev-login?ws=w1&next=%2Frelay%2Fbilling%3Fplan%3Dpro-year"), env());
    expect(landed.headers.get("location")).toBe("/relay/billing?plan=pro-year");
  });

  test("HEAD / is answered like GET; a failing session check serves the app instead of an error", async () => {
    const head = await withFetch(catalogFetch, () =>
      worker.fetch(new Request(`${APP}/`, { method: "HEAD" }), { ...env(), ASSETS: assets }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    const broken = { ...env(), ASSETS: assets, SIGNING_KEY: "not-a-key" };
    const res = await worker.fetch(new Request(`${APP}/`, { headers: { cookie: await sessionCookie("user_A") } }), broken);
    expect(await res.text()).toContain("app index");
  });

  test("signed in with a plan, GET / is the app's index.html as today; without one, the relay's home", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const paid = await worker.fetch(new Request(`${APP}/`, { headers: { cookie: await sessionCookie("user_A") } }), {
      ...env(),
      ASSETS: assets,
    });
    expect(await paid.text()).toContain("app index");
    const free = await worker.fetch(new Request(`${APP}/`, { headers: { cookie: await sessionCookie("user_B") } }), {
      ...env(),
      ASSETS: assets,
    });
    expect(free.status).toBe(302);
    expect(free.headers.get("location")).toBe("/relay/home");
  });
});

describe("signed-in home", () => {
  const home = async (ws: string) => route(new Request(`${APP}/relay/home`, { headers: { cookie: await sessionCookie(ws) } }), env());
  /** The page's first heading: what a person reads first. */
  const first = (html: string) => html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const entitle = async (d: Awaited<ReturnType<typeof linkedDaemon>>) =>
    route(new Request(`${APP}/relay/entitlement`, { method: "POST", headers: await d.headers("POST", "/relay/entitlement") }), env());

  test("no computer linked: install first, with the site's own line and prompt; then how to link, waiting; plans last", async () => {
    const res = await home("user_A");
    const html = await res.text();
    expect(first(html)).toBe(plainWords.homeInstallTitle);
    expect(html).toContain(`<code id="install-line">${INSTALL_COMMAND}</code>`);
    expect(html).toContain(`<p id="install-prompt">${SETUP_PROMPT}</p>`);
    expect(html.match(/data-copy="install-(line|prompt)"/g)).toHaveLength(2);
    const order = [plainWords.homeInstallTitle, plainWords.homeLinkTitle, plainWords.homeWaiting, plainWords.homeSeeProLink];
    const at = order.map((s) => html.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain(plainWords.hostedChoosePlan);
    // its one inline script runs under a nonce, and may only read this origin
    const nonce = html.match(/<script nonce="([0-9a-f]+)">/)?.[1] ?? "";
    expect(nonce).not.toBe("");
    expect(res.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'; connect-src 'self'`);
  });

  test("the install line and the prompt are the site's: the home page renders the same constants", async () => {
    const { render } = await import("../../site/build");
    const site = render(readFileSync(join(import.meta.dir, "../../site/pages/index.html"), "utf8"), "./", "index.html");
    expect(site).toContain(INSTALL_COMMAND);
    expect(site.replace(/<[^>]+>/g, "")).toContain(SETUP_PROMPT);
  });

  test("computer linked, no plan: it says so, then Pro and Team", async () => {
    await entitle(await linkedDaemon("user_A"));
    const html = await (await home("user_A")).text();
    expect(first(html)).toBe(plainWords.homeLinkedTitle);
    for (const line of [...PLAN_COPY.pro.includes, ...PLAN_COPY.team.includes]) expect(html).toContain(line);
    expect(html).toContain('href="/relay/billing"');
    expect(html).not.toContain(plainWords.homeInstallTitle);
  });

  test("with a paid plan, or signed out, home is /", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    expect((await home("user_A")).headers.get("location")).toBe("/");
    expect((await route(new Request(`${APP}/relay/home`), env())).headers.get("location")).toBe("/");
  });

  test("the waiting line reads /relay/me: linked for the session's own workspace only, and not once unlinked", async () => {
    const me = async (ws: string) =>
      (
        (await (await route(new Request(`${APP}/relay/me`, { headers: { cookie: await sessionCookie(ws) } }), env())).json()) as {
          linked: boolean;
        }
      ).linked;
    expect(await me("user_A")).toBe(false);
    const d = await linkedDaemon("user_A");
    expect((await entitle(d)).status).toBe(402);
    expect(await me("user_A")).toBe(true);
    expect(await me("user_B")).toBe(false);
    const unlink = await route(
      new Request(`${APP}/relay/unlink`, { method: "POST", headers: await d.headers("POST", "/relay/unlink") }),
      env(),
    );
    expect(unlink.status).toBe(200);
    expect(await me("user_A")).toBe(false);
  });

  test("billing on Free with no computer: install above the plans, and Free's card points at it", async () => {
    const page = async (ws: string) =>
      withFetch(ipsFetch, async () =>
        (await route(new Request(`${APP}/relay/billing`, { headers: { cookie: await sessionCookie(ws) } }), env())).text(),
      );
    const fresh = await page("user_A");
    expect(fresh).toContain(`${plainWords.billingNotInstalled} ${plainWords.billingInstall}`);
    expect(fresh).toContain(INSTALL_COMMAND);
    await entitle(await linkedDaemon("user_A"));
    expect(await page("user_A")).not.toContain(INSTALL_COMMAND);
  });
});

describe("Paddle Retain", () => {
  // the catalog fetch 404s under this mock, so the page renders without prices; only the entitlement matters here
  const page = async (ws: string) =>
    withFetch(ipsFetch, async () =>
      (await route(new Request(`${APP}/relay/billing`, { headers: { cookie: await sessionCookie(ws) } }), env())).text(),
    );

  test("pwCustomer carries the workspace's Paddle customer ID once a webhook recorded one, and is omitted before", async () => {
    expect(await page("user_A")).not.toContain("pwCustomer");
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const text = await page("user_A");
    expect(text).toContain(`pwCustomer: {"id":"ctm_1"},`);
    expect(text).not.toMatch(/pwCustomer: \{"id":"(user_A|user_A@x)"/);
    expect(await page("user_B")).not.toContain("pwCustomer");
  });

  test("anything that isn't a Paddle customer ID is left out", async () => {
    const entitlement: Entitlement = {
      workspace: "user_A",
      plan: "pro",
      cycle: "month",
      seats: 1,
      status: "active",
      subscription_id: "sub_1",
      customer_id: "ctm_1",
      price_id: "pri_x",
      period_end: null,
      occurred_at: "2026-10-20T10:00:00Z",
    };
    const render = (customer_id: string) =>
      billingPage({
        session: { typ: "session", ws: "user_A", email: "user_A@x", iat: Date.now(), exp: Date.now() + 60_000 },
        catalog: null,
        entitlement: { ...entitlement, customer_id },
        active: true,
        linked: true,
        clientToken: "test_x",
        environment: "sandbox",
        picked: "",
        site: "",
        nonce: "n",
      });
    expect(render("ctm_01h8441jn5pcwrfhwh78jqt8hk")).toContain(`pwCustomer: {"id":"ctm_01h8441jn5pcwrfhwh78jqt8hk"},`);
    for (const bad of ["user_A", "user_A@x", "", 'ctm_1"});alert(1);//']) expect(render(bad)).not.toContain("pwCustomer");
  });
});

describe("billing plans", () => {
  const price = (id: string, amount: number, min = 1, max = 1) => ({ id, amount, currency: "EUR", min, max, product: "p" });
  const catalog = {
    pro: { month: price("pri_pm", 400), year: price("pri_py", 4000) },
    team: { month: price("pri_tm", 800, 2, 500), year: price("pri_ty", 8000, 2, 500) },
  };
  const pro: Entitlement = {
    workspace: "user_A",
    plan: "pro",
    cycle: "month",
    seats: 1,
    status: "active",
    subscription_id: "sub_1",
    customer_id: "ctm_1",
    price_id: "pri_pm",
    period_end: null,
    occurred_at: "2026-10-20T10:00:00Z",
  };
  const render = (
    o: { catalog?: Parameters<typeof billingPage>[0]["catalog"]; active?: boolean; picked?: string; linked?: boolean } = {},
  ) =>
    billingPage({
      session: { typ: "session", ws: "user_A", email: "user_A@x", iat: Date.now(), exp: Date.now() + 60_000 },
      catalog: o.catalog === undefined ? catalog : o.catalog,
      entitlement: o.active ? pro : null,
      active: Boolean(o.active),
      linked: o.linked ?? true,
      clientToken: "test_x",
      environment: "sandbox",
      picked: o.picked ?? "",
      site: "",
      nonce: "n",
    });
  const cardOf = (html: string, plan: string) =>
    html.match(new RegExp(`<(form|section) class="plan[^"]*"[^>]*aria-labelledby="plan-${plan}">[\\s\\S]*?</\\1>`))?.[0] ?? "";

  test("one card per plan, each with its promise and every line of its includes from plans.ts; the tax line once", () => {
    const html = render();
    for (const plan of ["free", ...PLANS] as const) {
      const card = cardOf(html, plan);
      expect(card).toContain(PLAN_COPY[plan].promise);
      for (const line of PLAN_COPY[plan].includes) expect(card).toContain(`<li>${line}</li>`);
    }
    expect(html.split(PLAN_TAX).length).toBe(2);
    expect(html.toLowerCase()).not.toContain("dashboard");
  });

  test("Free with no computer linked: Free's card links to the install block above the plans; linked, neither shows", () => {
    const fresh = render({ linked: false });
    expect(cardOf(fresh, "free")).toContain(`href="#install">${plainWords.billingInstall}</a>`);
    expect(fresh.indexOf('id="install"')).toBeLessThan(fresh.indexOf(`<h2>${plainWords.hostedPlans}</h2>`));
    expect(render()).not.toContain('id="install"');
    expect(render({ active: true, linked: false })).not.toContain('id="install"');
  });

  test("Paddle's checkout is one page, in English, dark or light as the page is; the overlay keeps the same settings", () => {
    expect(CHECKOUT_SETTINGS).toContain(`variant: "one-page"`);
    expect(CHECKOUT_SETTINGS).toContain(`theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"`);
    const html = render();
    expect(html).toContain(`checkout: { settings: ${CHECKOUT_SETTINGS} }`);
    expect(html).toContain(`settings: { ...${CHECKOUT_SETTINGS}, displayMode: "overlay" }`);
  });

  test("the yearly saving is computed from the catalog's prices, never written down", () => {
    expect(cardOf(render(), "pro")).toContain('€40<small> / year · <span class="save">2 months free</span>');
    const three = render({ catalog: { ...catalog, pro: { month: price("a", 500), year: price("b", 4500) } } });
    expect(cardOf(three, "pro")).toContain("3 months free");
    const uneven = render({ catalog: { ...catalog, pro: { month: price("a", 400), year: price("b", 4500) } } });
    expect(cardOf(uneven, "pro")).toContain("save €3");
    const none = render({ catalog: { ...catalog, pro: { month: price("a", 400), year: price("b", 4800) } } });
    expect(cardOf(none, "pro")).not.toMatch(/months free|save €/);
  });

  test("checkout posts the same plan, cycle and seats as before: the cycle a radio inside its plan's form", () => {
    const html = render({ picked: "team-year" });
    const team = cardOf(html, "team");
    expect(team).toStartWith('<form class="plan picked" data-plan="team"');
    expect(team).toContain('<input type="radio" name="cycle" value="month">');
    expect(team).toContain('<input type="radio" name="cycle" value="year" checked>');
    expect(team).toContain('name="seats" min="2" max="500" value="2"');
    expect(team).toContain('<button class="primary">Choose Team</button>');
    expect(cardOf(html, "pro")).toContain('<input type="radio" name="cycle" value="month" checked>');
    expect(html).toContain('post("/relay/checkout", { plan: f.dataset.plan, cycle: f.cycle.value, seats })');
    expect(cardOf(html, "free")).toContain(plainWords.billingYourPlan);
  });

  test("on a plan, its card is marked and nothing is for sale a second time", () => {
    const html = render({ active: true });
    expect(cardOf(html, "pro")).toContain(plainWords.billingYourPlan);
    expect(cardOf(html, "free")).not.toContain(plainWords.billingYourPlan);
    expect(html).not.toContain('<form class="plan');
    expect(cardOf(html, "team")).toContain("€8<small> per seat / month");
  });

  test("without a catalog the page says prices couldn't be loaded", () => {
    expect(render({ catalog: null })).toContain("Prices couldn't be loaded from Paddle");
  });
});

describe("cost model", () => {
  test("10,000 concurrent users stay under €100/month, and the formula reacts to TURN volume", () => {
    const base = monthlyCost(TEN_K);
    expect(base.usd * EUR_PER_USD).toBeLessThan(100);
    expect(base.usd).toBeGreaterThan(5); // never below the Workers Paid base
    expect(base.lines.doDuration).toBe(0); // hibernation: billed only while handlers run
    const heavy = monthlyCost({ ...TEN_K, turnShare: 0.3, mbPerRelayedOpen: 2 });
    expect(heavy.turnGb).toBeCloseTo(3600);
    expect(heavy.lines.turn).toBeCloseTo((3600 - 1000) * 0.05);
    expect(monthlyCost({ ...TEN_K, concurrent: 0 }).usd).toBe(5);
  });
});

describe("revocation", () => {
  test("sign out everywhere voids every earlier session of the workspace and closes its browsers' sockets", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const old = await sessionCookie("user_A");
    const other = await sessionCookie("user_B");
    const me = async (cookie: string, now?: number) =>
      (await (await route(new Request(`${APP}/relay/me`, { headers: { cookie } }), env(), now)).json()) as { signedIn: boolean };
    expect((await me(old)).signedIn).toBe(true);
    const out = (origin: string, now?: number) =>
      route(new Request(`${APP}/relay/signout-all`, { method: "POST", headers: { origin, cookie: old } }), env(), now);
    expect((await out("https://evil.example")).status).toBe(403);
    const t = Date.now();
    const r = await out(APP, t);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(forwarded.map((f) => [f.ws, f.headers.get("x-kick")])).toEqual([["user_A", "peers"]]);
    expect((await me(old, t + 1)).signedIn).toBe(false);
    const up = { upgrade: "websocket", origin: APP, cookie: old };
    expect((await route(new Request(`${APP}/relay/ws`, { headers: up }), env(), t + 1)).status).toBe(401);
    // another workspace is untouched, and signing in again works
    expect((await me(other, t + 1)).signedIn).toBe(true);
    const fresh = await signToken((await relayKeys(env())).sign, { typ: "session", ws: "user_A", email: "e", iat: t + 5, exp: t + 60_000 });
    expect((await me(`hl_session=${fresh}`, t + 6)).signedIn).toBe(true);
  });

  test("unlinking a computer revokes its key: no entitlement, no socket, its open socket closed; others stay", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const d = await linkedDaemon("user_A");
    const other = await linkedDaemon("user_A");
    const post = async (dm: typeof d, path: string) =>
      route(new Request(`${APP}${path}`, { method: "POST", headers: await dm.headers("POST", path) }), env());
    expect((await post(d, "/relay/entitlement")).status).toBe(200);
    expect((await post(d, "/relay/unlink")).status).toBe(200);
    expect(forwarded.map((f) => [f.ws, f.headers.get("x-kick")])).toEqual([["user_A", `daemon:${d.dk.pub}`]]);
    expect((await post(d, "/relay/entitlement")).status).toBe(401);
    expect((await post(d, "/relay/unlink")).status).toBe(401);
    const sock = await route(
      new Request(`${APP}/relay/ws`, { headers: { upgrade: "websocket", ...(await d.headers("GET", "/relay/ws")) } }),
      env(),
    );
    expect(sock.status).toBe(401);
    expect((await post(other, "/relay/entitlement")).status).toBe(200);
  });

  test("a client can't smuggle a kick through its own upgrade", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const up = { upgrade: "websocket", origin: APP, cookie: await sessionCookie("user_A"), "x-kick": "peers" };
    await route(new Request(`${APP}/relay/ws`, { headers: up }), env());
    expect(forwarded[0]?.headers.get("x-kick")).toBeNull();
  });

  test("the room closes every browser, or only the daemon with that key, telling the other side", () => {
    const room = new Workspace(fakeState(), {});
    const d = socket();
    const a = socket();
    const b = socket();
    room.accept(d, daemonWho);
    room.accept(a, { role: "peer", id: PEER_A });
    room.accept(b, { role: "peer", id: PEER_B });
    room.kick("daemon:SOMEONE_ELSE");
    expect(d.closed).toBeNull();
    room.kick("peers");
    expect([a.closed, b.closed]).toEqual([4001, 4001]);
    expect(d.sent.filter((m) => m.type === "bye").length).toBe(2);
    const c = socket();
    room.accept(c, { role: "peer", id: PEER_A });
    room.kick(`daemon:${daemonWho.role === "daemon" ? daemonWho.pub : ""}`);
    expect(d.closed).toBe(4001);
    expect(c.sent.at(-1)).toMatchObject({ type: "daemon", online: false });
  });
});

describe("TURN budget", () => {
  const turn = { iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }] };
  test("TURN credentials until the workspace's monthly grants run out, then STUN only; a new month starts over", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    await webhook(subscriptionEvent({ ws: "user_B" }));
    let calls = 0;
    const capped = { ...env(), TURN_MONTHLY_GRANTS: "2" };
    const ice = async (ws: string, now: number) => {
      const token = await signToken((await relayKeys(env())).sign, { typ: "session", ws, email: "e", iat: 0, exp: now + 60_000 });
      const cookie = `hl_session=${token}`;
      const res = await withFetch(
        async () => {
          calls++;
          return Response.json(turn);
        },
        () => route(new Request(`${APP}/relay/ice`, { method: "POST", headers: { origin: APP, cookie } }), capped, now),
      );
      return JSON.stringify(await res.json());
    };
    const t = Date.parse("2026-10-20T12:00:00Z");
    expect(await ice("user_A", t)).toContain("turn:");
    expect(await ice("user_A", t)).toContain("turn:");
    const over = await ice("user_A", t);
    expect(over).not.toContain("turn:");
    expect(over).toContain("stun:");
    expect(calls).toBe(2); // past the cap, Cloudflare isn't even asked
    expect(await ice("user_B", t)).toContain("turn:");
    expect(await ice("user_A", Date.parse("2026-11-01T00:00:00Z"))).toContain("turn:");
  });

  test("without the var, the default cap applies", async () => {
    await webhook(subscriptionEvent({ ws: "user_A" }));
    const cookie = await sessionCookie("user_A");
    await db
      .prepare("INSERT INTO turn_grants (workspace, month, n) VALUES (?, ?, ?)")
      .bind("user_A", new Date().toISOString().slice(0, 7), TURN_GRANTS)
      .run();
    const res = await withFetch(
      async () => Response.json(turn),
      () => route(new Request(`${APP}/relay/ice`, { method: "POST", headers: { origin: APP, cookie } }), env()),
    );
    expect(await res.json()).toMatchObject({ turn: false });
  });
});

describe("what a security scanner sees", () => {
  const assets = { fetch: async () => new Response("", { status: 404 }) };
  const get = (path: string) => worker.fetch(new Request(`${APP}${path}`), { ...env(), ASSETS: assets });
  test("robots.txt and security.txt are real files; a missing file is a 404, never the app's page", async () => {
    expect(await (await get("/robots.txt")).text()).toContain("Disallow: /relay/");
    const sec = await (await get("/.well-known/security.txt")).text();
    expect(sec).toMatch(/^Contact: mailto:hello@overhand\.dev$/m);
    expect(Date.parse(sec.match(/^Expires: (.+)$/m)?.[1] ?? "")).toBeGreaterThan(Date.now());
    expect((await get("/js/raif_ch.js")).status).toBe(404);
    const cfg = readFileSync(join(import.meta.dir, "..", "wrangler.jsonc"), "utf8");
    expect(cfg).toContain('"not_found_handling": "none"');
    for (const p of ["/robots.txt", "/.well-known/security.txt"]) expect(cfg).toContain(`"${p}"`);
  });
  test("every relay page and every static file turns off the same unused browser features", async () => {
    expect((await route(new Request(`${APP}/relay/login`), env())).headers.get("permissions-policy")).toBe(PERMISSIONS);
    expect(readFileSync(join(import.meta.dir, "..", "wrangler.jsonc"), "utf8")).toContain(`Permissions-Policy: ${PERMISSIONS}`);
  });
});
