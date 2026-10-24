import type { WordKey } from "@overhand/themes";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DEMO } from "@/demo/demo";
import { dockWidth } from "@/lib/layout";

/** The spans a social card can show. */
export type CardSpan = "night" | "today" | "week";
/** The span a card opens on: the night in the morning, the day after noon. */
export const cardSpanNow = (now = new Date(Date.now())): CardSpan => (now.getHours() < 12 ? "night" : "today");

import { useWords } from "./theme";

/** The full views, each a drawer off the bridge on a computer and a tab of its own on a phone. */
export const VIEWS = ["work", "crew", "health"] as const;
export type View = (typeof VIEWS)[number];
/** Each view's name and the key that opens it when you aren't typing. */
export const VIEW_META: Record<View, { word: WordKey; key: string }> = {
  work: { word: "viewWork", key: "W" },
  crew: { word: "viewCrew", key: "C" },
  health: { word: "viewHealth", key: "H" },
};

/** The five places, one job each: Now is the bridge, then Work, Crew, Health and Settings. */
export const PLACES = ["now", "work", "crew", "health", "settings"] as const;
export type Place = (typeof PLACES)[number];
export const PLACE_WORD: Record<Place, WordKey> = {
  now: "viewNow",
  work: "viewWork",
  crew: "viewCrew",
  health: "viewHealth",
  settings: "settings",
};
const isPlace = (v: string): v is Place => PLACES.some((x) => x === v);

const phoneQuery = "(max-width: 1023px)";
/** True on phone and tablet widths, where places are tabs and drawers rise from the bottom. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = matchMedia(phoneQuery);
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    () => matchMedia(phoneQuery).matches,
  );
}

/** Where a phone is: a place, and the Settings tab or the project (Settings, Crew) it opened on. */
export type PhonePlace = { kind: Place; tab?: string; project?: string };

/** Which drawer is open, and what it shows. */
export type Drawer =
  | { kind: "ticket"; key: string }
  | { kind: "lead"; key: string }
  | { kind: "review"; key: string; preview?: boolean }
  | { kind: "brief"; text: string }
  | { kind: "share"; span: CardSpan }
  | { kind: "shutdown"; busy: boolean; startAgain: string }
  | { kind: "settings"; tab?: string; project?: string }
  | { kind: "instructions"; project?: string }
  | { kind: "guide"; project: string }
  | { kind: "alerts" | "notes" | "overdrive" | "sweep" | "menu" | "feedback" | "news" }
  | { kind: View; project?: string };

export interface ConfirmRequest {
  title: string;
  /** The consequence, in plain words in every theme. */
  body: string;
  go: string;
  /** Danger (red, the default) for stopping or removing; primary for an interruption that loses nothing, like a restart. */
  tone?: "danger" | "primary";
}

/** The drawers a link may open (`?drawer=`): the ones a click on the menu bar's popover opens, each by its key or tab. */
const LinkedDrawer = z.union([
  z.object({ kind: z.enum(["ticket", "lead", "review"]), key: z.string().min(1) }),
  z.object({ kind: z.literal("settings"), tab: z.string().optional() }),
  z.object({ kind: z.enum(["alerts", "crew", "work", "health"]) }),
]);

/** A drawer from a link's `?drawer=` (its JSON), or null when it names none a link may open. */
export function drawerParam(v: string | null): Drawer | null {
  try {
    return LinkedDrawer.safeParse(JSON.parse(v ?? "")).data ?? null;
  } catch {
    return null;
  }
}

interface UiContext {
  drawer: Drawer | null;
  /** Opens a drawer; on a phone a place (Work, Crew, Health, Settings) becomes the open tab instead. */
  openDrawer: (d: Drawer) => void;
  /** The place you're in: the open place drawer on a computer, the tab on a phone. */
  place: Place;
  /** On a phone, the open tab and what it opened on. */
  phonePlace: PhonePlace;
  goPlace: (p: Place) => void;
  closeDrawer: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** What the command bar starts with when it opens: empty, or a request to say again ("Mobile app: …"). */
  paletteSeed: string;
  /** Opens the command bar with `seed` typed in. */
  openPalette: (seed?: string) => void;
  /** Asks before something that interrupts work; resolves true when the person agrees. */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
}

const Ctx = createContext<UiContext | null>(null);

/** Drawer, command bar and confirmation state for the whole dashboard. */
export function UiProvider({ children }: { children: ReactNode }) {
  const w = useWords();
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const phone = usePhone();
  const [phonePlace, setPhonePlace] = useState<PhonePlace>({ kind: "now" });
  const openDrawer = useCallback(
    (d: Drawer) => {
      if (phone && isPlace(d.kind)) {
        setPhonePlace({
          kind: d.kind,
          ...("tab" in d && d.tab ? { tab: d.tab } : {}),
          ...("project" in d && d.project ? { project: d.project } : {}),
        });
        setDrawer(null);
        scrollTo({ top: 0 });
      } else setDrawer(d);
    },
    [phone],
  );
  const goPlace = useCallback(
    (p: Place) => {
      if (phone) {
        setPhonePlace({ kind: p });
        setDrawer(null);
        scrollTo({ top: 0 });
      } else setDrawer(p === "now" ? null : { kind: p });
    },
    [phone],
  );
  const place: Place = phone ? phonePlace.kind : drawer && isPlace(drawer.kind) ? drawer.kind : "now";
  const [paletteOpen, setOpen] = useState(false);
  const [paletteSeed, setSeed] = useState("");
  const setPaletteOpen = useCallback((open: boolean) => {
    if (!open) setSeed("");
    setOpen(open);
  }, []);
  const openPalette = useCallback((seed = "") => {
    setSeed(seed);
    setOpen(true);
  }, []);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => {});

  const confirm = useCallback((req: ConfirmRequest) => {
    setAsk(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const answer = (ok: boolean) => {
    resolver.current(ok);
    setAsk(null);
  };
  // the hosted page's "Open Overhand on this computer" lands on ?settings=phone, where Set it up links this computer;
  // the menu bar item opens what was clicked on its popover as ?drawer=… (glance.tsx)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const asked: Drawer | null = q.get("settings") === "phone" ? { kind: "settings", tab: "phone" } : drawerParam(q.get("drawer"));
    if (!asked) return;
    openDrawer(asked);
    q.delete("settings");
    q.delete("drawer");
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
  }, [openDrawer]);
  // the landing page's tour opens the views (it still calls them tabs; "now" is the bridge with nothing open), a lead and settings
  useEffect(() => {
    if (!DEMO) return;
    const onMessage = (e: MessageEvent<unknown>) => {
      if (e.source !== window.parent || typeof e.data !== "object" || e.data === null || !("type" in e.data)) return;
      const d = e.data;
      if (d.type === "overhand:tab" && "id" in d && typeof d.id === "string") {
        const id = d.id;
        if (id === "now" || isPlace(id)) goPlace(id);
        // the landing page's tour still names the old Inbox: it's Needs you in full now
        else if (id === "inbox") openDrawer({ kind: "alerts" });
      } else if (d.type === "overhand:lead" && "key" in d && typeof d.key === "string") setDrawer({ kind: "lead", key: d.key });
      else if (d.type === "overhand:settings" && "tab" in d && typeof d.tab === "string") openDrawer({ kind: "settings", tab: d.tab });
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [goPlace, openDrawer]);

  const value = useMemo(
    () => ({
      drawer,
      openDrawer,
      place,
      phonePlace,
      goPlace,
      closeDrawer: () => setDrawer(null),
      paletteOpen,
      setPaletteOpen,
      paletteSeed,
      openPalette,
      confirm,
    }),
    [drawer, openDrawer, place, phonePlace, goPlace, paletteOpen, setPaletteOpen, paletteSeed, openPalette, confirm],
  );
  return (
    <Ctx value={value}>
      {children}
      <AlertDialog open={ask !== null} onOpenChange={(open) => !open && answer(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => answer(false)}>{w.cancel}</AlertDialogCancel>
            <AlertDialogAction variant={ask?.tone === "primary" ? "primary" : "danger"} onClick={() => answer(true)}>
              {ask?.go}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx>
  );
}

/** Dashboard UI state: drawers (the full views among them), the command bar and confirmations. */
export function useUi(): UiContext {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useUi needs a UiProvider");
  return ctx;
}

const onResize = (l: () => void) => {
  addEventListener("resize", l);
  return () => removeEventListener("resize", l);
};

/** The viewport's width in CSS px, following resizes. */
export function useViewport(): number {
  return useSyncExternalStore(onResize, () => innerWidth);
}

/** The width of the place docked beside the bridge (Work, Crew, Health or Settings from `3xl`), or 0 when none is. */
export function useDock(): number {
  const { drawer } = useUi();
  const vw = useViewport();
  const k = drawer?.kind;
  return k === "work" || k === "crew" || k === "health" || k === "settings" ? dockWidth(k, vw) : 0;
}
