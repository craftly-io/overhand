import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import {
  FEATURES,
  FEATURES_FROM,
  GUARD_LIMIT,
  HOME_GROUPS,
  LEAD_TEMPLATES,
  LEAD_WORK,
  PLAN_COPY,
  PLAN_KEYS,
  PLAN_TAX,
  PLUGIN_LIMIT,
  PLUGIN_REVIEW,
  PLUGIN_STOPS,
  type PriceTable,
  SANDBOX_LIMIT,
  SANDBOX_PROJECT_OFF,
  SANDBOX_STOPS,
  WAY_OF_WORKING,
} from "@overhand/contract";
import { PERMISSIONS } from "@overhand/contract/links";
import { MARK_INK } from "@overhand/themes/brand";
import { SYSTEM, systemSchemeCss } from "@overhand/themes/system";
import { plainWords as W } from "@overhand/themes/words";
import { Glob } from "bun";
import { LEAD_WORDS, previewRows } from "../apps/web/src/lib/leads";
import {
  cliCommands,
  configDefault,
  docMain,
  docMarkdown,
  fetchPrices,
  llmsFullTxt,
  llmsTxt,
  render,
  SKILL_PATH,
  securityTxt,
  siteHeaders,
  sitemap,
  tiersHtml,
  walk,
  wordSlot,
} from "./build";
import { CLAIMS, DOCS, MADE_FOR, SITE } from "./site";

const CMD = `curl -fsSL ${SITE.get} | sh`;

/** The built home page, the site's stylesheet and the agent-readable setup guide, checked from their sources. */
const here = import.meta.dir;
const read = (f: string) => readFileSync(join(here, f), "utf8");
const home = render(read("pages/index.html"), "./", "index.html");
const pricing = read("pages/pricing.html");

const eur = (amount: number) => ({ amount, currency: "EUR" });
const CATALOG: PriceTable = { pro: { month: eur(900), year: eur(9000) }, team: { month: eur(1250), year: eur(12000) } };

/** Each card's lines as rendered: its name, promise and included items, by plan. */
const cards = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<li class="card plan" data-plan="(\w+)">([\s\S]*?)\n<\/li>/g)].map(([, k, body]) => [
      k,
      {
        name: body?.match(/<h2>(.*?)<\/h2>/)?.[1],
        promise: body?.match(/<p class="promise">(.*?)<\/p>/)?.[1],
        includes: [...(body?.match(/<ul class="list">(.*?)<\/ul>/)?.[1] ?? "").matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]),
      },
    ]),
  );

test("the pricing page's plan lines are the plans module's, and its amounts the catalog's", () => {
  const html = render(pricing, "./", "pricing.html", CATALOG);
  expect(cards(html)).toEqual(
    Object.fromEntries(
      PLAN_KEYS.map((k) => [k, { name: PLAN_COPY[k].name, promise: PLAN_COPY[k].promise, includes: [...PLAN_COPY[k].includes] }]),
    ),
  );
  for (const want of [
    "€9 <small>/ month</small>",
    "or €90 / year",
    "€12.50 <small>per seat / month</small>",
    "or €120 per seat / year",
    PLAN_TAX,
  ])
    expect(html).toContain(want);
  expect(html).toContain("/relay/billing?plan=pro-month");
  expect(html).not.toContain("<script>");
  for (const gone of ["08:00", "Coming", "In testing", "dashboard", "relay/prices", "Prices at launch"]) expect(html).not.toContain(gone);
});

test("without a catalog the paid plans read 'Prices at launch', the words unchanged", () => {
  const html = render(pricing, "./", "pricing.html", null);
  expect(html.match(/Prices at launch/g)).toHaveLength(2);
  expect(html).not.toMatch(/€\d+ <small>(?:per seat )?\/ month/);
  expect(cards(html).team?.includes).toEqual([...PLAN_COPY.team.includes]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stub = (f: () => Promise<Response>) => {
  globalThis.fetch = Object.assign(f, { preconnect: realFetch.preconnect });
};

test("the build reads the catalog from the relay, and a failure or a malformed answer is null", async () => {
  stub(async () => Response.json({ prices: CATALOG, environment: "sandbox" }));
  expect(await fetchPrices("https://app.example")).toEqual(CATALOG);
  stub(async () => new Response("down", { status: 502 }));
  expect(await fetchPrices("https://app.example")).toBeNull();
  stub(async () => Response.json({ prices: { pro: { month: { amount: "9", currency: "EUR" } } } }));
  expect(await fetchPrices("https://app.example")).toBeNull();
  stub(() => new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 5)));
  expect(await fetchPrices("https://app.example", 1)).toBeNull();
});

test("the home page is one page: no slot left, no night clock, no harbour, one live window", () => {
  expect(home.includes("{{"), "{{").toBe(false);
  expect(home.includes("time_"), "time_").toBe(false);
  expect(home.includes("shore"), "shore").toBe(false);
  expect(home.includes("scene.js"), "scene.js").toBe(false);
  expect(home.match(/<iframe/g) ?? []).toHaveLength(1);
});

test("until the demo is ready, the window says it's loading and the guided steps wait", () => {
  expect(home.includes("Loading Overhand on sample data…"), "Loading Overhand on sample data…").toBe(true);
  const steps = [...home.matchAll(/<button[^>]*data-try=[^>]*>/g)].map((m) => m[0]);
  expect(steps).toHaveLength(3);
  for (const b of steps) expect(b).toContain('aria-disabled="true"');
  // the iframe holds its source back until the page is idle
  expect(/<iframe[^>]*data-src="\.\/demo\/\?demo"/.test(home)).toBe(true);
  expect(/<iframe[^>]*\ssrc=/.test(home)).toBe(false);
});

test("the page carries the positioning's hook and its five pains, in the reader's words", () => {
  for (const line of [
    "Stop babysitting your coding agents.",
    "I start agents, then spend my day watching terminals.",
    "It said done. It wasn't.",
    "It went too far.",
    "Too many projects, agents and accounts.",
    "I can't explain what happened.",
  ])
    expect(home.includes(line), line).toBe(true);
  expect(/coming soon/i.test(home)).toBe(false);
});

test("the daily cap is told as it works: it stops billed accounts only, and plan accounts follow their limits", () => {
  const hood = render(read("pages/under-the-hood.html"), "./", "under-the-hood.html");
  const claim = `A daily cap stops pay-per-use and cloud agents once they've been billed about that much today. ${W.budgetUnknown} ${W.plansLimit}`;
  expect(hood.includes(claim), claim).toBe(true);
  // the home page says it short and points at the whole of it
  expect(home).toContain("Pay-per-use and cloud agents stop at about the amount you set for the day.");
  expect(home).toContain('href="./under-the-hood.html#cap"');
  for (const page of [home, hood]) expect(/daily cap pauses agents/i.test(page)).toBe(false);
});

test("both ways to install: the command, and a prompt for your agent that points at setup.md", () => {
  expect(home.includes(CMD), CMD).toBe(true);
  const prompt = `Set up Overhand from ${new URL(SITE.url).host}/setup.md. Ask me before each step.`;
  // the prompt reads as one sentence; its setup.md address is a link to the steps it points at
  const shown = home.match(/<p class="prompt" id="prompt">([\s\S]*?)<\/p>/)?.[1] ?? "";
  expect(shown.replace(/<[^>]+>/g, "")).toBe(prompt);
  expect(shown).toContain('href="./setup.md"');
});

test("the site follows the computer's light or dark, both palettes the system's own", () => {
  expect(read("public/site.css")).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark;/);
  const head = render(read("pages/_partials/head.html"), "./", "index.html");
  expect(head).toContain('<meta name="color-scheme" content="light dark">');
  expect(head).toContain(`media="(prefers-color-scheme: light)" content="${SYSTEM.ink.day[0]}"`);
  expect(head).toContain(`media="(prefers-color-scheme: dark)" content="${SYSTEM.ink.night[0]}"`);
  // system.css is the system's day and, under prefers-color-scheme: dark, its night: every ink step, state and surface
  const css = systemSchemeCss();
  const [day = "", night = ""] = css.split("@media (prefers-color-scheme: dark)");
  for (const [i, c] of SYSTEM.ink.day.entries()) expect(day).toContain(`--ink-${i + 1}: ${c};`);
  for (const [i, c] of SYSTEM.ink.night.entries()) expect(night).toContain(`--ink-${i + 1}: ${c};`);
  expect(night).toContain(`--you: ${SYSTEM.state.night.you};`);
  for (const k of Object.keys(SYSTEM.surface.site)) expect(night, k).toContain(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`);
  // the mark beside the name turns with it; the pieces and the live window carry no scheme of their own
  expect(home).toContain(`.work{stroke:${MARK_INK.dark}}`);
  expect(read("public/pieces.js")).not.toContain("color-scheme");
  expect(read("pages/index.html")).not.toMatch(/color-scheme:\s*light/);
});

test("setup.md only gives commands the code really has", () => {
  const guide = render(read("pages/setup.md"), "./", "setup.md");
  expect(guide.includes(CMD), CMD).toBe(true);
  const daemon = readFileSync(join(here, "../packages/core/src/daemon.ts"), "utf8");
  const cmds = [...guide.matchAll(/`overhand ([a-z-]+)/g)].map((m) => m[1] ?? "");
  expect(cmds.length).toBeGreaterThan(2);
  for (const c of cmds) expect(daemon.includes(`mode === "${c}"`), c).toBe(true);
  expect(guide.includes("http://127.0.0.1:4317"), "http://127.0.0.1:4317").toBe(true);
});

test("the home page's plans row is the plans module's words and the catalog's prices, nothing typed", () => {
  const src = read("pages/index.html");
  expect(src).toContain("{{tiers}}");
  for (const k of ["free", "pro", "team"] as const) expect(src.includes(PLAN_COPY[k].promise), k).toBe(false);
  expect(src).not.toMatch(/€\d/);
  const html = render(src, "./", "index.html", CATALOG);
  for (const k of ["free", "pro", "team"] as const) {
    expect(html).toContain(`<h3>${PLAN_COPY[k].name}</h3>`);
    expect(html).toContain(PLAN_COPY[k].promise);
  }
  for (const want of ["€0 forever", "€9 / month", "€12.50 per seat / month", PLAN_TAX]) expect(html).toContain(want);
  expect(html).not.toContain("Prices at launch");
});

test("without a catalog the home page's paid plans read 'Prices at launch'", () => {
  const html = tiersHtml(null);
  expect(html.match(/Prices at launch/g)).toHaveLength(2);
  expect(html).toContain("€0 forever");
});

/** Every page of the site as the build writes it: [path under site/pages, html]. */
const pagesDir = join(here, "pages");
const built = walk(pagesDir)
  .filter((f) => f.endsWith(".html"))
  .map((f): [string, string] => {
    const rel = relative(pagesDir, f);
    const depth = rel.split("/").length - 1;
    return [rel, render(read(`pages/${rel}`), depth ? "../".repeat(depth) : "./", rel)];
  });

test("one system on every page: no harbour, no night clock, no drawn rules, no features page", () => {
  expect(built.length).toBeGreaterThan(8);
  for (const [rel, html] of built)
    for (const gone of ["features.html", "concepts/", "use-cases/", "scene.js", "rules.js", "shore", "<canvas", 'class="illus"', "<time>"])
      expect(html.includes(gone), `${rel}: ${gone}`).toBe(false);
  for (const f of ["scene.ts", "scene.test.ts", "rules.ts", "pages/features.html", "pages/_partials/shore.html"])
    expect(existsSync(join(here, f)), f).toBe(false);
});

test("only what's built: no page promises anything as coming or soon", () => {
  for (const [rel, html] of built) expect(/\b(coming|soon|in testing)\b/i.test(html.replace(/<[^>]+>/g, " ")), rel).toBe(false);
});

test("each made-for page opens with a live piece, and every page's footer reaches them all and Under the hood", () => {
  expect(MADE_FOR.map((m) => m.slug)).toEqual(["solo", "studios", "teams", "makers"]);
  for (const m of MADE_FOR) {
    const page = built.find(([rel]) => rel === `for/${m.slug}.html`)?.[1] ?? "";
    expect(page, m.slug).toContain(`<h1`);
    const main = page.slice(page.indexOf("<main"));
    expect(main.indexOf("data-piece="), m.slug).toBeGreaterThan(0);
    expect(main.indexOf("data-piece="), m.slug).toBeLessThan(main.indexOf("<h2"));
    expect(page).toContain(m.name);
  }
  for (const [rel, html] of built) {
    const foot = html.slice(html.indexOf("<footer"));
    for (const m of MADE_FOR) expect(new RegExp(`for/${m.slug}\\.html"[^>]*>${m.name}<`).test(foot), `${rel}: ${m.slug}`).toBe(true);
    expect(foot.includes("under-the-hood.html"), rel).toBe(true);
  }
});

test("the home page adds 'Also in Overhand': the registry's placed features by whose they are, even groups", () => {
  const also = home.slice(home.indexOf('id="also"'), home.indexOf('aria-labelledby="safe"'));
  const groups = also.split("<h3>").slice(1);
  expect(groups.map((g) => g.slice(0, g.indexOf("</h3>")))).toEqual(Object.values(HOME_GROUPS));
  // every group the same length, every point a bold label, its line, then How to its docs
  const sizes = Object.keys(HOME_GROUPS).map((g) => FEATURES.filter((f) => f.place === g).length);
  expect(new Set(sizes).size).toBe(1);
  expect(sizes[0]).toBeGreaterThanOrEqual(3);
  for (const [i, g] of groups.entries()) {
    const want = FEATURES.filter((f) => f.place === Object.keys(HOME_GROUPS)[i]);
    expect([...g.matchAll(/<li><b>([^<]+)<\/b> ([^<]+) <a class="how" href="\.\/([^"]+)"/g)].map((m) => [m[1], m[2], m[3]])).toEqual(
      want.map((f) => [f.name, f.line, f.docs]),
    );
  }
});

test("the feature registry: each entry built, its docs real, its tip beside a control the app has", () => {
  const web = [...new Glob("apps/web/src/**/*.tsx").scanSync(join(here, ".."))].map((f) => read(`../${f}`)).join("\n");
  expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  for (const f of FEATURES) {
    expect(f.since, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.since >= FEATURES_FROM, f.id).toBe(true);
    expect(existsSync(join(here, "..", f.source)), `${f.id}: ${f.source}`).toBe(true);
    expect(f.place === "none" || f.place in HOME_GROUPS, f.id).toBe(true);
    const [page = "", anchor = ""] = f.docs.split("#");
    const html = built.find(([rel]) => rel === page)?.[1];
    expect(html, `${f.id}: ${page}`).toBeDefined();
    expect(html?.includes(`id="${anchor}"`), `${f.id}: ${f.docs}`).toBe(true);
    if (f.tip) expect(web.includes(`at="${f.tip.where}"`), `${f.id}: no FeatureTip at="${f.tip.where}" in apps/web`).toBe(true);
  }
});

test("a feature's line is on the site once, on the home page where it's placed, and written only in the registry", () => {
  const sources = walk(pagesDir).map((f) => read(`pages/${relative(pagesDir, f)}`));
  const claims: string[] = Object.values(CLAIMS);
  for (const f of FEATURES) {
    const count = built.reduce((n, [, html]) => n + html.split(f.line).length - 1, 0);
    const onHome = home.split(f.line).length - 1;
    // a claim (CLAIMS) is one sentence several pages make through its slot; every other line is only the home page's
    if (claims.includes(f.line)) expect(onHome, f.id).toBeGreaterThanOrEqual(f.place === "none" ? 0 : 1);
    else {
      expect(onHome, f.id).toBe(f.place === "none" ? 0 : 1);
      expect(count, f.id).toBe(onHome);
    }
    for (const src of sources) expect(src.includes(f.line), f.id).toBe(false);
  }
});

test("Under the hood says where things run and what the relay sees, from the same facts as the rest of the site", () => {
  const page = built.find(([rel]) => rel === "under-the-hood.html")?.[1] ?? "";
  for (const want of [SITE.app.replace(/^https?:\/\//, ""), "WorkOS", PLAN_TAX, "peer to peer", "Ship"]) expect(page, want).toContain(want);
});

test("the company is named once on the face of the site, in the footer; the legal pages name it where the law needs it", () => {
  for (const [rel, html] of built) {
    const n = html.split(SITE.company).length - 1;
    if (["terms.html", "privacy.html", "refund.html"].includes(rel)) expect(n, rel).toBeGreaterThan(1);
    else {
      expect(n, rel).toBe(1);
      expect(html.slice(html.indexOf("<footer")).includes(SITE.company), rel).toBe(true);
    }
  }
  expect(PLAN_TAX).not.toContain(SITE.company);
});

test("the no-merge claim is one sentence, true as stated, wherever a page makes it", () => {
  // the home page says what the guard blocks, in which CLIs, and links to the whole of it on Under the hood
  for (const rel of ["for/teams.html", "under-the-hood.html"]) expect(built.find(([r]) => r === rel)?.[1], rel).toContain(CLAIMS.noMerge);
  expect(built.find(([r]) => r === "index.html")?.[1]).toContain('href="./under-the-hood.html#guard"');
  expect(built.find(([r]) => r === "under-the-hood.html")?.[1]).toContain(CLAIMS.guardReach);
  expect(built.find(([r]) => r === "index.html")?.[1]).toContain(CLAIMS.guardBlocks);
  for (const rel of ["index.html", "for/solo.html"]) expect(built.find(([r]) => r === rel)?.[1], rel).toContain(CLAIMS.quietMode);
  for (const [rel, html] of built) expect(/They merge only where|a person reviews and merges every/.test(html), rel).toBe(false);
});

test("the guard's limits are said plainly, from one source: it isn't a sandbox", () => {
  expect(GUARD_LIMIT).toContain("isn't a sandbox");
  expect(GUARD_LIMIT).toContain("can write Overhand's own files");
  for (const rel of ["under-the-hood.html", "docs/guard.html"]) expect(built.find(([r]) => r === rel)?.[1], rel).toContain(GUARD_LIMIT);
  expect(GUARD_LIMIT).toContain("OS sandbox's job, when you turn it on");
});

test("the OS sandbox's claims, what it stops and what it can't, come from one source, on the site and in SECURITY", () => {
  // it ships off by default: no claim may say every run is sandboxed
  expect(SANDBOX_STOPS).toStartWith("With the OS sandbox on,");
  for (const word of ["network", "GitHub and SSH", "Keychain", "guard only"]) expect(SANDBOX_LIMIT).toContain(word);
  for (const rel of ["under-the-hood.html", "docs/guard.html"])
    for (const claim of [SANDBOX_STOPS, SANDBOX_LIMIT]) expect(built.find(([r]) => r === rel)?.[1], rel).toContain(claim);
  expect(built.find(([r]) => r === "docs/guard.html")?.[1]).toContain(SANDBOX_PROJECT_OFF);
  const flat = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8").replace(/\s+/g, " ");
  for (const claim of [SANDBOX_STOPS, SANDBOX_LIMIT, SANDBOX_PROJECT_OFF]) expect(flat("SECURITY.md")).toContain(claim);
  expect(built.find(([r]) => r === "docs/guard.html")?.[1]).toContain("logs/sandbox-would-deny.jsonl");
});

test("the plugin sandbox's claims come from one source, on the docs page and in SECURITY, and promise no review by us", () => {
  const page = built.find(([r]) => r === "docs/plugins.html")?.[1] ?? "";
  const flat = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8").replace(/\s+/g, " ");
  for (const claim of [PLUGIN_STOPS, PLUGIN_LIMIT, PLUGIN_REVIEW]) {
    expect(page).toContain(claim);
    expect(flat("SECURITY.md")).toContain(claim);
  }
  expect(PLUGIN_REVIEW).toContain("no review by us yet");
});

const docs = built.filter(([rel]) => rel.startsWith("docs/"));
/** Paths the deploy adds beside the built pages (site/wrangler.jsonc), and files the build writes itself. */
const DEPLOYED = [
  "demo/index.html",
  "docs/design/index.html",
  "system.css",
  "llms.txt",
  "llms-full.txt",
  "skill.md",
  ...DOCS.map((d) => `docs/${d.slug}.md`),
];

test("the docs are one page per DOCS entry, plus the index, each with its own title", () => {
  expect(docs.map(([rel]) => rel).sort()).toEqual(["docs/index.html", ...DOCS.map((d) => `docs/${d.slug}.html`)].sort());
  for (const d of DOCS) {
    const html = docs.find(([rel]) => rel === `docs/${d.slug}.html`)?.[1] ?? "";
    expect(html, d.slug).toContain(`<h1 id="hook">${d.title}</h1>`);
    expect(html, d.slug).toContain('href="../docs/" aria-current="page"');
  }
});

test("every link on a docs page reaches a page (and an anchor) that exists", () => {
  for (const [rel, html] of docs)
    for (const [, href = ""] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [withQuery = "", hash = ""] = href.split("#");
      const path = withQuery.split("?")[0] ?? "";
      const target = path
        ? normalize(join(dirname(rel), path))
            .replace(/(^|\/)$/, "$1index.html")
            .replace(/^\.\/?$/, "index.html")
        : rel;
      const page = built.find(([r]) => r === target)?.[1];
      const exists =
        page !== undefined || DEPLOYED.includes(target) || existsSync(join(pagesDir, target)) || existsSync(join(here, "public", target));
      expect(exists, `${rel} → ${href}`).toBe(true);
      if (hash && page) expect(page.includes(`id="${hash}"`), `${rel} → ${href}`).toBe(true);
    }
});

test("llms.txt lists every docs page and setup.md", () => {
  const txt = llmsTxt();
  for (const [rel] of docs) expect(txt, rel).toContain(`(${SITE.url}/${rel.replace(/\.html$/, ".md")})`);
  expect(txt).toContain(`(${SITE.url}/setup.md)`);
  expect(txt.startsWith(`# ${SITE.name}\n\n> `)).toBe(true);
});

test("only the What's next page names what isn't built", () => {
  // each thing not built yet is named on What's next, and nowhere else
  const each = [/hosted runner/i, /\bSSO\b|single sign-on/i];
  const unbuilt = /railway|fly\.io|hosted runner|\bSSO\b|single sign-on/gi;
  const next = built.find(([rel]) => rel === "docs/next.html")?.[1] ?? "";
  for (const re of each) expect(next, String(re)).toMatch(re);
  const others: [string, string][] = [
    ...built.filter(([rel]) => rel !== "docs/next.html"),
    ["setup.md", read("pages/setup.md")],
    ["llms.txt", llmsTxt()],
  ];
  for (const [rel, html] of others) expect(html.match(unbuilt), rel).toBeNull();
});

test("every line of overhand help splits into its command and what it does (two spaces between)", () => {
  // a command read with its description stuck to it squeezes the command reference's descriptions to one word wide
  for (const [cmd, say] of cliCommands()) {
    expect(cmd, cmd).toMatch(/^overhand [a-z-]+(?: [^ ].*)?$/);
    expect(cmd.length, cmd).toBeLessThan(60);
    expect(say.length, cmd).toBeGreaterThan(0);
  }
});

test("the docs give only commands the CLI has, and quote only messages the code prints", () => {
  const usage = cliCommands().map(([c]) => c);
  expect(usage).toContain("overhand start");
  const daemon = readFileSync(join(here, "../packages/core/src/daemon.ts"), "utf8");
  const code = [
    ...[...new Bun.Glob("packages/core/src/**/*.ts").scanSync(join(here, ".."))].map((f) => join(here, "..", f)),
    join(here, "../release/install.sh"),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const plain = (s: string) =>
    s
      .replace(/<[^>]+>/g, "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
  for (const [rel, html] of docs) {
    for (const [, c = ""] of html.matchAll(/<code>overhand ([a-z-]+)/g))
      expect(daemon.includes(`mode === "${c}"`), `${rel}: ${c}`).toBe(true);
    for (const [, m = ""] of html.matchAll(/<samp>([\s\S]*?)<\/samp>/g)) expect(code.includes(plain(m)), `${rel}: ${m}`).toBe(true);
  }
  expect(docs.find(([rel]) => rel === "docs/troubleshooting.html")?.[1].match(/<samp>/g)?.length).toBeGreaterThan(8);
});

test("every ready-made lead has its name wherever it shows (the docs page, its suggestion, its preview) and one way of working", () => {
  const page = docs.find(([rel]) => rel === "docs/leads.html")?.[1] ?? "";
  for (const k of LEAD_WORK) {
    // the suggestion's title and the name Start gives the lead are both this word
    const name = W[LEAD_WORDS[k].name];
    expect(name, k).toMatch(/^[A-Z][^{}]+$/);
    expect(page, k).toContain(`<b>${name}</b> ${LEAD_TEMPLATES[k].goal}`);
    for (const [label, line] of previewRows({ kind: k, items: [{ kind: k, ref: "web#4", url: "", brief: "" }] }, "act", "agent", W))
      expect(line, `${k} ${label}`).toMatch(/^[^{}]*[a-z][^{}]*$/);
  }
  expect(page).not.toContain("undefined");
  expect(page.split(WAY_OF_WORKING)).toHaveLength(2);
});

test("no page names the hosted app's address itself: every link to it comes from SITE.app, so a staging build points at staging's relay", () => {
  for (const f of walk(join(import.meta.dir, "pages")).concat(walk(join(import.meta.dir, "pages", "_partials"))))
    expect(readFileSync(f, "utf8"), relative(import.meta.dir, f)).not.toContain("app.overhand.dev");
  expect(readFileSync(join(import.meta.dir, "wrangler.jsonc"), "utf8")).toContain(
    "OVERHAND_APP=https://staging-app.overhand.dev bun site/build.ts",
  );
});

test("the site's headers turn off unused browser features and outside framing; staging alone says noindex", () => {
  const prod = siteHeaders(false);
  expect(prod).toContain(`Permissions-Policy: ${PERMISSIONS}`);
  expect(prod).toContain("frame-ancestors 'self'");
  expect(prod).not.toContain("noindex");
  expect(siteHeaders(true)).toContain("X-Robots-Tag: noindex");
  const sec = securityTxt(Date.parse("2026-10-23"));
  expect(sec).toContain(`Contact: mailto:${SITE.email}`);
  expect(sec).toContain("Expires: 2027-10-23T00:00:00Z");
  const map = sitemap(["index.html", "pricing.html", "docs/index.html", "docs/install.html", "setup.md"]);
  expect(map).toContain(`<loc>${SITE.url}/</loc>`);
  expect(map).toContain(`<loc>${SITE.url}/docs/install</loc>`);
  expect(map).not.toContain("setup.md");
});

/** The words of a text, lower-cased, without markup: what a reader reads, to compare a page with its Markdown. */
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
/** A built page's own text, the way the Markdown says it: tags out, entities back. */
const pageWords = (html: string) =>
  words(
    docMain(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/&(lt|gt|quot|amp);/g, " "),
  );
/** Markdown's text: link targets and fence marks out. */
const mdWords = (md: string) => words(md.replace(/\]\([^)\s]+\)/g, "]").replace(/^```.*$/gm, ""));
const docsMd = new Map(docs.map(([rel, html]): [string, string] => [rel, docMarkdown(html, `${SITE.url}/${rel}`)]));

test("every docs page has a Markdown twin with the same text, and llms-full.txt holds each one in order", () => {
  expect(docsMd.size).toBe(DOCS.length + 1);
  for (const [rel, html] of docs) {
    const md = docsMd.get(rel) ?? "";
    expect(md.startsWith("# "), rel).toBe(true);
    expect(mdWords(md), rel).toBe(pageWords(html));
    // links are absolute, so the Markdown reads the same wherever it's fetched from
    for (const [, href = ""] of md.matchAll(/\]\(([^)\s]+)\)/g)) expect(href, rel).toMatch(/^(https?:|mailto:)/);
    expect(md, rel).not.toMatch(/<\/?(a|b|p|li|ul|em|code|samp|section|div|h[1-6])\b|&(lt|gt|amp|quot);|\{\{/);
  }
  const full = llmsFullTxt(new Map(DOCS.map((d) => [d.slug, docsMd.get(`docs/${d.slug}.html`) ?? ""])));
  let at = 0;
  for (const d of DOCS) {
    const i = full.indexOf(docsMd.get(`docs/${d.slug}.html`) ?? "\0", at);
    expect(i, d.slug).toBeGreaterThan(at);
    at = i;
  }
  for (const f of [full, llmsTxt()]) expect(f).toContain(`${SITE.repo}/blob/main/LICENSE-docs`);
  expect(existsSync(join(here, "../LICENSE-docs"))).toBe(true);
  expect(read("../LICENSE-docs")).toContain("CC0 1.0 Universal");
});

test("llms.txt links each page's Markdown, llms-full.txt and the skill", () => {
  const txt = llmsTxt();
  for (const d of DOCS) expect(txt, d.slug).toContain(`(${SITE.url}/docs/${d.slug}.md)`);
  for (const f of ["llms-full.txt", "skill.md", "setup.md", "docs/index.md"]) expect(txt, f).toContain(`(${SITE.url}/${f})`);
});

test("the agent skill: valid frontmatter, the site's install command, and only commands the CLI has", () => {
  const skill = readFileSync(SKILL_PATH, "utf8");
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const fields = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
  // Agent Skills: a lower-case name that matches its folder, a description of what it does and when to use it
  expect(fields.name).toBe("overhand");
  expect(SKILL_PATH.endsWith(`/${fields.name}/SKILL.md`)).toBe(true);
  expect(fields.description?.length ?? 0).toBeGreaterThan(50);
  expect(fields.description?.length ?? 0).toBeLessThanOrEqual(1024);
  expect(fields.description).toContain("Use when");
  expect(skill).toContain(CMD);
  for (const [, url = ""] of skill.matchAll(/(https:\/\/overhand\.dev[^\s)`]*)/g)) expect(url.startsWith(SITE.url), url).toBe(true);
  const daemon = readFileSync(join(here, "../packages/core/src/daemon.ts"), "utf8");
  const cmds = [...skill.matchAll(/`overhand ([a-z-]+)/g)].map((m) => m[1] ?? "");
  expect(cmds.length).toBeGreaterThan(8);
  for (const c of cmds) expect(daemon.includes(`mode === "${c}"`), c).toBe(true);
});

test("a docs page names an app control only through its words slot, so a renamed control can't go stale", () => {
  for (const f of walk(join(here, "pages/docs"))) {
    const src = readFileSync(f, "utf8");
    // every <em> on a docs page is a control or message the app shows: {{w.key}}, never typed
    for (const [, inner = ""] of src.matchAll(/<em>([\s\S]*?)<\/em>/g)) expect(inner, relative(here, f)).toMatch(/^\{\{w\.\w+\}\}$/);
    for (const [, k = ""] of src.matchAll(/\{\{w\.(\w+)\}\}/g)) expect(wordSlot(k), `${relative(here, f)}: ${k}`).toBeDefined();
    for (const [, p = ""] of src.matchAll(/\{\{cfg\.([\w.]+)\}\}/g)) expect(configDefault(p), `${relative(here, f)}: ${p}`).toBeDefined();
  }
  expect(() => render("<em>{{w.noSuchWord}}</em>", "./", "x.html")).toThrow("unknown slot {{w.noSuchWord}}");
  expect(() => render("{{cfg.governor.nope}}", "./", "x.html")).toThrow("unknown slot {{cfg.governor.nope}}");
  expect(configDefault("governor.slots.build")).toBe("2");
});
