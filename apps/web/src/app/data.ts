import type { DashboardState } from "@overhand/contract";
import { DashboardStateSchema } from "@overhand/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DEMO, demoClock, demoState, followParent, type Play } from "@/demo/demo";
import { type Alert, computeAlerts } from "@/lib/alerts";
import { fetchState, openEvents, STREAM_CLOSED } from "@/lib/api";
import { armedCount, type InboxItem, type Plan, parseInbox, parsePlan } from "@/lib/plan";
import { settleFocus } from "./focus";
import { useTheme } from "./theme";
import { settleTips } from "./tips";

/** Everything the views show, derived once per poll. */
export interface Model {
  s: DashboardState;
  plan: Plan;
  alerts: Alert[];
  inbox: InboxItem[];
  armed: number;
  /** A client's colour: the nth client in config gets the theme's nth hue. */
  hue: (client: string) => string;
}

export const STATE_KEY = ["state"] as const;
/** Longer than this without a pushed state, the live stream counts as stalled (the daemon pushes every 25 s at most). */
const STREAM_SILENT_MS = 40_000;

// whether the live stream is delivering; while it is, nothing polls
let live = false;
const liveListeners = new Set<() => void>();
const setLive = (on: boolean) => {
  live = on;
  for (const f of liveListeners) f();
};
const liveStore = {
  subscribe: (f: () => void) => {
    liveListeners.add(f);
    return () => liveListeners.delete(f);
  },
  get: () => live,
};

/**
 * Keeps the state live over Server-Sent Events (`/api/events`), validated against the contract like a fetch. When the
 * stream isn't there (an older daemon) or drops for good, `useStateQuery` falls back to polling. In the demo it runs
 * the sample night instead, playing `play` (the arrival, unless a piece of the site names its own moment) on its cue.
 */
export function useLiveState(play?: Play): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (DEMO) return followParent(qc, STATE_KEY, play);
    const es = openEvents("/api/events");
    let heard = Date.now();
    es.onmessage = (e) => {
      heard = Date.now();
      const parsed = DashboardStateSchema.safeParse(JSON.parse(e.data));
      if (!parsed.success) return; // the poll reports the contract error, naming the field
      qc.setQueryData(STATE_KEY, parsed.data);
      if (!live) setLive(true);
    };
    es.onerror = () => {
      if (es.readyState === STREAM_CLOSED || live) setLive(false); // reconnecting or gone: poll meanwhile
    };
    // the daemon sends the state at least every 25 s; a stream silent for longer is a frozen Overhand, so the poll (and
    // its timeout) takes over and says so, and the next message hands back to the stream
    const quiet = setInterval(() => {
      if (live && Date.now() - heard > STREAM_SILENT_MS) setLive(false);
    }, 5000);
    return () => {
      clearInterval(quiet);
      es.close();
      setLive(false);
    };
  }, [qc, play]);
}

/** `/api/state`, validated against the contract: pushed live when the stream is up, else polled every 8 s while visible. */
export function useStateQuery() {
  const streaming = useSyncExternalStore(liveStore.subscribe, liveStore.get);
  return useQuery({
    queryKey: STATE_KEY,
    queryFn: DEMO ? demoState : fetchState,
    refetchInterval: streaming || DEMO ? false : 8000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !DEMO,
    retry: false,
  });
}

/** The derived dashboard model, or undefined until the first good payload arrives. */
export function useModel(): Model | undefined {
  const { data } = useStateQuery();
  const { theme, words } = useTheme();
  return useMemo(() => {
    if (!data) return undefined;
    // the first state tells a new install from one in use, which sets where Focus starts
    settleFocus(data.dayOne);
    settleTips(data.dayOne);
    const plan = parsePlan(data.plan);
    const now = Date.now();
    const index = new Map(data.clients.map((c, i) => [c.name, i]));
    const hues = theme.hues;
    const hue = (client: string) => {
      const i = index.get(client);
      return i === undefined ? "var(--primary)" : (hues[i % hues.length] ?? "var(--primary)");
    };
    return {
      s: data,
      plan,
      alerts: computeAlerts(data, plan, words, now),
      inbox: parseInbox(plan.inbox, data.pending, now),
      armed: armedCount(plan, data),
      hue,
    };
  }, [data, theme, words]);
}

/** The current time, refreshed every `ms` milliseconds. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  const demoNow = useSyncExternalStore(demoClock.subscribe, demoClock.get);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return DEMO ? demoNow : now;
}
