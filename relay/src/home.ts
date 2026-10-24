/**
 * app.overhand.dev signed in without a paid plan, /relay/home (GET / sends you here). Most new accounts haven't
 * installed Overhand yet, so with no computer linked it shows the install line and the prompt for your agent first,
 * then how to link, with a line that turns to Linked by itself; plans come last. Once a computer is linked, the plans.
 * With a paid plan, / is your Overhand as ever.
 */
import { INSTALL_COMMAND, LOCAL_PORT, PLAN_COPY, PLAN_TAX, PLANS, planPrices, SETUP_PROMPT, type SessionClaim } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes/words";
import { prices } from "./billing";
import type { D1 } from "./paddle";
import { access } from "./team";
import { BRAND, type Env, esc, page, pageHeaders } from "./worker";

/** Remembers a linked computer's key for its workspace; a failed write is logged and never fails the daemon's request. */
export async function recordLink(db: D1, ws: string, pub: string, now: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO links (pub, workspace, linked_at) VALUES (?, ?, ?)")
    .bind(pub, ws, now)
    .run()
    .catch((e: unknown) => console.error(`record link: ${e instanceof Error ? e.message : String(e)}`));
}

/** Whether a computer is linked to this workspace and not unlinked since; false when it can't be read. */
export async function hasLink(db: D1, ws: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM links l WHERE l.workspace = ? AND NOT EXISTS (SELECT 1 FROM revoked_links r WHERE r.pub = l.pub) LIMIT 1")
    .bind(ws)
    .first()
    .catch(() => null);
  return Boolean(row);
}

/** The install block's styles, for the home page and billing: a command or a prompt beside its Copy button. */
export const INSTALL_CSS = `
.copy{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 14px;border:1px solid var(--ink-6);border-radius:var(--radius-card);background:var(--ink-2)}
.copy>:first-child{flex:1;min-width:0;margin:0}.copy button{flex:none}
@media (max-width:480px){.copy{flex-direction:column;align-items:stretch;padding:12px}}`;

/**
 * Install Overhand: the one line and the prompt for your agent, from the same constants the site shows
 * (packages/contract/src/links.ts), each with a Copy button that COPY_SCRIPT wires up.
 */
export const installBlock = (heading: string, tag: "h1" | "h2") =>
  `<${tag} id="install">${heading}</${tag}>
<p>${w.homeInstallLine}</p>
<div class="copy"><code id="install-line">${esc(INSTALL_COMMAND)}</code><button type="button" data-copy="install-line">${w.hostedCopy}</button></div>
<p>${w.homeInstallAgent}</p>
<div class="copy"><p id="install-prompt">${esc(SETUP_PROMPT)}</p><button type="button" data-copy="install-prompt">${w.homeCopyPrompt}</button></div>`;

/** Copies the text a `data-copy` button points at, and says Copied for a moment. */
export const COPY_SCRIPT = `for (const b of document.querySelectorAll("[data-copy]")) {
  const label = b.textContent;
  b.addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(() => {
      b.textContent = ${JSON.stringify(w.hostedCopied)};
      setTimeout(() => { b.textContent = label; }, 2000);
    }, () => {});
  });
}`;

const CSS = `${INSTALL_CSS}
.live{display:flex;align-items:center;gap:10px;color:var(--ink-10)}
.live::before{content:"";flex:none;width:8px;height:8px;border-radius:var(--radius-control);background:var(--ink-9);animation:wait var(--m-loop) infinite}
.live.on{color:var(--ink-12);font-weight:600}.live.on::before{background:var(--ok);animation:none}
@keyframes wait{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.live::before{animation:none}}
.quiet{border-top:1px solid var(--ink-6);padding-top:16px;color:var(--ink-10)}
.plans{display:grid;gap:12px;padding:0;list-style:none}
.plans>li{border:1px solid var(--ink-6);background:var(--ink-3);border-radius:var(--radius-card);padding:16px}.plans ul{margin:6px 0 0;padding-left:18px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.links{display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;font-size:14px;color:var(--ink-10)}.links a{display:inline-block;padding:8px 0}
.links button{min-height:36px;padding:0 14px}`;

/** The page for a signed-in browser without a paid plan: install and link first, or, once linked, the plans. */
export function homePage(o: { session: SessionClaim; linked: boolean; prices: Parameters<typeof planPrices>[1]; nonce: string }): string {
  const open = `<a class="button" href="http://localhost:${LOCAL_PORT}/?settings=phone" target="_blank" rel="noopener noreferrer">${w.hostedOpenLocal}</a>`;
  const from = planPrices("pro", o.prices)[0];
  const body = o.linked
    ? `<h1>${w.homeLinkedTitle}</h1>
<p>${w.hostedNeedsPlanLine}</p>
<h2>${w.hostedWhatYouGet}</h2>
<ul class="plans">${PLANS.map((k) => `<li><b>${PLAN_COPY[k].name}</b><ul>${PLAN_COPY[k].includes.map((i) => `<li>${i}</li>`).join("")}</ul></li>`).join("")}</ul>
${from ? `<p><b>${esc(w.hostedFrom.replace("{price}", from))}</b></p>` : ""}
<div class="row"><a class="button primary" href="/relay/billing">${w.hostedChoosePlan}</a></div>
<p><small>${w.hostedNeedsPlanBody}${from ? ` ${PLAN_TAX}` : ""}</small></p>`
    : `${installBlock(w.homeInstallTitle, "h1")}
<h2>${w.homeLinkTitle}</h2>
<p>${w.homeLinkLine.replace("{setUp}", `<b>${w.anywhereSetUp}</b>`)}</p>
<div class="row">${open}</div>
<p id="live" class="live" role="status" aria-live="polite">${w.homeWaiting}</p>
<p class="quiet">${w.homeSeePro} <a href="/relay/billing">${w.homeSeeProLink}</a></p>`;
  const poll = o.linked
    ? ""
    : `
const live = document.getElementById("live");
const poll = async () => {
  const me = document.hidden ? {} : await fetch("/relay/me").then((r) => r.json()).catch(() => ({}));
  if (!me.linked) return setTimeout(poll, 3000);
  live.textContent = ${JSON.stringify(w.homeLinked)};
  live.classList.add("on");
  setTimeout(() => location.reload(), 1500);
};
setTimeout(poll, 3000);`;
  return page(
    w.brand,
    `${BRAND}
${body}
<nav class="links" aria-label="${w.brand}"><span>${esc(w.homeSignedInAs.replace("{email}", o.session.email))}</span><a href="/relay/billing">${w.homeBilling}</a><button type="button" id="signout">${w.hostedSignOut}</button></nav>`,
    {
      css: CSS,
      tail: `<script nonce="${o.nonce}">
${COPY_SCRIPT}${poll}
document.getElementById("signout").addEventListener("click", () => fetch("/relay/logout", { method: "POST" }).then(() => { location.href = "/"; }));
</script>`,
    },
  );
}

/** GET /relay/home: signed out, or with a paid plan, back to /; otherwise the page for where this account stands. */
export async function homeRoute(env: Env, s: SessionClaim | null, now: number): Promise<Response> {
  if (!s || (await access(env.DB, s.ws, now))) return new Response(null, { status: 302, headers: { location: "/" } });
  const linked = await hasLink(env.DB, s.ws);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // the price only matters once a computer is linked; before that, plans are one quiet link
  const table = linked ? await prices(env, now).catch(() => null) : null;
  return new Response(homePage({ session: s, linked, prices: table, nonce }), { headers: pageHeaders(nonce) });
}
