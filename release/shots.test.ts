import { expect, setDefaultTimeout, test } from "bun:test";
import { SYSTEM } from "../packages/themes/src/system";
import { audit, contactSheet, type Frame, isTouch, SCREENS, SITE_PAGES, SITE_SCHEMES, SITE_VIEWPORTS, summarize, VIEWPORTS } from "./shots";

// these start a real browser, often several times: a shared CI runner needs more than bun's default 5 s
setDefaultTimeout(30_000);

const frame = (viewport: string, severities: ("hard" | "soft" | "info")[], screen = "now"): Frame => ({
  screen,
  viewport,
  theme: "observatory",
  file: `${screen}__${viewport}__observatory.jpg`,
  findings: severities.map((severity) => ({ check: "overlap", severity, detail: "8×8px", where: "a ⟷ b" })),
});

test("summarize counts hard and soft findings per viewport, ignoring info", () => {
  const s = summarize([frame("390x844", ["hard", "soft", "info"]), frame("390x844", ["soft"]), frame("1440x900", [])]);
  expect(s["390x844"]).toEqual({ hard: 1, soft: 2, frames: 2 });
  expect(s["1440x900"]).toEqual({ hard: 0, soft: 0, frames: 1 });
});

test("the contact sheet has a row per screen and escapes what the page said", () => {
  const f = frame("390x844", ["hard"]);
  const evil = { ...f, findings: [{ check: "clipped" as const, severity: "soft" as const, detail: "<script>", where: "x" }] };
  const html = contactSheet([f, { ...evil, screen: "work" }]);
  expect(html).toContain("<th>now</th>");
  expect(html).toContain("<th>work</th>");
  expect(html).toContain("1 hard");
  expect(html).not.toContain("<script>x");
  expect(html).toContain("&lt;script&gt;");
});

test("the sweep covers phones to 5K ultra-wides, touch up to 1024", () => {
  expect(VIEWPORTS.map(([w]) => w)).toContain(320);
  expect(VIEWPORTS.map(([w]) => w)).toContain(5120);
  expect(isTouch(1024)).toBe(true);
  expect(isTouch(1280)).toBe(false);
  expect(SCREENS).toContain("setup");
  expect(SCREENS).toContain("pair");
});

test("the site is swept at its own widths, every page of it", () => {
  expect(SITE_VIEWPORTS.map(([w]) => w)).toEqual([375, 768, 1024, 1440, 2200, 3200]);
  for (const p of ["pricing", "under-the-hood", "for/solo", "for/studios", "for/teams", "for/makers"]) expect(SITE_PAGES).toContain(p);
  for (const p of SITE_PAGES) expect(SCREENS).toContain(`site-${p}`);
  for (const p of SITE_PAGES) expect(Bun.file(`${import.meta.dir}/../site/pages/${p}.html`).size, p).toBeGreaterThan(0);
});

test("the site is swept in light and dark, each frame with the contrast check", async () => {
  expect([...SITE_SCHEMES]).toEqual(["light", "dark"]);
  const src = await Bun.file(`${import.meta.dir}/shots.ts`).text();
  expect(src).toContain("page.emulateMedia({ colorScheme: scheme })");
  expect(src.match(/theme: look \}, width, false, true\)/g)).toHaveLength(2);
});

/** The contrast findings on a snippet, in the real browser, in `scheme`. */
async function contrastFindings(html: string, scheme: "light" | "dark" = "light"): Promise<string[]> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ colorScheme: scheme });
    await page.setContent(`<html><body>${html}</body></html>`);
    const { findings } = await page.evaluate(audit, {
      touch: false,
      wide: false,
      type: false,
      contrast: true,
      faces: SYSTEM.font.name,
      gap: SYSTEM.space.gap,
    });
    return findings.filter((f) => f.check === "contrast").map((f) => f.detail);
  } finally {
    await browser.close();
  }
}

test("text under WCAG AA against what's behind it is a hard finding; large text needs 3:1, text over an image is skipped", async () => {
  const [day, night] = [SYSTEM.ink.day, SYSTEM.ink.night];
  expect(await contrastFindings(`<p style="color:${day[9]};background:${day[0]}">Muted words on paper.</p>`)).toEqual([]);
  expect(await contrastFindings(`<p style="color:${day[8]};background:${day[0]}">Too faint on paper.</p>`)).toHaveLength(1);
  expect(
    await contrastFindings(`<div style="background:${night[0]}"><p style="color:${night[9]}">Muted by night.</p></div>`, "dark"),
  ).toEqual([]);
  // a translucent pane is read over what's under it
  expect(
    await contrastFindings(
      `<div style="background:${night[0]}"><p style="background:rgb(255 255 255 / 0.04);color:${night[7]}">Faint by night.</p></div>`,
    ),
  ).toHaveLength(1);
  expect(await contrastFindings(`<h1 style="font-size:32px;color:#888;background:#fff">Big and grey</h1>`)).toEqual([]);
  expect(await contrastFindings(`<p style="color:#888;background:#fff">Small and grey</p>`)).toHaveLength(1);
  expect(await contrastFindings(`<p style="color:#888;background:linear-gradient(#fff,#eee)">Over a gradient</p>`)).toEqual([]);
});

/** Runs the page checks on a snippet in the real browser; skipped output means no Chromium, which the shots need anyway. */
async function fontFindings(html: string): Promise<string[]> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><body>${html}</body></html>`);
    const { findings } = await page.evaluate(audit, {
      touch: false,
      wide: false,
      type: true,
      faces: SYSTEM.font.name,
      gap: SYSTEM.space.gap,
    });
    return findings.filter((f) => f.check === "font").map((f) => f.detail);
  } finally {
    await browser.close();
  }
}

test("the font check flags Newsreader on a site page and passes the system's two faces", async () => {
  const { body, mono } = SYSTEM.font.name;
  const story = await fontFindings(`<p style="font-family: Newsreader, serif">The story reads in the body face.</p>`);
  expect(story.some((d) => d.includes("Newsreader"))).toBe(true);
  expect(await fontFindings(`<p style="font-family: '${body}'">Words in the body face.</p>`)).toEqual([]);
  expect(await fontFindings(`<code style="font-family: '${mono}'">overhand start</code>`)).toEqual([]);
  expect(await fontFindings(`<p style="font-family: '${mono}'">Words in the data face.</p>`)).toHaveLength(1);
  expect(await fontFindings(`<p style="font-family: Geist">Words in the old face.</p>`)).toHaveLength(1);
});

test("the sweep runs the font check on the site's frames too", async () => {
  const src = await Bun.file(`${import.meta.dir}/shots.ts`).text();
  expect(src).toContain("type: true,");
  expect(src).not.toContain('type: !frame.screen.startsWith("landing")');
});

/** The gap findings the page checks raise on a snippet, in the real browser. */
async function gapFindings(html: string): Promise<{ severity: string; detail: string }[]> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
    const { findings } = await page.evaluate(audit, {
      touch: false,
      wide: false,
      type: false,
      faces: SYSTEM.font.name,
      gap: SYSTEM.space.gap,
    });
    return findings.filter((f) => f.check === "gap");
  } finally {
    await browser.close();
  }
}

const pane = (h: number, style = "") => `<section class="hud-pane" style="height:${h}px;${style}"><h2 style="margin:0">Pane</h2></section>`;

test("two panes stacked in a column closer than the system gap are a hard finding", async () => {
  const touching = await gapFindings(`<div style="width:400px">${pane(100)}${pane(100)}</div>`);
  expect(touching).toHaveLength(1);
  expect(touching[0]?.severity).toBe("hard");
  expect(touching[0]?.detail).toContain("0px");
  const over = await gapFindings(`<div style="width:400px">${pane(100)}${pane(100, "margin-top:-20px")}</div>`);
  expect(over[0]?.detail).toContain("overlap");
  expect(await gapFindings(`<div style="width:400px;display:grid;gap:${SYSTEM.space.gap}px">${pane(100)}${pane(100)}</div>`)).toEqual([]);
  // side by side, or one inside another, isn't a stack
  expect(
    await gapFindings(`<div style="display:flex;gap:${SYSTEM.space.gap}px">${pane(100, "width:300px")}${pane(100, "width:300px")}</div>`),
  ).toEqual([]);
  expect(await gapFindings(`<section class="hud-pane" style="width:400px">${pane(100)}</section>`)).toEqual([]);
  // a pane in a column that scrolls ends where the column does: what's scrolled out of it is under nothing
  expect(
    await gapFindings(
      `<div style="width:400px;height:300px;overflow-y:auto">${pane(600)}</div><div style="width:400px;margin-top:${SYSTEM.space.gap}px">${pane(100)}</div>`,
    ),
  ).toEqual([]);
});

/** The hard layout findings (audit's section 8) on a snippet at 1200×900, in the real browser, as "check: where". */
async function layoutFindings(html: string): Promise<string[]> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(`<html><body style="margin:0;font:14px/20px sans-serif">${html}</body></html>`);
    const { findings } = await page.evaluate(audit, {
      touch: false,
      wide: false,
      type: false,
      faces: SYSTEM.font.name,
      gap: SYSTEM.space.gap,
      geometry: true,
    });
    return findings.filter((f) => f.severity === "hard").map((f) => `${f.check}: ${f.where}`);
  } finally {
    await browser.close();
  }
}

const border = "border:1px solid #888";

test("a card wider than its column is a hard finding; one in a sideways scroller its author made is not", async () => {
  const column = (inner: string, style = "") => `<section style="${border};width:200px;${style}">${inner}</section>`;
  const card = `<div style="${border};width:320px">A card</div>`;
  const out = await layoutFindings(column(card));
  expect(out.some((f) => f.startsWith("contain:") && f.includes("A card"))).toBe(true);
  expect(await layoutFindings(column(`<div data-scroll-x style="overflow-x:auto">${card}</div>`))).toEqual([]);
  // a scroller meant to scroll down only, made to scroll sideways by what's in it
  const down = await layoutFindings(`<div style="overflow-y:auto;height:100px;width:200px">${card}</div>`);
  expect(down.some((f) => f.startsWith("contain:") && f.includes("scrolls") === false)).toBe(true);
});

test("a title squeezed to a strip beside a button, while its card has room, is a hard finding", async () => {
  const words = "Move every settings screen under the new folder and keep the old paths working";
  const row = (title: string) =>
    `<div style="${border};width:400px;display:flex;gap:8px"><p style="width:70px;margin:0">${title}</p><button style="flex:1">Assign an agent</button></div>`;
  expect((await layoutFindings(row(words))).some((f) => f.startsWith("squeeze:"))).toBe(true);
  expect(await layoutFindings(`<div style="${border};width:400px"><p style="margin:0">${words}</p></div>`)).toEqual([]);
});

test("a count drawn over the next column's heading is a hard finding", async () => {
  const html = `<div style="display:flex"><h3 style="margin:0;width:80px">Planned</h3><span style="margin-left:-30px">23</span><h3 style="margin:0">Queued</h3></div>`;
  expect((await layoutFindings(html)).some((f) => f.startsWith("overlap:"))).toBe(true);
  expect(await layoutFindings(`<div style="display:flex;gap:8px"><h3 style="margin:0">Planned</h3><span>23</span></div>`)).toEqual([]);
});

test("a button its words don't fit, and two targets under 24px side by side, are hard findings", async () => {
  const cut = await layoutFindings(`<button style="width:40px;white-space:nowrap;overflow:hidden">Assign an agent</button>`);
  expect(cut.some((f) => f.startsWith("clipped:"))).toBe(true);
  const small = "width:16px;height:16px;padding:0;border:0";
  const tiny = await layoutFindings(
    `<div style="display:flex"><button style="${small}">a</button><button style="${small}">b</button></div>`,
  );
  expect(tiny.filter((f) => f.startsWith("target:"))).toHaveLength(2);
  const fine = "width:24px;height:24px;padding:0;border:0";
  expect(
    await layoutFindings(`<div style="display:flex"><button style="${fine}">a</button><button style="${fine}">b</button></div>`),
  ).toEqual([]);
});

test("words cut short in the header bar are a hard finding; a title marked data-truncates may end in an ellipsis", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const cut = "display:block;width:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    await page.setContent(
      `<header class="app-header"><span style="${cut}">Can't reach Overhand</span><span data-truncates style="${cut}">A long meeting</span></header>`,
    );
    const { findings } = await page.evaluate(audit, {
      touch: false,
      wide: false,
      type: false,
      faces: SYSTEM.font.name,
      gap: SYSTEM.space.gap,
    });
    const hard = findings.filter((f) => f.check === "clipped" && f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]?.where).toContain("Can't reach");
  } finally {
    await browser.close();
  }
});
