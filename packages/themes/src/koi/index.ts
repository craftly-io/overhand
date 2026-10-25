import { defineTheme, fromInk } from "../define";
import { SYSTEM } from "../system";
import { plainWords } from "../words";

/** Pond at dusk: deep teal ink, pale water light. */
const dusk = [
  "#071a1c", // 1 app background
  "#0a2022", // 2 subtle background
  "#0c2326", // 3 card
  "#10292c", // 4 hover, popover
  "#143034", // 5 selected
  "#18373b", // 6 subtle border
  "#22454a", // 7 border
  "#2f575c", // 8 strong border
  "#4e7470", // 9 solid, muted
  "#8fa8a4", // 10 muted text
  "#bcd0cb", // 11 low-contrast text
  "#e8f2ee", // 12 high-contrast text
] as const;

/** The same pond by day: pale jade paper, deep teal ink. */
const day = [
  "#f1f6f4", // 1 app background
  "#eaf1ee", // 2 subtle background
  "#fafcfb", // 3 card
  "#e4ece8", // 4 hover, popover
  "#dce6e1", // 5 selected
  "#d3dfd9", // 6 subtle border
  "#c0d0c9", // 7 border
  "#a3b7af", // 8 strong border
  "#768f87", // 9 solid, muted
  "#4d6660", // 10 muted text
  "#2d433e", // 11 low-contrast text
  "#0c1f1c", // 12 high-contrast text
] as const;

/**
 * Koi Pond: a pond at dusk. Agents are koi; working ones swim, idle ones rest under the lily pads, and one that needs
 * you rises to the lantern by your stone, in lantern gold, the world's one colour. By day the water is clear and green.
 */
export default defineTheme({
  id: "koi",
  name: "Koi Pond",
  tagline: "A pond at dusk, lit by one lantern",
  ink: dusk,
  lightInk: day,
  light: fromInk(day, { you: "#7d5408", youFill: "#f2b544", youInk: "#0c1f1c", ok: "#1f6a45", bad: "#a8332a", destructive: "#a8332a" }),
  tokens: fromInk(dusk, { you: "#f2b544", youFill: "#f2b544", youInk: "#071a1c", ok: "#8fd3a8", bad: "#f08a78", destructive: "#a8332a" }),
  fonts: {
    display: SYSTEM.font.body,
    greeting: '"Zen Old Mincho", ui-serif, Georgia, serif',
    body: SYSTEM.font.body,
    mono: SYSTEM.font.mono,
    href: "fonts/koi.css",
  },
  // projects are named, not coloured: colour is state and you
  hues: [dusk[11], dusk[10], dusk[11], dusk[10], dusk[11], dusk[10]],
  lightHues: [day[11], day[10], day[11], day[10], day[11], day[10]],
  words: plainWords,
  voice: { prefer: ["Daniel", "Arthur", "Google UK English Male", "Microsoft Ryan", "Microsoft George"], rate: 1, pitch: 1 },
  world: "koi",
});
