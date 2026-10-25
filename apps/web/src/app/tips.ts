import { FEATURES, FEATURES_FROM, type Feature } from "@overhand/contract";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { useStateQuery } from "./data";
import { store } from "./store";

/**
 * Tips about new features: one quiet line beside the control a new feature lives at (the registry's `tip`,
 * packages/contract/src/features.ts), for a feature newer than what this browser had seen. At most one a day, never
 * on the install's first day or this browser's, never again once shown, and none at all with Settings' switch off.
 * Kept in this browser, like Focus.
 */
const KEY = "overhand-tips";
const OFF = "overhand-tips-off";

const Seen = z.object({
  /** The first day this browser opened Overhand: no tip that day. */
  first: z.string(),
  /** Features from this day or before count as seen. */
  from: z.string(),
  /** Tips shown on an earlier day, never shown again. */
  seen: z.array(z.string()),
  /** The day's tip, once one has shown, and whether it was closed. */
  today: z.object({ id: z.string(), day: z.string(), closed: z.boolean() }).nullable(),
});
/** What this browser has seen of the tips. */
export type TipsSeen = z.infer<typeof Seen>;

/** Today in this browser's time zone, as YYYY-MM-DD (the registry's `since`). */
export const localDay = (now = new Date(Date.now())): string =>
  [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");

/** A browser's first record: on a new install everything so far is seen; otherwise what shipped since the beta isn't. */
export const firstSight = (today: string, dayOne: boolean): TipsSeen => ({
  first: today,
  from: dayOne ? today : FEATURES_FROM,
  seen: [],
  today: null,
});

/** The feature whose tip shows beside `where` now, or null: the day's tip if it's this one, else the oldest unseen. */
export function tipAt(
  where: string,
  rec: TipsSeen | null,
  at: { today: string; dayOne: boolean; off: boolean },
  features: readonly Feature[] = FEATURES,
): Feature | null {
  if (at.off || at.dayOne || !rec || rec.first === at.today) return null;
  if (rec.today?.day === at.today) {
    const t = rec.today;
    const f = features.find((x) => x.id === t.id);
    return !t.closed && f?.tip?.where === where ? f : null;
  }
  const fresh = features.filter((f) => f.tip?.where === where && f.since > rec.from && !rec.seen.includes(f.id));
  return fresh.reduce<Feature | null>((a, f) => (a && a.since <= f.since ? a : f), null);
}

/** The record once `id` has shown today: the day's one tip, never shown again. */
export const shown = (rec: TipsSeen, id: string, today: string): TipsSeen =>
  rec.today?.day === today ? rec : { ...rec, seen: [...rec.seen, id], today: { id, day: today, closed: false } };

/** The record once the day's tip is closed. */
export const closed = (rec: TipsSeen, today: string): TipsSeen =>
  rec.today?.day === today ? { ...rec, today: { ...rec.today, closed: true } } : rec;

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const write = (k: string, v: string) => {
  store.set(k, v);
  for (const l of listeners) l();
};
const read = (raw: string | null): TipsSeen | null => {
  if (raw === null) return null;
  try {
    const r = Seen.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

/** Starts this browser's record the first time state arrives, so its first day shows no tip. */
export function settleTips(dayOne: boolean): void {
  if (read(store.get(KEY)) === null) store.set(KEY, JSON.stringify(firstSight(localDay(), dayOne)));
}

/** Turns tips about new features on or off (Settings → You). */
export const setTipsOn = (on: boolean): void => write(OFF, on ? "0" : "1");

/** Whether tips about new features are on: on unless Settings turned them off. */
export const useTipsOn = (): boolean => useSyncExternalStore(subscribe, () => store.get(OFF) !== "1");

/** The tip beside `where`, if it shows now, and how to close it; showing it makes it the day's one tip. */
export function useTip(where: string): { feature: Feature; close: () => void } | null {
  const { data } = useStateQuery();
  const raw = useSyncExternalStore(subscribe, () => store.get(KEY));
  const on = useTipsOn();
  const today = localDay();
  const rec = read(raw);
  const f = data ? tipAt(where, rec, { today, dayOne: data.dayOne, off: !on }) : null;
  // before paint, so a second new control on the same screen never flashes a second tip
  useLayoutEffect(() => {
    // read again: another tip on screen may have just taken the day
    const now = read(store.get(KEY));
    if (f && now && now.today?.day !== today) write(KEY, JSON.stringify(shown(now, f.id, today)));
  }, [f, today]);
  return f && rec ? { feature: f, close: () => write(KEY, JSON.stringify(closed(rec, today))) } : null;
}
