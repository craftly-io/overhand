import type { PluginState } from "@overhand/contract";
import type { WordKey, Words } from "@overhand/themes";
import { ago, fmt } from "./format";

/** Each plugin kind's word. */
export const PLUGIN_KIND: Record<PluginState["kind"], WordKey> = {
  check: "plKindCheck",
  tracker: "plKindTracker",
  notifier: "plKindNotifier",
};

/** Where a plugin stands, in one line: waiting, on (and its last run), paused, changed or unreadable. */
export function pluginLine(p: PluginState, w: Words, now = Date.now()): string {
  if (p.state === "waiting") return w.plWaiting;
  if (p.state === "changed") return w.plChanged;
  if (p.state === "broken") return fmt(w.plBroken, { why: p.why });
  const run = !p.last
    ? w.plNever
    : p.last.ok
      ? fmt(w.plRanOk, { ago: ago(p.last.at, now) })
      : fmt(w.plRanFailed, { ago: ago(p.last.at, now), why: p.last.why });
  return `${p.state === "paused" ? w.plPaused : fmt(w.plOn, { n: p.everyMin })} · ${run}`;
}

/** A finding's dot colour: bad red, warn amber, info quiet. */
export const severityColor = (s: PluginState["findings"][number]["severity"]): string =>
  s === "bad" ? "var(--bad)" : s === "warn" ? "var(--warn)" : "var(--ok)";
