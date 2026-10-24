/**
 * Builds the public site's pages: site/pages/**.html → site/public, and the link preview's source
 * site/og/og.tpl.html → site/og/og.html. Two slots, nothing else:
 *   {{> header}}  a partial from site/pages/_partials
 *   {{name}}      a value from SITE or CLAIMS (site/site.ts), or {{mark}} / {{markLarge}}: the mark (packages/themes/src/brand.ts), or
 *                 {{root}}: the path back to the site root ("./" or "../"), {{paper}} / {{paperNight}}: the page's paper by day and night (system.ts), or a
 *                 moment of the sample night (apps/web/src/demo/moments.ts): {{at_call}} in minutes, {{time_call}} as "07:24",
 *                 for the pages' live pieces, {{modeWatch}} / {{modeAct}} / {{modePropose}} / {{modeShip}}: the dashboard's names for its modes,
 *                 {{plansLimit}} / {{budgetUnknown}}: what limits a plan account, and what the budget does with an
 *                 unknown one (the words beside the daily budget), or
 *                 {{plans}} / {{tiers}} / {{planTax}}: the pricing page's cards and the home page's row of the plans
 *                 (packages/contract/src/plans.ts), with prices read from the relay's
 *                 catalog once per build (`fetchPrices`), never typed and never fetched in the browser, or
 *                 {{madeFor}}: a link to each made-for page (MADE_FOR, site/site.ts), and on those pages {{forName}} /
 *                 {{forLine}}: the page's own name and who it's for, or {{relayHost}}: the relay's host name, or {{questionFallback}}: the minutes a team
 *                 question waits on its project's owner before it goes to the backup too (packages/contract/src/team.ts), or
 *                 the docs' pieces: {{docsList}} / {{docsNav}} (DOCS, site/site.ts), and on a docs page {{docTitle}} /
 *                 {{docLine}}; {{cli}}: the CLI's own help; {{guardTable}}: the guard's coverage; {{leadTemplates}}: the
 *                 ready-made leads; {{also}}: the home page's features (packages/contract/src/features.ts); {{wayOfWorking}}: how every lead works (WAY_OF_WORKING); {{firstDayCap}}, {{shipPerDay}}, {{shipProtect}}, {{localUrl}}, {{freshMin}}: the defaults they name;
 *                 {{w.key}}: a control's or message's name from the app's words; {{cfg.a.b}}: a config default (config.ts)
 * The header link to the page itself (on a docs page, Docs) gets aria-current. /llms.txt lists the docs (`llmsTxt`). Markdown in site/pages (setup.md, for agents) is filled the
 * same way and served as it is. For agents, every docs page is also written as Markdown beside it (`docMarkdown`), all of
 * them in one /llms-full.txt (`llmsFullTxt`), and skills/overhand/SKILL.md is served as /skill.md. It also bundles the home page's script (`bundleHome`), the attention map, the
 * dashboard's own drawing, into public/map.js and map.css (`bundleMap`). Every other page's live pieces are frames of the
 * dashboard itself (public/pieces.js). Run: bun site/build.ts (the deploy runs it,
 * site/wrangler.jsonc)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  FEATURES,
  FRESH_MIN,
  GUARD_COVERAGE,
  HOME_GROUPS,
  LEAD_TEMPLATES,
  LEAD_WORK,
  PLAN_COPY,
  PLAN_KEYS,
  PLAN_TAX,
  type PlanKey,
  type PriceTable,
  planPrices,
  priceText,
  QUESTION_FALLBACK_MS,
  RUNTIME_NAMES,
  SHIP_DEFAULTS,
  WAY_OF_WORKING,
} from "@overhand/contract";
import { LOCAL_PORT, PERMISSIONS } from "@overhand/contract/links";
import { blankConfig, FIRST_DAY_BUDGET_USD } from "@overhand/core/config";
import { markSvg } from "@overhand/themes/brand";
import { SYSTEM, systemSchemeCss } from "@overhand/themes/system";
import { plainWords as W } from "@overhand/themes/words";
import { z } from "zod";
import { MOMENTS, minutesOf } from "../apps/web/src/demo/moments";
import { LEAD_WORDS } from "../apps/web/src/lib/leads";
import { CLAIMS, DOCS, MADE_FOR, SITE } from "./site";

const here = import.meta.dir;
const pages = join(here, "pages");
const partials = join(pages, "_partials");

/** The mark as inline SVG for a page, hidden from screen readers (the name beside it says it). */
const inlineMark = (size: number, on: "light" | "auto"): string =>
  markSvg({ size, on }).trim().replace("<svg ", '<svg aria-hidden="true" ');

/** What a paid plan's price reads when the catalog couldn't be read at build time. */
const NO_PRICE = "Prices at launch";

const Price = z.object({ amount: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });
const Cycles = z.object({ month: Price.optional(), year: Price.optional() });
const Prices = z.object({ prices: z.object({ pro: Cycles.optional(), team: Cycles.optional() }) });

/** The relay's catalog (`${app}/relay/prices`, Paddle's prices by plan and cycle), or null when it can't be read in time. */
export async function fetchPrices(app: string, timeoutMs = 5000): Promise<PriceTable | null> {
  try {
    const r = await fetch(`${app}/relay/prices`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Prices.parse(await r.json()).prices;
  } catch (e) {
    console.warn(`prices: ${e instanceof Error ? e.message : String(e)}; the plans say "${NO_PRICE}"`);
    return null;
  }
}

/** What each plan's card leads to: Free installs, the paid plans open billing on the relay, Business writes to us. */
const CTA: { readonly [K in PlanKey]: (root: string) => string } = {
  free: (root) => `<a class="pill dark" href="${root}#install">Install free</a>`,
  pro: () =>
    `<a class="pill dark" href="${SITE.app}/relay/billing?plan=pro-month">Get Pro <span class="arr" aria-hidden="true">→</span></a>`,
  team: () => `<a class="pill" href="${SITE.app}/relay/billing?plan=team-month">Get Team</a>`,
  business: (root) => `<a class="pill" href="${root}contact.html">Get in touch</a>`,
};

/** The pricing page's cards: every line from the plans module, every amount from the catalog ("Prices at launch" without it). */
export function plansHtml(prices: PriceTable | null, root: string): string {
  const cards = PLAN_KEYS.map((k) => {
    const c = PLAN_COPY[k];
    let price: string;
    let year = "";
    if (k === "free" || k === "business") {
      const u = PLAN_COPY[k];
      price = `<p class="price">${u.price}${u.note ? ` <small>${u.note}</small>` : ""}</p>`;
    } else {
      const m = prices?.[k]?.month;
      const y = prices?.[k]?.year;
      const per = PLAN_COPY[k].per;
      price = m ? `<p class="price">${priceText(m)} <small>${per.month.trim()}</small></p>` : `<p class="price unknown">${NO_PRICE}</p>`;
      year = m && y ? `or ${priceText(y)}${per.year}` : "";
    }
    return [
      `<li class="card plan" data-plan="${k}">`,
      `<h2>${c.name}</h2>`,
      price,
      `<p class="year">${year}</p>`,
      `<p class="promise">${c.promise}</p>`,
      `<ul class="list">${c.includes.map((i) => `<li>${i}</li>`).join("")}</ul>`,
      CTA[k](root),
      "</li>",
    ].join("\n");
  });
  return `<ul class="plans" id="plans">\n${cards.join("\n")}\n</ul>`;
}

/** The home page's short row of plans (Free, Pro, Team): names and lines from the plans module, prices from the catalog. */
export function tiersHtml(prices: PriceTable | null): string {
  const free = PLAN_COPY.free;
  const row = (k: "free" | "pro" | "team", price: string) =>
    `<li data-plan="${k}"><h3>${PLAN_COPY[k].name}</h3><p class="price">${price}</p><p>${PLAN_COPY[k].promise}</p></li>`;
  const paid = (["pro", "team"] as const).map((k) => row(k, planPrices(k, prices)[0] ?? NO_PRICE));
  return ['<ul class="tiers">', row("free", `${free.price} ${free.note}`), ...paid, "</ul>"].join("\n");
}

/** A link to each made-for page; the one this page is (`self`, its path under site/pages) gets aria-current. */
export function madeForHtml(root: string, self: string): string {
  return MADE_FOR.map((m) => {
    const here = self === `for/${m.slug}.html`;
    return `<a href="${root}for/${m.slug}.html"${here ? ' aria-current="page"' : ""}>${m.name}</a>`;
  }).join("\n");
}

/** Text made safe to put in HTML. */
const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Every config default, as a fresh install has it (config.ts), for `{{cfg.a.b}}` slots. */
const DEFAULTS: unknown = blankConfig("you");

/** A config default by its dotted path ("governor.slots.browser"), as text; undefined when there's no such plain value. */
export function configDefault(path: string): string | undefined {
  let v: unknown = DEFAULTS;
  for (const k of path.split("."))
    v = typeof v === "object" && v !== null && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v.join(", ");
  return typeof v === "number" || typeof v === "string" ? String(v) : undefined;
}

/** A control's or message's name as the app says it (packages/themes/src/words.ts), for `{{w.key}}`; a `{tool}` reads `<tool>`. */
export function wordSlot(key: string): string | undefined {
  return Object.hasOwn(W, key) ? esc(W[key as keyof typeof W]).replace(/\{(\w+)\}/g, "&lt;$1&gt;") : undefined;
}

/** The docs index's list: each page's title as a link, then its one line. */
export function docsListHtml(root: string): string {
  const items = DOCS.map((d) => `<li><b><a href="${root}docs/${d.slug}.html">${d.title}</a></b> ${d.line}</li>`);
  return `<ul class="facts">\n${items.join("\n")}\n</ul>`;
}

/** Every docs page's way to the others, at its foot; the page itself gets aria-current. */
export function docsNavHtml(root: string, self: string): string {
  const links = DOCS.map((d) => {
    const here = self === `docs/${d.slug}.html`;
    return `<a href="${root}docs/${d.slug}.html"${here ? ' aria-current="page"' : ""}>${d.title}</a>`;
  });
  return `<nav class="wrap others" aria-label="Docs pages">\n<a href="${root}docs/">All docs</a>\n${links.join("\n")}\n</nav>`;
}

/** The CLI's own help (USAGE in packages/core/src/daemon.ts), read from its source so the reference can't drift: [command, what it does]. */
export function cliCommands(): [string, string][] {
  const src = readFileSync(join(here, "../packages/core/src/daemon.ts"), "utf8");
  const usage = src.match(/const USAGE = `[^\n]*\n([\s\S]*?)`;/)?.[1];
  if (!usage) throw new Error("no USAGE in packages/core/src/daemon.ts");
  const out: [string, string][] = [];
  for (const raw of usage.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [cmd = "", ...say] = line.split(/\s{2,}/);
    const last = out.at(-1);
    if (cmd.startsWith("overhand ")) out.push([cmd, say.join(" ")]);
    // a description that wraps onto the next line
    else if (last) last[1] = `${last[1]} ${line}`;
  }
  return out;
}

/** The CLI reference: each command and what it does, as the CLI's help says it. */
export function cliHtml(): string {
  const rows = cliCommands().map(([cmd, say]) => `<dt><code>${esc(cmd)}</code></dt><dd>${esc(say)}</dd>`);
  return `<dl class="cli">\n${rows.join("\n")}\n</dl>`;
}

/** How the guard reaches each agent CLI and whether a real run confirmed it, A to Z (GUARD_COVERAGE, packages/contract/src/guard.ts). */
export function guardTableHtml(): string {
  const items = Object.entries(GUARD_COVERAGE)
    .map(([id, c]) => ({ name: RUNTIME_NAMES[id] ?? id, c }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, c }) => {
      const v = c.verified;
      const noShell = c.kind === "no-shell";
      const proof = !v
        ? "Set up, not yet confirmed in a real run."
        : noShell
          ? `Confirmed in a real run, on ${esc(v.version)}: asked to run <code>${esc(v.blocked)}</code>, it ran nothing.`
          : `Confirmed in a real run, on ${esc(v.version)}: it blocked <code>${esc(v.blocked)}</code>.`;
      const how = noShell ? `${c.how.charAt(0).toUpperCase()}${c.how.slice(1)}` : `Through ${c.how}`;
      return `<li><b>${name}</b> ${esc(how)}.${noShell ? " It runs no shell commands." : ""} ${proof}</li>`;
    });
  return `<ul class="facts">\n${items.join("\n")}\n</ul>`;
}

/** The home page's "Also in Overhand": each group's features from the registry, a bold label, the line, then How → its docs. */
export function alsoHtml(root: string): string {
  const groups = Object.entries(HOME_GROUPS).map(([g, heading]) => {
    const items = FEATURES.filter((f) => f.place === g).map(
      (f) =>
        `<li><b>${esc(f.name)}</b> ${esc(f.line)} <a class="how" href="${root}${f.docs}" aria-label="How it works: ${esc(f.name)}">How <span aria-hidden="true">→</span></a></li>`,
    );
    return `<div>\n<h3>${heading}</h3>\n<ul>\n${items.join("\n")}\n</ul>\n</div>`;
  });
  return `<div class="groups">\n${groups.join("\n")}\n</div>`;
}

/** The ready-made leads: each one's name as the app says it (LEAD_WORDS) and what it's told to work toward (LEAD_TEMPLATES). */
export function leadTemplatesHtml(): string {
  const items = LEAD_WORK.map((k) => `<li><b>${esc(W[LEAD_WORDS[k].name])}</b> ${esc(LEAD_TEMPLATES[k].goal)}</li>`);
  return `<ul class="facts">\n${items.join("\n")}\n</ul>`;
}

/** The skill any coding agent can load (Agent Skills format), kept in the repo and served as /skill.md. */
export const SKILL_PATH = join(here, "../skills/overhand/SKILL.md");

/** What the docs, the skill and the llms files are licensed under, said the same in each. */
const DOCS_LICENSE = `The docs, the agent skill and these llms files are CC0 1.0 (${SITE.repo}/blob/main/LICENSE-docs): copy them freely. The code is FSL-1.1-ALv2.`;

/** The summary line every llms file opens with. */
const summary = (): string =>
  `> ${SITE.tagline} ${SITE.name} runs the coding agents you already use (${agentList()}) on your own computer, on any model. ${SITE.lede}`;

/** /llms.txt (llmstxt.org): the site in one line, then every docs page (as Markdown), the setup guide and the skill, from DOCS. */
export function llmsTxt(): string {
  return [
    `# ${SITE.name}`,
    "",
    summary(),
    "",
    DOCS_LICENSE,
    "",
    "## Docs",
    "",
    `- [Docs](${SITE.url}/docs/index.md): every page below, in order`,
    ...DOCS.map((d) => `- [${d.title}](${SITE.url}/docs/${d.slug}.md): ${d.line}`),
    `- [All the docs in one file](${SITE.url}/llms-full.txt): every page above, in order`,
    "",
    "## For agents",
    "",
    `- [Set up ${SITE.name}](${SITE.url}/setup.md): the steps a coding agent follows to set it up for you`,
    `- [Agent skill](${SITE.url}/skill.md): install, check status, answer its questions and find details (${SITE.repo}/blob/main/skills/overhand/SKILL.md)`,
    "",
    "## Optional",
    "",
    `- [Under the hood](${SITE.url}/under-the-hood.html): where it runs, what the relay sees, the guard and Ship's rules`,
    `- [Privacy](${SITE.url}/privacy.html): what the hosted services keep`,
    "",
  ].join("\n");
}

/** Every agent CLI Overhand runs, A to Z so none comes first: "Aider, Claude Code, … and OpenCode". */
const agentList = (): string => new Intl.ListFormat("en-GB", { type: "conjunction" }).format(Object.values(RUNTIME_NAMES).sort());

/** HTML entities back to their characters. */
const unesc = (s: string): string => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** A built docs page's own content: its <main> without the kicker and the row of other pages. */
export function docMain(html: string): string {
  return html
    .slice(html.indexOf("<main"), html.indexOf("</main>"))
    .replace(/<nav class="wrap others"[\s\S]*?<\/nav>/, "")
    .replace(/<p class="kick">[\s\S]*?<\/p>/, "");
}

/**
 * A built docs page as Markdown, for agents (/docs/<slug>.md): headings, each fact as a bullet with its bold label, code
 * blocks fenced, links made absolute against the page's own address (`url`).
 */
export function docMarkdown(html: string, url: string): string {
  const inline = (s: string): string =>
    unesc(
      s
        .replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, h: string, t: string) => `[${t}](${new URL(unesc(h), url).href})`)
        .replace(/<(code|samp)>([\s\S]*?)<\/\1>/g, "`$2`")
        .replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, "**$2**")
        .replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
        .replace(/<[^>]+>/g, ""),
    )
      .replace(/\s+/g, " ")
      .trim();
  const fence = (code: string): string => ["", "```", unesc(code).trim(), "```", ""].join("\n");
  const blocks =
    /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>|<li[^>]*>([\s\S]*?)<\/li>|<p[^>]*>([\s\S]*?)<\/p>|<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
  const out: string[] = [];
  for (const [, level, heading, item, para, term, def] of docMain(html).matchAll(blocks)) {
    if (level && heading !== undefined) out.push("", `${"#".repeat(Number(level))} ${inline(heading)}`, "");
    else if (item !== undefined) {
      // a fact may carry a code block, and text after it: the fact, the block, then the rest
      const [first = "", ...rest] = item.split(/<pre><code>([\s\S]*?)<\/code><\/pre>/);
      out.push(`- ${inline(first)}`);
      rest.forEach((part, i) => {
        if (i % 2 === 0) out.push(fence(part));
        else if (inline(part)) out.push(inline(part));
      });
    } else if (para !== undefined) out.push("", inline(para), "");
    else if (term !== undefined && def !== undefined) out.push(`- ${inline(term)}: ${inline(def)}`);
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** /llms-full.txt: every docs page's Markdown in one file, in reading order (`pages`: slug → Markdown). */
export function llmsFullTxt(pages: ReadonlyMap<string, string>): string {
  const body = DOCS.map((d) => [`<!-- ${SITE.url}/docs/${d.slug}.html -->`, pages.get(d.slug) ?? ""].join("\n"));
  return [`# ${SITE.name} docs, in full`, "", summary(), "", DOCS_LICENSE, "", ...body].join("\n");
}

/** Fills one template; an unknown slot is a build error, so a typo never ships as literal braces. */
export function render(src: string, root: string, self: string, prices: PriceTable | null = null): string {
  const moments = Object.entries(MOMENTS).flatMap(([k, hm]) => [
    [`at_${k}`, String(minutesOf(hm))],
    [`time_${k}`, hm],
  ]);
  const vars: Record<string, string> = {
    ...SITE,
    ...CLAIMS,
    root,
    // the site follows the computer's light or dark: the browser's bar takes the page's paper in each
    paper: SYSTEM.ink.day[0] ?? "",
    paperNight: SYSTEM.ink.night[0] ?? "",
    // the mark, inline beside the name: 20px in the bar and the footer, following light or dark; 28px on the link
    // preview, which is always drawn light
    mark: inlineMark(20, "auto"),
    markLarge: inlineMark(28, "light"),
    // the dashboard's own names for its modes, for the pages' live pieces (packages/themes/src/words.ts)
    modeAct: W.autonomyActName,
    modePropose: W.autonomyProposeName,
    modeShip: W.autonomyShipName,
    modeWatch: W.autonomyWatchName,
    modeLabel: W.autonomyLabel,
    // what limits a plan account, said the same as beside the dashboard's daily budget
    plansLimit: W.plansLimit,
    budgetUnknown: W.budgetUnknown,
    // every agent CLI Overhand runs, A to Z so none comes first: "Aider, Claude Code, … and OpenCode"
    agents: agentList(),
    plans: plansHtml(prices, root),
    tiers: tiersHtml(prices),
    planTax: PLAN_TAX,
    teamPlan: PLAN_COPY.team.name,
    madeFor: madeForHtml(root, self),
    // the hosted relay's address as people see it: app.overhand.dev
    relayHost: new URL(SITE.app).host,
    // this site's address as people type it: overhand.dev
    host: new URL(SITE.url).host,
    questionFallback: String(QUESTION_FALLBACK_MS / 60_000),
    docsList: docsListHtml(root),
    docsNav: docsNavHtml(root, self),
    cli: cliHtml(),
    guardTable: guardTableHtml(),
    leadTemplates: leadTemplatesHtml(),
    also: alsoHtml(root),
    wayOfWorking: esc(WAY_OF_WORKING),
    firstDayCap: `$${FIRST_DAY_BUDGET_USD}`,
    shipPerDay: String(SHIP_DEFAULTS.perDay),
    shipProtect: SHIP_DEFAULTS.protect.map((p) => `<code>${p}</code>`).join(" and "),
    localUrl: `http://127.0.0.1:${LOCAL_PORT}`,
    freshMin: String(FRESH_MIN),
    ...Object.fromEntries(moments),
  };
  const me = MADE_FOR.find((m) => self === `for/${m.slug}.html`);
  if (me) Object.assign(vars, { forName: me.name, forLine: me.line });
  const doc = DOCS.find((d) => self === `docs/${d.slug}.html`);
  if (doc) Object.assign(vars, { docTitle: doc.title, docLine: doc.line, docSlug: doc.slug });
  const withPartials = src.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_, p: string) => readFileSync(join(partials, `${p}.html`), "utf8"));
  // {{w.key}}: the app's own words for a control or message; {{cfg.a.b}}: a config default; {{name}}: vars
  const out = withPartials.replace(/\{\{(?:(w|cfg)\.)?([\w.]+)\}\}/g, (_, kind: string | undefined, k: string) => {
    const v = kind === "w" ? wordSlot(k) : kind === "cfg" ? configDefault(k) : vars[k];
    if (v === undefined) throw new Error(`unknown slot {{${kind ? `${kind}.` : ""}${k}}} in ${self}`);
    return v;
  });
  // mark the current page in the site header (every docs page marks Docs), unless it's marked already
  const current = self === "index.html" ? "" : self.startsWith("docs/") ? "docs/" : self;
  const link = new RegExp(`href="${`${root}${current}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"(?! aria-current)`);
  return out.replace(/<header[\s\S]*?<\/header>/, (h) => h.replace(link, (m) => `${m} aria-current="page"`));
}

/**
 * The headers on every file of the site: the browser features no page uses off, framing by this site only, no
 * referrer past the origin; staging also tells search engines to stay out.
 */
export const siteHeaders = (staging: boolean): string =>
  [
    "/*",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    `  Permissions-Policy: ${PERMISSIONS}`,
    "  X-Frame-Options: SAMEORIGIN",
    "  Content-Security-Policy: frame-ancestors 'self'",
    ...(staging ? ["  X-Robots-Tag: noindex"] : []),
    "",
  ].join("\n");

/** security.txt (RFC 9116): where to report a vulnerability, valid for a year from `now`. */
export const securityTxt = (now: number): string =>
  [
    `Contact: mailto:${SITE.email}`,
    `Expires: ${new Date(now + 365 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
    `Policy: ${SITE.repo}/security/policy`,
    `Canonical: ${SITE.url}/.well-known/security.txt`,
    "Preferred-Languages: en, fi",
    "",
  ].join("\n");

/** sitemap.xml: every page the build writes (not Markdown or partials), at its address. */
export const sitemap = (rels: readonly string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rels
      .filter((r) => r.endsWith(".html"))
      .map((r) => `  <url><loc>${SITE.url}/${r.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");

/** Every page and Markdown file under `dir`, skipping partials (names starting with _). */
export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith("_")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(html|md)$/.test(e.name) ? [p] : [];
  });
}

/**
 * The dashboard's map alone (apps/web/src/map/site.tsx): React and the map's own modules, with the app's providers,
 * which the map's drawing never calls, stubbed out so the rest of the dashboard doesn't come along.
 */
export async function bundleMap(outdir: string): Promise<void> {
  const r = await Bun.build({
    entrypoints: [join(here, "../apps/web/src/map/site.tsx")],
    outdir,
    naming: "map.[ext]",
    minify: true,
    format: "esm",
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "no-app",
        setup(b) {
          b.onResolve({ filter: /^@\/(app\/(theme|ui|data)|components\/now\/Alerts)$/ }, () => ({ path: "app", namespace: "no-app" }));
          b.onLoad({ filter: /.*/, namespace: "no-app" }, () => ({
            contents: "export const useTheme = () => ({}); export const useUi = () => ({}); export const needs = () => [];",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!r.success) throw new AggregateError(r.logs, "the map bundle failed");
}

/** The home page's script (site/home.ts): the live window, section enter and the copy buttons: public/home.js. */
export async function bundleHome(outdir: string): Promise<void> {
  const r = await Bun.build({
    entrypoints: [join(here, "home.ts")],
    outdir,
    naming: "home.[ext]",
    minify: true,
    format: "esm",
    target: "browser",
  });
  if (!r.success) throw new AggregateError(r.logs, "the home bundle failed");
}

if (import.meta.main) {
  const out = join(here, "public");
  const prices = await fetchPrices(SITE.app);
  const docsMd = new Map<string, string>();
  for (const [file, rel] of walk(pages).map((f): [string, string] => [f, relative(pages, f)])) {
    const depth = rel.split("/").length - 1;
    const root = depth ? "../".repeat(depth) : "./";
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    const html = render(readFileSync(file, "utf8"), root, rel, prices);
    writeFileSync(dst, html);
    console.log(`public/${rel}`);
    // every docs page also as Markdown beside it, for agents
    const doc = rel.match(/^docs\/([\w-]+)\.html$/)?.[1];
    if (doc) {
      const md = docMarkdown(html, `${SITE.url}/${rel}`);
      writeFileSync(dst.replace(/\.html$/, ".md"), md);
      docsMd.set(doc, md);
    }
  }
  writeFileSync(join(out, "llms.txt"), llmsTxt());
  writeFileSync(join(out, "llms-full.txt"), llmsFullTxt(docsMd));
  writeFileSync(join(out, "skill.md"), readFileSync(SKILL_PATH, "utf8"));
  console.log("public/llms.txt, public/llms-full.txt, public/skill.md, public/docs/*.md");
  writeFileSync(join(out, "_headers"), siteHeaders(Boolean(process.env.OVERHAND_STAGING)));
  mkdirSync(join(out, ".well-known"), { recursive: true });
  writeFileSync(join(out, ".well-known", "security.txt"), securityTxt(Date.now()));
  writeFileSync(join(out, "sitemap.xml"), sitemap(walk(pages).map((f) => relative(pages, f))));
  console.log("public/_headers, public/.well-known/security.txt, public/sitemap.xml");
  await bundleMap(out);
  console.log("public/map.js");
  await bundleHome(out);
  console.log("public/home.js");
  // the design system's values (packages/themes/src/system.ts), day and, when the computer prefers dark, night;
  // site.css and every page only read these variables
  writeFileSync(join(out, "system.css"), systemSchemeCss());
  console.log("public/system.css");
  writeFileSync(join(here, "og/og.html"), render(readFileSync(join(here, "og/og.tpl.html"), "utf8"), "../public/", "og.html"));
  console.log("og/og.html");
}
