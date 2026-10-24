/**
 * Who may use the dashboard. On this machine, the local key (`localKey`): a browser gets a cookie made from it by opening an
 * open link, the CLI reads it from its file, so another program here or a web page doesn't have it (an agent can still
 * read the file until the agent sandbox ships). A phone
 * (through `tailscale serve` or any other proxy) is paired once with a short-lived code the local dashboard shows, and
 * then carries a long random session cookie. Only the cookie's SHA-256 is stored (.devices.json, 0600), never logged.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RUN_KEY_ENV, RUN_KEY_HEADER, writeAtomic } from "./control";
import { OPS } from "./env";

/** The session cookie a paired device sends. */
const COOKIE = "overhand_session";
/** How long a pairing code works. */
export const PAIR_TTL_MS = 10 * 60_000;
/** Wrong codes in a row before the pending one is burned, so guessing it is hopeless. */
const MAX_TRIES = 5;
// no 0/O, 1/I/L: read off a laptop screen and typed on a phone
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const StoredSchema = z.object({ id: z.string(), name: z.string(), at: z.number(), seen: z.number(), hash: z.string() });
type Stored = z.infer<typeof StoredSchema>;
/** A paired device as the dashboard lists it. */
export type Device = Omit<Stored, "hash">;

const file = () => join(OPS, ".devices.json");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Equal without leaking where they differ; different lengths are simply unequal. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function load(): Stored[] {
  try {
    const list = StoredSchema.array().safeParse(existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : []);
    return list.success ? list.data : [];
  } catch {
    return [];
  }
}
const save = (list: Stored[]) => writeFileSync(file(), JSON.stringify(list, null, 2), { mode: 0o600 });
const shown = ({ hash: _, ...d }: Stored): Device => d;

/** Every paired device, newest first. */
export const devices = (): Device[] => load().map(shown).reverse();

// ponytail: one pending code in memory; a restart drops it, and a new "Add a device" replaces it
let pending: { code: string; until: number; tries: number } | null = null;

/** A fresh one-time pairing code (10 characters, ~49 bits), replacing any earlier one. */
export function newPairing(now = Date.now()): { code: string; until: number } {
  const code = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  pending = { code, until: now + PAIR_TTL_MS, tries: 0 };
  return { code, until: pending.until };
}

/** A device's name from its browser, good enough to tell your phone from your tablet in the list. */
function nameOf(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome|CriOS/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os}, ${browser}` : os;
}

/**
 * Trades the pending code for a new device and its session token (shown once, as the cookie). The code works once and
 * expires; five wrong tries burn it.
 */
export function redeem(code: string, userAgent: string, now = Date.now()): { token: string; device: Device } | { error: string } {
  const typed = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!pending || now > pending.until) {
    pending = null;
    return { error: "That code has expired. Make a new one on the Mac: Settings, Phone, Add a device." };
  }
  if (!same(typed, pending.code)) {
    if (++pending.tries >= MAX_TRIES) pending = null;
    return { error: "That code doesn't match. Check it on the Mac and try again." };
  }
  pending = null;
  const token = randomBytes(32).toString("base64url");
  const d: Stored = { id: randomUUID().slice(0, 8), name: nameOf(userAgent), at: now, seen: now, hash: sha(token) };
  save([...load(), d]);
  return { token, device: shown(d) };
}

/** The session token (or another cookie, by `name`) in a Cookie header, or "". */
export function cookieToken(header: string | null, name = COOKIE): string {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/** The cookie a browser on this machine carries once it opened the dashboard by an open link. */
const LOCAL_COOKIE = "overhand_local";
/** The header Overhand's own CLI sends the local key in. */
export const LOCAL_HEADER = "x-overhand-key";
/** How long an open link (`openLink`) works. */
export const OPEN_TTL_MS = 2 * 60_000;

/** Where this install's local key lives. */
export const keyFile = (ops: string): string => join(ops, "control", "local-key");
// the key as last read, by the file's identity, size and mtime: every request checks it, so it's read once per change
let cached: { file: string; stamp: string; key: string } | null = null;

/** The key in `f` when it's whole (32+ characters), else ""; a file others may read is made yours alone first. */
function readKey(f: string): string {
  try {
    const st = statSync(f);
    if (st.mode & 0o077) chmodSync(f, 0o600);
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (cached?.file === f && cached.stamp === stamp) return cached.key;
    const key = readFileSync(f, "utf8").trim();
    if (key.length < 32) return "";
    cached = { file: f, stamp, key };
    return key;
  } catch {
    return "";
  }
}

/**
 * This install's local key (control/local-key, 0600), made on first use. A caller on this machine needs it: the CLI reads
 * it from the file and sends it, a browser trades a short-lived open link for a cookie made from it. That stops other
 * programs and web pages on this machine. It doesn't stop an agent: an agent runs as you, so it can read the file
 * (the guard blocks naming control/, but not every way of reaching it) until the agent sandbox ships.
 */
export function localKey(ops = OPS): string {
  const f = keyFile(ops);
  const k = readKey(f);
  if (k) return k;
  mkdirSync(dirname(f), { recursive: true });
  const made = randomBytes(32).toString("base64url");
  try {
    // exclusive create: when two callers make it at once, one key wins and both use it
    writeFileSync(f, made, { flag: "wx", mode: 0o600 });
    return made;
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
  }
  // the other caller's key, once it's written
  for (let i = 0; i < 50; i++) {
    const theirs = readKey(f);
    if (theirs) return theirs;
    Bun.sleepSync(10);
  }
  // still too short after half a second: a broken file, replaced
  writeAtomic(f, made);
  return made;
}

/**
 * A new local key in place of the old one (`overhand open --reset`): every browser's cookie and every open link stop
 * working at once, and the CLI uses the new key from its next call.
 */
export function resetLocalKey(ops = OPS): string {
  const k = randomBytes(32).toString("base64url");
  writeAtomic(keyFile(ops), k);
  return k;
}

const mac = (key: string, at: number): string => createHmac("sha256", key).update(`open:${at}`).digest("base64url");
/** A browser's cookie: made from the key, never the key itself, so a cookie read out of a browser can't call as the CLI. */
const browserMac = (key: string): string => createHmac("sha256", key).update("browser").digest("base64url");
// ponytail: used open links in memory until they expire; a restart forgets them, and they expire in two minutes anyway
const usedOpen = new Map<string, number>();

/**
 * The dashboard address with a one-time open link that works for OPEN_TTL_MS: what `overhand start` and `open` open.
 * `base` may name a page and a query (the menu bar's glance page, a drawer to open); the link keeps both.
 */
export function openLink(base: string, now = Date.now(), key = localKey()): string {
  const u = new URL(base);
  u.searchParams.set("open", `${now}.${mac(key, now)}`);
  return u.toString();
}

/** Whether `code` is a fresh open link this install made, never used before; using it burns it. */
export function useOpenLink(code: string, now = Date.now(), key = localKey()): boolean {
  for (const [c, until] of usedOpen) if (until < now) usedOpen.delete(c);
  const [at = "", sig = ""] = code.split(".");
  const t = Number(at);
  if (!Number.isSafeInteger(t) || t > now || now - t > OPEN_TTL_MS || usedOpen.has(code) || !same(sig, mac(key, t))) return false;
  usedOpen.set(code, t + OPEN_TTL_MS);
  return true;
}

/** Whether a request carries this install's local key: the key itself by header (the CLI), or a browser's cookie. */
export function hasLocalKey(req: Request, key = localKey()): boolean {
  const header = req.headers.get(LOCAL_HEADER);
  if (header !== null) return same(header, key);
  const cookie = cookieToken(req.headers.get("cookie"), LOCAL_COOKIE);
  return cookie !== "" && same(cookie, browserMac(key));
}

/**
 * The Set-Cookie value for this machine's browser: made from the local key, HttpOnly, kept for the browser's maximum.
 * SameSite=Lax, so it rides the top-level GET back from an OAuth consent page or the relay (whose single-use state or
 * nonce still decides); a page elsewhere can't use it to act, as every POST also needs the dashboard's own Origin.
 */
export const localCookie = (key = localKey()): string =>
  [`${LOCAL_COOKIE}=${browserMac(key)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=34560000"].join("; ");

/**
 * Headers for Overhand's own CLI calling the local dashboard: the Origin it checks and the local key, or inside a run
 * its own key (control.ts runKey), which opens only the routes a run may call.
 */
export function localHeaders(base: string, env = process.env): Record<string, string> {
  const run = env[RUN_KEY_ENV];
  return { Origin: base, ...(run ? { [RUN_KEY_HEADER]: run } : { [LOCAL_HEADER]: localKey() }) };
}

/** The paired device a request's cookie belongs to, or null. Marks it seen (at most once an hour, to spare the disk). */
export function deviceOf(req: Request, now = Date.now()): Device | null {
  const token = cookieToken(req.headers.get("cookie"));
  if (!token) return null;
  const h = sha(token);
  const list = load();
  // every stored hash is compared, constant-time, so the answer's timing says nothing about which one is close
  let hit: Stored | null = null;
  for (const d of list) if (same(d.hash, h)) hit = d;
  if (!hit) return null;
  if (now - hit.seen > 60 * 60_000) {
    hit.seen = now;
    save(list);
  }
  return shown(hit);
}

/** Forgets a device: its cookie stops working at once. False when there's no such device. */
export function revoke(id: string): boolean {
  const list = load();
  const left = list.filter((d) => d.id !== id);
  if (left.length === list.length) return false;
  save(left);
  return true;
}

/** The Set-Cookie value for a new session: HttpOnly, SameSite=Strict, Secure over https, kept for the browser's maximum. */
export const sessionCookie = (token: string, https: boolean): string =>
  [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=34560000", ...(https ? ["Secure"] : [])].join("; ");

// headers a reverse proxy (tailscale serve among them) adds; a request carrying one came from somewhere else
const PROXIED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "tailscale-user-login"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a request comes from a browser on this machine. The daemon listens on 127.0.0.1 only, so every connection is
 * local at the socket; what tells a phone apart is the address it asked for (a tailnet name, not 127.0.0.1) and the
 * forwarding headers the proxy adds. Either one makes it remote.
 */
export function isLocal(req: Request): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const name = URL.parse(`http://${host}`)?.hostname ?? "";
  return LOOPBACK.has(name) && !PROXIED.some((h) => req.headers.has(h));
}
