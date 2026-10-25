/** Fills `{name}` placeholders in a theme word. */
export function fmt(word: string, vars: Record<string, string | number> = {}): string {
  return word.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** One of a spoken line's ` | `-separated alternatives. */
export function pick(word: string, random: () => number = Math.random): string {
  const options = word.split(" | ");
  return options[Math.floor(random() * options.length)] ?? word;
}

/** A day in the browser's own date format (the same one its date inputs show): 15.10.2026, 10/15/2026. */
export function date(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/** 14:05 */
export function hm(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/** A time ahead: "14:05" within a day, else with its weekday ("Sat 14:05"); "" for none. */
export function until(ms: number, now: number): string {
  if (!ms) return "";
  return ms - now < 86_400_000
    ? hm(ms)
    : new Date(ms).toLocaleDateString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** "12 min ago", "3 h ago", "12 days ago" */
export function ago(ms: number, now: number = Date.now()): string {
  const m = Math.round((now - ms) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

/** "a, b and c": the house's words are English. */
export const and = (xs: string[]): string => new Intl.ListFormat("en", { type: "conjunction" }).format(xs);

/** $3.50; from $1,000 grouped and without cents ($12,346), so a big figure stays short enough to read at a glance. */
export function money(n: number): string {
  return n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

/** "42 min", "2 h 5 min" */
export function uptime(sec: number): string {
  return sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

/** A run's stopwatch: "4:05", then "1:02:09" past an hour. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mmss = `${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return s < 3600 ? mmss.replace(/^0/, "") : `${Math.floor(s / 3600)}:${mmss}`;
}

/** 37% of a 0–1 share; "–" when it's unknown (negative). */
export function pct(f: number): string {
  return f < 0 ? "–" : `${Math.round(f * 100)}%`;
}

/** "2.2×": how many times `a` is of `b`; "far" when `b` is zero. */
export function times(a: number, b: number): string {
  return b > 0 ? `${String(Math.round((a / b) * 10) / 10)}×` : "far";
}

/** Disk size from kilobytes: "1.2 GB", "340 MB". */
export function size(kb: number): string {
  return kb / 1048576 >= 1 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Numbers as a voice would say them: "two", "eleven" stays 11. */
export function spokenNum(n: number): string {
  return NUM[n] ?? String(n);
}

/** Minutes until a time, never below 1. */
export function minutesUntil(ms: number, now: number): number {
  return Math.max(1, Math.round((ms - now) / 60000));
}
