/**
 * Access from anywhere (Settings → Connections): the daemon's side of the hosted relay. Off unless you turn it on, and it
 * connects only while a valid entitlement exists. The daemon holds an Ed25519 device key (.relay.json, 0600) that you
 * link to your account once from a signed-in browser; it then keeps one hibernating WebSocket to its workspace's
 * Durable Object, answers browsers' WebRTC offers, and serves the same API over the data channel as over HTTP, through
 * the server's own handler, so device pairing, the Origin check and every permission rule apply unchanged. A remote
 * peer is never "local".
 *
 * Nothing local depends on this: the relay being down, unpaid or unreachable only means the hosted page can't connect.
 * Every network call here is async; none sits on a timer path that could block.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  APP,
  b64url,
  bodyFrames,
  daemonProof,
  type EntitlementClaim,
  entitlementState,
  type Frame,
  fingerprint,
  GZIP_FRAME_BYTES,
  newKeyPair,
  parseFrame,
  RELAY_PUBLIC_KEY,
  readToken,
  type Signal,
  sign,
  signingKey,
  unb64url,
  verifyingKey,
} from "@overhand/contract";
import { z } from "zod";
import { OPS } from "./env";

/** The relay's origin (also the hosted dashboard's). */
export const relayUrl = (): string => (process.env.OVERHAND_RELAY_URL ?? APP).replace(/\/$/, "");
/** The relay's public key, or "" when this build has none (then Access from anywhere says it isn't available). */
const relayKey = (): string => process.env.OVERHAND_RELAY_KEY ?? RELAY_PUBLIC_KEY;

const StateSchema = z.object({
  enabled: z.boolean().default(false),
  priv: z.string().default(""),
  pub: z.string().default(""),
  /** The link certificate the relay issued for this key: proves which workspace it belongs to. */
  cert: z.string().default(""),
  email: z.string().default(""),
  /** The last entitlement token; kept through GRACE_MS when the relay can't be reached. */
  ent: z.string().default(""),
});
type State = z.infer<typeof StateSchema>;

const file = () => join(OPS, ".relay.json");
function load(): State {
  try {
    return StateSchema.parse(existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
  } catch {
    return StateSchema.parse({});
  }
}
const save = (s: State) => writeFileSync(file(), JSON.stringify(s), { mode: 0o600 });

/** The device key, made on first use. */
async function deviceKey(): Promise<State> {
  const s = load();
  if (s.priv && s.pub) return s;
  const k = await newKeyPair();
  const next = { ...s, priv: k.priv, pub: k.pub, cert: "", email: "", ent: "" };
  save(next);
  return next;
}

// ── entitlement ──

let claim: EntitlementClaim | null = null;
let claimToken = "";
/** The verified entitlement, re-read when the stored token changes. */
async function entitlement(s = load()): Promise<EntitlementClaim | null> {
  if (s.ent === claimToken) return claim;
  claimToken = s.ent;
  claim = s.ent && relayKey() ? await readToken(await verifyingKey(relayKey()), s.ent, "ent").catch(() => null) : null;
  return claim;
}

/**
 * Whether hosted features may run: relay connection, Web Push through the hosted page. True while the token is valid
 * and through its offline grace. Only hosted features ask; nothing local ever does.
 */
export function hostedActive(now = Date.now()): boolean {
  return entitlementState(claim, now) !== "none";
}

let lastTs = 0;
/**
 * A request to the relay signed with the device key and carrying the link certificate. Each gets its own millisecond:
 * the relay takes a signature once, so two requests in the same millisecond to one path must still differ.
 */
async function signed(path: string, method = "POST", s = load()): Promise<Record<string, string>> {
  lastTs = Math.max(Date.now(), lastTs + 1);
  const ts = lastTs;
  return {
    "x-overhand-cert": s.cert,
    "x-overhand-ts": String(ts),
    "x-overhand-sig": await sign(await signingKey(s.priv), daemonProof(method, path, ts)),
  };
}

/** Whether this computer is linked to an account (Teams needs the link, not the Access from anywhere switch). */
export const relayLinked = (): boolean => Boolean(load().cert);

/**
 * A request to the relay as this daemon (signed with its device key, carrying its link certificate), or null when it
 * isn't linked. Network failures throw; callers decide.
 */
export async function relayRequest(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response | null> {
  const s = load();
  if (!s.cert) return null;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return fetch(`${relayUrl()}${path}`, {
    method,
    headers: {
      ...(await signed(new URL(path, "http://x").pathname, method, s)),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
}

/** A signed WebSocket address on the relay (the proof rides in the query), or null when not linked. */
export async function relaySocketUrl(path: string, query: Record<string, string> = {}): Promise<string | null> {
  const s = load();
  if (!s.cert) return null;
  const h = await signed(path, "GET", s);
  const q = new URLSearchParams({
    ...query,
    cert: h["x-overhand-cert"] ?? "",
    ts: h["x-overhand-ts"] ?? "",
    sig: h["x-overhand-sig"] ?? "",
  });
  return `${relayUrl().replace(/^http/, "ws")}${path}?${q}`;
}

let lastError = "";
/**
 * Asks the relay for a fresh entitlement token. A 402 (no paid plan) clears it; a network failure keeps the old one,
 * so a relay outage never takes hosted features away before the grace period ends.
 */
export async function refreshEntitlement(): Promise<void> {
  const s = load();
  if (!s.cert) return;
  try {
    const r = await fetch(`${relayUrl()}/relay/entitlement`, {
      method: "POST",
      headers: await signed("/relay/entitlement"),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 402 || r.ok) {
      const body = z.object({ token: z.string().optional(), cert: z.string().optional() }).parse(await r.json().catch(() => ({})));
      if (r.ok && !body.token) throw new Error("the relay sent no token");
      // the relay renews the link certificate with each answer, plan or not: kept only when it's for this key
      const link = body.cert && relayKey() ? await readToken(await verifyingKey(relayKey()), body.cert, "link") : null;
      const cur = load();
      save({ ...cur, ent: r.ok ? (body.token ?? "") : "", cert: link?.pub === cur.pub && body.cert ? body.cert : cur.cert });
      lastError = "";
    } else lastError = `the relay answered ${r.status}`;
  } catch (e) {
    lastError = `couldn't reach the relay: ${e instanceof Error ? e.message : String(e)}`;
  }
  await entitlement();
  syncConnection();
}

// ── linking ──

const nonces = new Map<string, number>();
/** The hosted page that links this daemon to your account, with a single-use nonce for the way back. */
export async function linkUrl(port: number, now = Date.now()): Promise<string> {
  const s = await deviceKey();
  const nonce = b64url(new Uint8Array(randomBytes(18)));
  for (const [n, at] of nonces) if (now - at > 10 * 60_000) nonces.delete(n);
  nonces.set(nonce, now);
  const q = new URLSearchParams({
    pub: s.pub,
    name:
      hostname()
        .replace(/\.local$/, "")
        .slice(0, 60) || "Overhand",
    port: String(port),
    nonce,
  });
  return `${relayUrl()}/relay/link?${q}`;
}

/**
 * The relay sending the browser back with the link certificate. Only with a nonce this daemon made in the last ten
 * minutes (once), and only a certificate the relay signed for this daemon's own key.
 */
export async function finishLink(nonce: string, cert: string, now = Date.now()): Promise<{ ok: true } | { error: string }> {
  const at = nonces.get(nonce);
  nonces.delete(nonce);
  if (at === undefined || now - at > 10 * 60_000) return { error: "That link expired. Start it again from Settings → Connections." };
  if (!relayKey()) return { error: "This build has no relay key." };
  const link = await readToken(await verifyingKey(relayKey()), cert, "link");
  const s = load();
  if (!link || link.pub !== s.pub) return { error: "The relay's answer didn't check out; nothing was linked." };
  save({ ...s, cert, email: link.email, enabled: true, ent: "" });
  void refreshEntitlement();
  return { ok: true };
}

/** Turns Access from anywhere on or off (off closes the connection at once). */
export function setEnabled(on: boolean): void {
  save({ ...load(), enabled: on });
  syncConnection();
  if (on) void refreshEntitlement();
}

/**
 * Unlink this computer: the relay revokes its key first (so a copy of the key and certificate is useless too), then it
 * forgets the link, the entitlement and the key; linking again makes a new key. When the relay can't be reached it
 * still unlinks here and says so: the certificate then stays valid at the relay, but its key is gone from this computer.
 */
export async function unlink(): Promise<void> {
  const s = load();
  if (s.cert) {
    try {
      const r = await fetch(`${relayUrl()}/relay/unlink`, {
        method: "POST",
        headers: await signed("/relay/unlink"),
        signal: AbortSignal.timeout(10_000),
      });
      // 401: already revoked, or a certificate the relay never knew; either way nothing is left to revoke
      lastError = r.ok || r.status === 401 ? "" : `Unlinked here, but the relay answered ${r.status}; it may still accept the old link.`;
    } catch {
      lastError = "Unlinked here, but the relay couldn't be reached to revoke the old link.";
    }
  }
  save({ ...load(), cert: "", email: "", ent: "", enabled: false, priv: "", pub: "" });
  claim = null;
  claimToken = "";
  syncConnection();
}

/** The hosted origin a channel request presents, when Access from anywhere is on: the server lets it in like a tailnet address. */
export const relayOrigins = (): string[] => {
  const s = load();
  return s.enabled && s.cert ? [new URL(relayUrl()).origin] : [];
};

/** The pairing link for a phone over the relay: the hosted page, the code, and this daemon's key to pin. */
export function relayPairUrl(code: string): string {
  const s = load();
  return s.enabled && s.cert ? `${relayUrl()}/?pair=${code}#k=${s.pub}` : "";
}

/** What Settings → Connections shows. */
export async function relayStatus() {
  const s = load();
  const c = await entitlement(s);
  return {
    available: Boolean(relayKey()),
    enabled: s.enabled,
    linked: Boolean(s.cert),
    email: s.email,
    fingerprint: s.pub ? await fingerprint(s.pub) : "",
    plan: c?.plan ?? null,
    entitlement: entitlementState(c, Date.now()),
    online: socket?.readyState === WebSocket.OPEN,
    peers: peers.size,
    app: relayUrl(),
    error: lastError,
  };
}

// ── the data channel: the dashboard's API, through the server's own handler ──

/** Headers a browser may send through the channel. Host, Origin and the forwarding header are always set here. */
const PASSED = ["content-type", "accept"];
/** Request bodies over the channel are small JSON; more is refused. */
const MAX_BODY = 1024 * 1024;
const COMPRESSIBLE = /json|text|event-stream/;

/**
 * Serves API requests arriving as frames, through `handler` (the server's handle()). Each request is rebuilt as a
 * remote one: Host and Origin are the hosted page's, a forwarding header marks it as proxied (so isLocal is false and
 * a paired device's session is required), and only the session cookie and content headers come through.
 */
export function channelServer(handler: (req: Request) => Promise<Response>, send: (frame: string) => void, origin: string) {
  const incoming = new Map<number, { head: Extract<Frame, { t: "req" }>; body: Uint8Array[]; size: number }>();
  const running = new Map<number, AbortController>();
  const out = (f: Frame) => send(JSON.stringify(f));

  async function run(head: Extract<Frame, { t: "req" }>, body: Uint8Array<ArrayBuffer>) {
    const ac = new AbortController();
    running.set(head.id, ac);
    try {
      if (!head.path.startsWith("/api/")) {
        out({ t: "res", id: head.id, status: 404, headers: {} });
        return;
      }
      const headers = new Headers({ host: new URL(origin).host, origin, "x-forwarded-for": "webrtc" });
      for (const h of PASSED) if (head.headers[h]) headers.set(h, head.headers[h]);
      const session = /(?:^|;\s*)(overhand_session=[A-Za-z0-9_-]{1,100})/.exec(head.headers.cookie ?? "")?.[1];
      if (session) headers.set("cookie", session);
      const hasBody = head.method !== "GET" && head.method !== "HEAD";
      const res = await handler(
        new Request(`${origin}${head.path}`, { method: head.method, headers, body: hasBody ? body : undefined, signal: ac.signal }),
      );
      const passed: Record<string, string> = {};
      for (const h of ["content-type", "set-cookie"]) {
        const v = res.headers.get(h);
        if (v) passed[h] = v;
      }
      out({ t: "res", id: head.id, status: res.status, headers: passed });
      const zip = COMPRESSIBLE.test(passed["content-type"] ?? "");
      const reader = res.body?.getReader();
      ac.signal.addEventListener("abort", () => void reader?.cancel().catch(() => {}));
      while (reader) {
        const { done, value } = await reader.read();
        if (done || ac.signal.aborted) break;
        if (!zip) for (const f of bodyFrames(head.id, value)) out(f);
        else
          for (let i = 0; i < value.length; i += GZIP_FRAME_BYTES)
            out({ t: "body", id: head.id, d: b64url(Bun.gzipSync(value.subarray(i, i + GZIP_FRAME_BYTES))), z: true });
      }
    } catch (e) {
      if (!ac.signal.aborted) out({ t: "res", id: head.id, status: 500, headers: { "content-type": "application/json" } });
      if (!ac.signal.aborted) console.error(`relay channel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running.delete(head.id);
      if (!ac.signal.aborted) out({ t: "end", id: head.id });
    }
  }

  return {
    /** One frame from the browser. */
    onMessage(raw: string): void {
      const f = parseFrame(raw);
      if (!f) return;
      if (f.t === "req") {
        if (incoming.size + running.size < 64) incoming.set(f.id, { head: f, body: [], size: 0 });
      } else if (f.t === "body") {
        const r = incoming.get(f.id);
        if (!r) return;
        const piece = unb64url(f.d);
        r.size += piece.length;
        if (r.size > MAX_BODY) {
          incoming.delete(f.id);
          out({ t: "res", id: f.id, status: 413, headers: {} });
          out({ t: "end", id: f.id });
        } else r.body.push(piece);
      } else if (f.t === "end") {
        const r = incoming.get(f.id);
        incoming.delete(f.id);
        if (r) void run(r.head, new Uint8Array(r.body.flatMap((b) => [...b])));
      } else if (f.t === "abort") running.get(f.id)?.abort();
    },
    /** The channel closed: every running request (event streams above all) is cancelled. */
    close(): void {
      for (const ac of running.values()) ac.abort();
      running.clear();
      incoming.clear();
    },
  };
}

// ── signalling and WebRTC ──

let handlerRef: ((req: Request) => Promise<Response>) | null = null;
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let backoff = 5_000;
let ping: ReturnType<typeof setInterval> | null = null;
/** When the signalling socket last heard from the relay: a pong, a signal, or its opening. */
let heard = 0;
/**
 * How often the socket pings, and how long a dial may take. A socket that hears nothing for two pings is given up: a
 * laptop's sleep or a network change leaves it half open, with no close event, and the hosted page would see the
 * computer as off until a restart. Tests shorten these.
 */
export const relayTiming = { ping: 50_000, dial: 20_000 };
/** Browsers connected or connecting, by the Durable Object's id for them. */
const peers = new Map<string, { close(): void; signal(s: Signal): void }>();
/** Peer connections at once; a phone, a tablet and a laptop leave room. */
const MAX_PEER_CONNECTIONS = 8;

let ice: { at: number; servers: { urls: string | string[]; username?: string; credential?: string }[] } | null = null;
/** TURN credentials from the relay (Cloudflare Realtime), cached for an hour; STUN alone when that fails. */
async function iceServers() {
  if (ice && Date.now() - ice.at < 60 * 60_000) return ice.servers;
  try {
    const r = await fetch(`${relayUrl()}/relay/ice`, {
      method: "POST",
      headers: await signed("/relay/ice"),
      signal: AbortSignal.timeout(10_000),
    });
    const j = z
      .object({
        iceServers: z.array(
          z.object({
            urls: z.union([z.string(), z.array(z.string())]),
            username: z.string().optional(),
            credential: z.string().optional(),
          }),
        ),
      })
      .parse(await r.json());
    ice = { at: Date.now(), servers: j.iceServers };
  } catch {
    return [{ urls: "stun:stun.cloudflare.com:3478" }];
  }
  return ice.servers;
}

/** Answers one browser's offer: werift (pure TypeScript WebRTC), loaded only when someone connects. */
async function answer(from: string, sdp: string): Promise<void> {
  const handler = handlerRef;
  const ws = socket;
  if (!handler || !ws || peers.has(from) || peers.size >= MAX_PEER_CONNECTIONS) return;
  // The browser trickles its candidates right after the offer, while werift loads and TURN credentials arrive. They
  // wait here until the offer is applied: dropped, a TURN-only browser never connects (its relay candidates are the
  // only way in, and the daemon's own TURN allocation only admits addresses it was told about).
  const early: { candidate: string; mid: string }[] = [];
  let ready: ((c: { candidate: string; mid: string }) => void) | null = null;
  let closed = false;
  let close = () => {
    closed = true;
    peers.delete(from);
  };
  peers.set(from, {
    close: () => close(),
    signal: (m) => {
      if (m.type !== "ice" || !m.candidate) return;
      const c = { candidate: m.candidate, mid: m.mid };
      if (ready) ready(c);
      else if (early.length < 64) early.push(c);
    },
  });
  const s = load();
  const { RTCPeerConnection } = await import("werift");
  const servers = await iceServers();
  if (closed) return;
  const pc = new RTCPeerConnection({ iceServers: servers });
  const tell = (m: Signal) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  let channel: ReturnType<typeof channelServer> | null = null;
  close = () => {
    channel?.close();
    peers.delete(from);
    void pc.close().catch(() => {});
  };
  pc.onIceCandidate.subscribe((c) => {
    if (c?.candidate) tell({ type: "ice", candidate: c.candidate, mid: c.sdpMid ?? "0", to: from });
  });
  pc.connectionStateChange.subscribe((st) => {
    if (st === "failed" || st === "closed") close();
  });
  pc.onDataChannel.subscribe((dc) => {
    if (dc.label !== "api") return;
    channel = channelServer(handler, (f) => dc.send(f), new URL(relayUrl()).origin);
    dc.onMessage.subscribe((m) => channel?.onMessage(typeof m === "string" ? m : m.toString()));
    dc.stateChanged.subscribe((st) => st === "closed" && close());
  });
  try {
    await pc.setRemoteDescription({ type: "offer", sdp });
    ready = (c) => void pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid }).catch(() => {});
    for (const c of early.splice(0)) ready(c);
    await pc.setLocalDescription(await pc.createAnswer());
    const local = pc.localDescription?.sdp ?? "";
    // signed with the device key: the browser pins it, so even the relay can't swap in its own DTLS fingerprint
    tell({ type: "answer", sdp: local, sig: await sign(await signingKey(s.priv), local), to: from });
  } catch (e) {
    console.error(`relay: couldn't answer a browser: ${e instanceof Error ? e.message : String(e)}`);
    close();
  }
}

function onSignal(raw: string): void {
  if (raw === "pong") return;
  let m: Signal;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "offer" && m.from) void answer(m.from, m.sdp);
  else if (m.type === "ice" && m.from) peers.get(m.from)?.signal(m);
  else if (m.type === "bye") peers.get(m.from)?.close();
}

/** Whether the daemon should hold a relay connection now: switched on, linked, and paid for (or in grace). */
export const shouldConnect = (s = load(), now = Date.now()): boolean => s.enabled && Boolean(s.cert) && hostedActive(now);

/** Opens or closes the signalling socket to match shouldConnect. */
function syncConnection(): void {
  if (!handlerRef) return;
  if (!shouldConnect()) {
    if (retry) clearTimeout(retry);
    retry = null;
    for (const p of [...peers.values()]) p.close();
    socket?.close(1000, "off");
    socket = null;
    return;
  }
  if (socket || retry) return;
  void connect();
}

async function connect(): Promise<void> {
  retry = null;
  const url = `${relayUrl().replace(/^http/, "ws")}/relay/ws`;
  let ws: WebSocket;
  try {
    // the proof rides in the query: a WebSocket's constructor takes no headers in the standard API. It's bound to this
    // path and two minutes, and the certificate is useless without the device key.
    const h = await signed("/relay/ws", "GET");
    const q = new URLSearchParams({ cert: h["x-overhand-cert"] ?? "", ts: h["x-overhand-ts"] ?? "", sig: h["x-overhand-sig"] ?? "" });
    ws = new WebSocket(`${url}?${q}`);
  } catch {
    return scheduleRetry();
  }
  socket = ws;
  const dial = setTimeout(() => ws.readyState === WebSocket.CONNECTING && drop(ws, "the relay didn't answer"), relayTiming.dial);
  ws.onopen = () => {
    clearTimeout(dial);
    backoff = 5_000;
    lastError = "";
    heard = Date.now();
    if (ping) clearInterval(ping);
    // answered by the Durable Object's auto-response: keeps NATs open without waking it
    ping = setInterval(() => {
      if (Date.now() - heard > 2 * relayTiming.ping) return drop(ws, "the relay went quiet");
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, relayTiming.ping);
  };
  ws.onmessage = (e: MessageEvent) => {
    heard = Date.now();
    onSignal(String(e.data));
  };
  ws.onclose = (e: CloseEvent) => {
    clearTimeout(dial);
    // a socket already given up on: its replacement owns the retry
    if (socket !== ws) return;
    socket = null;
    if (ping) clearInterval(ping);
    if (e.code !== 1000) lastError = e.reason || `relay connection closed (${e.code})`;
    scheduleRetry();
  };
}

/** Gives up on a socket that never opened or went quiet, and dials again. */
function drop(ws: WebSocket, reason: string): void {
  if (socket !== ws) return;
  socket = null;
  if (ping) clearInterval(ping);
  lastError = reason;
  ws.close();
  scheduleRetry();
}

function scheduleRetry(): void {
  if (retry || !shouldConnect()) return;
  // clear the handle first: syncConnection skips while one is pending, so a fired timer left set never dialled again
  retry = setTimeout(() => {
    retry = null;
    syncConnection();
  }, backoff);
  backoff = Math.min(backoff * 2, 5 * 60_000);
}

/**
 * Starts Access from anywhere when it's on: reads the stored entitlement, refreshes it now and every six hours, and
 * keeps the signalling socket up while it's valid. `handler` is the dashboard server's own request handler.
 */
export async function startRelay(handler: (req: Request) => Promise<Response>): Promise<void> {
  handlerRef = handler;
  await entitlement();
  syncConnection();
  if (load().cert) void refreshEntitlement();
  setInterval(() => void refreshEntitlement(), 6 * 60 * 60_000).unref();
}
