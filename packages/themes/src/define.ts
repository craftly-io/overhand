import type { Words } from "./words";

/** CSS variables the dashboard's Tailwind classes read. Colours used as text must reach AA on `background`. */
export const TOKEN_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  /** Text and dots for good / attention / bad states. */
  "ok",
  "warn",
  "bad",
  /**
   * The one colour that isn't a state: what waits on you (and the brand mark). `you` reads as text on the page,
   * `you-fill` is its fill (counts, the answer button), `you-ink` is text on that fill.
   */
  "you",
  "you-fill",
  "you-ink",
  /** Panes and surfaces. */
  "radius",
  /** Buttons, inputs and other controls. */
  "radius-control",
  /** A CSS background-image painted behind the page, or "none". */
  "backdrop",
] as const;

export type TokenKey = (typeof TOKEN_KEYS)[number];
export type Tokens = { readonly [K in TokenKey]: string };

/**
 * Two voices in every world: Atkinson Hyperlegible Next for every word and heading (weight makes the hierarchy, display sizes track tighter)
 * and Atkinson Hyperlegible Mono for data only (numbers, times, counts, ticket keys, the clock). A world may set one face of its own,
 * for the one big greeting on Now and nothing else.
 */
export interface ThemeFonts {
  /** Headings. */
  display: string;
  /** Every other word: controls, lists, settings, the brief and the story. */
  body: string;
  /** Data: numbers, times, counts, ticket keys, the clock. */
  mono: string;
  /** The world's own face, for the greeting on Now only. Falls back to `display`. */
  greeting?: string;
  /**
   * The stylesheet that loads the families above, if they aren't system fonts: bundled in apps/web/public/fonts (the
   * dashboard works offline), relative to the page.
   */
  href?: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  tagline: string;
  /** Dashboard colours and shape. */
  tokens: Tokens;
  /** The same theme by day: every look follows the computer's light or dark (or the Appearance setting). */
  light: Tokens;
  fonts: ThemeFonts;
  /** Client colours, in config order; must read as text on `background`. */
  hues: readonly string[];
  /** Client colours for `light`, in the same order; must read as text on its `background`. */
  lightHues?: readonly string[];
  /**
   * A 12-step ink scale, set as `--ink-1` … `--ink-12` (app background → subtle background → card → hover → selected →
   * subtle border → border → strong border → solid → muted text → low text → high text). Only the house theme has one;
   * see docs/design-system.md.
   */
  ink?: readonly string[];
  /** The ink scale for `light`. */
  lightInk?: readonly string[];
  /** Every dashboard label: the plain words, with at most the flavour lines (`FLAVOUR_KEYS`) reworded. */
  words: Words;
  /**
   * Spoken briefings, in the browser's own voice: the first of `prefer` (voice names, matched by substring across
   * macOS, Chrome and Windows) the device has, else any British English voice, at `rate` and `pitch`.
   */
  voice: { prefer: readonly string[]; rate: number; pitch: number };
  /**
   * The world the attention map is drawn in (apps/web/src/map/worlds): its ground, your centre, its characters. Every
   * theme has one, and Now shows its map.
   */
  world: "instrument" | "observatory" | "transit" | "koi" | "catnap";
}

/** A theme's state colours and its one colour, for `fromInk`. */
export interface InkState {
  /** What waits on you, as text on the page. */
  you: string;
  /** Its fill: counts, the answer button. */
  youFill: string;
  /** Text on `youFill`. */
  youInk: string;
  /** Done. */
  ok: string;
  /** Broken. */
  bad: string;
  /** A fill behind white text, for stopping or removing. */
  destructive: string;
}

/**
 * The dashboard's tokens from a 12-step ink scale (app background → high-contrast text) and the state colours: ink
 * first, so primary is ink 12 on ink 1, focus is ink, and the only colour that isn't a state is `you`. Panes have no
 * radius; every action button and input takes the one control radius, 6px. See docs/design-system.md.
 */
export function fromInk(ink: readonly string[], state: InkState): Tokens {
  const step = (n: number) => ink[n - 1] ?? "";
  return {
    background: step(1),
    foreground: step(12),
    card: step(3),
    "card-foreground": step(12),
    popover: step(4),
    "popover-foreground": step(12),
    primary: step(12),
    "primary-foreground": step(1),
    secondary: step(5),
    "secondary-foreground": step(12),
    muted: step(4),
    "muted-foreground": step(10),
    accent: step(5),
    "accent-foreground": step(12),
    destructive: state.destructive,
    border: step(7),
    input: step(8),
    ring: step(12),
    ok: state.ok,
    warn: state.you,
    bad: state.bad,
    you: state.you,
    "you-fill": state.youFill,
    "you-ink": state.youInk,
    radius: "0px",
    "radius-control": "6px",
    backdrop: "none",
  };
}

/**
 * Declares a theme. It only checks the shape: every token and every word must be present, so a theme that misses
 * one fails to type-check. The World view (a later phase) extends the same definition.
 */
export function defineTheme(theme: ThemeDefinition): ThemeDefinition {
  return theme;
}
