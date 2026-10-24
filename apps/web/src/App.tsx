import { AlertTriangle } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useActions } from "@/app/actions";
import { type Model, useLiveState, useModel, useStateQuery } from "@/app/data";
import { useFreshOnReturn } from "@/app/fresh";
import { useEventChimes } from "@/app/sound";
import { Term, useTheme } from "@/app/theme";
import { useDock, usePhone, useUi, useViewport } from "@/app/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Boot } from "./components/Boot";
import { DrawerHost, PlaceBody } from "./components/drawers/DrawerHost";
import { Header } from "./components/Header";
import { Systems } from "./components/health/Systems";
import { Activity } from "./components/now/Activity";
import { NeedsYou } from "./components/now/Alerts";
import { Cast } from "./components/now/Cast";
import { DayRibbon } from "./components/now/DayRibbon";
import { FirstRun } from "./components/now/FirstRun";
import { FirstWin } from "./components/now/FirstWin";
import { BeatCaption, Prologue } from "./components/now/Story";
import { Today } from "./components/now/Today";
import { MapWindow } from "./components/now/Window";
import { Pair } from "./components/Pair";
import { Palette } from "./components/Palette";
import { Steps } from "./components/Pane";
import { PlaceBar } from "./components/PlaceBar";
import { Setup, SetupOrganise } from "./components/Setup";
import { MeTeam } from "./components/team/MeTeam";
import { InFlight } from "./components/work/InFlight";
import { ContractError, Unpaired } from "./lib/api";
import { fmt } from "./lib/format";
import { type BridgeSlot, bridgeLayout, CONTENT_MAX } from "./lib/layout";
import { cn } from "./lib/utils";

/** Says plainly when the daemon is unreachable or sends data the contract rejects, naming the field. */
function StateBanner() {
  const w = useTheme().words;
  const { error } = useStateQuery();
  if (!error) return null;
  const text = error instanceof ContractError ? fmt(w.bannerInvalid, { path: error.path, message: error.message }) : w.bannerUnreachable;
  return (
    <Alert variant="destructive" className="mx-4 mt-3 w-auto border-bad/60 lg:mx-6" role="alert">
      <AlertTriangle aria-hidden="true" />
      <AlertDescription className="text-foreground">{text}</AlertDescription>
    </Alert>
  );
}

/**
 * Gives the panes inside a power-on slot, so the bridge's panes light up one after another. On a phone the wings fold
 * into one column, and `className` carries the slot's place in it.
 */
function Slot({ i, id, className, children }: { i: number; id?: string; className?: string; children: ReactNode }) {
  return (
    <div id={id} className={className ?? "contents"} style={{ "--i": i } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * The bridge, which is Now: a window onto the world in the centre (the greeting and the story at its top, then clear,
 * so the scene behind shows through with each project in its place), what needs you to one side, glances at the crew,
 * the work and the systems to the other, the day along the bottom. The columns follow `bridgeLayout`; the side columns
 * scroll on their own, the window never does. On a phone Now is one column (what needs you, the story and the window,
 * today, the ribbon, the day so far) and the glances are tabs of their own; on a phone held sideways it's two.
 */
function Bridge({ m }: { m: Model }) {
  const phone = usePhone();
  const { theme } = useTheme();
  // the bridge's width: the content (capped at 3200px) less the place docked beside it, less main's padding; known
  // up front, so docking reflows the bridge in the same frame
  const dock = useDock();
  const width = Math.min(CONTENT_MAX, useViewport() - dock) - 48;
  // once the bridge has reflowed (a place docked, the window resized), panes moving to a new column don't play their
  // entrance again
  const first = useRef<string | null>(null);
  if (!m.s.clients.length) return <FirstRun m={m} />;
  const layout = bridgeLayout(width);
  // with an attention map, the map is the centrepiece: from three columns the story moves beside it, at the head of
  // the right wing, and the map takes the whole centre column
  const beside = !phone && layout.tracks.length > 2;
  const story = (
    <>
      <Prologue m={m} />
      <BeatCaption m={m} />
    </>
  );
  const ribbon = (
    <div id="jump-ribbon" className="m-enter scroll-mt-20" style={{ "--i": 8 } as CSSProperties}>
      <p className="ribbon-label mb-1 text-xs tracking-[0.08em] text-muted-foreground">
        <Term k="storyDay" />
      </p>
      <Steps>
        <DayRibbon m={m} />
      </Steps>
    </div>
  );
  const view = (
    <section id="jump-now" className="relative flex min-h-0 scroll-mt-20 flex-col gap-2 px-2 pt-2 lg:flex-1 lg:px-6">
      {/* with a team: Me / Team; the Team view lives in components/team, apart from the rest of Now */}
      <MeTeam
        m={m}
        mine={
          <>
            {beside ? null : story}
            <MapWindow m={m} world={theme.world} />
          </>
        }
      />
    </section>
  );
  const slot: Record<Exclude<BridgeSlot, "window">, ReactNode> = {
    needs: (
      <Slot key="needs" i={1} id="jump-needs" className="grid scroll-mt-20 gap-(--space-gap)">
        {m.s.firstWin ? <FirstWin m={m} /> : null}
        <NeedsYou m={m} />
      </Slot>
    ),
    today: (
      <Slot key="today" i={3} id="jump-today" className="scroll-mt-20">
        <Today m={m} />
      </Slot>
    ),
    activity: (
      <Slot key="activity" i={4} id="jump-activity" className="scroll-mt-20">
        <Activity m={m} />
      </Slot>
    ),
    crew: (
      <Slot key="crew" i={2}>
        <Cast m={m} glance />
      </Slot>
    ),
    work: (
      <Slot key="work" i={5}>
        <InFlight m={m} />
      </Slot>
    ),
    health: (
      <Slot key="health" i={6}>
        <Systems m={m} />
      </Slot>
    ),
  };
  if (phone)
    // one column; held sideways, two: what needs you and your day | the story, the window and the ribbon; on a tablet
    // held upright, today and the day so far sit two-up. With an attention map the story and the map come first (the
    // map says at a glance what Needs you lists below it)
    return (
      <div className="grid gap-(--space-gap) short:grid-cols-2 short:items-start tablet:grid-cols-2 tablet:items-start">
        <div className="contents short:grid short:gap-(--space-gap)">
          <div className={"order-2 short:order-none tablet:col-span-2"}>{slot.needs}</div>
          <div className="order-3 short:order-none">{slot.today}</div>
          <div className="order-5 short:order-none">{slot.activity}</div>
        </div>
        <div className="contents short:grid short:gap-(--space-gap)">
          <div className={"order-1 short:order-none tablet:col-span-2"}>{view}</div>
          <div className="order-4 short:order-none tablet:order-6 tablet:col-span-2">{ribbon}</div>
        </div>
      </div>
    );
  first.current ??= layout.name;
  const last = layout.tracks.length - 1;
  // the story leads the column right of the window
  const storyAt = layout.tracks.findIndex((t) => t.includes("window")) + 1;
  return (
    <div
      data-layout={layout.name}
      data-reflowed={layout.name !== first.current ? "" : undefined}
      className="grid h-full grid-rows-[minmax(0,1fr)_auto] gap-(--space-gap)"
      style={{ gridTemplateColumns: layout.columns }}
    >
      {layout.tracks.map((slots, i) =>
        slots.includes("window") ? (
          <div key="window" className="flex min-h-0 flex-col">
            {view}
          </div>
        ) : (
          <aside
            key={slots.join()}
            className={cn(
              "wing grid min-h-0 grid-cols-1 content-start gap-(--space-gap)",
              // the outer columns turn toward you, like glass either side of the window
              i === 0 && "origin-left pr-2 [transform:perspective(1600px)_rotateY(6deg)]",
              i === last && "origin-right pl-2 [transform:perspective(1600px)_rotateY(-6deg)]",
            )}
          >
            {beside && i === storyAt ? (
              <section id="jump-story" className="story-beside grid gap-3 border-b border-border pb-4">
                {story}
              </section>
            ) : null}
            {slots.map((s) => (s === "window" ? null : slot[s]))}
          </aside>
        ),
      )}
      <div className="col-span-full">{ribbon}</div>
    </div>
  );
}

/** Margins that keep the content centred in the room a docked place leaves, still capped at 3200px. */
const docked = (dock: number): CSSProperties => {
  const side = `max(0px, (100vw - ${dock}px - 3200px) / 2)`;
  return { width: "auto", marginLeft: side, marginRight: `calc(${dock}px + ${side})` };
};

/** The menu bar item's Night report opens the dashboard on `?run=brief`: the report, once the state is in. */
function useBriefParam(ready: boolean) {
  const { run } = useActions();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!ready || q.get("run") !== "brief") return;
    q.delete("run");
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
    void run({ name: "brief" });
  }, [ready, run]);
}

/** The dashboard: header, the bridge, drawers and the command bar. */
export function App() {
  const { words: w, theme } = useTheme();
  const m = useModel();
  const { error } = useStateQuery();
  // set when setup saved two projects or more: the organise step shows before the dashboard
  const [organising, setOrganising] = useState(false);
  const setup = m?.s.setup ?? false;
  const bridge = Boolean(m?.s.clients.length && !setup);
  useLiveState();
  useBriefParam(Boolean(m));
  useFreshOnReturn(m?.s);
  useEventChimes(m?.s.reports, theme.id);
  const ui = useUi();
  const phone = usePhone();
  const dock = useDock();
  const away = phone && ui.phonePlace.kind !== "now";
  // another device that isn't paired yet: only the pairing card, nothing of the dashboard
  if (error instanceof Unpaired) return <Pair />;
  return (
    <div className="relative min-h-dvh overflow-x-clip lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden">
      <div className="hud-veil" aria-hidden="true" />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-2">
        Skip to content
      </a>
      <Header m={m} unreachable={Boolean(error) && !(error instanceof ContractError)} />
      <StateBanner />
      {/* the bridge holds still and its wings scroll; the setup wizard and first run are pages that scroll */}
      {/* the content stops at 3200px, centred, and the scene fills the edges; a place docked beside it makes room */}
      <main
        id="main"
        className={`relative mx-auto w-full max-w-[3200px] px-4 pt-4 pb-8 lg:min-h-0 lg:flex-1 lg:px-6 lg:pb-3 ${bridge ? "max-lg:pb-24 short:pb-16 lg:overflow-hidden" : "lg:overflow-y-auto"}`}
        style={dock ? docked(dock) : undefined}
      >
        {m?.s.setup ? (
          <Setup onSaved={(n) => setOrganising(n > 1)} />
        ) : organising ? (
          <SetupOrganise onDone={() => setOrganising(false)} />
        ) : m && away ? (
          <PlaceBody m={m} at={ui.phonePlace} />
        ) : m ? (
          <Bridge m={m} />
        ) : (
          // the first state hasn't arrived: the one loader (a pane that loads draws skeletons instead)
          <Boot ready={false} label={w.starting} />
        )}
      </main>
      {m && bridge ? <PlaceBar m={m} /> : null}
      <DrawerHost m={m} />
      <Palette m={m} />
    </div>
  );
}
