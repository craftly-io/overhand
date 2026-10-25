/**
 * One live piece of the dashboard for the public site's pages (site/public/pieces.js frames `piece.html?demo&p=…`):
 * the real component, the app's own providers and the demo's scripted night, so a visitor answers a real card, opens a
 * real Explain or presses Go ahead on a real plan, and nothing talks to a daemon. Each piece opens just before its moment
 * (demo.ts `PIECE_PLAYS`), light or dark with the page, and plays it once when the page posts `{ type: "overhand:play" }`; under reduced
 * motion, or framed again with `&after` once the page has played it, it opens at the moment's end. Nothing else the page
 * posts moves it. When it plays, what the moment is about (`Play.focus`) lifts while the rest dims, then it all settles
 * (lib/motion.ts `focusOnce`). A piece shows a short slice of the real thing (`&max=N` items), and reports its height
 * (`overhand:piece`) so its frame fits it exactly and nothing scrolls inside; messages stay on this origin.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Model, useLiveState, useModel } from "./app/data";
import { ThemeProvider } from "./app/theme";
import { UiProvider } from "./app/ui";
import { ReviewDrawer } from "./components/drawers/ReviewDrawer";
import { NeedsList, NeedsYou, needs } from "./components/now/Alerts";
import { Cast } from "./components/now/Cast";
import { DayRibbon } from "./components/now/DayRibbon";
import { FirstWin } from "./components/now/FirstWin";
import { InProgress } from "./components/now/InProgress";
import { Prologue } from "./components/now/Story";
import { ProjectRules } from "./components/QuickSettings";
import { Sheet } from "./components/ui/sheet";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { browserHost, PIECE_PLAYS, pieceSlice } from "./demo/demo";
import { focusOnce, MOTION } from "./lib/motion";
import "./index.css";

/** The plan a sentence starts (the plan piece's moment, demo.ts): only its card from Needs you, once it has landed. */
function Plan({ m }: { m: Model }) {
  const list = needs(m).filter((n) => "alert" in n && m.s.findings.some((f) => f.task && n.alert.item === `held:${f.id}`));
  // until it lands there's nothing to show, not an empty pane
  return list.length ? pane(<NeedsList list={list} />) : null;
}

/** A piece without a pane of its own sits on the dashboard's pane, like it does on the board. */
const pane = (children: ReactNode) => <section className="hud-pane">{children}</section>;

const params = new URLSearchParams(location.search);
const which = params.get("p") ?? "";
const known = PIECE_PLAYS[which] ?? PIECE_PLAYS.morning;
if (!known) throw new Error("demo.ts has no morning piece");
const PLAY = { ...known, settled: params.has("after") };
/** How many items a list piece shows (`&max=N`); without it, what the dashboard shows. */
const max = Number(params.get("max")) || undefined;

/** Each piece, drawn at the night's minute; `round` counts its plays (the brief counts its numbers up again). */
const PIECES: Record<string, (m: Model, round: number) => ReactNode> = {
  needs: (m) => <NeedsYou m={m} slice={(l) => pieceSlice(l, max ?? 6, (n) => "alert" in n && n.alert.item === PLAY.focus)} />,
  inflight: (m) => <InProgress m={m} />,
  firstwin: (m) => <FirstWin m={m} />,
  cast: (m) => <Cast m={m} max={max} />,
  morning: (m, round) =>
    pane(
      <div className="grid gap-4">
        <div key={round} data-id="brief">
          <Prologue m={m} />
        </div>
        <DayRibbon m={m} />
      </div>,
    ),
  // the review drawer's body, opened on its preview, up to what's worth a look and the proof; its title expects the
  // drawer around it, which stays closed here
  review: (m) =>
    pane(
      <Sheet open={false}>
        <ReviewDrawer m={m} ticketKey="BOOK-88" onPreview short />
      </Sheet>,
    ),
  plan: (m) => <Plan m={m} />,
  rules: (m) => pane(<ProjectRules m={m} />),
};

function Piece() {
  useLiveState(PLAY);
  const m = useModel();
  const box = useRef<HTMLDivElement>(null);
  const [round, setRound] = useState(0);
  // the play: once the moment has drawn (and a card it brings has entered), its focus lifts while the rest dims
  useEffect(() => {
    const host = browserHost();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle = () => {};
    const stop = host.listen((e) => {
      const d = e.data;
      const cue = typeof d === "object" && d !== null && "type" in d && d.type === PLAY.cue;
      if (done || host.reduced || PLAY.settled || !cue || e.source !== host.parent || e.origin !== host.origin) return;
      done = true;
      setRound((r) => r + 1);
      timer = setTimeout(() => {
        const el = box.current;
        const f = PLAY.focus ? el?.querySelector(`[data-id="${CSS.escape(PLAY.focus)}"]`) : null;
        if (el && f) settle = focusOnce(f, el);
      }, MOTION.base);
    });
    return () => {
      stop();
      clearTimeout(timer);
      settle();
    };
  }, []);
  // the frame on the site page takes the piece's height, so nothing scrolls inside it
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const host = browserHost();
    const tell = () => host.post({ type: "overhand:piece", p: which, h: Math.ceil(el.getBoundingClientRect().height) });
    const ro = new ResizeObserver(tell);
    ro.observe(el);
    tell();
    return () => ro.disconnect();
  }, []);
  const render = PIECES[which];
  return (
    <div ref={box} className="p-1">
      {m && render ? render(m, round) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("piece.html has no #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <UiProvider>
            <Piece />
            <Toaster />
          </UiProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
