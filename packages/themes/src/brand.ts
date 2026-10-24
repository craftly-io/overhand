/**
 * Overhand's mark, Hand over: the work, an outline square in ink, and you, the signal-orange square lifted over it, up
 * and right by just under half a square. Everything here is drawn from the one source (system.ts): the dashboard's
 * Logo and loader, the share card and the site read `markParts`; build-brand.ts writes the files (favicons, app
 * icons, the brand kit) from `markSvg`, `iconSvg` and `lockupSvg`. Spec: docs/specs/2026-10-22-brand-design.md.
 */
import { SYSTEM } from "./system";

/**
 * The master: drawn on a 16-unit grid, the work and you are each 11 units, you lifted 5 (5/11 ≈ 0.45, just under half).
 * At 16px that's one unit per pixel, so the favicon is the master itself.
 */
const LIFT = 5 / 11;
/**
 * The outline's weight for its size: 2px at 28px (spec). Drawn in whole pixels it rounds down (2px up to 47px, 3px at
 * 48, 4px at 64), so mid sizes don't go heavy, and never below 2px, so at 16px it thickens to one eighth of the mark.
 */
const WEIGHT = 1 / 14;
/** Up to this size the mark is drawn in whole pixels (favicons, the header, the loader); above it, it scales freely. */
const SNAP = 64;

/** The mark's measures at `size` px: each square's side, how far you're lifted, and the outline's stroke. */
export interface MarkParts {
  size: number;
  side: number;
  lift: number;
  stroke: number;
}

/** The mark's measures at `size` px (its bounding square), pixel-snapped up to 64px so every edge is crisp. */
export function markParts(size: number): MarkParts {
  if (size > SNAP) {
    const side = size / (1 + LIFT);
    return { size, side, lift: size - side, stroke: size * WEIGHT };
  }
  const side = Math.round(size / (1 + LIFT));
  return { size, side, lift: size - side, stroke: Math.max(2, Math.floor(size * WEIGHT)) };
}

/** What the mark sits on: paper, dark, or either (a favicon that follows the browser's light or dark). */
export type MarkOn = "light" | "dark" | "auto";

/** The outline's ink on each ground: ink 12 on paper, the night's ink 12 on dark. The square is always you-fill. */
export const MARK_INK = { light: SYSTEM.ink.day[11], dark: SYSTEM.ink.night[11] } as const;
/** The grounds an icon tile sits on: day paper and night ink 1. */
export const MARK_GROUND = { light: SYSTEM.ink.day[0], dark: SYSTEM.ink.night[0] } as const;
const YOU = SYSTEM.state.day.youFill;

/** Up to 3 decimals, no trailing zeros: the SVG stays readable and byte-stable. */
const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * One shape of a brand drawing, back to front: a rectangle filled with `fill` (its corners rounded by `r`), or, with
 * `stroke`, an outline that wide drawn inside the rectangle, so it keeps the rectangle's outer size.
 */
export interface Shape {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  r?: number;
  stroke?: number;
}

/** What a brand file is drawn from: its size and its shapes. The SVGs write it out; build-brand.ts rasterises it. */
export interface Drawing {
  w: number;
  h: number;
  shapes: Shape[];
}

/** The two squares at `x`,`y` (top left of the mark's box); `ink` is the outline's colour. */
function squares(p: MarkParts, x: number, y: number, ink: string): Shape[] {
  return [
    // the work: an outline, inside the square, so both squares share the same outer size
    { x, y: y + p.lift, w: p.side, h: p.side, fill: ink, stroke: p.stroke },
    // you, lifted over it
    { x: x + p.lift, y, w: p.side, h: p.side, fill: YOU },
  ];
}

function rect(s: Shape): string {
  if (s.stroke) {
    const h = s.stroke / 2;
    return `<rect class="work" x="${n(s.x + h)}" y="${n(s.y + h)}" width="${n(s.w - s.stroke)}" height="${n(s.h - s.stroke)}" fill="none" stroke="${s.fill}" stroke-width="${n(s.stroke)}"/>`;
  }
  const r = s.r ? ` rx="${n(s.r)}"` : "";
  return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${r} fill="${s.fill}"/>`;
}

/** A drawing as SVG; `head` goes before the shapes (a style), `tail` after them (the wordmark). */
const svg = (d: Drawing, head = "", tail = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(d.w)}" height="${n(d.h)}" viewBox="0 0 ${n(d.w)} ${n(d.h)}">${head}${d.shapes.map(rect).join("")}${tail}</svg>\n`;

/** The mark alone at `size` px on a light or dark ground, with no ground of its own. */
export function markDrawing({ size, on }: { size: number; on: "light" | "dark" }): Drawing {
  return { w: size, h: size, shapes: squares(markParts(size), 0, 0, MARK_INK[on]) };
}

/**
 * The menu bar's mark (apps/menubar): one ink, so macOS tints it as a template image to suit the bar, light or dark.
 * 36px is the bar's 18pt at 2x.
 */
export function menubarDrawing(size = 36): Drawing {
  const d = markDrawing({ size, on: "light" });
  return { ...d, shapes: d.shapes.map((s) => ({ ...s, fill: "#000000" })) };
}

/** The mark alone at `size` px on `on`: no ground, so it sits on whatever is behind it. "auto" follows light/dark. */
export function markSvg({ size, on }: { size: number; on: MarkOn }): string {
  if (on !== "auto") return svg(markDrawing({ size, on }));
  return svg(markDrawing({ size, on: "light" }), `<style>@media (prefers-color-scheme: dark){.work{stroke:${MARK_INK.dark}}}</style>`);
}

/** An app icon's options: see `iconDrawing`. */
export interface IconOptions {
  size: number;
  on: "light" | "dark";
  mark?: number;
  radius?: number;
  inset?: number;
}

/**
 * An app icon: the mark centred on a tile of paper (light) or night ink (dark). `mark` is the mark's share of the tile
 * (0.55 keeps it inside a maskable icon's safe circle), `radius` the tile's corner as a share of its side (0 = full
 * bleed, for platforms that round it themselves), `inset` the tile's margin inside the canvas (macOS draws its icons
 * smaller than their canvas).
 */
export function iconDrawing({ size, on, mark = 0.55, radius = 0, inset = 0 }: IconOptions): Drawing {
  const tile = size - inset * 2;
  const m = size > SNAP ? tile * mark : Math.round(tile * mark);
  const at = size > SNAP ? (size - m) / 2 : Math.round((size - m) / 2);
  const ground: Shape = { x: inset, y: inset, w: tile, h: tile, fill: MARK_GROUND[on], r: radius ? tile * radius : undefined };
  return { w: size, h: size, shapes: [ground, ...squares(markParts(m), at, at, MARK_INK[on])] };
}

/** An app icon as SVG (see `iconDrawing`). */
export function iconSvg(o: IconOptions): string {
  return svg(iconDrawing(o));
}

/**
 * The wordmark's measures in Atkinson Hyperlegible Next Bold at -0.02em, in em (measured in Chromium): its cap height
 * and the ink's left and right edges of "Overhand". The work square is one cap height, so it stands on the baseline
 * level with the letters and you rise above them.
 */
export const WORDMARK = { cap: 0.668, left: 0.033, right: 4.317, track: "-0.02em", weight: 700, text: "Overhand" } as const;

/**
 * The lockup: the mark, then "Overhand", with clear space of one lift (the step you rise by) all round; the gap between
 * them is one lift too. `font` embeds the face (a base64 woff2) so the file draws the same anywhere.
 */
export function lockupSvg({ on, size = 48, font }: { on: "light" | "dark"; size?: number; font?: string }): string {
  const p = markParts(size);
  const em = p.side / WORDMARK.cap;
  const clear = p.lift;
  const textX = clear + size + p.lift - WORDMARK.left * em;
  const w = clear + size + p.lift + (WORDMARK.right - WORDMARK.left) * em + clear;
  const h = clear + size + clear;
  const face = font
    ? `<style>@font-face{font-family:"${SYSTEM.font.name.body}";font-weight:700;src:url(data:font/woff2;base64,${font}) format("woff2")}</style>`
    : "";
  const text = `<text x="${n(textX)}" y="${n(clear + size)}" fill="${MARK_INK[on]}" font-family="${SYSTEM.font.name.body}, sans-serif" font-weight="${WORDMARK.weight}" font-size="${n(em)}" letter-spacing="${WORDMARK.track}">${WORDMARK.text}</text>`;
  return svg({ w, h, shapes: squares(p, clear, clear, MARK_INK[on]) }, face, text);
}
