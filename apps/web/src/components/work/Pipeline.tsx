import type { WordKey } from "@overhand/themes";
import type { CSSProperties, ReactNode } from "react";
import { useActions } from "@/app/actions";
import { type Model, useNow } from "@/app/data";
import { Term, useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { canAssign, isAssigned } from "@/lib/assign";
import { explainPr, explainRun } from "@/lib/explain";
import { fmt } from "@/lib/format";
import { type Card, pipeline, resumesAt, STAGES, type Stage, yours } from "@/lib/pipeline";
import { cn } from "@/lib/utils";
import { AssignButton } from "../AssignButton";
import { PreviewLink } from "../drawers/ReviewDrawer";
import { Explain } from "../Explain";
import { Muted } from "../Pane";
import { ShipNote } from "../ShipNote";
import { checks } from "./InFlight";

const HEAD: Record<Stage, { word: WordKey; hint?: WordKey; tone: string }> = {
  planned: { word: "stagePlanned", hint: "stagePlannedHint", tone: "var(--muted-foreground)" },
  queued: { word: "stageQueued", hint: "stageQueuedHint", tone: "var(--primary)" },
  running: { word: "stageRunning", tone: "var(--primary)" },
  review: { word: "stageReview", tone: "var(--warn)" },
  merged: { word: "stageMerged", hint: "stageMergedHint", tone: "var(--ok)" },
};

/** What a card says under its title: why it was picked, how long it has run, or its PR's state. */
function Meta({ c, m }: { c: Card; m: Model }) {
  const w = useWords();
  const now = useNow(1000);
  if (c.run) {
    const min = Math.max(0, Math.floor((now - c.run.startedAt) / 60000));
    return <p className="text-xs text-muted-foreground">{`${c.run.account} · ${min} of ${m.s.taskTimeoutMin} min`}</p>;
  }
  if (c.pr) {
    const { gh, color, word } = checks(m, c.pr.url);
    return (
      <p className="text-xs text-muted-foreground">
        {c.pr.draft ? <span className="text-warn">{`${w.reviewDraft} · ${w.waitsForYou} · `}</span> : null}
        <ShipNote ship={c.pr.ship} />
        {word ? <span style={{ color }}>{w[word]} · </span> : null}
        {c.pr.reviewRound
          ? c.pr.fixes >= c.pr.reviewRound
            ? fmt(w.fixFromNotes, { n: c.pr.reviewRound })
            : w.notesWithAgent
          : c.pr.fixes === 1
            ? w.fixRoundsOne
            : c.pr.fixes
              ? fmt(w.fixRounds, { n: c.pr.fixes })
              : w.noFixRounds}
        {gh?.review === "CHANGES_REQUESTED" ? ` · ${w.changesRequested}` : ""}
      </p>
    );
  }
  return c.why ? <p className="text-xs break-words text-muted-foreground">{c.why}</p> : null;
}

/**
 * A card's title, which opens it: the ticket key in its project's colour, then the title, kept whole a word at a time
 * (a word longer than the card, a path or an identifier, breaks only where it must), then `children` under it.
 */
function CardTitle({
  k,
  title,
  client,
  m,
  onClick,
  children,
}: {
  k: string;
  title: string;
  client: string;
  m: Model;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    // the title reaches into the card's padding, so a one-line card is still a 24px target without growing
    <button type="button" className="-my-1 min-w-0 flex-1 py-1 text-left pointer-coarse:min-h-11" disabled={!k} onClick={onClick}>
      <p className="text-sm leading-snug break-words">
        {k ? (
          <span className="mr-1.5 font-mono text-xs whitespace-nowrap" style={{ color: m.hue(client) }}>
            {k}
          </span>
        ) : null}
        {title}
      </p>
      {children}
    </button>
  );
}

/**
 * One ticket. The whole card opens it: Review when it has a PR, else the ticket. Planned and queued cards arm with a
 * switch. Its actions sit on a row of their own under the title, so a narrow column never squeezes the title to a strip.
 */
function TicketCard({ c, m, i }: { c: Card; m: Model; i: number }) {
  const w = useWords();
  const ui = useUi();
  const now = useNow(1000);
  const { toggle } = useActions();
  const open = () =>
    c.pr ? ui.openDrawer({ kind: "review", key: c.key }) : c.key ? ui.openDrawer({ kind: "ticket", key: c.key }) : undefined;
  const arm = c.line !== undefined && (c.stage === "planned" || c.stage === "queued");
  const label = fmt(c.on ? w.disarm : w.arm, { key: c.key || c.title });
  const assign = Boolean(c.key && !c.pr && !c.run && canAssign(m.s, c.client));
  return (
    <li
      className={cn(
        "work-card m-enter grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-background/40 p-2.5 transition-colors duration-(--m-instant) hover:border-primary/40",
        c.pr?.draft && "border-warn/50",
        c.stage === "merged" && "opacity-75",
      )}
      style={{ "--i": i } as CSSProperties}
    >
      <div className="flex items-start gap-2.5">
        {arm ? (
          <Switch
            className="mt-0.5"
            checked={Boolean(c.on)}
            aria-label={label}
            title={label}
            onCheckedChange={() => void toggle(c.line ?? 0)}
          />
        ) : null}
        <CardTitle k={c.key} title={c.title} client={c.client} m={m} onClick={open}>
          <Meta c={c} m={m} />
        </CardTitle>
        {c.pr ? (
          <Explain x={explainPr(m.s, c.pr, w)} about={c.key} className="mt-1" />
        ) : c.run ? (
          <Explain x={explainRun(c.run, c.key, m.s.taskTimeoutMin, now, w)} about={c.key || c.title} className="mt-1" />
        ) : null}
      </div>
      {c.pr?.preview || assign ? (
        <div className="flex flex-wrap items-center gap-x-3 text-xs">
          {c.pr?.preview ? (
            <>
              <button
                type="button"
                className="hit-area relative inline-flex h-6 items-center text-primary hover:underline"
                onClick={() => ui.openDrawer({ kind: "review", key: c.key, preview: true })}
              >
                {w.pvTitle}
              </button>
              <PreviewLink url={c.pr.preview} className="hit-area relative inline-flex h-6 items-center text-primary hover:underline">
                {w.reviewPreview} ↗
              </PreviewLink>
            </>
          ) : null}
          {assign ? <AssignButton offer={{ project: c.client, key: c.key }} assigned={isAssigned(m.s, c.key)} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Work as one flow: every ticket moves left to right through Planned, Queued, Running, In review and Merged, one card
 * each, and Yours holds what the planner left for you. On a phone it's one list grouped by stage under sticky headers.
 */
export function Pipeline({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  const { run } = useActions();
  const flow = pipeline(m.s, m.plan);
  const mine = yours(m.plan);
  const queued = flow.queued.length;
  let n = 0;
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* say what you want built in your own words: the command bar takes it, and the agent plans first */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="primary" size="sm" onClick={() => ui.openPalette("")}>
              {w.startAgent}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{w.startAgentHint}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={() => void run({ name: "overdrive" })}>
              {w.overdrive}…
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{w.overdriveHint}</TooltipContent>
        </Tooltip>
      </div>
      {/* a wide panel (a docked Work on a big screen) puts Yours beside the pipeline instead of under it */}
      <div className="grid grid-cols-1 items-start gap-4 @min-[90rem]:grid-cols-[minmax(0,1fr)_22rem]">
        {/* on a computer, a board: a column with cards keeps a readable width and shares the rest, an empty one shrinks to
            its heading, and when they can't all fit the board scrolls sideways in its own scroller (index.css) */}
        <div className="work-board grid items-start gap-3" data-scroll-x>
          {STAGES.map((st) => {
            const h = HEAD[st];
            const cards = flow[st];
            return (
              <section
                key={st}
                aria-label={w[h.word]}
                data-empty={cards.length ? undefined : ""}
                className="work-col grid min-w-0 grid-cols-1 gap-2 lg:rounded-lg lg:border lg:border-border lg:bg-card lg:p-3"
              >
                <header className="work-head sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 -mx-1 flex items-baseline justify-between gap-2 bg-background/95 px-1 py-1.5 backdrop-blur lg:static lg:mx-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
                  <h3 className="min-w-0 text-sm font-semibold">
                    {w[h.word]} {h.hint ? <span className="font-normal text-muted-foreground">{w[h.hint]}</span> : null}
                  </h3>
                  {cards.length ? (
                    <span className="pane-count shrink-0" style={{ "--c": h.tone } as CSSProperties}>
                      {cards.length}
                    </span>
                  ) : null}
                </header>
                {cards.length ? (
                  <ul className="grid grid-cols-1 gap-2">
                    {cards.map((c) => (
                      <TicketCard key={c.id} c={c} m={m} i={n++} />
                    ))}
                  </ul>
                ) : st === "merged" && m.s.week.merged ? null : (
                  <Muted className="text-xs">
                    {st === "planned" ? <Term k="emptyQueue" /> : st === "review" ? <Term k="emptyAgentPrs" /> : w.emptyStage}
                  </Muted>
                )}
                {st === "queued" && queued && !m.s.paused && !resumesAt(m.s) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="justify-self-start" onClick={() => void run({ name: "work" })}>
                        {fmt(w.startArmed, { n: queued })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">{w.runArmedHint}</TooltipContent>
                  </Tooltip>
                ) : null}
                {st === "merged" && m.s.week.merged ? (
                  <p className="text-xs text-muted-foreground">{fmt(w.mergedWeek, { n: m.s.week.merged })}</p>
                ) : null}
              </section>
            );
          })}
        </div>
        <section aria-label={w.stageYours} className="@container grid grid-cols-1 gap-2 rounded-lg border border-border bg-card p-3">
          <h3 className="text-sm font-semibold">
            {w.stageYours} <span className="font-normal text-muted-foreground">{w.stageYoursHint}</span>
          </h3>
          {mine.length ? (
            <ul className="grid grid-cols-1 gap-2 @md:grid-cols-2">
              {mine.map((y) => (
                <li key={y.i} className="grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-background/40 p-2.5">
                  <CardTitle
                    k={y.key}
                    title={y.title}
                    client={y.client}
                    m={m}
                    onClick={() => ui.openDrawer({ kind: "ticket", key: y.key })}
                  >
                    {y.why ? <p className="text-xs break-words text-muted-foreground">{y.why}</p> : null}
                  </CardTitle>
                  <span className="flex flex-wrap items-center gap-1 empty:hidden">
                    {y.url ? (
                      <Button asChild variant="ghost" size="xs">
                        <a href={y.url} target="_blank" rel="noopener noreferrer">
                          {w.prLink} ↗
                        </a>
                      </Button>
                    ) : null}
                    {y.key ? <AssignButton offer={{ project: y.client, key: y.key }} assigned={isAssigned(m.s, y.key)} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted className="text-xs">
              <Term k="emptyMine" />
            </Muted>
          )}
        </section>
      </div>
    </div>
  );
}
