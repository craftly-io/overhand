/**
 * The responsive sweep: every screen of the dashboard and the landing page, at every screen size from a small phone to
 * a 5K ultra-wide, in every theme. Each frame gets a screenshot and DOM checks; the output is a contact sheet
 * (index.html) and every finding (report.json). Hard failures (the page scrolls sideways, controls overlap) exit 1, so
 * the release preflight blocks on them; soft findings are listed.
 *
 * Usage: bun run shots [--out dir] [--viewports 390x844,1440x900] [--themes observatory-dark,koi-light] [--screens now,work]
 *                      [--data demo,stress] [--workers 4] [--no-build]
 *
 * The dashboard is swept twice: on the sample night (`?demo`) in every look, and on the stress night (`?demo=stress`,
 * apps/web/src/demo/stress.ts: long names and identifiers, full and empty columns, many-digit numbers) in the first
 * look, as `<screen>+stress`. Its frames get the layout checks too (audit's section 8): a box out of its card, pane or
 * drawer, text squeezed into a strip, text over text, a button its words don't fit, a target under 24px.
 *
 * `--screens design` sweeps the design catalog (apps/design, overhand.dev/docs/design) instead: every entry's page and
 * every state that renders in a frame of its own, in light and dark, at 390, 1024 and 1440 unless --viewports says
 * otherwise. A state the catalog couldn't render is a hard finding.
 *
 * It needs playwright-core (a devDependency) and its Chromium: `bunx playwright-core install chromium-headless-shell`,
 * or point PLAYWRIGHT_BROWSERS_PATH at an existing install.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { BrowserContext, Page, Route } from "playwright-core";
import { demoGet } from "../apps/web/src/demo/fixtures";
import { nightAt } from "../apps/web/src/demo/night";
import { SYSTEM } from "../packages/themes/src/system";
import { DOCS } from "../site/site";

const ROOT = resolve(import.meta.dir, "..");

/** Width × height in CSS px: phones, phone landscape, tablets, laptops, desktops and ultra-wides. */
export const VIEWPORTS: [number, number][] = [
  [320, 568],
  [360, 740],
  [390, 844],
  [430, 932],
  [844, 390],
  [768, 1024],
  [834, 1194],
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1680, 1050],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [5120, 1440],
];

/** Each look: the theme id stored in "overhand-theme" and the appearance in "overhand-appearance". */
export const THEMES = [
  { id: "overhand-dark", theme: "overhand", appearance: "dark" },
  { id: "overhand-light", theme: "overhand", appearance: "light" },
  { id: "observatory-dark", theme: "observatory", appearance: "dark" },
  { id: "observatory-light", theme: "observatory", appearance: "light" },
  { id: "transit-light", theme: "transit", appearance: "light" },
  { id: "transit-dark", theme: "transit", appearance: "dark" },
  { id: "koi-dark", theme: "koi", appearance: "dark" },
  { id: "koi-light", theme: "koi", appearance: "light" },
  { id: "catnap-light", theme: "catnap", appearance: "light" },
  { id: "catnap-dark", theme: "catnap", appearance: "dark" },
] as const;

const SETTINGS_TABS = [
  "projects",
  "accounts",
  "leads",
  "schedule",
  "rules",
  "integrations",
  "plugins",
  "phone",
  "team",
  "look",
  "health",
  "system",
  "json",
];
const LANDING = ["landing-top", "landing-mid", "landing-install", "landing-footer"];
/** The site's other pages, by path under site/public: each a screen of its own, shot in the site's sweep. */
export const SITE_PAGES = [
  "pricing",
  "under-the-hood",
  "for/solo",
  "for/studios",
  "for/teams",
  "for/makers",
  "contact",
  "privacy",
  "terms",
  "refund",
  "docs/index",
  // every docs page, from the site's own list, so a new page is swept from its first day
  ...DOCS.map((d) => `docs/${d.slug}`),
];
/** The site follows the computer's light or dark (no toggle), so its every frame is shot in both. */
export const SITE_SCHEMES = ["light", "dark"] as const;
const SITE = [...LANDING, ...SITE_PAGES.map((p) => `site-${p}`)];
/**
 * The site's widths (docs/specs/2026-10-22-design-system-and-site-design.md, "Quality bar"): the landing page
 * and every site page are swept at these by default, the dashboard at VIEWPORTS. --viewports sweeps both at the ones given.
 */
export const SITE_VIEWPORTS: [number, number][] = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [2200, 1240],
  [3200, 1800],
];
/** Every screen, in contact sheet order. Site screens render once per viewport in each of SITE_SCHEMES. */
export const SCREENS = [
  ...SITE,
  "now",
  "work",
  "crew",
  "crew-project",
  "lead-preview",
  "health",
  ...SETTINGS_TABS.map((t) => `settings-${t}`),
  "menu",
  "quick",
  "command",
  "command-typo",
  "needs-all",
  "review",
  "instructions",
  "guide",
  "lead",
  "brief",
  "sweep",
  "share",
  "setup",
  "setup-organise",
  "pair",
  "design",
];
/** The design catalog's sweep: its widths, and its two looks (the house look's light and dark). */
export const DESIGN_VIEWPORTS: [number, number][] = [
  [390, 844],
  [1024, 768],
  [1440, 900],
];

export type Severity = "hard" | "soft" | "info";
export interface Finding {
  check:
    | "overflow-x"
    | "overlap"
    | "gap"
    | "offscreen"
    | "clipped"
    | "tap"
    | "tiny-text"
    | "contrast"
    | "line-length"
    | "wide"
    | "capture"
    | "font"
    | "render"
    | "contain"
    | "squeeze"
    | "target";
  severity: Severity;
  detail: string;
  where: string;
}
export interface Frame {
  screen: string;
  viewport: string;
  theme: string;
  file: string;
  findings: Finding[];
  /** Ultra-wide only: pane and drawer widths, and the empty margins either side of the content. */
  metrics?: Record<string, number | number[]>;
}

/** Touch-size screens get tap target checks and a phone's touch emulation. */
export const isTouch = (width: number): boolean => width <= 1024;

/**
 * The DOM checks, run inside the page (so it must not use anything from outside its own body). `touch` adds tap target
 * checks; `wide` adds the ultra-wide measurements; `type` checks the two voices (the dashboard's and the site's); `faces` names them (SYSTEM.font.name);
 * `gap` is the one gap between panes (SYSTEM.space.gap), which two panes stacked in a column must keep.
 */
export function audit(opts: {
  touch: boolean;
  wide: boolean;
  type: boolean;
  faces: { body: string; mono: string };
  gap: number;
  /** The layout checks (section 8): boxes leaving their card, squeezed text, text on text, cut buttons, small targets. */
  geometry?: boolean;
  /** The contrast check (section 9): text against the solid colours behind it, WCAG AA. */
  contrast?: boolean;
}): {
  findings: Finding[];
  metrics: Record<string, number | number[]>;
} {
  const findings: Finding[] = [];
  const metrics: Record<string, number | number[]> = {};
  const vw = innerWidth;
  const seen = new Set<string>();
  const add = (f: Finding) => {
    const key = `${f.check}|${f.where}|${f.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };
  const name = (el: Element): string => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")) : [];
    const label = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().replace(/\s+/g, " ");
    const id = el.id ? `#${el.id}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls.length ? `.${cls.slice(0, 3).join(".")}` : ""}${label ? ` "${label.slice(0, 40)}"` : ""}`;
  };
  const hidden = (el: Element): boolean => {
    if (el.closest("[aria-hidden=true],[inert]")) return true;
    // the inside of a closed <details> (content-visibility: hidden) still reports a box, where nothing is drawn
    if (!el.checkVisibility()) return true;
    const s = getComputedStyle(el);
    return s.visibility !== "visible" || s.display === "none" || Number(s.opacity) === 0 || s.pointerEvents === "none";
  };
  /** The part of an element left after every clipping ancestor, or null when nothing of it shows. */
  const visibleRect = (el: Element): DOMRect | null => {
    const r = el.getBoundingClientRect();
    let [l, t, ri, b] = [r.left, r.top, r.right, r.bottom];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const q = p.getBoundingClientRect();
      [l, t, ri, b] = [Math.max(l, q.left), Math.max(t, q.top), Math.min(ri, q.right), Math.min(b, q.bottom)];
    }
    return ri - l >= 2 && b - t >= 2 ? new DOMRect(l, t, ri - l, b - t) : null;
  };
  const ownText = (el: Element): string =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("")
      .trim();

  // 1. the page scrolls sideways
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollWidth > vw + 1) {
    const wide = [...document.body.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && !hidden(el))
      .slice(-3)
      .map(name);
    add({
      check: "overflow-x",
      severity: "hard",
      detail: `page is ${doc.scrollWidth}px wide in a ${vw}px viewport`,
      where: wide.join(" | "),
    });
  }

  // the type system: the body face for every word and heading, the mono face for data only (numbers, times, counts, ticket keys,
  // the clock), and the world's own face (--font-greeting) on the greeting alone
  const family = (el: Element) =>
    getComputedStyle(el)
      .fontFamily.split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  const greeting =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-greeting")
      .split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  const DATA = "kbd,code,pre,time,[data-data]";
  // data: a digit, a ticket key, a keyboard key, a path or address, or only symbols
  const isData = (t: string) => /\d|^[A-Z][A-Z0-9]*-\d|^[A-Z⌘⇧⌥⌃/.?]{1,3}$|^[^\p{L}]+$|^\S*[/.@]\S*$/u.test(t);
  const typeCheck = (el: Element, text: string) => {
    const f = family(el);
    const role =
      f === greeting && greeting !== opts.faces.body
        ? el.closest("h1.readout")
          ? ""
          : `${f} is the world's greeting face, used off the greeting`
        : f === opts.faces.body
          ? ""
          : f === opts.faces.mono
            ? isData(text) || el.closest(DATA)
              ? ""
              : `${opts.faces.mono} on words, not data`
            : `${f || "no font"} is outside the type system`;
    if (role) add({ check: "font", severity: "hard", detail: role, where: name(el) });
  };
  if (opts.type)
    for (const t of document.querySelectorAll("svg text")) {
      const text = (t.textContent ?? "").trim();
      if (text && !t.closest("[aria-hidden=true]") && t.getClientRects().length) typeCheck(t, text);
    }

  /** How far a hit area (the hit-area utility's ::before) on `el` or a control in it reaches past a side: it widens scrollWidth. */
  const overhangOf = (el: Element): number =>
    Math.max(
      0,
      ...[el, ...el.querySelectorAll(".hit-area")].map((x) => {
        const b = getComputedStyle(x, "::before");
        return b.position === "absolute" ? ((Number.parseFloat(b.width) || 0) - x.clientWidth) / 2 : 0;
      }),
    );
  const all = [...document.body.querySelectorAll("*")].filter((el) => !(el instanceof SVGElement));
  const canvas = document.createElement("canvas").getContext("2d");
  for (const el of all) {
    if (!(el instanceof HTMLElement) || el.closest("[aria-hidden=true],.sr-only")) continue;
    const text = ownText(el);
    if (!text) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility !== "visible" || el.getClientRects().length === 0) continue;
    if (!visibleRect(el)) continue;
    // 2. text that doesn't fit its box: cut off without an ellipsis, or spilling out
    const overhang = overhangOf(el);
    if (el.scrollWidth > el.clientWidth + 1 + overhang && el.clientWidth > 0 && s.display !== "inline") {
      const scrolls = s.overflowX === "auto" || s.overflowX === "scroll";
      const ellipsis = s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none";
      // the header bar has room for every word it shows: cut there ("C…") is a lost status or place, not a long line
      // (a meeting title marked data-truncates is the one cut allowed)
      if (ellipsis && el.closest(".app-header") && !el.closest("[data-truncates]"))
        add({
          check: "clipped",
          severity: "hard",
          detail: `cut in the header: ${el.scrollWidth}px of text in ${el.clientWidth}px`,
          where: name(el),
        });
      else if (!scrolls && !ellipsis)
        add({
          check: "clipped",
          severity: "soft",
          detail: `${s.overflowX === "visible" ? "spills" : "clipped"}: ${el.scrollWidth}px of text in ${el.clientWidth}px`,
          where: name(el),
        });
    }
    // 3. text too small to read
    const size = Number.parseFloat(s.fontSize);
    if (size < 11) add({ check: "tiny-text", severity: "soft", detail: `${size}px`, where: name(el) });
    if (opts.type) typeCheck(el, text);
    // 4. reading lines too long: characters per line from the element's width and its own average glyph width
    // (a one-line label cut with an ellipsis isn't read across a line, so it can't be too long to read)
    if (canvas && text.length > 95 && s.display !== "inline" && s.whiteSpace !== "nowrap") {
      canvas.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const sample = text.slice(0, 400);
      const glyph = canvas.measureText(sample).width / sample.length;
      const width = el.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
      const perLine = Math.round(width / glyph);
      if (glyph > 0 && perLine > 95 && text.length > perLine)
        add({
          check: "line-length",
          severity: "soft",
          detail: `~${perLine} characters per line (${Math.round(width)}px)`,
          where: name(el),
        });
    }
  }

  // 5. interactive elements overlapping, and 6. tap targets too small on touch screens
  const controls = [
    ...document.querySelectorAll<HTMLElement | SVGElement>(
      "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=slider]",
    ),
  ]
    .filter((el) => !hidden(el) && !el.closest(".sr-only"))
    // a map agent is tapped on its hit circle; its group's box also spans its hidden hover note
    .map((el) => ({ el, r: visibleRect(el.querySelector(":scope > .hit") ?? el) }))
    .filter((c): c is { el: HTMLElement | SVGElement; r: DOMRect } => c.r !== null && c.r.width >= 4 && c.r.height >= 4);
  /** The fixed or sticky layer an element rides in: content scrolling under a pinned bar isn't an overlap. */
  const layer = (el: Element): Element | null => {
    for (let p: Element | null = el; p; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky") return p;
    }
    return null;
  };
  const layers = new Map(controls.map((c) => [c.el, layer(c.el)]));
  for (let i = 0; i < controls.length; i++) {
    const a = controls[i];
    if (!a) continue;
    for (let j = i + 1; j < controls.length; j++) {
      const b = controls[j];
      if (!b || a.el.contains(b.el) || b.el.contains(a.el) || layers.get(a.el) !== layers.get(b.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w < 2 || h < 2) continue;
      // two map agents are circles: their squares can meet at the corners while the circles stay apart
      const round = (x: { el: Element; r: DOMRect }) => x.el.querySelector(":scope > .hit") !== null;
      if (round(a) && round(b)) {
        const gap = Math.hypot(a.r.x + a.r.width / 2 - (b.r.x + b.r.width / 2), a.r.y + a.r.height / 2 - (b.r.y + b.r.height / 2));
        if (gap >= (a.r.width + b.r.width) / 2 - 2) continue;
      }
      const share = (w * h) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      // markers in a drawn scene (SVG) may cluster; that's the scene's business, not a layout failure
      const drawn = a.el instanceof SVGElement || b.el instanceof SVGElement;
      const hard = !drawn && w * h >= 64 && share >= 0.2;
      add({
        check: "overlap",
        severity: hard ? "hard" : "soft",
        detail: `${Math.round(w)}×${Math.round(h)}px (${Math.round(share * 100)}% of the smaller)`,
        where: `${name(a.el)} ⟷ ${name(b.el)}`,
      });
    }
  }
  // 5b. controls nobody can reach: past the side of the screen (the app clips sideways overflow, so the page never
  // scrolls to them), or past the top or bottom of a fixed layer that can't scroll
  const scrolls = (el: Element, axis: "x" | "y"): boolean => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p)[axis === "x" ? "overflowX" : "overflowY"];
      if ((o === "auto" || o === "scroll") && (axis === "x" ? p.scrollWidth > p.clientWidth : p.scrollHeight > p.clientHeight)) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea")) {
    if (hidden(el) || el.closest(".sr-only")) continue;
    const r = el.getBoundingClientRect();
    // wholly clipped by an ancestor (a collapsed section, a scrolled-away row) is hidden on purpose, not lost
    if (r.width < 4 || r.height < 4 || !visibleRect(el)) continue;
    const sideways = (r.right > vw + 1 || r.left < -1) && !scrolls(el, "x");
    const pinned = layer(el);
    const fixedOff =
      pinned !== null && getComputedStyle(pinned).position === "fixed" && (r.top < -1 || r.bottom > innerHeight + 1) && !scrolls(el, "y");
    if (sideways || fixedOff)
      add({
        check: "offscreen",
        severity: "hard",
        detail: `out of reach at ${Math.round(r.left)},${Math.round(r.top)} (${Math.round(r.width)}×${Math.round(r.height)}) in ${vw}×${innerHeight}`,
        where: name(el),
      });
  }
  if (opts.touch)
    for (const { el, r } of controls) {
      // a checkbox or radio inside its label answers taps anywhere on the label: the label is the target
      const label = el instanceof HTMLInputElement ? el.closest("label") : null;
      const full = (label ?? el).getBoundingClientRect();
      // a target in running text is exempt (WCAG 2.5.8): an inline link, or a control set in a sentence (its parent
      // has words of its own)
      const display = getComputedStyle(el).display;
      const inline =
        (display === "inline" && el.tagName === "A") ||
        (display.startsWith("inline") && el.parentElement !== null && ownText(el.parentElement).length > 0);
      // a hit area drawn wider than the control (the hit-area utility's ::before) counts as the target
      const hit = getComputedStyle(el, "::before");
      const extended = hit.content !== "none" && hit.position === "absolute";
      const hw = extended ? Math.max(full.width, Number.parseFloat(hit.width) || 0) : full.width;
      const hh = extended ? Math.max(full.height, Number.parseFloat(hit.height) || 0) : full.height;
      // only a target shown whole: one cut by a clipping ancestor is measured where it isn't clipped
      const whole = r.width === el.getBoundingClientRect().width;
      if (!inline && (hw < 32 || hh < 32) && whole)
        add({ check: "tap", severity: "soft", detail: `${Math.round(full.width)}×${Math.round(full.height)}px`, where: name(el) });
    }

  // 6b. panes stacked in one column keep the system's gap: each pane against the nearest one below it in the same layer
  // (the page, or a drawer); a pane inside another pane is part of it, not a neighbour
  const stack = [...document.querySelectorAll(".hud-pane")]
    .filter((el) => !hidden(el) && !el.parentElement?.closest(".hud-pane"))
    .map((el) => ({ el, r: el.getBoundingClientRect(), layer: el.closest("[role=dialog]") }))
    .filter((p) => p.r.width > 0 && p.r.height > 0);
  for (const a of stack) {
    const below = stack
      .filter(
        (b) =>
          b !== a &&
          b.layer === a.layer &&
          b.r.top > a.r.top &&
          Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > Math.min(a.r.width, b.r.width) / 2,
      )
      .sort((x, y) => x.r.top - y.r.top)[0];
    if (!below) continue;
    const gap = Math.round(below.r.top - a.r.bottom);
    if (gap < opts.gap - 1)
      add({
        check: "gap",
        severity: "hard",
        detail:
          gap < 0 ? `panes overlap by ${-gap}px (the gap is ${opts.gap}px)` : `${gap}px between stacked panes (the gap is ${opts.gap}px)`,
        where: [a, below].map((p) => `"${(p.el.querySelector("h2")?.textContent ?? name(p.el)).trim()}"`).join(" ⟷ "),
      });
  }

  // 8. layout geometry, on the dashboard: what breaks when real data is longer, wider or more than the sample's
  if (opts.geometry) {
    /** The box an element must stay inside: its card (a bordered box), its pane, its drawer, or the screen. */
    const boxOf = (el: Element): Element | null => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.matches(".hud-pane, [role=dialog]")) return p;
        const ps = getComputedStyle(p);
        if (Number.parseFloat(ps.borderLeftWidth) > 0 && Number.parseFloat(ps.borderRightWidth) > 0) return p;
      }
      return null;
    };
    /** A box's inside (its padding box), or the screen's. */
    const inner = (b: Element | null): DOMRect => {
      if (!b) return new DOMRect(0, 0, vw, innerHeight);
      const r = b.getBoundingClientRect();
      const bs = getComputedStyle(b);
      const [l, ri] = [Number.parseFloat(bs.borderLeftWidth), Number.parseFloat(bs.borderRightWidth)];
      const [t, bo] = [Number.parseFloat(bs.borderTopWidth), Number.parseFloat(bs.borderBottomWidth)];
      return new DOMRect(r.left + l, r.top + t, r.width - l - ri, r.height - t - bo);
    };
    /** A scroller its author meant to scroll sideways (overflow-x-auto, overflow-auto, code), not one that just does. */
    const sideways = (el: Element) =>
      el.matches("pre, textarea, code, table, [data-scroll-x]") ||
      (typeof el.className === "string" && /(^|\s)overflow-(x-)?(auto|scroll)(\s|$)/.test(el.className));
    const els = [...document.body.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el instanceof HTMLElement && !hidden(el) && !el.closest(".sr-only, svg") && el.getClientRects().length > 0,
    );
    const spilled = new Set<Element>();
    for (const el of els) {
      const s = getComputedStyle(el);
      // 8a. a scroller that scrolls sideways when it was only meant to scroll down: something in it is too wide
      if ((s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && !sideways(el))
        add({
          check: "contain",
          severity: "hard",
          detail: `scrolls sideways: ${el.scrollWidth}px of content in ${el.clientWidth}px`,
          where: name(el),
        });
      // 8b. a box that sticks out of its card, pane or drawer (or the screen), over the border or past it; a clipping
      // or scrolling ancestor in between means it's cut or scrolled, which 8a and the text checks cover
      if (s.display === "inline" || s.display === "contents" || s.position === "absolute" || s.position === "fixed") continue;
      if (el.parentElement && spilled.has(el.parentElement)) {
        spilled.add(el);
        continue;
      }
      const box = boxOf(el);
      let [cx, cy, free] = [false, false, true];
      for (let p = el.parentElement; p && p !== box && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.position === "absolute" || ps.position === "fixed") free = false;
        if (ps.overflowX !== "visible") cx = true;
        if (ps.overflowY !== "visible") cy = true;
      }
      // the box itself may scroll (a drawer scrolls down): what's past its edge on that axis is scrolled, not out;
      // a box that only clips (overflow hidden) still cuts what sticks out of it
      if (box) {
        const bs = getComputedStyle(box);
        const scrolls = (o: string) => o === "auto" || o === "scroll";
        if (scrolls(bs.overflowX)) cx = true;
        if (scrolls(bs.overflowY)) cy = true;
      }
      if (!free || (cx && cy)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const c = inner(box);
      const x = cx ? 0 : Math.max(r.right - c.right, c.left - r.left);
      const y = box && !cy ? Math.max(r.bottom - c.bottom, c.top - r.top) : 0;
      const over = Math.round(Math.max(x, y));
      if (over > 1) {
        spilled.add(el);
        const what = !box ? "screen" : box.matches(".hud-pane") ? "pane" : box.matches("[role=dialog]") ? "drawer" : "card";
        add({
          check: "contain",
          severity: "hard",
          detail: `${over}px outside its ${what}`,
          where: `${name(el)} in ${box ? name(box) : "the screen"}`,
        });
      }
    }

    // 8c. text squeezed into a strip: wrapped to a few words a line while its box has room for many
    const lineBoxes = (el: Element): DOMRect[] => {
      const out: DOMRect[] = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        out.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
      }
      return out;
    };
    const texts: { el: Element; rects: DOMRect[]; layer: Element | null }[] = [];
    for (const el of els) {
      const text = ownText(el);
      const clip = text ? visibleRect(el) : null;
      const rects = clip ? lineBoxes(el) : [];
      if (!clip || rects.length === 0) continue;
      const shown = rects.flatMap((r) => {
        const [l, t] = [Math.max(r.left, clip.left), Math.max(r.top, clip.top)];
        const [ri, b] = [Math.min(r.right, clip.right), Math.min(r.bottom, clip.bottom)];
        return ri - l > 0 && b - t > 0 ? [new DOMRect(l, t, ri - l, b - t)] : [];
      });
      texts.push({ el, rects: shown, layer: layer(el) });
      const s = getComputedStyle(el);
      if (s.display === "inline" || !canvas) continue;
      const block = el.getBoundingClientRect();
      const n = new Set(rects.map((r) => Math.round(r.top / 4))).size;
      const words = text.split(/\s+/).length;
      canvas.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const ch = canvas.measureText("abcdefghijklmnopqrstuvwxyz").width / 26;
      const room = inner(boxOf(el)).width;
      const narrow = block.width < Math.max(120, 14 * ch);
      if (n >= 3 && ((narrow && room >= 2.5 * block.width) || (n >= 4 && words / n <= 2 && room >= 2 * block.width)))
        add({
          check: "squeeze",
          severity: "hard",
          detail: `${n} lines in ${Math.round(block.width)}px (~${Math.round(words / n)} words a line) while its box is ${Math.round(room)}px`,
          where: name(el),
        });
    }
    // 8d. text drawn over other text: a badge on the next column's heading, a label under a button's
    const meet = (x: DOMRect, y: DOMRect) =>
      Math.min(x.right, y.right) - Math.max(x.left, y.left) >= 3 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) >= 3;
    for (let i = 0; i < texts.length; i++) {
      const a = texts[i];
      for (let j = i + 1; a && j < texts.length; j++) {
        const b = texts[j];
        if (b && a.layer === b.layer && a.rects.some((x) => b.rects.some((y) => meet(x, y))))
          add({ check: "overlap", severity: "hard", detail: "text over text", where: `${name(a.el)} ⟷ ${name(b.el)}` });
      }
    }
    // 8e. a button whose words don't fit it: cut off or spilling out (an ellipsis is a deliberate cut)
    for (const { el } of controls) {
      if (!(el instanceof HTMLElement) || el.matches("input, textarea, select")) continue;
      const overhang = overhangOf(el);
      const cut = [el, ...el.querySelectorAll("*")].some((x) => {
        const xs = getComputedStyle(x);
        return xs.textOverflow === "ellipsis" || xs.webkitLineClamp !== "none";
      });
      if (!cut && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 + overhang)
        add({
          check: "clipped",
          severity: "hard",
          detail: `button's words don't fit: ${el.scrollWidth}px in ${el.clientWidth}px`,
          where: name(el),
        });
    }
    // 8f. targets: 24×24 at least (WCAG 2.5.8) unless no other control is within 24px; a control that asks for the
    // touch hit area (hit-area) must be positioned, or its ::before doesn't grow round it
    const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;
    for (const { el, r } of controls) {
      const es = getComputedStyle(el);
      const inline =
        (es.display === "inline" && el.tagName === "A") ||
        (es.display.startsWith("inline") && el.parentElement !== null && ownText(el.parentElement).length > 0);
      // only a target shown whole: one cut by a scroller's edge is measured once it's scrolled to
      const full = el.getBoundingClientRect();
      if (inline || el.matches("input[type=checkbox], input[type=radio]") || r.width !== full.width || r.height !== full.height) continue;
      const hit = getComputedStyle(el, "::before");
      const extended = hit.content !== "none" && hit.position === "absolute" && es.position !== "static";
      const w = extended ? Math.max(r.width, Number.parseFloat(hit.width) || 0) : r.width;
      const h = extended ? Math.max(r.height, Number.parseFloat(hit.height) || 0) : r.height;
      const [x, y] = centre(r);
      const crowded = controls.some((o) => {
        if (o.el === el || o.el.contains(el) || el.contains(o.el)) return false;
        const [ox, oy] = centre(o.r);
        return Math.hypot(ox - x, oy - y) < 24;
      });
      if ((w < 24 || h < 24) && crowded)
        add({
          check: "target",
          severity: "hard",
          detail: `${Math.round(w)}×${Math.round(h)}px, another control within 24px`,
          where: name(el),
        });
      if (opts.touch && typeof el.className === "string" && /(^|\s)hit-area(\s|$)/.test(el.className) && es.position === "static")
        add({
          check: "target",
          severity: "hard",
          detail: "hit-area on an unpositioned control: its touch area doesn't grow",
          where: name(el),
        });
    }
  }

  // 7. ultra-wide: how the width is used
  if (opts.wide) {
    const panes = [...document.querySelectorAll(".hud-pane, main > *, body > section, body > header, body > footer, .inner")]
      .filter((el) => !hidden(el))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 40);
    const drawers = [...document.querySelectorAll("[role=dialog]")].map((el) => Math.round(el.getBoundingClientRect().width));
    const panesOnly = [...document.querySelectorAll(".hud-pane")]
      .filter((el) => !hidden(el))
      .map((el) => Math.round(el.getBoundingClientRect().width));
    // with a drawer open the page behind it is hidden, so the drawer is the content
    const content = [
      ...document.querySelectorAll("[role=dialog], .hud-pane, main p, main h1, main h2, section p, section h1, section h2, footer p"),
    ]
      .filter((el) => !hidden(el))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0);
    const left = content.length ? Math.min(...content.map((r) => r.left)) : 0;
    const right = content.length ? Math.max(...content.map((r) => r.right)) : vw;
    metrics.paneWidths = panesOnly;
    metrics.drawerWidths = drawers;
    metrics.marginLeft = Math.round(Math.max(0, left));
    metrics.marginRight = Math.round(Math.max(0, vw - right));
    metrics.contentWidth = Math.round(right - left);
    metrics.blocks = panes.length;
    if (right - left < vw * 0.55)
      add({
        check: "wide",
        severity: "soft",
        detail: `content stranded: ${Math.round(right - left)}px of ${vw}px used, margins ${Math.round(left)}px / ${Math.round(vw - right)}px`,
        where: "page",
      });
    for (const w of panesOnly)
      if (w > 1280) add({ check: "wide", severity: "soft", detail: `pane stretched to ${w}px`, where: ".hud-pane" });
    for (const w of drawers)
      if (w > 1280) add({ check: "wide", severity: "soft", detail: `drawer stretched to ${w}px`, where: "[role=dialog]" });
  }

  // 9. contrast (WCAG 2.2 AA, 1.4.3): every piece of text against the solid colours behind it, 4.5:1, or 3:1 when it's
  // large (24px, or 18.66px bold). Text over an image or a gradient, and disabled controls, are left out.
  if (opts.contrast) {
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba | null => {
      const rgb = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
      const srgb = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
      return null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => {
      const a = top[3] + under[3] * (1 - top[3]);
      const mix = (i: 0 | 1 | 2) => (a ? (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a : 0);
      return [mix(0), mix(1), mix(2), a];
    };
    const lum = ([r, g, b]: Rgba) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    /** The solid colour behind an element: its own and its ancestors' backgrounds stacked, or null over an image. */
    const behind = (el: Element): Rgba | null => {
      const layers: Rgba[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== "none") return null;
        const c = parse(s.backgroundColor);
        if (c === null) return null;
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      // the canvas under it all: the page's own scheme
      let acc: Rgba = matchMedia("(prefers-color-scheme: dark)").matches ? [0, 0, 0, 1] : [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    for (const el of document.body.querySelectorAll("*")) {
      if (!ownText(el) || hidden(el) || !visibleRect(el)) continue;
      if (el.closest("[aria-disabled=true],:disabled,svg")) continue;
      const s = getComputedStyle(el);
      const fg = parse(s.color);
      const bg = behind(el);
      if (!fg || !bg) continue;
      const shown = over(fg, bg);
      const [a, b] = [lum(shown), lum(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = Number.parseFloat(s.fontSize);
      const need = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio < need)
        add({
          check: "contrast",
          severity: "hard",
          detail: `${ratio.toFixed(2)}:1, needs ${need}:1 (${s.color} on its background)`,
          where: name(el),
        });
    }
  }
  return { findings, metrics };
}

/** Hard and soft finding counts per viewport, in viewport order. */
export function summarize(frames: Frame[]): Record<string, { hard: number; soft: number; frames: number }> {
  const out: Record<string, { hard: number; soft: number; frames: number }> = {};
  for (const f of frames) {
    const row = out[f.viewport] ?? { hard: 0, soft: 0, frames: 0 };
    row.frames++;
    for (const x of f.findings) {
      if (x.severity === "hard") row.hard++;
      else if (x.severity === "soft") row.soft++;
    }
    out[f.viewport] = row;
  }
  return out;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The contact sheet: one row per screen, one column per viewport, filtered by theme; a cell opens its frame and findings. */
export function contactSheet(frames: Frame[]): string {
  const vps = [...new Set(frames.map((f) => f.viewport))].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const screens = [...new Set(frames.map((f) => f.screen))].sort((a, b) => rank(a) - rank(b));
  const themes = [...new Set(frames.map((f) => f.theme))].filter((t) => t !== "site");
  const cell = (f: Frame) => {
    const hard = f.findings.filter((x) => x.severity === "hard").length;
    const soft = f.findings.filter((x) => x.severity === "soft").length;
    const list = f.findings.map((x) => `<li class="${x.severity}">[${x.check}] ${esc(x.detail)} <i>${esc(x.where)}</i></li>`).join("");
    return [
      `<figure data-theme="${f.theme}">`,
      f.file ? `<a href="${esc(f.file)}" target="_blank"><img loading="lazy" src="${esc(f.file)}" alt=""></a>` : "",
      `<figcaption>${hard ? `<b class="hard">${hard} hard</b> ` : ""}${soft ? `<b class="soft">${soft} soft</b>` : "ok"}`,
      f.findings.length ? `<details><summary>findings</summary><ul>${list}</ul></details>` : "",
      "</figcaption></figure>",
    ].join("");
  };
  const rows = screens
    .map((s) => {
      const cells = vps
        .map(
          (v) =>
            `<td>${frames
              .filter((f) => f.screen === s && f.viewport === v)
              .map(cell)
              .join("")}</td>`,
        )
        .join("");
      return `<tr><th>${esc(s)}</th>${cells}</tr>`;
    })
    .join("\n");
  const totals = summarize(frames);
  const head = vps.map((v) => `<th>${v}<br><small>${totals[v]?.hard ?? 0} hard · ${totals[v]?.soft ?? 0} soft</small></th>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Responsive sweep</title><style>
:root{color-scheme:dark;--bg:#070b16;--fg:#edf1fa;--mute:#8e9ab4;--line:#1d2742;--bad:#ff7a85;--warn:#f5b14c}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.wrap{overflow:auto}table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:6px;vertical-align:top}
thead th{position:sticky;top:0;background:var(--bg)}tbody th{position:sticky;left:0;background:var(--bg);text-align:left;white-space:nowrap}
figure{margin:0 0 8px;width:180px}img{width:180px;max-height:320px;object-fit:cover;object-position:top;display:block;border:1px solid var(--line)}
figcaption{color:var(--mute);font-size:12px}.hard{color:var(--bad)}.soft{color:var(--warn)}li{margin:2px 0;word-break:break-word}i{color:var(--mute)}
ul{padding-left:16px;max-height:240px;overflow:auto}</style></head><body>
<header><b>Responsive sweep</b><label>Theme <select id="t"><option value="">all</option>${themes.map((t) => `<option>${t}</option>`).join("")}</select></label>
<span>${frames.length} frames · ${frames.reduce((n, f) => n + f.findings.filter((x) => x.severity === "hard").length, 0)} hard · ${frames.reduce((n, f) => n + f.findings.filter((x) => x.severity === "soft").length, 0)} soft · report.json has every finding</span></header>
<div class="wrap"><table><thead><tr><th>screen</th>${head}</tr></thead><tbody>
${rows}
</tbody></table></div>
<script>document.getElementById("t").addEventListener("change",(e)=>{for(const f of document.querySelectorAll("figure"))f.hidden=!!e.target.value&&f.dataset.theme!=="site"&&f.dataset.theme!==e.target.value});</script>
</body></html>`;
}

/** A dashboard screen on the stress night (apps/web/src/demo/stress.ts) is named `<screen>+stress`. */
export const STRESS = "+stress";
/** The data the dashboard is swept with: the sample night, and the stress night (in the first look). */
export const DATA = ["demo", "stress"] as const;

/** Where a screen sorts: its place in SCREENS, stress beside it; the catalog's pages (`design:…`) after the rest. */
const rank = (screen: string): number => {
  const base = screen.replace(STRESS, "");
  const i = SCREENS.indexOf(base.startsWith("design:") ? "design" : base);
  return (i < 0 ? SCREENS.length : i) + (base === screen ? 0 : 0.5);
};

/** Serves the landing page at /, the built dashboard at /demo/ and the catalog at /docs/design/, as the site deploy lays them out. */
export function serve(): ReturnType<typeof Bun.serve> {
  const site = join(ROOT, "site", "public");
  const dist = join(ROOT, "apps", "web", "dist");
  const design = join(ROOT, "apps", "design", "dist");
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const [base, rest] =
        path.startsWith("/demo/") || path === "/demo"
          ? [dist, path.slice(5)]
          : path.startsWith("/docs/design/")
            ? [design, path.slice(12)]
            : [site, path];
      const file = normalize(join(base, rest.endsWith("/") || rest === "" ? `${rest}/index.html` : rest));
      if (!file.startsWith(base)) return new Response("no", { status: 403 });
      const f = Bun.file(file);
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    },
  });
}

/** What the setup wizard's scan finds: a plausible machine, so the wizard shows its full form. */
const SETUP_FACTS = {
  needed: true,
  owner: "Sam",
  codeRoot: "/Users/sam/Overhand/projects",
  scanned: false,
  projectsDir: "/Users/sam/Overhand/projects",
  folder: true,
  tools: { claude: true, git: true, gh: true },
  github: "sam",
  claude: true,
  claudeExisting: true,
  projects: ["acme", "globex", "initech", "umbrella"].map((p) => ({
    name: p[0]?.toUpperCase() + p.slice(1),
    dir: p,
    prefix: p.slice(0, 4).toUpperCase(),
    trackerRepo: `${p}/${p}`,
    trackerRepos: [`${p}/${p}`, `${p}/web`],
    repos: [`${p}/${p}`, `${p}/web`],
  })),
  elsewhere: ["/Users/sam/Projects/side-project"],
  agents: [
    { id: "claude-code", label: "Claude Code", installed: true, signedIn: true, connect: "", docs: "" },
    { id: "codex", label: "Codex", installed: true, signedIn: true, connect: "codex login", docs: "" },
  ],
  ollama: [],
  agent: "claude-code",
  backend: { kind: "claude" },
};

/** Answers the dashboard's API for a page that isn't in demo mode: Setup's first run, or a device that isn't paired. */
async function fakeApi(page: Page, mode: "setup" | "setup-organise" | "pair"): Promise<void> {
  // setup-organise: Start saves (the four projects), then the dashboard opens on the organise step
  let saved = false;
  await page.route("**/api/**", (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (mode === "pair") return route.fulfill({ status: 401, body: "pair first" });
    if (url.includes("/api/setup") && route.request().method() === "POST") {
      saved = true;
      return json({ ok: true });
    }
    if (url.includes("/api/state")) return json({ ...nightAt(510), setup: !saved });
    if (url.includes("/api/setup")) return json(SETUP_FACTS);
    const got = demoGet(new URL(url).pathname + new URL(url).search);
    return got === undefined ? route.fulfill({ status: 404, body: "none" }) : json(got);
  });
}

const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);
const post = (page: Page, msg: Record<string, string>) => page.evaluate((m) => window.postMessage(m, "*"), msg);

/** Opens the command bar and runs its first match for `keyword`. */
async function command(page: Page, keyword: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.waitForSelector("[cmdk-input]", { timeout: 3000 });
  await page.keyboard.type(keyword);
  await settle(page, 200);
  await page.keyboard.press("Enter");
  // the command bar is itself a dialog: wait for it to go, so the frame is the drawer it opened
  await page.waitForSelector("[cmdk-input]", { state: "detached", timeout: 3000 });
}

/** Back to the bridge with nothing open. */
async function reset(page: Page): Promise<void> {
  for (let i = 0; i < 2 && (await page.$("[role=dialog]")); i++) {
    await page.keyboard.press("Escape");
    await settle(page, 250);
  }
  await post(page, { type: "overhand:tab", id: "now" });
  await settle(page, 250);
}

/** Puts the page in front of one dashboard screen; throws when it can't. */
async function open(page: Page, screen: string): Promise<void> {
  if (["work", "crew", "health"].includes(screen)) await post(page, { type: "overhand:tab", id: screen });
  else if (screen === "crew-project" || screen === "lead-preview") {
    // one project's own view: its leads, the ready-made ones its work suggests, and its worktrees
    await post(page, { type: "overhand:tab", id: "crew" });
    await page.click("button[aria-pressed]:has-text('Online shop')", { timeout: 3000 });
    // the first click on a suggestion: what that lead would do, before it exists
    // the project view's own list, not the bridge's behind the drawer; a DOM click, as the drawer's balanced columns
    // keep settling, which Playwright reads as an unstable target
    if (screen === "lead-preview")
      await page.evaluate(() => {
        const views = document.querySelectorAll("section[aria-label='Worth a lead']");
        const b = views[views.length - 1]?.querySelector("button[aria-expanded]");
        if (b instanceof HTMLElement) b.click();
      });
  } else if (screen.startsWith("settings-")) await post(page, { type: "overhand:settings", tab: screen.slice(9) });
  else if (screen === "menu") await page.click("header button:has(svg.lucide-ellipsis)", { timeout: 3000 });
  else if (screen === "quick") await page.click("header button:has(svg.lucide-sliders-horizontal)", { timeout: 3000 });
  else if (screen === "command" || screen === "command-typo") {
    await page.keyboard.press("Control+k");
    await page.waitForSelector("[cmdk-input]", { timeout: 3000 });
    if (screen === "command-typo") await page.keyboard.type("thehe");
  } else if (screen === "lead") await command(page, "lead ");
  else if (screen === "brief") await command(page, "brief");
  else if (screen === "sweep") await command(page, "sweep");
  else if (screen === "needs-all") await command(page, "alerts");
  else if (screen === "review") await command(page, "review ");
  else if (screen === "instructions") await command(page, "instructions");
  else if (screen === "guide") await command(page, "guide shop");
  else if (screen === "share") await command(page, "share");
  if (["menu", "quick", "needs-all", "review", "instructions", "guide", "lead", "brief", "sweep", "share"].includes(screen))
    await page.waitForSelector("[role=dialog]", { timeout: 3000 });
  await settle(page);
}

/** Scrolls the landing page to one of its four stops. */
async function scrollLanding(page: Page, screen: string): Promise<void> {
  await page.evaluate((s) => {
    const what = document.getElementById("what");
    const install = document.getElementById("install");
    const top =
      s === "landing-mid" && what
        ? what.getBoundingClientRect().top + scrollY + what.offsetHeight / 2
        : s === "landing-install" && install
          ? install.getBoundingClientRect().top + scrollY - 40
          : s === "landing-footer"
            ? document.documentElement.scrollHeight
            : 0;
    scrollTo({ top, behavior: "instant" });
  }, screen);
  await settle(page, 900);
}

interface Options {
  out: string;
  viewports: [number, number][];
  themes: (typeof THEMES)[number][];
  screens: string[];
  workers: number;
  build: boolean;
  data: (typeof DATA)[number][];
  /** --viewports given: every screen at every one of them, instead of the site at SITE_VIEWPORTS and the dashboard at VIEWPORTS. */
  exact: boolean;
}

const has = (list: [number, number][], [w, h]: [number, number]) => list.some(([x, y]) => x === w && y === h);
/** Whether this run shoots the site, and the dashboard, at `vp`. */
const sweeps = (o: Options, vp: [number, number]) => ({ site: o.exact || has(SITE_VIEWPORTS, vp), dash: o.exact || has(VIEWPORTS, vp) });

function options(argv: string[]): Options {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (k: string) => arg(k)?.split(",").filter(Boolean);
  const vps = list("--viewports");
  const themes = list("--themes");
  const screens = list("--screens");
  const data: readonly string[] = list("--data") ?? DATA;
  return {
    out: resolve(arg("--out") ?? join(ROOT, "release", "out", "shots")),
    // any size: the listed ones, or one of its own (2200x1240)
    viewports: vps
      ? vps.map((v) => {
          const [w = 0, h = 0] = v.split("x").map(Number);
          return [w, h];
        })
      : screens?.length === 1 && screens[0] === "design"
        ? DESIGN_VIEWPORTS
        : [...VIEWPORTS, ...SITE_VIEWPORTS.filter((v) => !has(VIEWPORTS, v))],
    themes: themes
      ? THEMES.filter((t) => themes.includes(t.id))
      : screens?.length === 1 && screens[0] === "design"
        ? THEMES.filter((t) => t.theme === "overhand")
        : [...THEMES],
    screens: screens ? SCREENS.filter((s) => screens.includes(s)) : SCREENS,
    workers: Number(arg("--workers") ?? 4),
    build: !argv.includes("--no-build"),
    data: DATA.filter((d) => data.includes(d)),
    exact: Boolean(vps),
  };
}

/** Captures one frame: the checks first (on the real viewport), then the screenshot. */
async function capture(
  page: Page,
  o: Options,
  frame: Omit<Frame, "file" | "findings">,
  width: number,
  geometry = false,
  contrast = false,
): Promise<Frame> {
  const file = `${frame.screen.replace(/[^\w-]+/g, "_")}__${frame.viewport}__${frame.theme}.jpg`;
  const { findings, metrics } = await page.evaluate(audit, {
    touch: isTouch(width),
    wide: width >= 2560,
    type: true,
    contrast,
    faces: SYSTEM.font.name,
    gap: SYSTEM.space.gap,
    geometry,
  });
  // a scrolling phone page is shot whole; drawers, dialogs and the fixed desktop layout as the viewport shows them
  const whole = width < 1024 && !frame.screen.startsWith("landing") && !(await page.$("[role=dialog]"));
  await page.screenshot({ path: join(o.out, file), type: "jpeg", quality: 60, fullPage: whole, timeout: 30_000 });
  // a full-page shot drops Chromium's touch emulation ((pointer: coarse) turns false) for the rest of the page's life;
  // put it back for the next screen (the session stays attached: detaching undoes it)
  if (whole && isTouch(width))
    await (await page.context().newCDPSession(page)).send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  return { ...frame, file, findings, ...(width >= 2560 ? { metrics } : {}) };
}

/** A state the catalog couldn't render says so on the page (apps/design/src/stage.tsx): a hard finding. */
async function unrendered(page: Page): Promise<Finding[]> {
  const said = await page.evaluate(() =>
    [...document.querySelectorAll("p")]
      .map((p) => p.textContent ?? "")
      .filter((t) => t.startsWith("This state didn't render") || t.startsWith("No state called")),
  );
  return said.map((detail) => ({ check: "render", severity: "hard", detail, where: page.url() }));
}

/**
 * The design catalog in one look: Foundations, then every entry's page (the catalog's own chrome and its inline
 * states), then each state shown in a frame, opened on its own. The entries are read from the catalog's sidebar.
 */
async function sweepDesign(ctx: BrowserContext, o: Options, width: number, viewport: string, theme: string): Promise<Frame[]> {
  const look = theme === "overhand-light" ? "light" : theme === "overhand-dark" ? "dark" : "";
  // the catalog is swept at its own three widths, whatever else the run covers
  if (!look || !DESIGN_VIEWPORTS.some(([w, h]) => `${w}x${h}` === viewport)) return [];
  const frames: Frame[] = [];
  const page = await ctx.newPage();
  // opened on its own a frame keeps its choices in localStorage (in the catalog's iframes, in memory): Team picked on
  // Now in one state mustn't carry into the next
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("team.view");
    } catch {}
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (screen: string, url: string, ms: number) => {
    try {
      errors.length = 0;
      // a fresh document each time: the catalog's addresses differ only after the #, and a frame needs its own page
      await page.goto("about:blank");
      await page.goto(url, { waitUntil: "load" });
      await settle(page, ms);
      const f = await capture(page, o, { screen: `design:${screen}`, viewport, theme }, width);
      const broke = errors.map((detail): Finding => ({ check: "render", severity: "hard", detail, where: url }));
      frames.push({ ...f, findings: [...f.findings, ...(await unrendered(page)), ...broke] });
    } catch (e) {
      frames.push({
        screen: `design:${screen}`,
        viewport,
        theme,
        file: "",
        findings: [
          {
            check: "capture",
            severity: "hard",
            detail: `couldn't open: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
            where: url,
          },
        ],
      });
    }
  };
  const base = "/docs/design/?demo";
  await shot("foundations", `${base}#/foundations?look=${look}`, 900);
  const entries = await page.$$eval('nav[aria-label="Catalog"] a', (as) =>
    as.map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("#/") && !h.startsWith("#/foundations")),
  );
  for (const href of entries) {
    const path = href.slice(2).split("?")[0] ?? "";
    await shot(path, `${base}${href.includes("?") ? href : `${href}?look=${look}`}`, 1200);
    const srcs = await page.$$eval("iframe.stage-frame", (fs) => fs.map((f) => f.getAttribute("src") ?? ""));
    for (const src of srcs) {
      const state = new URLSearchParams(src.split("?").at(-1)).get("state") ?? "";
      await shot(`${path}?state=${state}`, `/docs/design/${src.replace(/^\.\//, "")}`, 1500);
    }
  }
  await page.close();
  return frames;
}

/** One viewport × theme: the dashboard screens in demo mode, then Setup and Pair, then (once per viewport) the landing page. */
async function sweep(ctx: BrowserContext, o: Options, [width, height]: [number, number], theme: string): Promise<Frame[]> {
  const viewport = `${width}x${height}`;
  const frames: Frame[] = [];
  const failed = (screen: string, e: unknown): Frame => ({
    screen,
    viewport,
    theme,
    file: "",
    findings: [
      {
        check: "capture",
        severity: "soft",
        detail: `couldn't open: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        where: screen,
      },
    ],
  });
  const at = sweeps(o, [width, height]);
  if (o.screens.includes("design")) frames.push(...(await sweepDesign(ctx, o, width, viewport, theme)));
  const dash = at.dash ? o.screens.filter((s) => !SITE.includes(s) && !["setup", "setup-organise", "pair", "design"].includes(s)) : [];
  // the stress night in the first look only: themes change art, not layout
  for (const data of dash.length ? o.data.filter((d) => d === "demo" || theme === o.themes[0]?.id) : []) {
    const page = await ctx.newPage();
    await page.goto(data === "stress" ? "/demo/?demo=stress" : "/demo/?demo", { waitUntil: "load" });
    await page.waitForSelector(".hud-pane", { timeout: 20_000 });
    await settle(page, 1200);
    for (const s of dash) {
      const screen = data === "stress" ? `${s}${STRESS}` : s;
      try {
        await reset(page);
        await open(page, s);
        frames.push(await capture(page, o, { screen, viewport, theme }, width, true));
      } catch (e) {
        frames.push(failed(screen, e));
      }
    }
    await page.close();
  }
  for (const screen of o.screens.filter((s) => at.dash && (s === "setup" || s === "setup-organise" || s === "pair"))) {
    const page = await ctx.newPage();
    try {
      await fakeApi(page, screen === "pair" ? "pair" : screen === "setup" ? "setup" : "setup-organise");
      await page.goto("/demo/", { waitUntil: "load" });
      await page.waitForSelector(screen === "pair" ? "input" : "main section", { timeout: 15_000 });
      await settle(page, 1500);
      if (screen === "setup-organise") {
        // the scan finishes, Start saves, and the dashboard opens on "Here's how we'd organise your work"
        await page.click("main button:has-text('Start Overhand'):not([disabled])", { timeout: 20_000 });
        await page.waitForSelector("#organise-title", { timeout: 20_000 });
        await settle(page, 1200);
      }
      frames.push(await capture(page, o, { screen, viewport, theme }, width, true));
    } catch (e) {
      frames.push(failed(screen, e));
    }
    await page.close();
  }
  // the site follows the computer's light or dark: every site frame in both, with the contrast check
  for (const scheme of at.site && theme === o.themes[0]?.id ? SITE_SCHEMES : []) {
    const look = scheme === "light" ? "site" : `site-${scheme}`;
    const landing = o.screens.filter((s) => LANDING.includes(s));
    if (landing.length) {
      const page = await ctx.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/", { waitUntil: "load" });
      await settle(page, 2000);
      for (const screen of landing) {
        try {
          await scrollLanding(page, screen);
          frames.push(await capture(page, o, { screen, viewport, theme: look }, width, false, true));
        } catch (e) {
          frames.push(failed(screen, e));
        }
      }
      await page.close();
    }
    // the site's other pages, each opened on its own
    for (const screen of o.screens.filter((s) => s.startsWith("site-"))) {
      const page = await ctx.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      try {
        await page.goto(`/${screen.slice(5)}.html`, { waitUntil: "load" });
        await settle(page, 1500);
        frames.push(await capture(page, o, { screen, viewport, theme: look }, width, false, true));
      } catch (e) {
        frames.push(failed(screen, e));
      }
      await page.close();
    }
  }
  return frames;
}

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  for (const app of o.build ? ["web", ...(o.screens.includes("design") ? ["design"] : [])] : [])
    if (Bun.spawnSync(["bun", "run", "--filter", app, "build"], { cwd: ROOT, stdout: "ignore", stderr: "inherit" }).exitCode !== 0)
      throw new Error(`the ${app} build failed`);
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const { chromium } = await import("playwright-core");
  const server = serve();
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const frames: Frame[] = [];
  try {
    // a width only the site is swept at needs one look: the site draws its own
    const jobs = o.viewports.flatMap((vp) => o.themes.filter((_, i) => i === 0 || sweeps(o, vp).dash).map((t) => ({ vp, t })));
    const total = jobs.length;
    const worker = async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const [width, height] = job.vp;
        const ctx = await browser.newContext({
          baseURL: `http://127.0.0.1:${server.port}`,
          viewport: { width, height },
          deviceScaleFactor: 1,
          isMobile: isTouch(width),
          hasTouch: isTouch(width),
          reducedMotion: "reduce",
        });
        // test browsers never talk: speechSynthesis uses the OS voice even headless, so a replayed brief speaks aloud
        await ctx.addInitScript(() => {
          try {
            Object.defineProperty(window, "speechSynthesis", {
              value: {
                speak() {},
                cancel() {},
                getVoices: () => [],
                pause() {},
                resume() {},
                speaking: false,
                pending: false,
                paused: false,
                onvoiceschanged: null,
                addEventListener() {},
                removeEventListener() {},
              },
            });
          } catch {}
        });

        const { theme, appearance } = job.t;
        await ctx.addInitScript(
          (look: { t: string; a: string }) => {
            try {
              localStorage.setItem("overhand-theme", look.t);
              localStorage.setItem("overhand-appearance", look.a);
              sessionStorage.setItem("overhand-booted", "1");
            } catch {}
          },
          { t: theme, a: appearance },
        );
        try {
          frames.push(...(await sweep(ctx, o, job.vp, job.t.id)));
        } finally {
          await ctx.close();
        }
        console.log(`  ${total - jobs.length}/${total} ${width}x${height} ${job.t.id}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, o.workers) }, worker));
  } finally {
    await browser.close();
    server.stop(true);
  }
  frames.sort((a, b) => rank(a.screen) - rank(b.screen) || a.viewport.localeCompare(b.viewport));
  writeFileSync(join(o.out, "report.json"), JSON.stringify({ at: new Date().toISOString(), summary: summarize(frames), frames }, null, 1));
  writeFileSync(join(o.out, "index.html"), contactSheet(frames));
  const hard = frames.flatMap((f) =>
    f.findings.filter((x) => x.severity === "hard").map((x) => `${f.screen} ${f.viewport} ${f.theme}: [${x.check}] ${x.detail} ${x.where}`),
  );
  const soft = frames.reduce((n, f) => n + f.findings.filter((x) => x.severity === "soft").length, 0);
  console.log(`\n${frames.length} frames, ${hard.length} hard, ${soft} soft: ${join(o.out, "index.html")}`);
  for (const h of hard.slice(0, 40)) console.log(`  ✗ ${h}`);
  if (hard.length > 40) console.log(`  … and ${hard.length - 40} more in report.json`);
  if (hard.length) process.exit(1);
}

if (import.meta.main) await main();
