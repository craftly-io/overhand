import { useSyncExternalStore } from "react";
import { DEMO } from "@/demo/demo";
import type { Beat } from "@/lib/beats";
import { store } from "./store";

/**
 * Focus: outcomes only. What needs you, what finished and what broke stay; the steps on the way there (what agents
 * are saying, subagents, model and uptime, the day's minute-by-minute beats, the day's timeline) fold behind "Show
 * steps", never gone. Kept in this browser, like the map's motion and sound.
 */
const KEY = "overhand-focus";
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/**
 * Whether Focus is on: what this browser chose, else the default. A browser that never chose gets Focus on a new
 * install's first day (`dayOne`) and in the demo; an install already in use keeps what it showed before Focus existed.
 */
export function focusOn(saved: string | null, dayOne: boolean, demo = DEMO): boolean {
  return saved === null ? demo || dayOne : saved === "1";
}

/** Pins the default the first time state arrives, so a new install keeps Focus on after its first day. */
export function settleFocus(dayOne: boolean): void {
  if (store.get(KEY) === null) store.set(KEY, focusOn(null, dayOne) ? "1" : "0");
}

/** Turns Focus on or off, for every component showing it. */
export function setFocus(on: boolean): void {
  store.set(KEY, on ? "1" : "0");
  changed();
}

/** The key that turns Focus on or off when you aren't typing (beside W, A and H, which open the views). */
export const FOCUS_KEY = "F";

/** Turns Focus the other way: the F key and the command bar. */
export const toggleFocus = (): void => setFocus(!focusOn(store.get(KEY), false));

/** Whether Focus is on, shared by Quick settings, the F key and everything it folds. */
export function useFocus(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => focusOn(store.get(KEY), false),
  );
}

/**
 * The beats Focus keeps: results (good news), anything broken or warning, and a restart loop (something stuck). Wake-ups,
 * quiet finishes and checks are steps.
 */
export function outcomeBeats(story: readonly Beat[]): Beat[] {
  return story.filter((b) => b.tone === "ok" || b.tone === "bad" || b.tone === "warn" || b.count > 1);
}
