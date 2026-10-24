/**
 * The menu bar item's popover on a Mac (core menubar.ts holds it in apps/menubar's helper): who's at work, what needs
 * you, quiet mode and the way into the full dashboard, from the dashboard's own parts and words. It tells the helper,
 * through `window.webkit.messageHandlers.overhand`, the count beside the mark, its own height, that it needs signing in,
 * and anything that opens the full dashboard (a drawer, the Night report), which the daemon opens in your browser.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { type Model, useLiveState, useModel, useStateQuery } from "./app/data";
import { ThemeProvider, useTheme, useWords } from "./app/theme";
import { UiProvider, useUi } from "./app/ui";
import { Logo } from "./components/Logo";
import { anyBroken, NeedsList, needs } from "./components/now/Alerts";
import { Prologue } from "./components/now/Story";
import { QuietRow } from "./components/QuickSettings";
import { Button } from "./components/ui/button";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { Unpaired } from "./lib/api";
import { fmt } from "./lib/format";
import "./index.css";

/** What the page tells the helper. */
type ToHelper =
  | { type: "count"; n: number; broken: boolean }
  | { type: "height"; h: number }
  | { type: "signin" }
  | { type: "open"; query: string }
  | { type: "hide" };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { overhand?: { postMessage: (m: ToHelper) => void } } };
  }
}

const tell = (m: ToHelper): void => {
  window.webkit?.messageHandlers?.overhand?.postMessage(m);
};
/** Opens the full dashboard in the browser at `query` (the daemon keeps only `drawer` and `run`). */
const openFull = (query = "?") => tell({ type: "open", query });

/** How many of Needs you the popover shows. */
const GLANCE_NEEDS = 2;

/** A drawer a click opened here opens in the full dashboard instead: the popover has no room for one. */
function useDrawersOpenFull(): void {
  const ui = useUi();
  useEffect(() => {
    if (!ui.drawer) return;
    openFull(`?drawer=${encodeURIComponent(JSON.stringify(ui.drawer))}`);
    ui.closeDrawer();
  }, [ui.drawer, ui.closeDrawer]);
}

function Body({ m }: { m: Model }) {
  const w = useWords();
  // the look picked in the dashboard: this popover's web view keeps no choice of its own
  const { showTheme } = useTheme();
  useEffect(() => showTheme(m.s.look), [showTheme, m.s.look]);
  const list = needs(m);
  const broken = anyBroken(list);
  useEffect(() => {
    tell({ type: "count", n: list.length, broken });
  }, [list.length, broken]);
  return (
    <div className="grid gap-3">
      <Prologue m={m} greeting={false} />
      {/* the top two, so quiet mode and the buttons fit without scrolling; the rest are one click away */}
      {list.length ? <NeedsList list={list.slice(0, GLANCE_NEEDS)} /> : null}
      {list.length > GLANCE_NEEDS ? (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          onClick={() => openFull(`?drawer=${encodeURIComponent('{"kind":"alerts"}')}`)}
        >
          {fmt(w.glanceMore, { n: list.length - GLANCE_NEEDS })}
        </Button>
      ) : null}
      <QuietRow m={m} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => openFull()}>
          {w.glanceOpen}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openFull("?run=brief")}>
          {w.briefMe}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => tell({ type: "hide" })}>
          {w.glanceHide}
        </Button>
      </div>
    </div>
  );
}

function Glance() {
  const m = useModel();
  const { error } = useStateQuery();
  const ref = useRef<HTMLDivElement>(null);
  useLiveState();
  useDrawersOpenFull();
  useEffect(() => {
    if (error instanceof Unpaired) tell({ type: "signin" });
  }, [error]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => tell({ type: "height", h: Math.ceil(el.getBoundingClientRect().height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="grid gap-3 p-4">
      <Logo size={16} />
      {m ? <Body m={m} /> : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("glance.html has no #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <UiProvider>
            <Glance />
            <Toaster />
          </UiProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
