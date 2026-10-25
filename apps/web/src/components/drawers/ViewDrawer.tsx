import type { CSSProperties } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi, VIEW_META, type View } from "@/app/ui";
import { fmt } from "@/lib/format";
import { guideStatus } from "@/lib/guide";
import { flagged, projectRules, summary } from "@/lib/instructions";
import { placeStatus, placesFrom } from "@/lib/world";
import { Accounts } from "../health/Accounts";
import { Guardrails } from "../health/Guardrails";
import { HealthPane } from "../health/HealthPane";
import { Machine } from "../health/Machine";
import { Plugins } from "../health/Plugins";
import { WorkReports } from "../health/Reports";
import { Scorecard } from "../health/Scorecard";
import { Spend } from "../health/Spend";
import { Updates } from "../health/Updates";
import { Week } from "../health/Week";
import { InlineMd } from "../Markdown";
import { Cast } from "../now/Cast";
import { ControlRoom } from "../now/ControlRoom";
import { Worktrees } from "../now/Worktrees";
import { Dot, Muted, Pane } from "../Pane";
import { Button } from "../ui/button";
import { Pipeline } from "../work/Pipeline";
import { DrawerHead } from "./DrawerHost";

/** Each project's agent instruction files at a glance; a project opens its rules in full. */
function Instructions({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  return (
    <Pane title="instTitle" subtitle={w.instHint}>
      {m.s.instructions.length ? (
        <ul className="divide-y divide-border">
          {m.s.instructions.map((p) => {
            const n = flagged(p);
            return (
              <li key={p.project}>
                <button
                  type="button"
                  className="grid w-full grid-cols-[auto_1fr] items-baseline gap-x-2 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() => ui.openDrawer({ kind: "instructions", project: p.project })}
                >
                  <Dot color={n ? "var(--warn)" : "var(--muted-foreground)"} />
                  <span className="min-w-0">
                    <b className="font-medium" style={{ color: m.hue(p.project) }}>
                      {p.project}
                    </b>{" "}
                    <span className="text-muted-foreground">
                      {projectRules(p) ? summary(w, p) : w.instEmpty}
                      {n ? <span className="text-warn"> · {fmt(w.instFlagged, { n })}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Muted>{w.instNone}</Muted>
      )}
    </Pane>
  );
}

/** Each project's onboarding guide at a glance: fresh, out of date (with Refresh), being written, or none yet. */
function Guides({ m, project }: { m: Model; project?: string }) {
  const w = useWords();
  const ui = useUi();
  const { guideRun } = useActions();
  const list = m.s.guides.filter((g) => !project || g.project === project);
  return (
    <Pane title="guideTitle" subtitle={w.guideHint}>
      {list.length ? (
        <ul className="divide-y divide-border">
          {list.map((g) => {
            const busy = g.run === "queued" || g.run === "running";
            const stale = g.drift.length > 0 && !busy;
            const color =
              g.run === "failed"
                ? "var(--bad)"
                : stale
                  ? "var(--warn)"
                  : busy
                    ? "var(--primary)"
                    : g.text
                      ? "var(--ok)"
                      : "var(--muted-foreground)";
            return (
              <li key={g.project} className="flex items-center gap-2">
                <button
                  type="button"
                  className="grid min-h-10 min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-2 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() => ui.openDrawer({ kind: "guide", project: g.project })}
                >
                  <Dot color={color} />
                  <span className="min-w-0 break-words">
                    <b className="font-medium" style={{ color: m.hue(g.project) }}>
                      {g.project}
                    </b>{" "}
                    <span className={stale ? "text-warn" : "text-muted-foreground"}>
                      <InlineMd text={guideStatus(w, g)} />
                    </span>
                  </span>
                </button>
                {stale && !g.prKey ? (
                  <Button variant="outline" size="xs" className="shrink-0" onClick={() => guideRun(g.project)}>
                    {w.guideRefresh}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <Muted>{w.instNone}</Muted>
      )}
    </Pane>
  );
}

/**
 * Each project at a glance, as a list: the keyboard's way to the map's sectors. A project shows its crew; Everyone shows
 * them all again.
 */
function Places({ m, project }: { m: Model; project?: string }) {
  const w = useWords();
  const ui = useUi();
  const pick = (p?: string) => ui.openDrawer(p ? { kind: "crew", project: p } : { kind: "crew" });
  return (
    <Pane title="placesTitle" subtitle={w.placesHint}>
      <ul className="grid gap-1">
        {placesFrom(m.s).map((p) => (
          <li key={p.name}>
            <button
              type="button"
              aria-pressed={project === p.name}
              className="grid min-h-10 w-full grid-cols-[auto_1fr] items-baseline gap-x-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40 aria-pressed:bg-(--c)/10"
              style={{ "--c": m.hue(p.name) } as CSSProperties}
              onClick={() => pick(project === p.name ? undefined : p.name)}
            >
              <Dot color={p.failure ? "var(--bad)" : p.needs ? "var(--warn)" : p.working ? "var(--ok)" : "var(--muted-foreground)"} />
              <span className="min-w-0">
                <b className="font-medium text-(--c)">{p.name}</b> <span className="text-muted-foreground">{placeStatus(p, w)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {project ? (
        <button type="button" className="mt-1 min-h-10 justify-self-start px-2 text-sm text-primary hover:underline" onClick={() => pick()}>
          {w.placesEveryone}
        </button>
      ) : null}
    </Pane>
  );
}

/**
 * A place behind the bridge: Work (the pipeline), Crew (who's working, where, under which instructions) or Health (is
 * anything broken, and is it worth it: spend, the budget and each account's usage together).
 */
export function ViewDrawer({ m, view, project }: { m: Model; view: View; project?: string }) {
  const w = useWords();
  const { word, key } = VIEW_META[view];
  return (
    <>
      <DrawerHead kicker={w.brand} named={word} />
      <kbd className="view-key absolute top-4 right-12 hidden font-mono text-xs text-muted-foreground lg:block">{key}</kbd>
      {view === "work" ? (
        <div className="mt-4">
          <Pipeline m={m} />
        </div>
      ) : view === "crew" ? (
        <div className="balance mt-4">
          <Cast m={m} project={project} />
          {project ? <Worktrees m={m} project={project} /> : null}
          <ControlRoom m={m} />
          <Places m={m} project={project} />
          <Instructions m={m} />
          <Guides m={m} project={project} />
          {project ? <WorkReports m={m} project={project} /> : null}
        </div>
      ) : (
        // the balanced panes, then the two wide ones, one gap apart. Accounts before Spend: the columns come out nearly
        // even (Spend is the tallest), and the two still meet where the first column turns into the second
        <div className="mt-4 grid gap-(--space-gap)">
          <div className="balance">
            <HealthPane m={m} />
            <Week m={m} />
            <Accounts m={m} />
            <Spend m={m} />
            <Machine m={m} />
            <Guardrails m={m} />
            <Updates m={m} />
            <Plugins m={m} />
          </div>
          <Scorecard m={m} />
          <WorkReports m={m} />
        </div>
      )}
    </>
  );
}
