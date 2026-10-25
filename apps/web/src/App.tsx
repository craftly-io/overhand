import { START_COMMAND } from "@overhand/contract";
import { AlertTriangle } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { toast } from "sonner";
import { useActions } from "@/app/actions";
import { type Model, useLiveState, useModel, useStateQuery } from "@/app/data";
import { useFreshOnReturn } from "@/app/fresh";
import { useEventChimes } from "@/app/sound";
import { useTheme } from "@/app/theme";
import { useDock, usePhone } from "@/app/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Boot } from "./components/Boot";
import { DrawerHost } from "./components/drawers/DrawerHost";
import { Header, NightReport } from "./components/Header";
import { NeedsYou } from "./components/now/Alerts";
import { FirstRun } from "./components/now/FirstRun";
import { FirstWin } from "./components/now/FirstWin";
import { InProgress } from "./components/now/InProgress";
import { Prologue } from "./components/now/Story";
import { MapWindow } from "./components/now/Window";
import { Pair } from "./components/Pair";
import { Palette } from "./components/Palette";
import { Setup, SetupOrganise } from "./components/Setup";
import { MeTeam } from "./components/team/MeTeam";
import { ContractError, Unpaired } from "./lib/api";
import { fmt } from "./lib/format";

/** Says plainly when the daemon is unreachable or sends data the contract rejects, naming the field. */
function StateBanner() {
  const w = useTheme().words;
  const { error, refetch, isFetching } = useStateQuery();
  if (!error) return null;
  const invalid = error instanceof ContractError;
  const text = invalid ? fmt(w.bannerInvalid, { path: error.path, message: error.message }) : w.bannerUnreachable;
  return (
    <Alert variant="destructive" className="mx-4 mt-3 w-auto border-bad/60 lg:mx-6" role="alert">
      <AlertTriangle aria-hidden="true" />
      <AlertDescription className="grid gap-2 text-foreground">
        <span>{text}</span>
        {/* unreachable: what starts it again (the page can't), and asking again now */}
        {invalid ? null : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{w.bannerStartIt}</span>
            <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">{START_COMMAND}</code>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard.writeText(START_COMMAND).then(
                  () => toast(w.hostedCopied),
                  () => undefined,
                )
              }
            >
              {w.hostedCopy}
            </Button>
            <Button size="xs" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              {w.retryNow}
            </Button>
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Now, in three blocks, like the menu bar's glance: one sentence (who's at work, what needs you, what merged, what it
 * cost; each number opens what it counts) with the Night report beside it on a phone, where the header has no room for
 * it; then Needs you and In progress, side by side from 1024. The first win leads Now on a phone while it's under way
 * (firstwin.ts SHOW_MS takes it away once it's days old), else it follows Needs you, which stays in view above the
 * fold. The map shows above the two lists
 * only when it's switched on (Settings › You); with a team, Me / Team swaps the lists for the Team view.
 */
function Home({ m }: { m: Model }) {
  const phone = usePhone();
  const { theme } = useTheme();
  if (!m.s.clients.length) return <FirstRun m={m} />;
  const winFirst = phone && (m.s.firstWin?.state ?? "none") !== "none";
  return (
    <div className="mx-auto grid w-full max-w-[100rem] gap-(--space-gap)">
      {winFirst ? <FirstWin m={m} /> : null}
      <section id="jump-now" className="flex scroll-mt-20 flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <Prologue m={m} />
        <NightReport className="lg:hidden" />
      </section>
      <MeTeam
        m={m}
        mine={
          <>
            <MapWindow m={m} world={theme.world} />
            <div className="grid items-start gap-(--space-gap) lg:grid-cols-2">
              <div id="jump-needs" className="grid scroll-mt-20 gap-(--space-gap)">
                <NeedsYou m={m} home />
                {m.s.firstWin && !winFirst ? <FirstWin m={m} /> : null}
              </div>
              <div id="jump-progress" className="scroll-mt-20">
                <InProgress m={m} />
              </div>
            </div>
          </>
        }
      />
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

/** The dashboard: header, Now, drawers and the command bar. */
export function App() {
  const { words: w, theme } = useTheme();
  const m = useModel();
  const { error } = useStateQuery();
  // set when setup saved two projects or more: the organise step shows before the dashboard
  const [organising, setOrganising] = useState(false);
  useLiveState();
  useBriefParam(Boolean(m));
  useFreshOnReturn(m?.s);
  useEventChimes(m?.s.reports, theme.id);
  const dock = useDock();
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
      {/* Now, the setup wizard and first run are pages that scroll under the header */}
      {/* the content stops at 3200px, centred; a view docked beside it makes room */}
      <main
        id="main"
        className="relative mx-auto w-full max-w-[3200px] px-4 pt-4 pb-8 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-6"
        style={dock ? docked(dock) : undefined}
      >
        {m?.s.setup ? (
          <Setup onSaved={(n) => setOrganising(n > 1)} />
        ) : organising ? (
          <SetupOrganise onDone={() => setOrganising(false)} />
        ) : m ? (
          <Home m={m} />
        ) : (
          // the first state hasn't arrived: the one loader (a pane that loads draws skeletons instead)
          <Boot ready={false} label={w.starting} />
        )}
      </main>
      <DrawerHost m={m} />
      <Palette m={m} />
    </div>
  );
}
