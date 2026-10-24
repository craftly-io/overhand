/**
 * The billing page, /relay/billing: plans read from Paddle at runtime, Paddle.js overlay checkout, the customer portal
 * and Team seats. A plain page of its own (never inside the dashboard): Paddle's overlay is a third-party iframe, so
 * this page must never be cross-origin isolated (no COEP), and the dashboard's bundle never carries Paddle code. The
 * dashboard's upgrade path and the site's pricing page open it in a new tab.
 */
import {
  COMPANY,
  CYCLES,
  type Cycle,
  EMAIL,
  PLAN_COPY,
  PLAN_TAX,
  PLANS,
  type Plan,
  planPrices,
  priceText,
  type SessionClaim,
  yearSaving,
} from "@overhand/contract";
import { markSvg } from "@overhand/themes/brand";
import { plainWords as w } from "@overhand/themes/words";
import { z } from "zod";
import { COPY_SCRIPT, hasLink, INSTALL_CSS, installBlock } from "./home";
import { activeEntitlement, type Catalog, type Entitlement, entitlementOf, listPrices, paddle, paddleBase, selectPrices } from "./paddle";
import { BRAND, type Env, html, json, page } from "./worker";

/**
 * Paddle checkout's settings, as script for both pages that run Paddle.js: one page, English, and light or dark as the
 * page itself is (the brand colour is set on the Paddle account).
 */
export const CHECKOUT_SETTINGS = `{ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", variant: "one-page", locale: "en" }`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A cycle's price as read: "€4 / month", the year with its saving computed from the catalog ("€40 / year · 2 months free"). */
function cycleText(plan: Plan, cycle: Cycle, c: Catalog): string {
  const p = c[plan][cycle];
  if (!p) return "";
  const s = cycle === "year" ? yearSaving(plan, c) : null;
  const saving = !s
    ? ""
    : Number.isInteger(s.months) && s.months >= 2
      ? w.billingMonthsFree.replace("{n}", String(s.months))
      : w.billingSave.replace("{amount}", s.amount);
  return `${esc(priceText(p))}<small>${PLAN_COPY[plan].per[cycle]}${saving ? ` · <span class="save">${esc(saving)}</span>` : ""}</small>`;
}

/**
 * One plan's card, the same five rows in every card so plans compare at a glance: name (and Your plan), promise, price,
 * what's included, and the action. A paid plan you can buy is a form: its cycle a real radio choice, Team its seats.
 */
function planCard(
  plan: "free" | Plan,
  c: Catalog,
  o: { current: boolean; buy: boolean; picked: string; install: boolean; switchOn?: Cycle | null },
): string {
  const copy = PLAN_COPY[plan];
  const paid = plan === "free" ? null : plan;
  // switching keeps the subscription's billing cycle: only that one is offered
  const cycles = paid ? CYCLES.filter((cy) => c[paid][cy] && (!o.switchOn || cy === o.switchOn)) : [];
  if (paid && !cycles.length) return "";
  const pickedCycle = cycles.find((cy) => o.picked === `${plan}-${cy}`);
  const form = Boolean(paid && (o.buy || o.switchOn));
  const head = `<h3 id="plan-${plan}">${copy.name}${o.current ? ` <span class="badge">${w.billingYourPlan}</span>` : ""}</h3>`;
  const includes = `<ul class="gets">${copy.includes.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  let price = paid ? "" : `<p class="prices">${PLAN_COPY.free.price}<small> ${PLAN_COPY.free.note}</small></p>`;
  // Free with no computer linked yet: its action is installing the app, just above the plans
  let act = !paid && o.install ? `<div class="act"><a class="button" href="#install">${w.billingInstall}</a></div>` : "<div></div>";
  if (paid && form) {
    const first = pickedCycle ?? cycles[0] ?? "month";
    price = `<fieldset class="cycles"><legend class="sr">${w.billingCycle}</legend>${cycles
      .map(
        (cy) =>
          `<label><input type="radio" name="cycle" value="${cy}"${cy === first ? " checked" : ""}><span>${cycleText(paid, cy, c)}</span></label>`,
      )
      .join("")}</fieldset>`;
    const p = c[paid][first];
    const seats =
      paid === "team" && p
        ? `<label>Seats <input type="number" name="seats" min="${p.min}" max="${p.max}" value="${p.min}" inputmode="numeric"></label>`
        : "";
    const label = (o.switchOn ? w.billingSwitch : w.billingChoose).replace("{plan}", copy.name);
    act = `<div class="act">${seats}<button${pickedCycle ? ' class="primary"' : ""}>${label}</button></div>`;
  } else if (paid) price = `<p class="prices">${cycles.map((cy) => cycleText(paid, cy, c)).join("<br>")}</p>`;
  const tag = form ? "form" : "section";
  const cls = `plan${pickedCycle ? " picked" : ""}${o.current ? " current" : ""}`;
  const data = form ? ` data-plan="${plan}" data-name="${copy.name}"${o.switchOn ? " data-switch" : ""}` : "";
  return `<${tag} class="${cls}"${data} aria-labelledby="plan-${plan}">${head}<p>${copy.promise}</p>${price}${includes}${act}</${tag}>`;
}

/** What follows "You're on Pro": the cancel or pause scheduled for the period's end, else when it renews. */
function until(e: Entitlement): string {
  const at = e.scheduled_at ?? e.period_end;
  if (!at) return ".";
  const said =
    e.scheduled_change === "cancel" ? w.billingUntilCancel : e.scheduled_change === "pause" ? w.billingUntilPause : w.billingRenewing;
  return said.replace("{date}", esc(at.slice(0, 10)));
}

/** The page for a signed-in browser. `nonce` allows its one inline script under the page's CSP. */
export function billingPage(o: {
  session: SessionClaim;
  catalog: Catalog | null;
  entitlement: Entitlement | null;
  active: boolean;
  /** A computer is linked to this workspace: without one, Free shows how to install first. */
  linked: boolean;
  clientToken: string;
  environment: string;
  picked: string;
  site: string;
  nonce: string;
}): string {
  const e = o.entitlement;
  const status =
    o.active && e
      ? `<p>You're on <b>${e.plan === "pro" ? "Pro" : "Team"}</b>${e.plan === "team" ? ` with ${e.seats} seats` : ""}${until(e)}${e.status === "past_due" ? ' <span class="warn">The last payment failed: Paddle will retry, or update your card below.</span>' : ""}</p>`
      : `<p>You're on <b>${PLAN_COPY.free.name}</b>: ${PLAN_COPY.free.promise.toLowerCase()} Paid plans add hosted features only.</p>`;
  const manage = e
    ? `<div class="row"><button id="portal">Manage billing (cards, invoices, cancel)</button></div>${
        o.active && e.plan === "team"
          ? `<form id="seats" class="row"><label>Seats <input type="number" name="seats" min="2" max="500" value="${e.seats}"></label><button>Change seats</button><small>Prorated by Paddle from today.</small></form>`
          : ""
      }`
    : "";
  const on = o.active && e ? e.plan : "free";
  const c = o.catalog;
  const install = !o.active && !o.linked;
  const plans = c
    ? `<h2>${w.hostedPlans}</h2><div class="plans">${(["free", ...PLANS] as const)
        .map((plan) =>
          planCard(plan, c, {
            current: plan === on,
            buy: !o.active,
            picked: o.picked,
            install,
            // on a plan the other paid one switches it, unless it's set to end (Paddle keeps that change first)
            switchOn:
              o.active && e && plan !== "free" && plan !== on && !e.scheduled_change ? (CYCLES.find((cy) => cy === e.cycle) ?? null) : null,
          }),
        )
        .join("")}</div><p><small>${PLAN_TAX}</small></p>`
    : "<p role=alert>Prices couldn't be loaded from Paddle just now. Try again in a minute.</p>";
  const sandbox =
    o.environment === "production"
      ? ""
      : `<p class="note">Sandbox: no real money moves. Test card 4242 4242 4242 4242, any future date, any CVC.</p>`;
  // Paddle Retain identifies the customer by Paddle's own ID only (never our workspace or the email); the pattern also
  // keeps anything unexpected out of the inline script
  const pwCustomer = e && /^ctm_[a-z0-9]+$/.test(e.customer_id) ? `\n    pwCustomer: ${JSON.stringify({ id: e.customer_id })},` : "";
  const css = `${install ? INSTALL_CSS : ""}
.install{display:grid;gap:12px;padding:16px;border:1px solid var(--ink-6);border-radius:var(--radius-card)}.install>*{margin:0}
.pane{max-width:60rem}
.plans{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(15rem,100%),1fr))}
.plan{border:1px solid var(--ink-6);background:var(--ink-3);border-radius:var(--radius-card);padding:16px;display:grid;grid-row:span 5;grid-template-rows:subgrid;gap:12px}.plan>*{margin:0}
.plan.current,.plan.picked{border-color:var(--ink-12)}
.plan h3{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;font:600 var(--t-body-size)/var(--t-small-line) var(--font-body)}
.badge{font-size:12px;line-height:20px;padding:0 10px;border-radius:var(--radius-control);background:var(--ink-12);color:var(--ink-1)}
.prices{font-size:20px;line-height:1.5;font-variant-numeric:tabular-nums}.prices small,.cycles small{font-size:14px}
.cycles{border:0;padding:0;margin:0;min-width:0;display:grid;gap:8px;align-content:start}
.cycles label{display:flex;gap:10px;align-items:center;min-height:44px;padding:6px 12px;border:1px solid var(--ink-6);border-radius:var(--radius-control);background:var(--ink-2);cursor:pointer;font-variant-numeric:tabular-nums}
.cycles label:has(:checked){border-color:var(--ink-12)}.cycles label:hover{border-color:var(--ink-9)}
.save{white-space:nowrap}
.cycles input{width:auto;min-height:0;margin:0;padding:0;accent-color:var(--ink-12)}
.gets{list-style:none;padding:0;display:grid;gap:6px;align-content:start}.gets li{position:relative;padding-left:22px}
.gets li::before{content:"\\2713"/"";position:absolute;left:0;color:var(--ink-10)}
.act{display:grid;gap:10px;align-content:end}.act button{width:100%}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}#msg:empty{display:none}
.links{display:flex;flex-wrap:wrap;gap:0 16px;font-size:14px}.links a{display:inline-block;padding:8px 0}`;
  const main = `${BRAND}
<h1>Billing</h1>
<p><small>Signed in as ${esc(o.session.email)}</small></p>
${status}${manage}${install ? `<section class="install" aria-labelledby="install">${installBlock(`${w.billingNotInstalled} ${w.billingInstall}`, "h2")}</section>` : ""}${plans}${sandbox}
<p id="msg" role="status" aria-live="polite"></p>
<h2>Security</h2>
<div class="row"><button id="signout-all">Sign out everywhere</button><small>Signs every browser out of this account, this one too. Your computers stay linked; unlink one from its own Settings → Phone.</small></div>
<nav class="links" aria-label="Overhand"><a href="${esc(o.site)}/pricing.html">Pricing</a><a href="${esc(o.site)}/terms.html">Terms</a><a href="${esc(o.site)}/refund.html">Refunds</a><a href="${esc(o.site)}/privacy.html">Privacy</a><a href="/">Back to Overhand</a></nav>`;
  return page("Overhand billing", main, {
    css,
    tail: `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script nonce="${o.nonce}">
${install ? COPY_SCRIPT : ""}
const msg = (t) => { document.getElementById("msg").textContent = t; };
const post = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const token = ${JSON.stringify(o.clientToken)};
if (token && window.Paddle) {
  if (${JSON.stringify(o.environment)} !== "production") Paddle.Environment.set("sandbox");
  Paddle.Initialize({
    token,${pwCustomer}
    checkout: { settings: ${CHECKOUT_SETTINGS} },
    eventCallback: (ev) => {
      if (ev.name !== "checkout.completed") return;
      msg("Payment received. Your plan turns on in a few seconds…");
      const poll = async (n) => {
        const me = await fetch("/relay/me").then((r) => r.json()).catch(() => ({}));
        if (me.active) return location.reload();
        if (n > 0) setTimeout(() => poll(n - 1), 2000);
      };
      poll(30);
    },
  });
}
for (const f of document.querySelectorAll("form.plan")) {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!window.Paddle || !token) return msg("Checkout isn't available right now.");
    const seats = f.seats ? Number(f.seats.value) : undefined;
    if (f.dataset.switch !== undefined) {
      if (!confirm(${JSON.stringify(w.billingSwitchAsk)}.replace("{plan}", f.dataset.name))) return;
      try { await post("/relay/switch", { plan: f.dataset.plan, cycle: f.cycle.value, seats }); msg(${JSON.stringify(w.billingSwitched)}); setTimeout(() => location.reload(), 3000); }
      catch (err) { msg(err.message); }
      return;
    }
    try {
      const t = await post("/relay/checkout", { plan: f.dataset.plan, cycle: f.cycle.value, seats });
      Paddle.Checkout.open({ transactionId: t.transactionId, customer: { email: t.email }, settings: { ...${CHECKOUT_SETTINGS}, displayMode: "overlay" } });
    } catch (err) { msg(err.message); }
  });
}
document.getElementById("portal")?.addEventListener("click", async () => {
  try { window.open((await post("/relay/portal")).url, "_blank", "noopener"); } catch (err) { msg(err.message); }
});
document.getElementById("signout-all").addEventListener("click", async () => {
  if (!confirm("Sign out of Overhand in every browser, this one too?")) return;
  try { await post("/relay/signout-all"); location.href = "/"; } catch (err) { msg(err.message); }
});
document.getElementById("seats")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await post("/relay/seats", { seats: Number(e.target.seats.value) }); msg("Seats changed. Paddle bills the difference, prorated."); setTimeout(() => location.reload(), 3000); }
  catch (err) { msg(err.message); }
});
</script>`,
  });
}

/**
 * app.overhand.dev's front page signed out, as real HTML (no script): the same content as the hosted app's signed-out
 * view (apps/web Hosted.tsx), in the relay's page styles: the plans from packages/contract plans.ts, prices from the catalog.
 */
export function publicPage(c: Catalog | null, site: string, next: string | null = null): Response {
  const plan = (k: (typeof PLANS)[number]) =>
    `<li><b>${PLAN_COPY[k].name}</b> <small>${planPrices(k, c).map(esc).join(" · ")}</small><br><small>${PLAN_COPY[k].promise}</small><ul>${PLAN_COPY[k].includes.map((i) => `<li><small>${i}</small></li>`).join("")}</ul></li>`;
  const plans = c
    ? `<ul class="plans">${PLANS.map(plan).join("")}</ul>`
    : `<p><a href="${esc(site)}/pricing">${w.hostedPricesElsewhere}</a></p>`;
  const links = [
    [w.hostedTerms, `${site}/terms`],
    [w.hostedPrivacy, `${site}/privacy`],
    [w.hostedRefund, `${site}/refund`],
    [w.hostedContact, `${site}/contact`],
    [w.hostedGetApp, site],
  ]
    .map(([label, href]) => `<a href="${esc(href ?? "")}">${label}</a>`)
    .join(" ");
  return html(
    `${w.brand}: ${w.hostedTitle}`,
    `<h1 class="brand">${markSvg({ size: 20, on: "auto" })}${w.brand}</h1>
<style>.plans{padding:0;list-style:none;display:grid;gap:12px}.plans ul{margin:4px 0 0;padding-left:18px}nav a{display:inline-block;padding:8px 16px 8px 0}</style>
<p>${w.hostedPublicLine}</p>
<p><small>${w.hostedPublicAbout}</small></p>
<h2>${w.hostedHowTitle}</h2>
<ol><li>${w.hostedHow1}</li><li>${w.hostedHow2}</li><li>${w.hostedHow3}</li></ol>
<h2>${w.hostedPlans}</h2>
${plans}
<p><small>${PLAN_TAX}</small></p>
<p><a class="button primary" href="/relay/login${next ? `?next=${encodeURIComponent(next)}` : ""}">${w.hostedSignIn}</a></p>
<nav aria-label="${w.brand}">${links}</nav>
<p><small>${w.hostedMaker.replace("{company}", COMPANY).replace("{email}", `<a href="mailto:${EMAIL}">${EMAIL}</a>`)}</small></p>`,
    200,
    false,
    w.hostedPublicLine,
  );
}

/**
 * A plan picked on the site ("pro-month", "team-year"), or null for anything else: the only thing a sign-in's return
 * address to billing is built from, so it's always /relay/billing on this site, never another host or path.
 */
export const pickedPlan = (v: string | null): string | null => (v && PLANS.some((p) => CYCLES.some((c) => v === `${p}-${c}`)) ? v : null);

/**
 * GET / with no session: the public front page. Arriving from billing (?billing or ?plan=…), Sign in comes back to
 * billing, with the plan only when it's a known one; otherwise to the app.
 */
export async function publicHome(env: Env, url: URL, now = Date.now()): Promise<Response> {
  const q = url.searchParams;
  const plan = pickedPlan(q.get("plan"));
  const next = plan ? `/relay/billing?plan=${plan}` : q.has("billing") || q.has("plan") ? "/relay/billing" : null;
  return publicPage(await prices(env, now).catch(() => null), env.SITE_ORIGIN, next);
}

let catalog: { at: number; base: string; value: Catalog } | null = null;
let failed: { at: number; base: string } | null = null;
const CATALOG_MS = 10 * 60_000;
const FAILED_MS = 60_000;
/**
 * The tagged catalog, cached per isolate for ten minutes, so a price changed in Paddle shows within that, no release.
 * A failed read (Paddle down or slower than 3 s) is remembered for a minute, so a public page never queues on it.
 */
export async function prices(env: Env, now = Date.now()): Promise<Catalog> {
  const base = paddleBase(env.PADDLE_ENV);
  if (catalog && catalog.base === base && now - catalog.at < CATALOG_MS) return catalog.value;
  if (failed && failed.base === base && now - failed.at < FAILED_MS) throw new Error("Paddle prices unavailable, retrying shortly");
  try {
    catalog = { at: now, base, value: selectPrices(await listPrices(base, env.PADDLE_API_KEY, AbortSignal.timeout(3000))) };
    failed = null;
    return catalog.value;
  } catch (e) {
    failed = { at: now, base };
    throw e;
  }
}

/** What the billing page says when Paddle refuses or fails an action. */
/** Checkout while a plan is on: a second subscription would bill twice, and canceling either would muddle access. */
export const BILLING_FAILED = `Paddle couldn't do that just now. Try again in a minute; if it keeps failing, write to ${EMAIL}.`;
/** Checkout while a plan is on: a second subscription would bill twice, and canceling either would muddle access. */
export const ON_A_PLAN = "You're on a plan already: switch it on this page.";

/** Headers for a page that runs Paddle.js under a nonce. */
const checkoutHeaders = (nonce: string): Record<string, string> => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Paddle's overlay is an iframe from paddle.com: this page is never cross-origin isolated (no COEP)
  "content-security-policy": [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' https://cdn.paddle.com https://*.paddle.com`,
    "frame-src https://*.paddle.com",
    "connect-src 'self' https://*.paddle.com",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://*.paddle.com",
    "frame-ancestors 'none'",
  ].join("; "),
});

/**
 * Paddle's default payment link, signed out: Paddle.js reads ?_ptxn= itself and opens that transaction's checkout (a card
 * update, a failed renewal). Nothing of the account shows.
 */
export const paymentLinkPage = (token: string, environment: string, site: string, nonce: string): string =>
  page(
    "Overhand payment",
    `${BRAND}<h1>Your payment</h1><p id="msg">Paddle's checkout opens here. If it doesn't, <a href="${esc(site)}/pricing.html">see pricing</a> or sign in to Overhand.</p>`,
    {
      center: true,
      tail: `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script nonce="${nonce}">
if (window.Paddle && ${JSON.stringify(token)}) {
  if (${JSON.stringify(environment)} !== "production") Paddle.Environment.set("sandbox");
  Paddle.Initialize({ token: ${JSON.stringify(token)}, checkout: { settings: ${CHECKOUT_SETTINGS} }, eventCallback: (ev) => {
    if (ev.name === "checkout.completed") document.getElementById("msg").textContent = "Done. Thank you.";
  } });
}
</script>`,
    },
  );

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The billing routes: /relay/prices (public, for the site's pricing page), the billing page, and its checkout, portal
 * and seats actions (a signed-in, same-origin browser only). Null for any other path.
 */
export async function billingRoute(req: Request, env: Env, url: URL, s: SessionClaim | null, now: number): Promise<Response | null> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/relay/prices") {
    const cors: Record<string, string> = env.SITE_ORIGIN ? { "access-control-allow-origin": env.SITE_ORIGIN, vary: "origin" } : {};
    try {
      return json({ prices: await prices(env, now), environment: env.PADDLE_ENV }, 200, {
        ...cors,
        "cache-control": "public, max-age=300",
      });
    } catch (e) {
      return json({ error: errorOf(e) }, 502, cors);
    }
  }
  if (req.method === "GET" && p === "/relay/billing") {
    // signed out, the plans and prices are app.overhand.dev's one public page
    if (!s) {
      // Paddle's own links (a card update, a renewal that failed) land here with ?_ptxn=: its checkout opens for that
      // transaction, signed in or not; the transaction is Paddle's, so no session of ours is needed
      const txn = url.searchParams.get("_ptxn") ?? "";
      if (/^txn_[a-z0-9]+$/.test(txn)) {
        const nonce = crypto.randomUUID().replace(/-/g, "");
        return new Response(paymentLinkPage(env.PADDLE_CLIENT_TOKEN, env.PADDLE_ENV, env.SITE_ORIGIN, nonce), {
          headers: checkoutHeaders(nonce),
        });
      }
      // the way back to billing always travels along; the plan only when it's a known one
      const plan = pickedPlan(url.searchParams.get("plan"));
      return new Response(null, { status: 302, headers: { location: plan ? `/?plan=${plan}` : "/?billing" } });
    }
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const page = billingPage({
      session: s,
      catalog: await prices(env, now).catch(() => null),
      entitlement: await entitlementOf(env.DB, s.ws),
      active: Boolean(await activeEntitlement(env.DB, s.ws)),
      linked: await hasLink(env.DB, s.ws),
      clientToken: env.PADDLE_CLIENT_TOKEN,
      environment: env.PADDLE_ENV,
      picked: url.searchParams.get("plan") ?? "",
      site: env.SITE_ORIGIN,
      nonce,
    });
    return new Response(page, { headers: checkoutHeaders(nonce) });
  }
  if (req.method !== "POST" || !["/relay/checkout", "/relay/switch", "/relay/portal", "/relay/seats"].includes(p)) return null;
  if (!s) return json({ error: "sign in" }, 401);
  if (req.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
  const body: unknown = await req.json().catch(() => ({}));
  const base = paddleBase(env.PADDLE_ENV);
  try {
    if (p === "/relay/checkout" || p === "/relay/switch") {
      const b = z.object({ plan: z.enum(PLANS), cycle: z.enum(CYCLES), seats: z.number().int().optional() }).safeParse(body);
      if (!b.success) return json({ error: "pick a plan and a billing cycle" }, 400);
      const on = await activeEntitlement(env.DB, s.ws);
      if (p === "/relay/switch") {
        // the subscription's item becomes the other plan's price in the same cycle, prorated today; the
        // subscription.updated webhook that follows updates the entitlement
        if (!on) return json({ error: "Choose a plan first: there's none to switch." }, 409);
        if (on.scheduled_change) return json({ error: w.billingSwitchScheduled }, 409);
        if (on.plan === b.data.plan || (on.cycle && on.cycle !== b.data.cycle))
          return json({ error: "Switching changes the plan and keeps its billing cycle." }, 400);
        const price = (await prices(env, now))[b.data.plan][b.data.cycle];
        if (!price) return json({ error: `no ${b.data.plan} ${b.data.cycle} price in Paddle` }, 404);
        const quantity = Math.min(price.max, Math.max(price.min, b.data.seats ?? price.min));
        await paddle(base, env.PADDLE_API_KEY, `/subscriptions/${encodeURIComponent(on.subscription_id)}`, {
          method: "PATCH",
          body: { items: [{ price_id: price.id, quantity }], proration_billing_mode: "prorated_immediately" },
        });
        return json({ ok: true });
      }
      // a draft transaction for the tagged price, with the workspace set here, never by the browser
      if (on) return json({ error: ON_A_PLAN }, 409);
      const price = (await prices(env, now))[b.data.plan][b.data.cycle];
      if (!price) return json({ error: `no ${b.data.plan} ${b.data.cycle} price in Paddle` }, 404);
      // Team's seats within the price's own quantity limits (2–500 in the catalog)
      const quantity = Math.min(price.max, Math.max(price.min, b.data.seats ?? price.min));
      const t = z.object({ id: z.string() }).parse(
        await paddle(base, env.PADDLE_API_KEY, "/transactions", {
          method: "POST",
          body: { items: [{ price_id: price.id, quantity }], custom_data: { workspace: s.ws } },
        }),
      );
      return json({ transactionId: t.id, email: s.email });
    }
    if (p === "/relay/portal") {
      // the portal's token is temporary, so the link is made on each click and never stored
      const e = await entitlementOf(env.DB, s.ws);
      if (!e) return json({ error: "no subscription yet" }, 404);
      const r = z.object({ urls: z.object({ general: z.object({ overview: z.string() }) }) }).parse(
        await paddle(base, env.PADDLE_API_KEY, `/customers/${encodeURIComponent(e.customer_id)}/portal-sessions`, {
          method: "POST",
          body: { subscription_ids: [e.subscription_id] },
        }),
      );
      return json({ url: r.urls.general.overview });
    }
    // seats: Team only, prorated now; the subscription.updated webhook that follows updates the entitlement
    const n = z.object({ seats: z.number().int().min(2).max(500) }).safeParse(body);
    if (!n.success) return json({ error: "Team has 2 to 500 seats" }, 400);
    const e = await activeEntitlement(env.DB, s.ws);
    if (e?.plan !== "team") return json({ error: "seats are for an active Team plan" }, 409);
    await paddle(base, env.PADDLE_API_KEY, `/subscriptions/${encodeURIComponent(e.subscription_id)}`, {
      method: "PATCH",
      body: { items: [{ price_id: e.price_id, quantity: n.data.seats }], proration_billing_mode: "prorated_immediately" },
    });
    return json({ ok: true });
  } catch (e) {
    // what Paddle said goes to the Worker's log; the page gets one plain line
    console.error(`billing ${p}: ${errorOf(e)}`);
    return json({ error: BILLING_FAILED }, 502);
  }
}
