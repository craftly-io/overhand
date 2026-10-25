/**
 * What the relay, the daemon and the hosted dashboard agree on: the signed tokens the relay issues (Ed25519, WebCrypto
 * only, so the Worker, Bun and browsers share this file), how long an entitlement lasts offline, and the frames the
 * dashboard's API travels in over a WebRTC data channel. Dependency-free.
 */

/** A browser's sign-in, as the relay's session cookie. `ws` is the workspace: today, the WorkOS user id.
 * `iat` lets "Sign out everywhere" void every session issued before it. */
export type SessionClaim = { typ: "session"; ws: string; email: string; iat: number; exp: number };
/**
 * A daemon's key bound to a workspace, issued when you link the daemon from a signed-in browser and renewed with each
 * entitlement refresh. `exp` is absent only on certificates from before expiry existed; the next refresh replaces them.
 */
export type LinkClaim = { typ: "link"; ws: string; email: string; pub: string; name: string; iat: number; exp?: number };
/** What a workspace pays for, given to its daemon. Short-lived; the daemon keeps using it for GRACE_MS once it lapses. */
export type EntitlementClaim = { typ: "ent"; ws: string; plan: Plan; seats: number; iat: number; exp: number };
export type Claim = SessionClaim | LinkClaim | EntitlementClaim;

/** The paid plans. Free is the absence of an entitlement, never a token. */
export const PLANS = ["pro", "team"] as const;
export type Plan = (typeof PLANS)[number];
export const CYCLES = ["month", "year"] as const;
export type Cycle = (typeof CYCLES)[number];

/** An entitlement token's life: the daemon refreshes it every few hours while the relay answers. */
export const ENTITLEMENT_TTL_MS = 24 * 60 * 60_000;
/** How long hosted features keep working on an expired token while the relay can't be reached. */
export const GRACE_MS = 7 * 24 * 60 * 60_000;
/** A link certificate's life: a computer that hasn't reached the relay for this long links again. */
export const LINK_TTL_MS = 90 * 24 * 60 * 60_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes to base64url, no padding. */
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (or base64) to bytes; throws on garbage. */
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An Ed25519 private key from its PKCS#8 bytes in base64url (the relay's SIGNING_KEY secret, a daemon's device key). */
export const signingKey = (pkcs8: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", unb64url(pkcs8), { name: "Ed25519" }, false, ["sign"]);

/** An Ed25519 public key from its raw 32 bytes in base64url. */
export const verifyingKey = (raw: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", unb64url(raw), { name: "Ed25519" }, false, ["verify"]);

/** A fresh Ed25519 key pair as base64url strings: `priv` PKCS#8, `pub` raw. */
export async function newKeyPair(): Promise<{ priv: string; pub: string }> {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in k)) throw new Error("Ed25519 generateKey returned a single key");
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  return { priv: b64url(priv), pub: b64url(pub) };
}

/** Signs `text` with an Ed25519 key, base64url. */
export async function sign(key: CryptoKey, text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(text))));
}

/** Whether `sig` is `key`'s signature over `text`; false for malformed input rather than throwing. */
export async function verify(key: CryptoKey, text: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64url(sig), enc.encode(text));
  } catch {
    return false;
  }
}

/** A signed token: base64url(JSON claim) "." base64url(signature over the first part). */
export async function signToken(key: CryptoKey, claim: Claim): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claim)));
  return `${body}.${await sign(key, body)}`;
}

/** The claim of a token `key` signed, when its `typ` is `typ`; null for anything else. Expiry is the caller's call. */
export async function readToken<T extends Claim["typ"]>(key: CryptoKey, token: string, typ: T): Promise<Extract<Claim, { typ: T }> | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || !(await verify(key, body, sig))) return null;
  try {
    const claim: unknown = JSON.parse(dec.decode(unb64url(body)));
    return isClaim(claim, typ) ? claim : null;
  } catch {
    return null;
  }
}

const str = (o: Record<string, unknown>, k: string) => typeof o[k] === "string";
const num = (o: Record<string, unknown>, k: string) => typeof o[k] === "number";

function isClaim<T extends Claim["typ"]>(v: unknown, typ: T): v is Extract<Claim, { typ: T }> {
  if (typeof v !== "object" || v === null || !("typ" in v) || v.typ !== typ) return false;
  const o: Record<string, unknown> = { ...v };
  if (!str(o, "ws")) return false;
  if (typ === "session") return str(o, "email") && num(o, "iat") && num(o, "exp");
  if (typ === "link") return str(o, "email") && str(o, "pub") && str(o, "name") && num(o, "iat") && (o.exp === undefined || num(o, "exp"));
  return PLANS.some((p) => p === o.plan) && num(o, "seats") && num(o, "iat") && num(o, "exp");
}

/**
 * Where a daemon's hosted features stand: "active" while its token is valid, "grace" for GRACE_MS after it expires
 * (the relay may just be unreachable), then "none". Only hosted features read this; nothing local ever does.
 */
export function entitlementState(claim: EntitlementClaim | null, now: number): "active" | "grace" | "none" {
  if (!claim) return "none";
  if (now < claim.exp) return "active";
  return now < claim.exp + GRACE_MS ? "grace" : "none";
}

/**
 * The text a daemon signs to prove it holds its key for one request: good for that method and path, for
 * PROOF_WINDOW_MS, once (the relay refuses a signature it has seen; the daemon never signs one timestamp twice).
 */
export const daemonProof = (method: string, path: string, ts: number): string => `${method} ${path} ${ts}`;
/** How old a daemon's signed request may be. */
export const PROOF_WINDOW_MS = 2 * 60_000;

/** A short, readable fingerprint of a public key, to compare on two screens. */
export async function fingerprint(pub: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64url(pub)));
  return Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{4})(?!$)/g, "$1 ");
}

// ── The dashboard's API over a data channel ────────────────────────────────────────────────────────────────────────
// One HTTP exchange is a head frame, body frames and an end frame, each a JSON string. Bodies travel as base64 in
// pieces small enough for any SCTP stack (a data channel message over 64 KiB isn't safe everywhere).

/** Bytes of body per frame; base64 makes it 16 KiB on the wire. */
export const FRAME_BYTES = 12 * 1024;
/** Bytes of compressible body per gzipped frame: JSON shrinks 5–10×, so the frame stays well under 64 KiB. */
export const GZIP_FRAME_BYTES = 40 * 1024;

/** A frame on the "api" data channel. */
export type Frame =
  | { t: "req"; id: number; method: string; path: string; headers: Record<string, string> }
  | { t: "res"; id: number; status: number; headers: Record<string, string> }
  /** `z`: the piece is gzipped (the daemon compresses JSON and event streams, so TURN carries a fraction). */
  | { t: "body"; id: number; d: string; z?: boolean }
  | { t: "end"; id: number }
  /** The browser gave up on a request (an event stream closed); the daemon cancels it. */
  | { t: "abort"; id: number };

/** The body frames for `bytes`, in order. */
export function bodyFrames(id: number, bytes: Uint8Array): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < bytes.length; i += FRAME_BYTES) out.push({ t: "body", id, d: b64url(bytes.subarray(i, i + FRAME_BYTES)) });
  return out;
}

/** A frame from the wire, or null when it isn't one. */
export function parseFrame(raw: string): Frame | null {
  try {
    const f: unknown = JSON.parse(raw);
    if (typeof f !== "object" || f === null || !("t" in f) || !("id" in f) || typeof f.id !== "number") return null;
    const o: Record<string, unknown> = { ...f };
    const headers = (h: unknown): h is Record<string, string> =>
      typeof h === "object" && h !== null && Object.values(h).every((v) => typeof v === "string");
    if (o.t === "req" && str(o, "method") && str(o, "path") && headers(o.headers))
      return { t: "req", id: f.id, method: String(o.method), path: String(o.path), headers: o.headers };
    if (o.t === "res" && num(o, "status") && headers(o.headers))
      return { t: "res", id: f.id, status: Number(o.status), headers: o.headers };
    if (o.t === "body" && str(o, "d")) return { t: "body", id: f.id, d: String(o.d), ...(o.z === true ? { z: true } : {}) };
    if (o.t === "end" || o.t === "abort") return { t: o.t, id: f.id };
    return null;
  } catch {
    return null;
  }
}

// ── Signalling, between a browser or daemon and the workspace's Durable Object ─────────────────────────────────────

/** What the signalling socket carries. Peers send without `from`; the Durable Object stamps it. */
export type Signal =
  | { type: "offer"; sdp: string; from?: string }
  | { type: "answer"; sdp: string; sig: string; to: string }
  | { type: "ice"; candidate: string; mid: string; to?: string; from?: string }
  /** The Durable Object telling a browser whether its daemon is connected, and the daemon's key. */
  | { type: "daemon"; online: boolean; pub: string; name: string }
  /** The Durable Object telling the daemon a browser left. */
  | { type: "bye"; from: string };
