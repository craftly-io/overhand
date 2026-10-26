import { useSyncExternalStore } from "react";
import { store } from "./store";

/** The field on Now: moving (the default), one still frame per change, or off (the plain lists). Kept in this browser. */
export type MapMode = "off" | "on" | "still";
// a key of its own: the map was always shown before, and that old setting only said whether it moved
const KEY = "overhand-map";
const toMode = (v: string | null): MapMode => (v === "off" || v === "still" ? v : "on");
const listeners = new Set<() => void>();

/** The map setting (Settings › You), shared by Now and the setting. */
export function useMapMode(): [MapMode, (mode: MapMode) => void] {
  const mode = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toMode(store.get(KEY)),
  );
  return [
    mode,
    (next) => {
      store.set(KEY, next);
      for (const l of listeners) l();
    },
  ];
}
