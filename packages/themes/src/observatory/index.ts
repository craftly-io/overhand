import { defineTheme, fromInk } from "../define";
import { SYSTEM } from "../system";
import { plainWords } from "../words";

/** Night sky: deep navy ink, starlight text. */
const night = [
  "#04070d", // 1 app background
  "#070c15", // 2 subtle background
  "#0a111c", // 3 card
  "#0e1724", // 4 hover, popover
  "#131e2e", // 5 selected
  "#182538", // 6 subtle border
  "#213149", // 7 border
  "#2e4260", // 8 strong border
  "#4a5f7e", // 9 solid, muted
  "#8fa0b6", // 10 muted text
  "#bcc8d8", // 11 low-contrast text
  "#e6eef8", // 12 high-contrast text
] as const;

/** The same sky by day: a star chart on cool paper, navy ink. */
const day = [
  "#f3f5f9", // 1 app background
  "#edf0f5", // 2 subtle background
  "#fbfcfe", // 3 card
  "#e7ebf2", // 4 hover, popover
  "#e0e6ee", // 5 selected
  "#d8dfe9", // 6 subtle border
  "#c6d0dd", // 7 border
  "#a8b5c6", // 8 strong border
  "#7b889e", // 9 solid, muted
  "#515e75", // 10 muted text
  "#313d56", // 11 low-contrast text
  "#0e182b", // 12 high-contrast text
] as const;

/**
 * Observatory: a night sky through a dome. Agents are satellites holding their orbits; one that needs you becomes a
 * comet falling toward you, in comet gold, the world's one colour. By day the sky is a star chart on paper.
 */
export default defineTheme({
  id: "observatory",
  name: "Observatory",
  tagline: "A night sky that watches with you",
  ink: night,
  lightInk: day,
  tokens: fromInk(night, { you: "#ffc76b", youFill: "#ffc76b", youInk: "#04070d", ok: "#6fe0b8", bad: "#ff5c7a", destructive: "#b0263f" }),
  light: fromInk(day, { you: "#80520a", youFill: "#f5b84f", youInk: "#0e182b", ok: "#1d6a4c", bad: "#ad2440", destructive: "#ad2440" }),
  fonts: {
    display: SYSTEM.font.body,
    greeting: '"Cormorant Garamond", ui-serif, Georgia, serif',
    body: SYSTEM.font.body,
    mono: SYSTEM.font.mono,
    href: "fonts/observatory.css",
  },
  // projects are named, not coloured: colour is state and you
  hues: [night[11], night[10], night[11], night[10], night[11], night[10]],
  lightHues: [day[11], day[10], day[11], day[10], day[11], day[10]],
  words: plainWords,
  voice: { prefer: ["Daniel", "Arthur", "Google UK English Male", "Microsoft Ryan", "Microsoft George"], rate: 1, pitch: 1 },
  world: "observatory",
});
