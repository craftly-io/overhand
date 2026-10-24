/**
 * The sample night's named moments, the one source for when they happen: the demo's script (night.ts) and the site's
 * pages (site/build.ts slots `{{at_<name>}}` in minutes after 23:30 and `{{time_<name>}}` as clock text) both read
 * these, so re-timing the night moves every page with it. Dependency-free on purpose: the site build imports it.
 */
export const MOMENTS = {
  /** The first agent starts its ticket (SHOP-142). */
  started: "00:12",
  /** SHOP-142 (Online shop is on Ship) merges by itself once its checks pass, with an Undo. */
  shipped: "00:58",
  /** BOOK-88's red check gets its fix round. */
  fixRound: "02:46",
  /** BOOK-88's checks pass after that fix round. */
  green: "02:55",
  /** The one call that needs you. */
  call: "07:24",
  /** You review BOOK-88's pull request. */
  review: "07:52",
  /** The night report. */
  morning: "08:00",
  /** A plan from a sentence, just after the night report. */
  plan: "08:02",
} as const;

/** Minutes after 23:30 for a clock time in the night ("23:40" is the evening before). */
export function minutesOf(hm: string): number {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  return (((h * 60 + m - (23 * 60 + 30)) % 1440) + 1440) % 1440;
}

/** Where the embedded demo opens: a minute before the call, so the visitor sees the question arrive. */
export const ARRIVE_FROM = minutesOf("07:23");
/** The morning after, where the demo rests: the call is in Needs you and the night report is out. */
export const MORNING = minutesOf(MOMENTS.morning);
