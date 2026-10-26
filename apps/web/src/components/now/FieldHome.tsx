import { useState, useSyncExternalStore } from "react";
import type { Model } from "@/app/data";
import { store } from "@/app/store";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { brokenCount } from "@/lib/alerts";
import { fmt } from "@/lib/format";
import { Field } from "@/map/Field";
import { MeTeam } from "../team/MeTeam";
import { NeedsYou, needs } from "./Alerts";
import { DayStrip } from "./DayStrip";
import { FirstWin } from "./FirstWin";
import { InProgress } from "./InProgress";
import { Prologue } from "./Story";
import { Suggested } from "./Suggested";
import { Today } from "./Today";

const SIDE = "overhand-in-progress";
const sideListeners = new Set<() => void>();

/** Whether In progress shows beside the field, kept in this browser (it shows until you hide it). */
function useSide(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      sideListeners.add(l);
      return () => sideListeners.delete(l);
    },
    () => store.get(SIDE) !== "hidden",
  );
  return [
    on,
    (next) => {
      store.set(SIDE, next ? "shown" : "hidden");
      for (const l of sideListeners) l();
    },
  ];
}

/**
 * Now on a computer, as one screen that never scrolls: the field behind everything; the sentence and Needs you on the
 * left, In progress on the right, each scrolling on its own; Today along the foot. With nothing waiting on you the
 * left keeps only the sentence (and today's plan, when there is one), and the field takes the room. In progress hides
 * to a button, and the field spreads into its side.
 */
export function FieldHome({ m, still }: { m: Model; still: boolean }) {
  const w = useWords();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [side, setSide] = useSide();
  const asks = needs(m).length + brokenCount(m.s);
  return (
    <div ref={setRoot} className="field-home relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-(--space-gap)">
      <Field m={m} still={still} root={root} />
      <div className="pointer-events-none relative z-10 flex min-h-0 items-start gap-(--space-gap)">
        <div
          data-field-avoid=""
          className="field-col pointer-events-auto grid max-h-full w-[clamp(23rem,27vw,26rem)] shrink-0 gap-(--space-gap) overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          <section id="jump-now" className="grid gap-3">
            <Prologue m={m} brief />
          </section>
          <MeTeam
            m={m}
            mine={
              <div id="jump-needs" className="grid gap-(--space-gap)">
                {asks ? (
                  <NeedsYou m={m} home />
                ) : (
                  <>
                    <Today m={m} />
                    <Suggested m={m} />
                  </>
                )}
                {m.s.firstWin ? <FirstWin m={m} /> : null}
              </div>
            }
          />
        </div>
        <div className="flex-1" />
        {side ? (
          <div
            id="jump-progress"
            data-field-avoid=""
            className="field-col pointer-events-auto max-h-full w-[clamp(18rem,22vw,22rem)] shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            <InProgress
              m={m}
              grouped
              extra={
                <Button variant="ghost" size="xs" className="-mr-1 text-muted-foreground" onClick={() => setSide(false)}>
                  {w.fieldHide}
                </Button>
              }
            />
          </div>
        ) : (
          <Button variant="outline" size="sm" className="pointer-events-auto" data-field-avoid="" onClick={() => setSide(true)}>
            {fmt(w.fieldShow, { n: m.s.running.length + m.s.godmode.filter((g) => g.running).length })}
          </Button>
        )}
      </div>
      <div data-field-avoid="" className="hud-pane relative z-10 !py-3">
        <DayStrip m={m} />
      </div>
    </div>
  );
}
