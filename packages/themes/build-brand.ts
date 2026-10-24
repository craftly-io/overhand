/**
 * Writes the brand's files from src/brand.ts: the brand kit (packages/themes/brand), and the favicons, app icons and
 * web app manifest the dashboard (apps/web/public) and the site (site/public) serve. `bun packages/themes/build-brand.ts`
 * (root script: `bun run brand`). PNGs are rasterised here, in plain TypeScript, from the same drawing the SVGs write
 * out: no browser, so every machine writes the same pixels. test/brand.test.ts compares every file's pixels with what
 * brand.ts draws, and CI runs `bun run brand && git diff --exit-code`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import {
  type Drawing,
  type IconOptions,
  iconDrawing,
  iconSvg,
  lockupSvg,
  MARK_GROUND,
  markSvg,
  menubarDrawing,
  type Shape,
} from "./src/brand";

const ROOT = join(import.meta.dir, "../..");
const FONT = readFileSync(join(ROOT, "site/public/fonts/atkinson-next-latin-700.woff2")).toString("base64");

/** One brand file: text (an SVG, the manifest) written as is, or a PNG of `png`. */
export type BrandFile = { path: string; text: string; png?: undefined } | { path: string; png: Drawing; text?: undefined };

const icon = (path: string, o: IconOptions): BrandFile[] => [{ path, png: iconDrawing(o) }];

/** The icons both the dashboard and the site serve at their root. */
function served(dir: string): BrandFile[] {
  return [
    // the master, one unit per pixel; it follows the browser's light or dark
    { path: `${dir}/favicon.svg`, text: markSvg({ size: 16, on: "auto" }) },
    // for browsers without SVG favicons: on a paper tile, so it reads on a light or a dark tab bar
    ...icon(`${dir}/favicon-32.png`, { size: 32, on: "light", mark: 0.75, radius: 0.1875 }),
    // the phone's home screen rounds it itself; full bleed, the mark inside a maskable icon's safe circle
    ...icon(`${dir}/apple-touch-icon.png`, { size: 180, on: "light" }),
    ...icon(`${dir}/icon-192.png`, { size: 192, on: "light" }),
    ...icon(`${dir}/icon-512.png`, { size: 512, on: "light" }),
  ];
}

/** The web app manifest: how the phone's home screen names and draws Overhand. */
const manifest = `${JSON.stringify(
  {
    name: "Overhand",
    short_name: "Overhand",
    start_url: "./",
    display: "standalone",
    background_color: MARK_GROUND.light,
    theme_color: MARK_GROUND.light,
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  },
  null,
  2,
)}\n`;

const KIT = "packages/themes/brand";
/** Every brand file, in the repo. */
export const BRAND_FILES: BrandFile[] = [
  { path: `${KIT}/mark-light.svg`, text: markSvg({ size: 512, on: "light" }) },
  { path: `${KIT}/mark-dark.svg`, text: markSvg({ size: 512, on: "dark" }) },
  // for 24px and under: the 16px master, whose outline is thicker for its size
  { path: `${KIT}/mark-small-light.svg`, text: markSvg({ size: 16, on: "light" }) },
  { path: `${KIT}/mark-small-dark.svg`, text: markSvg({ size: 16, on: "dark" }) },
  { path: `${KIT}/lockup-light.svg`, text: lockupSvg({ on: "light", font: FONT }) },
  { path: `${KIT}/lockup-dark.svg`, text: lockupSvg({ on: "dark", font: FONT }) },
  // the kit's icons, also as SVG for anyone who needs another size
  { path: `${KIT}/icon-light.svg`, text: iconSvg({ size: 1024, on: "light" }) },
  { path: `${KIT}/icon-dark.svg`, text: iconSvg({ size: 1024, on: "dark" }) },
  ...icon(`${KIT}/icon-light.png`, { size: 1024, on: "light" }),
  ...icon(`${KIT}/icon-dark.png`, { size: 1024, on: "dark" }),
  // macOS draws an icon as a rounded tile inside its canvas (824 of 1024)
  ...icon(`${KIT}/icon-macos-light.png`, { size: 1024, on: "light", inset: 100, radius: 0.2245 }),
  ...icon(`${KIT}/icon-macos-dark.png`, { size: 1024, on: "dark", inset: 100, radius: 0.2245 }),
  ...served("apps/web/public"),
  ...served("site/public"),
  { path: "apps/web/public/manifest.webmanifest", text: manifest },
  // the Mac menu bar item's mark, shipped beside the dashboard (core menubar.ts passes its path)
  { path: "apps/web/public/menubar.png", png: menubarDrawing() },
];

/** How much of pixel row/column [p, p+1] the span [a, b] covers, 0–1. */
const span = (p: number, a: number, b: number): number => Math.max(0, Math.min(p + 1, b) - Math.max(p, a));

/** Samples per side where a rounded corner crosses a pixel. */
const SS = 8;

/** How much of pixel (px, py) a rectangle (rounded by r) covers, 0–1: exact for straight edges, sampled at corners. */
function cover(px: number, py: number, x: number, y: number, w: number, h: number, r = 0): number {
  const exact = span(px, x, x + w) * span(py, y, y + h);
  if (!r || exact === 0) return exact;
  const nearX = px < x + r || px + 1 > x + w - r;
  const nearY = py < y + r || py + 1 > y + h - r;
  if (!nearX || !nearY) return exact;
  let hits = 0;
  for (let i = 0; i < SS; i++)
    for (let j = 0; j < SS; j++) {
      const sx = px + (i + 0.5) / SS;
      const sy = py + (j + 0.5) / SS;
      if (sx < x || sx > x + w || sy < y || sy > y + h) continue;
      const dx = Math.max(x + r - sx, 0, sx - (x + w - r));
      const dy = Math.max(y + r - sy, 0, sy - (y + h - r));
      if (dx * dx + dy * dy <= r * r) hits++;
    }
  return hits / (SS * SS);
}

/** How much of a pixel one shape covers: an outline is its rectangle less the rectangle inside its stroke. */
function coverage(px: number, py: number, s: Shape): number {
  if (!s.stroke) return cover(px, py, s.x, s.y, s.w, s.h, s.r);
  const t = s.stroke;
  return cover(px, py, s.x, s.y, s.w, s.h) - cover(px, py, s.x + t, s.y + t, s.w - 2 * t, s.h - 2 * t);
}

const rgb = (hex: string): [number, number, number] => {
  const v = Number.parseInt(hex.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A drawing as straight RGBA pixels on a transparent ground, each shape laid over the ones before it. */
export function rasterise(d: Drawing): Uint8Array {
  const out = new Uint8Array(d.w * d.h * 4);
  const shapes = d.shapes.map((s) => ({ s, c: rgb(s.fill) }));
  for (let py = 0; py < d.h; py++)
    for (let px = 0; px < d.w; px++) {
      // premultiplied while compositing
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const { s, c } of shapes) {
        const k = coverage(px, py, s);
        if (k <= 0) continue;
        r = c[0] * k + r * (1 - k);
        g = c[1] * k + g * (1 - k);
        b = c[2] * k + b * (1 - k);
        a = k + a * (1 - k);
      }
      const at = (py * d.w + px) * 4;
      if (a > 0) {
        out[at] = Math.round(r / a);
        out[at + 1] = Math.round(g / a);
        out[at + 2] = Math.round(b / a);
      }
      out[at + 3] = Math.round(a * 255);
    }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA pixels as a PNG: 8-bit, no filter, deflated at level 9 (the same bytes for the same pixels on any machine). */
export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const head = new Uint8Array(13);
  const v = new DataView(head.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  head.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) rows.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PNG this file wrote, back to its size and RGBA pixels (for the drift test). */
export function decodePng(png: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  for (let at = 8; at + 8 <= png.length; ) {
    const len = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      w = view.getUint32(at + 8);
      h = view.getUint32(at + 12);
    }
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(rows.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  return { w, h, rgba };
}

if (import.meta.main) {
  for (const f of BRAND_FILES) {
    const path = join(ROOT, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.png ? encodePng(f.png.w, f.png.h, rasterise(f.png)) : f.text);
    console.log(f.path);
  }
}
