import { defineTheme, fromInk } from "../define";
import { SYSTEM } from "../system";
import { plainWords } from "../words";

/** Map paper: warm off-white, printer's ink. */
const paper = [
  "#f7f6f1", // 1 app background
  "#efeee8", // 2 subtle background
  "#fdfcf8", // 3 card
  "#e9e8e1", // 4 hover, popover
  "#e1e0d8", // 5 selected
  "#d9d8cf", // 6 subtle border
  "#c7c5bb", // 7 border
  "#aba99f", // 8 strong border
  "#83817a", // 9 solid, muted
  "#5c5a55", // 10 muted text
  "#393834", // 11 low-contrast text
  "#141414", // 12 high-contrast text
] as const;

/** The night edition: warm charcoal, chalk ink. */
const night = [
  "#141412", // 1 app background
  "#181816", // 2 subtle background
  "#1c1c1a", // 3 card
  "#22221f", // 4 hover, popover
  "#282825", // 5 selected
  "#2e2e2b", // 6 subtle border
  "#3a3a36", // 7 border
  "#4e4d48", // 8 strong border
  "#75736c", // 9 solid, muted
  "#a5a39b", // 10 muted text
  "#d0cec6", // 11 low-contrast text
  "#f4f3ee", // 12 high-contrast text
] as const;

/**
 * Transit: a living metro map. Each project is a line out from you, the interchange at the centre; agents are
 * trains, and one that needs you waits at your platform, in platform orange, the world's one colour. After dark, the night edition.
 */
export default defineTheme({
  id: "transit",
  name: "Transit",
  tagline: "A living metro map on paper",
  ink: night,
  lightInk: paper,
  tokens: fromInk(night, { you: "#ff8a3d", youFill: "#f26b1d", youInk: "#141414", ok: "#62c486", bad: "#ff6b66", destructive: "#b8232b" }),
  light: fromInk(paper, { you: "#a3400a", youFill: "#f26b1d", youInk: "#141414", ok: "#25693f", bad: "#b8232b", destructive: "#b8232b" }),
  fonts: {
    display: SYSTEM.font.body,
    greeting: '"Overpass", ui-sans-serif, system-ui, sans-serif',
    body: SYSTEM.font.body,
    mono: SYSTEM.font.mono,
    href: "fonts/transit.css",
  },
  // projects are named, not coloured: colour is state and you
  hues: [night[11], night[10], night[11], night[10], night[11], night[10]],
  lightHues: [paper[11], paper[10], paper[11], paper[10], paper[11], paper[10]],
  words: plainWords,
  voice: { prefer: ["Daniel", "Arthur", "Google UK English Male", "Microsoft Ryan", "Microsoft George"], rate: 1, pitch: 1 },
  world: "transit",
});
