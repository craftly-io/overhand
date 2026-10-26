import { useSyncExternalStore } from "react";

/**
 * The minute the field shows: `null` is now, live; a time is the day as it was then (Today's ribbon sets it while you
 * drag along it or replay the day). Kept in memory only: a reload is always live.
 */
let at: number | null = null;
const listeners = new Set<() => void>();

/** The field's minute, shared by the field and the ribbon that moves it. */
export function useFieldTime(): [number | null, (next: number | null) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => at,
  );
  return [value, setFieldTime];
}

/** Moves the field to `next` (epoch ms), or back to live with `null`. */
export function setFieldTime(next: number | null) {
  if (next === at) return;
  at = next;
  for (const l of listeners) l();
}
