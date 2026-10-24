/**
 * Overhand's relay: one Worker that serves the hosted dashboard (static assets, which never run this code) and, under
 * /relay/, sign-in (src/signin.ts, through WorkOS), linking a daemon to an account, WebRTC signalling (a hibernating Durable Object
 * per workspace), TURN credentials, entitlement tokens, and Paddle billing. Dashboard traffic never flows through here:
 * it goes browser ↔ daemon over WebRTC, through Cloudflare TURN only when NAT leaves no direct path.
 */
import {
  APP,
  daemonProof,
  EMAIL,
  ENTITLEMENT_TTL_MS,
  fingerprint,
  type LinkClaim,
  PERMISSIONS,
  PROOF_WINDOW_MS,
  REPO_URL,
  readToken,
  type SessionClaim,
  signingKey,
  signToken,
  unb64url,
  verify,
  verifyingKey,
} from "@overhand/contract";
import { markSvg } from "@overhand/themes/brand";
import { systemSchemeCss } from "@overhand/themes/system";
import { z } from "zod";
import { billingRoute, publicHome } from "./billing";
import { applyEvent, type D1, entitlementOf, eventWorkspace, inCidr, paddleBase, paddleIps, verifyPaddleSignature } from "./paddle";
import { signedIn, signInRoute } from "./signin";
import { access, teamRoute, tellRoom } from "./team";

export { TeamRoom } from "./room";
export { Workspace } from "./signal";

/** The Durable Object namespace subset used here. */
type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };

/** Bindings, vars and secrets (wrangler.jsonc; secrets via `wrangler secret put`, never in code). */
export type Env = {
  WORKSPACE: Namespace;
  /** Teams' rooms (room.ts), one per team, named by the team's id. */
  TEAM: Namespace;
  DB: D1;
  ASSETS?: { fetch(req: Request): Promise<Response> };
  /** Ed25519 PKCS#8, base64url: signs sessions, link certificates and entitlement tokens. Secret. */
  SIGNING_KEY: string;
  WORKOS_CLIENT_ID: string;
  /** Secret. */
  WORKOS_API_KEY: string;
  TURN_KEY_ID: string;
  /** Secret. */
  TURN_KEY_API_TOKEN: string;
  /** "sandbox" (default) or "production". */
  PADDLE_ENV: string;
  /** Paddle.js client-side token (test_… in the sandbox): public by design. */
  PADDLE_CLIENT_TOKEN: string;
  /** Secret. */
  PADDLE_API_KEY: string;
  /** Secret: the notification destination's secret key. */
  PADDLE_WEBHOOK_SECRET: string;
  /** The public site, allowed to read /relay/prices. */
  SITE_ORIGIN: string;
  /** The OAuth providers the sign-in page offers, by WorkOS name ("GitHubOAuth,GoogleOAuth"); none when unset. */
  SIGN_IN_PROVIDERS?: string;
  /** "1" lets /relay/dev-login sign in without WorkOS, only on localhost (wrangler dev and tests). */
  DEV_LOGIN?: string;
  /** TURN credential grants per workspace per month before /relay/ice hands out STUN only; TURN_GRANTS by default. */
  TURN_MONTHLY_GRANTS?: string;
};

/**
 * The default monthly TURN budget, counted in credential grants (the daemon asks at most hourly while answering, a
 * browser once per connection). Generous: most connections never touch TURN, and past the cap they still try direct.
 */
export const TURN_GRANTS = 300;

/** The session cookie, and how long a session lasts. */
export const SESSION = "hl_session";
export const SESSION_MS = 7 * 24 * 60 * 60_000;

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

/** A cookie's value from the request, or "". */
export function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/** A Set-Cookie value: HttpOnly, Secure, SameSite=Lax. */
export const setCookie = (name: string, value: string, maxAge: number, path = "/") =>
  [`${name}=${value}`, `Path=${path}`, "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${maxAge}`].join("; ");

let keys: { secret: string; sign: CryptoKey; verify: CryptoKey; pub: string } | null = null;
/** The relay's signing key and its public half, imported once per isolate. */
export async function relayKeys(env: Env): Promise<{ sign: CryptoKey; verify: CryptoKey; pub: string }> {
  if (keys?.secret === env.SIGNING_KEY) return keys;
  const full = await crypto.subtle.importKey("pkcs8", unb64url(env.SIGNING_KEY), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", full);
  if (typeof jwk.x !== "string") throw new Error("SIGNING_KEY isn't an Ed25519 key");
  keys = { secret: env.SIGNING_KEY, sign: await signingKey(env.SIGNING_KEY), verify: await verifyingKey(jwk.x), pub: jwk.x };
  return keys;
}

/** The signed-in browser's session, or null. */
export async function sessionOf(req: Request, env: Env, now = Date.now()): Promise<SessionClaim | null> {
  const token = cookie(req, SESSION);
  if (!token) return null;
  const s = await readToken((await relayKeys(env)).verify, token, "session");
  if (!s || s.exp <= now) return null;
  // "Sign out everywhere" voids every session issued before it: one D1 read per signed-in request
  const epoch = await env.DB.prepare("SELECT not_before FROM session_epochs WHERE workspace = ?").bind(s.ws).first();
  return s.iat >= Number(epoch?.not_before ?? 0) ? s : null;
}

/** Closes sockets in a workspace's signalling room: every browser ("peers"), or the daemon with one key ("daemon:<pub>"). */
async function kick(env: Env, ws: string, who: string): Promise<void> {
  await env.WORKSPACE.get(env.WORKSPACE.idFromName(ws)).fetch(
    new Request("https://room/kick", { method: "POST", headers: { "x-kick": who } }),
  );
}

/**
 * The daemon a request comes from: a link certificate this relay issued (x-overhand-cert) plus the daemon's own
 * signature, with the key in that certificate, over the method, path and a fresh timestamp. Null for anything else.
 */
export async function daemonOf(req: Request, env: Env, now = Date.now()): Promise<LinkClaim | null> {
  // headers, or the query for a WebSocket upgrade (the standard WebSocket constructor can't set headers)
  const q = new URL(req.url).searchParams;
  const cert = req.headers.get("x-overhand-cert") ?? q.get("cert") ?? "";
  const ts = Number(req.headers.get("x-overhand-ts") ?? q.get("ts"));
  const sig = req.headers.get("x-overhand-sig") ?? q.get("sig") ?? "";
  if (!cert || !sig || !Number.isFinite(ts) || Math.abs(now - ts) > PROOF_WINDOW_MS) return null;
  const link = await readToken((await relayKeys(env)).verify, cert, "link");
  if (!link) return null;
  try {
    const ok = await verify(await verifyingKey(link.pub), daemonProof(req.method, new URL(req.url).pathname, ts), sig);
    if (!ok) return null;
  } catch {
    return null;
  }
  // an unlinked computer's certificate stays signed forever; the relay just stops honouring its key
  const revoked = await env.DB.prepare("SELECT 1 AS x FROM revoked_links WHERE pub = ?").bind(link.pub).first();
  return revoked ? null : link;
}

/** A same-origin browser request: the only kind allowed to change anything with a session cookie. */
export const sameOrigin = (req: Request, url: URL) => req.headers.get("origin") === url.origin;

/** A path on this site to return to after sign-in; anything else (another host, //evil) becomes "/". */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a return path may not hold
export const safeNext = (next: string | null): string => (next && /^\/(?![/\\])[^\s\x00-\x1f\\]*$/.test(next) ? next : "/");

/**
 * The relay's own pages (the public front page, billing, sign-in, linking and joining a team), on the design system
 * (packages/themes/src/system.ts): its values inlined, day by default and night when the browser prefers dark, Atkinson
 * Hyperlegible from the hosted app's own fonts, a raised paper pane, pill buttons with an ink primary. This CSS only
 * reads `var(--…)`; packages/themes/test/one-source.test.ts keeps it that way.
 */
export const PAGE_CSS = `${systemSchemeCss()}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--ink-1);color:var(--ink-12);font:var(--t-small-weight) var(--t-small-size)/var(--t-small-line) var(--font-body);overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
.pane{max-width:46rem;margin:0 auto;padding:var(--space-pane);display:grid;gap:16px;background:var(--pane);border:1px solid var(--glass-edge);border-radius:var(--radius-pane);box-shadow:var(--glass-lift)}
.pane>*{margin:0}
body.center{display:grid;place-items:center;min-height:100dvh}body.center .pane{width:100%;max-width:32rem}
.brand{display:flex;align-items:center;gap:8px;font-weight:600}
h1{font:var(--t-h3-weight) var(--t-h3-size)/var(--t-h3-line) var(--font-body);letter-spacing:var(--t-h3-track)}
h2{font:600 var(--t-body-size)/var(--t-small-line) var(--font-body)}
p{max-width:72ch}small,.note{color:var(--ink-10)}.warn{color:var(--you)}
a{color:inherit;text-underline-offset:.2em;text-decoration-thickness:1px}a:hover{text-decoration-thickness:2px}
code{font:var(--t-mono-weight) var(--t-mono-size)/var(--t-mono-line) var(--font-mono)}
button,a.button{font:inherit;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:var(--radius-control);border:1px solid var(--ink-7);background:var(--ink-3);color:var(--ink-12);text-decoration:none;cursor:pointer}
button:hover,a.button:hover{border-color:var(--ink-9)}
button.primary,a.button.primary{background:var(--ink-12);border-color:var(--ink-12);color:var(--ink-1);font-weight:600}
input{font:inherit;width:5.5rem;min-height:44px;margin-left:6px;padding:4px 12px;border-radius:var(--radius-control);border:1px solid var(--ink-9);background:var(--ink-2);color:var(--ink-12)}
:focus-visible{outline:2px solid var(--ink-12);outline-offset:3px}
@media (max-width:480px){.pane{padding:var(--space-pane-phone)}}`;

/**
 * The files every crawler and security scanner asks for: robots.txt (the public page may be indexed, the relay's own
 * routes not) and security.txt (RFC 9116: where to report a vulnerability, valid for a year from today).
 */
const WELL_KNOWN: Record<string, () => string> = {
  "/robots.txt": () => "User-agent: *\nAllow: /$\nDisallow: /relay/\n",
  "/.well-known/security.txt": () =>
    [
      `Contact: mailto:${EMAIL}`,
      `Expires: ${new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
      `Policy: ${REPO_URL}/security/policy`,
      `Canonical: ${APP}/.well-known/security.txt`,
      "Preferred-Languages: en, fi",
    ]
      .join("\n")
      .concat("\n"),
};

/** The mark and the name, atop every relay page but the front page, whose heading is the name itself. */
export const BRAND = `<p class="brand">${markSvg({ size: 20, on: "auto" })}Overhand</p>`;

/** A relay page's document: the system's styles, the fonts from the hosted app, the content in one pane. */
export const page = (
  title: string,
  main: string,
  o: { css?: string; center?: boolean; tail?: string; description?: string } = {},
): string =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${o.description ? `<meta name="description" content="${o.description}">` : ""}<link rel="stylesheet" href="/fonts/instrument.css"><link rel="stylesheet" href="/relay/page.css">${o.css ? `<style>${o.css}</style>` : ""}<body${o.center ? ' class="center"' : ""}><main class="pane">${main}</main>${o.tail ?? ""}</body></html>`;

/** A relay page: the title as its heading unless the body brings its own. No script, nothing third-party. */
export const html = (title: string, body: string, status = 200, brand = true, description = "") =>
  new Response(
    page(title, `${brand ? BRAND : ""}${body.startsWith("<h1") ? "" : `<h1>${title}</h1>`}${body}`, { center: true, description }),
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on a POST, even to this site, and
        // the link form's Origin check then refuses every real confirmation. Nothing leaves the site either way.
        "referrer-policy": "same-origin",
        "permissions-policy": PERMISSIONS,
        // the fonts and their stylesheet come from this origin (the hosted app's /fonts)
        "content-security-policy":
          "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'",
      },
    },
  );
/** Text escaped for HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LinkQuery = z.object({
  pub: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().min(1).max(60),
  port: z.coerce.number().int().min(1024).max(65535),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

/** Every /relay/ route; other paths are the hosted dashboard's static files. */
export async function route(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const get = req.method === "GET";

  // every relay page's styles, one file so a page's HTML is its content
  if (get && p === "/relay/page.css")
    return new Response(PAGE_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" } });

  // ── sign-in: the page, OAuth, email codes, the callback ──
  const signIn = await signInRoute(req, env, url, now);
  if (signIn) return signIn;
  if (get && p === "/relay/dev-login") {
    // wrangler dev and tests only: never on a real hostname, and only with DEV_LOGIN set in .dev.vars
    if (env.DEV_LOGIN !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) return json({ error: "not found" }, 404);
    return signedIn(env, url.searchParams.get("ws") ?? "dev-workspace", "dev@localhost", safeNext(url.searchParams.get("next")), now);
  }
  if (req.method === "POST" && p === "/relay/logout") {
    if (!sameOrigin(req, url)) return json({ error: "forbidden" }, 403);
    return json({ ok: true }, 200, { "set-cookie": setCookie(SESSION, "", 0) });
  }
  if (req.method === "POST" && p === "/relay/signout-all") {
    // every browser on the account, this one too: sessions issued before now are void, open signalling sockets close
    const s = await sessionOf(req, env, now);
    if (!s || !sameOrigin(req, url)) return json({ error: "forbidden" }, 403);
    await env.DB.prepare(
      "INSERT INTO session_epochs (workspace, not_before) VALUES (?, ?) ON CONFLICT (workspace) DO UPDATE SET not_before = excluded.not_before",
    )
      .bind(s.ws, now + 1)
      .run();
    await kick(env, s.ws, "peers");
    return json({ ok: true }, 200, { "set-cookie": setCookie(SESSION, "", 0) });
  }

  // ── billing, webhooks first: Paddle signs them, no session ──
  if (req.method === "POST" && p === "/relay/paddle/webhook") {
    // only from Paddle's own addresses; with no list at all, 503 so Paddle retries rather than an event being lost
    const ips = await paddleIps(paddleBase(env.PADDLE_ENV), now);
    if (!ips) return json({ error: "paddle addresses unavailable" }, 503);
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    if (!ips.some((c) => inCidr(ip, c))) return json({ error: "forbidden" }, 403);
    const raw = await req.text();
    if (!(await verifyPaddleSignature(req.headers.get("paddle-signature"), raw, env.PADDLE_WEBHOOK_SECRET, now)))
      return json({ error: "bad signature" }, 401);
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const result = await applyEvent(env.DB, event, now);
    // a bad event is acknowledged anyway: Paddle would retry it forever, and the log says why
    if (result === "bad") console.error("paddle webhook: unusable event", raw.slice(0, 200));
    // a plan or seat change: the paying workspace's team room checks who may stay connected now
    const workspace = result === "applied" ? eventWorkspace(event) : null;
    const team = workspace && (await env.DB.prepare("SELECT id FROM teams WHERE billing_ws = ?").bind(workspace).first());
    // the webhook is already applied: a room that can't be told now re-checks on its own within ROOM_CHECK_MS, and
    // a 500 here would only make Paddle's retry a duplicate that pokes nothing
    if (team)
      await tellRoom(env, String(team.id), "check").catch((e) =>
        console.error(`team room check: ${e instanceof Error ? e.message : String(e)}`),
      );
    return json({ ok: true, result });
  }

  // ── a daemon, by its key ──
  if (req.method === "POST" && p === "/relay/entitlement") {
    const d = await daemonOf(req, env, now);
    if (!d) return json({ error: "unknown daemon" }, 401);
    // their own plan, or a seat on a team with an active Team plan
    const e = await access(env.DB, d.ws, now);
    if (!e) return json({ error: "no paid plan", plan: null }, 402);
    const token = await signToken((await relayKeys(env)).sign, {
      typ: "ent",
      ws: d.ws,
      plan: e.plan,
      seats: e.seats,
      iat: now,
      exp: now + ENTITLEMENT_TTL_MS,
    });
    return json({ token });
  }
  if (req.method === "POST" && p === "/relay/unlink") {
    // "Unlink this computer", from its own Settings: its key is refused from now on, and its socket closes
    const d = await daemonOf(req, env, now);
    if (!d) return json({ error: "unknown daemon" }, 401);
    await env.DB.prepare("INSERT OR IGNORE INTO revoked_links (pub, workspace, revoked_at) VALUES (?, ?, ?)").bind(d.pub, d.ws, now).run();
    await kick(env, d.ws, `daemon:${d.pub}`);
    return json({ ok: true });
  }

  // ── signalling and TURN: a daemon by its key, or a signed-in browser; both only with a paid plan ──
  if (p === "/relay/ws" || p === "/relay/ice") {
    const d = await daemonOf(req, env, now);
    const s = d ? null : await sessionOf(req, env, now);
    // a browser socket only from the hosted page itself: another site can't ride the cookie (cross-site WebSocket hijacking)
    if (s && !sameOrigin(req, url)) return json({ error: "forbidden" }, 403);
    const ws = d?.ws ?? s?.ws;
    if (!ws) return json({ error: "sign in" }, 401);
    if (!(await access(env.DB, ws, now))) return json({ error: "Access from anywhere needs Overhand Pro or Team." }, 402);
    if (p === "/relay/ice") {
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      return iceServers(env, ws, now);
    }
    if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected a websocket" }, 426);
    const h = new Headers(req.headers);
    h.delete("x-kick");
    // the object trusts only these; whatever a client sent under the same names is replaced
    h.set("x-role", d ? "daemon" : "peer");
    h.set("x-pub", d?.pub ?? "");
    h.set("x-name", d?.name ?? "");
    return env.WORKSPACE.get(env.WORKSPACE.idFromName(ws)).fetch(new Request(req.url, { method: "GET", headers: h }));
  }

  // ── teams: a member's daemon or signed-in browser; every route checks membership and role in D1 ──
  const team = await teamRoute(req, env, url, now);
  if (team) return team;

  // ── a signed-in browser ──
  const s = await sessionOf(req, env, now);
  if (get && p === "/relay/link") return linkPage(url, s);
  const billed = await billingRoute(req, env, url, s, now);
  if (billed) return billed;
  if (req.method === "POST" && p === "/relay/link") {
    if (!s || !sameOrigin(req, url)) return html("Not linked", "<p>Sign in on this page first.</p>", 403);
    const q = LinkQuery.safeParse(Object.fromEntries(await req.formData().then((f) => [...f.entries()].map(([k, v]) => [k, String(v)]))));
    if (!q.success) return html("Not linked", "<p>That link is malformed. Start again from Overhand's settings.</p>", 400);
    const cert = await signToken((await relayKeys(env)).sign, {
      typ: "link",
      ws: s.ws,
      email: s.email,
      pub: q.data.pub,
      name: q.data.name,
      iat: now,
    });
    // back to the daemon on this computer, with the nonce it made: only that daemon, for that one link, takes it
    const back = new URL(`http://127.0.0.1:${q.data.port}/api/relay/linked`);
    back.search = new URLSearchParams({ nonce: q.data.nonce, cert }).toString();
    return new Response(null, { status: 303, headers: { location: back.toString(), "referrer-policy": "no-referrer" } });
  }
  if (get && p === "/relay/me") {
    if (!s) return json({ signedIn: false, clientToken: env.PADDLE_CLIENT_TOKEN, environment: env.PADDLE_ENV });
    const e = await entitlementOf(env.DB, s.ws);
    const active = Boolean(await access(env.DB, s.ws, now));
    return json({
      signedIn: true,
      email: s.email,
      workspace: s.ws,
      active,
      plan: e?.plan ?? null,
      cycle: e?.cycle ?? null,
      seats: e?.seats ?? 0,
      status: e?.status ?? null,
      periodEnd: e?.period_end ?? null,
      clientToken: env.PADDLE_CLIENT_TOKEN,
      environment: env.PADDLE_ENV,
    });
  }
  return json({ error: "not found" }, 404);
}

/** The confirmation page for linking a daemon: who you are, which computer, and its key's fingerprint. */
async function linkPage(url: URL, s: SessionClaim | null): Promise<Response> {
  const q = LinkQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!q.success) return html("Not linked", "<p>That link is malformed. Start again from Overhand's settings.</p>", 400);
  if (!s)
    return new Response(null, { status: 302, headers: { location: `/relay/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
  const fields = Object.entries(q.data)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(String(v))}">`)
    .join("");
  return html(
    "Link this computer",
    `<h1>Link ${esc(q.data.name)} to ${esc(s.email)}?</h1>
<p>Its key's fingerprint is <code>${await fingerprint(q.data.pub)}</code>; Overhand's settings on that computer show the same one.</p>
<p>Only link a computer you just started this from. Linking lets your browser reach it from anywhere; Overhand still asks to pair each device once.</p>
<form method="post" action="/relay/link">${fields}<button class="primary">Link it</button></form>`,
  );
}

const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * Short-lived TURN credentials from Cloudflare Realtime (a secret API token, never sent to clients), while the
 * workspace is under its monthly grant budget; STUN only past it, so a runaway client can't run up TURN egress.
 */
async function iceServers(env: Env, ws: string, now: number): Promise<Response> {
  const cap = Number(env.TURN_MONTHLY_GRANTS ?? TURN_GRANTS);
  const month = new Date(now).toISOString().slice(0, 7);
  const used = await env.DB.prepare(
    "INSERT INTO turn_grants (workspace, month, n) VALUES (?, ?, 1) ON CONFLICT (workspace, month) DO UPDATE SET n = n + 1 RETURNING n",
  )
    .bind(ws, month)
    .first();
  if (Number(used?.n) > (Number.isFinite(cap) ? cap : TURN_GRANTS)) return json({ iceServers: STUN, turn: false });
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 4 * 60 * 60 }),
  });
  const ice = z
    .object({
      iceServers: z.array(
        z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() }),
      ),
    })
    .safeParse(await r.json().catch(() => null));
  if (!r.ok || !ice.success) return json({ iceServers: STUN });
  // browsers block port 53; Cloudflare's docs say to drop those URLs
  const servers = ice.data.iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }));
  return json({ iceServers: servers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/relay/")) return route(req, env);
    const known = WELL_KNOWN[url.pathname];
    if (known)
      return new Response(known(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    // the front page signed out is public HTML (what Overhand is, plans, prices, policies); signed in, the app as ever
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
      // a session check that fails (D1 down) serves the app as before, never a 500 for everyone
      const s = await sessionOf(req, env).catch(() => undefined);
      if (s === null) return publicHome(env, url);
    }
    return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: "not found" }, 404);
  },
};
