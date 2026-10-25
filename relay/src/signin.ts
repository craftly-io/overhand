/**
 * Sign-in, on Overhand's own page at /relay/login: GitHub and Google through WorkOS OAuth (only the providers listed in
 * SIGN_IN_PROVIDERS), email through WorkOS Magic Auth (a 6-digit code), passkeys and SSO through the hosted AuthKit
 * page. Every way ends in `authenticate`, which sets the one session. A new email simply becomes an account.
 *
 * The email flow keeps the address out of URLs and logs: it travels in POST bodies, then in a cookie the relay signs
 * and expires with the code. Sends and code attempts are counted per email and per network in small fixed windows,
 * shaped so a stranger can slow one address down for minutes at most, and can't shut sign-in for anyone else.
 */
import { b64url, sign, signToken, unb64url, verify } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes/words";
import { z } from "zod";
import { sha256 } from "./team";
import { cookie, type Env, esc, html, relayKeys, SESSION, SESSION_MS, safeNext, sameOrigin, setCookie } from "./worker";

const WORKOS = "https://api.workos.com/user_management";
/** OAuth's state and return path, from the provider button to /relay/callback. */
const AUTH = "hl_auth";
/** The email flow's signed address and return path, from sending the code to entering it. */
const EMAIL = "hl_email";
/** WorkOS Magic Auth codes expire after 10 minutes; the flow's cookie with them. */
const CODE_S = 600;
/** The providers a button may start, by WorkOS's name, and their words. */
const OAUTH = { GitHubOAuth: w.signInGithub, GoogleOAuth: w.signInGoogle } as const;
/** The rate limits' fixed windows: a short one for bursts, a day for slow, steady abuse. */
export const LIMIT_WINDOW_MS = 15 * 60_000;
export const LIMIT_DAY_MS = 24 * 60 * 60_000;
/**
 * The tries each limit allows per window. Anything counted per email alone (which anyone who knows the address can
 * spend) refuses for one short window at most; the day caps count per email and network, so tries from elsewhere
 * never use up someone's own. All sends together are capped only for addresses that have never signed in: a flood of
 * made-up addresses can hold up new accounts for a window, never an existing one, whose sends (like one address's
 * day) only raise an alert past their mark. WorkOS's own expiry and invalidation of a code stays the brute-force defence.
 */
export const LIMITS = {
  sendEmail: 5,
  sendIp: 20,
  sendNew: 300,
  sendKnown: 300,
  sendEmailIpDay: 20,
  sendEmailDay: 40,
  codeEmailIp: 5,
  codeEmail: 10,
  codeIp: 30,
  failEmailIpDay: 20,
} as const;

const Provider = z.enum(["authkit", "GitHubOAuth", "GoogleOAuth"]);
const EmailForm = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)), next: z.string().max(2048).optional() });
const CodeForm = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
const Flow = z.object({ email: z.email(), next: z.string(), exp: z.number() });
const Authenticated = z.object({ user: z.object({ id: z.string(), email: z.string(), email_verified: z.boolean().optional() }) });

const STYLE =
  "<style>.ways{display:grid;gap:12px}.ways .button,.ways button{width:100%}.ways label{display:grid;gap:6px}.ways input{width:100%;margin:0}</style>";

/** The OAuth providers configured for this relay (SIGN_IN_PROVIDERS), in the order WorkOS knows them. */
const providers = (env: Env): (keyof typeof OAUTH)[] => {
  const on = (env.SIGN_IN_PROVIDERS ?? "").split(",").map((s) => s.trim());
  return (["GitHubOAuth", "GoogleOAuth"] as const).filter((p) => on.includes(p));
};

/** The sign-in page: the configured providers, the email form, the passkey link; `note` explains a refusal. */
function loginPage(env: Env, next: string, note = "", status = 200): Response {
  const n = encodeURIComponent(next);
  const start = (p: string) => `/relay/login/start?provider=${p}&amp;next=${n}`;
  const buttons = providers(env)
    .map((p) => `<a class="button" href="${start(p)}">${OAUTH[p]}</a>`)
    .join("");
  return html(
    w.signInTitle,
    `${STYLE}${note ? `<p class="warn" role="alert">${note}</p>` : ""}${buttons ? `<div class="ways">${buttons}</div>` : ""}
<form class="ways" method="post" action="/relay/login/email"><label>${w.signInEmailLabel}<input type="email" name="email" autocomplete="email" maxlength="254" required></label><input type="hidden" name="next" value="${esc(next)}"><button class="primary">${w.signInEmail}</button></form>
<p><small>${w.signInNew}</small></p>
<p><small><a href="${start("authkit")}">${w.signInPasskey}</a></small></p>`,
    status,
  );
}

/** The code page: where the code went, the code form, and the way back to send another. */
function codePage(email: string, next: string, note = "", status = 200): Response {
  return html(
    w.signInCodeTitle,
    `${STYLE}<p>${w.signInCodeSent.replace("{email}", `<b>${esc(email)}</b>`)}</p>${note ? `<p class="warn" role="alert">${note}</p>` : ""}
<form class="ways" method="post" action="/relay/login/code"><label>${w.signInCodeLabel}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label><button class="primary">${w.hostedSignIn}</button></form>
<p><small><a href="/relay/login?next=${encodeURIComponent(next)}">${w.signInOtherEmail}</a></small></p>`,
    status,
  );
}

/** The email flow's cookie value: the claim, signed apart from every token (its own prefix), so neither passes as the other. */
async function sealFlow(env: Env, flow: z.infer<typeof Flow>): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(flow)));
  return `${body}.${await sign((await relayKeys(env)).sign, `email-flow.${body}`)}`;
}

/** The email flow this browser is in, or null when there's none, it's forged, or it expired. */
async function openFlow(env: Env, req: Request, now: number): Promise<z.infer<typeof Flow> | null> {
  const [body, sig, extra] = cookie(req, EMAIL).split(".");
  if (!body || !sig || extra !== undefined || !(await verify((await relayKeys(env)).verify, `email-flow.${body}`, sig))) return null;
  try {
    const flow = Flow.safeParse(JSON.parse(new TextDecoder().decode(unb64url(body))));
    return flow.success && flow.data.exp > now ? flow.data : null;
  } catch {
    return null;
  }
}

/**
 * The network an address is on, for its limits: an IPv4 address as it is, an IPv6 one by its /48 (one cheap server
 * can get a /48 and rotate through its 65,536 /64s), normalised so every spelling of it counts as one.
 */
export function network(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!a.includes(":")) return a;
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4?.[1]) return v4[1];
  const [head = "", tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups
    .slice(0, 3)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/48`;
}

/** A counted thing: what (hashed before it's stored), its cap and its window; with `alert`, the cap logs, never refuses. */
type Counter = { what: string; max: number; ms: number; alert?: string };

/**
 * Counts one try against each counter (or, with `count` false, only reads them); true when any refusing one is past
 * its cap. Rows hold a hash, never an email or address, and the window's start in ms; rows older than a day go now
 * and then.
 */
async function overLimit(env: Env, counters: Counter[], now: number, count = true): Promise<boolean> {
  // ponytail: prune on ~1 in 50 calls; the win index keeps it cheap, a cron would make it exact
  if (Math.random() < 0.02)
    await env.DB.prepare("DELETE FROM sign_in_limits WHERE win < ?")
      .bind(now - LIMIT_DAY_MS)
      .run();
  let over = false;
  for (const c of counters) {
    const key = await sha256(c.what);
    const win = Math.floor(now / c.ms) * c.ms;
    const row = count
      ? await env.DB.prepare(
          "INSERT INTO sign_in_limits (key, win, n) VALUES (?, ?, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1 RETURNING n",
        )
          .bind(key, win)
          .first()
      : await env.DB.prepare("SELECT n + 1 AS n FROM sign_in_limits WHERE key = ? AND win = ?").bind(key, win).first();
    const n = Number(row?.n);
    // an alert logs once per window, as it's crossed: the owner looks, and nobody real is refused for it
    if (!c.alert) over ||= n > c.max;
    else if (count && n === c.max + 1) console.error(`sign-in: ${c.alert} passed ${c.max}`);
  }
  return over;
}

/** What an address that has signed in before is known by: a hash, never the address. */
const accountKey = (email: string) => sha256(`account:${email.toLowerCase()}`);

/** Whether this address has signed in here before: its sends then never share the pool made-up addresses use. */
async function knownAccount(env: Env, email: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare("SELECT 1 AS x FROM sign_in_accounts WHERE key = ?")
      .bind(await accountKey(email))
      .first(),
  );
}

/** Sets the session for a WorkOS user and goes to `next`; every way of signing in, and dev-login, ends here. */
export async function signedIn(env: Env, ws: string, email: string, next: string, now: number): Promise<Response> {
  await env.DB.prepare("INSERT OR IGNORE INTO sign_in_accounts (key, at) VALUES (?, ?)")
    .bind(await accountKey(email), now)
    .run();
  const token = await signToken((await relayKeys(env)).sign, { typ: "session", ws, email, iat: now, exp: now + SESSION_MS });
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(SESSION, token, SESSION_MS / 1000));
  h.append("set-cookie", setCookie(AUTH, "", 0, "/relay/"));
  h.append("set-cookie", setCookie(EMAIL, "", 0, "/relay/"));
  return new Response(null, { status: 302, headers: h });
}

/**
 * One WorkOS authenticate call (a code from OAuth, or an email's Magic Auth code), then the session; null if refused.
 * The email is trusted only when WorkOS says it's verified, or it's the address the Magic Auth code just proved
 * (`proven`): a provider handing back an unverified address never gets that address's team invites.
 */
async function authenticate(
  env: Env,
  req: Request,
  grant: Record<string, string>,
  next: string,
  now: number,
  proven = "",
): Promise<Response | null> {
  // the real client, so WorkOS's own abuse detection sees who is signing in, not the relay
  const client = { ip_address: req.headers.get("cf-connecting-ip") ?? "", user_agent: req.headers.get("user-agent") ?? "" };
  const seen = Object.fromEntries(Object.entries(client).filter(([, v]) => v));
  const r = await fetch(`${WORKOS}/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.WORKOS_CLIENT_ID, client_secret: env.WORKOS_API_KEY, ...grant, ...seen }),
  }).catch(() => null);
  const auth = Authenticated.safeParse(await r?.json().catch(() => null));
  if (!r?.ok || !auth.success) return null;
  const { id, email, email_verified } = auth.data.user;
  if (email_verified !== true && !(proven && email.toLowerCase() === proven)) return null;
  return signedIn(env, id, email, next, now);
}

const form = async (req: Request): Promise<Record<string, string>> =>
  Object.fromEntries(
    await req
      .formData()
      .then((f) => [...f.entries()].map(([k, v]) => [k, String(v)]))
      .catch(() => []),
  );

/** The /relay/login… and /relay/callback routes, or null for any other request. */
export async function signInRoute(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const p = url.pathname;
  const get = req.method === "GET";
  const post = req.method === "POST";
  const ip = network(req.headers.get("cf-connecting-ip") ?? "unknown");

  if (get && p === "/relay/login") return loginPage(env, safeNext(url.searchParams.get("next")));

  if (get && p === "/relay/login/start") {
    // a provider button, or the passkey link (AuthKit's hosted page, which also does SSO): only what's configured
    const next = safeNext(url.searchParams.get("next"));
    const provider = Provider.safeParse(url.searchParams.get("provider"));
    const allowed = provider.success && (provider.data === "authkit" || providers(env).includes(provider.data));
    if (!provider.success || !allowed)
      return new Response(null, { status: 302, headers: { location: `/relay/login?next=${encodeURIComponent(next)}` } });
    const state = crypto.randomUUID();
    const to = new URL(`${WORKOS}/authorize`);
    to.search = new URLSearchParams({
      response_type: "code",
      client_id: env.WORKOS_CLIENT_ID,
      redirect_uri: `${url.origin}/relay/callback`,
      provider: provider.data,
      state,
    }).toString();
    return new Response(null, {
      status: 302,
      headers: { location: to.toString(), "set-cookie": setCookie(AUTH, encodeURIComponent(`${state} ${next}`), CODE_S, "/relay/") },
    });
  }

  if (get && p === "/relay/callback") {
    let saved = "";
    try {
      saved = decodeURIComponent(cookie(req, AUTH));
    } catch {
      // a mangled cookie is no cookie
    }
    const [state, next = "/"] = saved.split(" ");
    const code = url.searchParams.get("code") ?? "";
    if (!state || state !== url.searchParams.get("state") || !code) return loginPage(env, safeNext(next), w.signInExpired, 400);
    return (
      (await authenticate(env, req, { grant_type: "authorization_code", code }, next, now)) ??
      loginPage(env, safeNext(next), w.signInRefused, 502)
    );
  }

  if (post && p === "/relay/login/email") {
    // a form on this page only (the link form's check): another site can't spend someone's codes or our sends
    if (!sameOrigin(req, url)) return loginPage(env, "/", w.signInExpired, 403);
    const body = await form(req);
    const next = safeNext(body.next ?? null);
    const q = EmailForm.safeParse(body);
    if (!q.success) return loginPage(env, next, w.signInBadEmail, 400);
    const { email } = q.data;
    const sends: Counter[] = [
      { what: `send:email:${email}`, max: LIMITS.sendEmail, ms: LIMIT_WINDOW_MS },
      { what: `send:ip:${ip}`, max: LIMITS.sendIp, ms: LIMIT_WINDOW_MS },
      { what: `send:email-ip-day:${email}:${ip}`, max: LIMITS.sendEmailIpDay, ms: LIMIT_DAY_MS },
      { what: `send:email-day:${email}`, max: LIMITS.sendEmailDay, ms: LIMIT_DAY_MS, alert: "one address's sends" },
      (await knownAccount(env, email))
        ? { what: "send:known", max: LIMITS.sendKnown, ms: LIMIT_WINDOW_MS, alert: "sends to accounts" }
        : { what: "send:new", max: LIMITS.sendNew, ms: LIMIT_WINDOW_MS },
    ];
    if (await overLimit(env, sends, now)) return loginPage(env, next, w.signInTooMany, 429);
    // the same answer whatever WorkOS says, so the page never tells whether the address has an account
    const r = await fetch(`${WORKOS}/magic_auth`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (!r?.ok) console.error("sign-in: WorkOS didn't send a code", r?.status ?? "unreachable");
    const flow = await sealFlow(env, { email, next, exp: now + CODE_S * 1000 });
    return new Response(null, {
      status: 303,
      headers: { location: "/relay/login/code", "set-cookie": setCookie(EMAIL, flow, CODE_S, "/relay/") },
    });
  }

  if (p === "/relay/login/code" && (get || post)) {
    const flow = await openFlow(env, req, now);
    if (get) return flow ? codePage(flow.email, flow.next) : loginPage(env, "/", w.signInExpired, 400);
    if (!sameOrigin(req, url) || !flow) return loginPage(env, flow?.next ?? "/", w.signInExpired, 403);
    const q = CodeForm.safeParse(await form(req));
    // a malformed code, one past the limits and one WorkOS refuses all get the same answer
    const refused = () => codePage(flow.email, flow.next, w.signInCodeFailed, 400);
    const failures: Counter[] = [{ what: `fail:email-ip-day:${flow.email}:${ip}`, max: LIMITS.failEmailIpDay, ms: LIMIT_DAY_MS }];
    const tries: Counter[] = [
      { what: `code:email-ip:${flow.email}:${ip}`, max: LIMITS.codeEmailIp, ms: LIMIT_WINDOW_MS },
      { what: `code:email:${flow.email}`, max: LIMITS.codeEmail, ms: LIMIT_WINDOW_MS },
      { what: `code:ip:${ip}`, max: LIMITS.codeIp, ms: LIMIT_WINDOW_MS },
    ];
    if ((await overLimit(env, tries, now)) || (await overLimit(env, failures, now, false))) return refused();
    const grant = q.success ? { grant_type: "urn:workos:oauth:grant-type:magic-auth:code", code: q.data.code, email: flow.email } : null;
    const done = grant && (await authenticate(env, req, grant, flow.next, now, flow.email));
    if (done) return done;
    await overLimit(env, failures, now);
    return refused();
  }
  return null;
}
