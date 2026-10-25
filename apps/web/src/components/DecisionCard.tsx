import { type Brief, type BriefOption, BriefSchema, CHOICE_IDS, type PlanPoints } from "@overhand/contract";
import type { WordKey } from "@overhand/themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { get } from "@/lib/api";
import { answerDetail, type Insight, insightFor, type OptionRunner, optionLabel, runOption, type Surface } from "@/lib/decide";
import { fmt, hm } from "@/lib/format";
import { parseMarkdown } from "@/lib/markdown";
import { useOrganiseActions } from "@/lib/organise";
import { cn } from "@/lib/utils";

const briefUrl = (item: string, explain = false) => `/api/brief?id=${encodeURIComponent(item)}${explain ? "&explain=1" : ""}`;

/** The brief on one item: asked for when it shows (entering Needs you, or a drawer opening), again every 4 s while pending. */
export function useBrief(item: string | undefined) {
  return useQuery({
    queryKey: ["brief", item],
    queryFn: () => get(briefUrl(item ?? ""), BriefSchema),
    enabled: Boolean(item),
    retry: false,
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.pending ? 4000 : false),
  });
}

/** Explain: asks the daemon to have your agent phrase this item's facts; the card shows it reading, then its words. */
function useExplain(item: string): () => void {
  const qc = useQueryClient();
  return () =>
    void get(briefUrl(item, true), BriefSchema)
      .then((b) => qc.setQueryData(["brief", item], b))
      .catch(() => {});
}

/** The dashboard's actions, as running a brief's option needs them. */
function useRunner(): OptionRunner {
  const a = useActions();
  const ui = useUi();
  const o = useOrganiseActions();
  return {
    organise: o.act,
    leadAnswer: a.leadAnswer,
    ticketAnswer: a.ticketAnswer,
    assign: a.assign,
    prReady: a.prReady,
    cardAct: a.cardAct,
    quiet: a.quiet,
    heldPost: a.heldPost,
    heldDismiss: a.heldDismiss,
    snooze: a.snooze,
    // change the plan: drop it and say the request again in the command bar, its project in front
    replan: async (finding, project, text) => {
      await a.heldDismiss(finding);
      ui.openPalette(`${project}: ${text}`);
    },
    openDrawer: ui.openDrawer,
    openLink: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  };
}

const CONFIDENCE: Record<Brief["recommend"]["confidence"], WordKey> = { high: "decConfHigh", medium: "decConfMedium", low: "decConfLow" };

/** Whether an option opens the drawer you're already in (`here`, an item id like `review:KITE-31`). */
const opensHere = (o: BriefOption, here: string | undefined) =>
  o.do === "drawer" &&
  here !== undefined &&
  (here === `${o.drawer === "review" ? "pr" : o.drawer}:${o.key}` || (o.id === "split" && here === `ticket:${o.key}`));

/** The recommended option answers what waits on you: it takes the `answer` button, the one control in your colour. */
const answers = (o: BriefOption) => o.do === "answer" || o.do === "reply" || o.do === "post";

/**
 * A decision card. Compact (a Needs you row): what it is, the recommended action, the rest in a menu. Full (a drawer):
 * one plain sentence, why, the recommendation and its reason, every option (the recommended one first) and a timed
 * default; the facts and the source text in full wait under Details. Shows nothing until the brief arrives, and nothing
 * for an item without one.
 */
export function DecisionCard({
  m,
  item,
  compact = false,
  here,
  fallback = null,
}: {
  m: Model;
  item: string;
  compact?: boolean;
  here?: string;
  /** Shown when there's no brief (an older daemon, or the item just went): the row's own quick actions. */
  fallback?: ReactNode;
}) {
  const w = useWords();
  const run = useRunner();
  const { data: b, isError, isLoading } = useBrief(item);
  const explain = useExplain(item);
  const [busy, setBusy] = useState(false);
  // the brief on its way: a line and an answer's pill, where they'll be
  if (!b && isLoading)
    return (
      <div className="grid gap-1.5" aria-busy="true">
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-6 w-28 justify-self-end rounded-(--radius-control)" />
      </div>
    );
  if (!b) return isError ? fallback : null;
  const options = b.options.filter((o) => !opensHere(o, here));
  const rec = options.find((o) => o.id === b.recommend.option);
  // a plan's "Change the plan" sits before Go ahead, and the agent's other answer choices after its recommendation, so
  // every choice shows; the rest wait behind …
  const before: BriefOption[] = compact ? options.filter((o) => o.do === "replan") : [];
  const after: BriefOption[] = compact ? options.filter((o) => o !== rec && CHOICE_IDS.some((id) => id === o.id)) : [];
  const rest = options.filter((o) => o !== rec && !before.includes(o) && !after.includes(o));
  // the recommended answer's words when they're too long for its button (a paragraph-long default)
  const detail = rec ? answerDetail(rec) : null;
  const go = (o: BriefOption) => {
    setBusy(true);
    void Promise.resolve(runOption(o, item, run)).finally(() => setBusy(false));
  };
  const button = (o: BriefOption, primary: boolean, size: "xs" | "sm") => (
    <Button
      key={o.id}
      size={size}
      disabled={busy}
      variant={primary ? (answers(o) ? "answer" : "primary") : o.do === "snooze" || o.do === "dismiss" ? "ghost" : "outline"}
      className={cn("h-auto min-h-6 max-w-full min-w-0 shrink py-1 text-left whitespace-normal", o.do === "link" && "after:content-['_↗']")}
      onClick={() => go(o)}
    >
      {optionLabel(o, w, m.s)}
    </Button>
  );
  if (compact)
    return (
      <div className="grid gap-1.5" data-decision={b.source}>
        {/* the row's card above already says what's asked (the brief's what, or a plan's request): here the one line
            you decide on, or the plan's points */}
        {b.plan ? <PlanParts plan={b.plan} /> : <p className="min-w-0 text-xs text-muted-foreground">{b.why}</p>}
        {detail ? <AnswerWords text={detail} /> : null}
        <div className="flex flex-wrap items-start justify-end gap-1">
          {before.map((o) => button(o, false, "xs"))}
          {rec ? button(rec, true, "xs") : null}
          {after.map((o) => button(o, false, "xs"))}
          {rest.length ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={w.decMoreOptions}>
                  <Ellipsis aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-64 gap-1 p-2">
                {rest.map((o) => button(o, false, "xs"))}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    );
  // a timed default is news; "it keeps waiting" is what waiting means, so that one sits under Details
  const timed = b.ifNothing?.at ? fmt(w.decIfNothingAt, { text: b.ifNothing.text, t: hm(b.ifNothing.at) }) : "";
  return (
    <section className="decision mt-4 grid gap-3 rounded-md border border-border p-3" aria-label={w.decRecommend} data-decision={b.source}>
      <div className="grid gap-2" data-decision-primary>
        <p className="text-sm font-medium text-foreground">{b.what}</p>
        {b.plan ? <PlanParts plan={b.plan} /> : null}
        <Part title={w.decWhy}>{b.why}</Part>
        <Part title={`${w.decRecommend} · ${w[CONFIDENCE[b.recommend.confidence]]}`}>{b.recommend.reason}</Part>
        {detail ? (
          <Part title={w.decTheAnswer}>
            <span className="whitespace-pre-wrap">{detail}</span>
          </Part>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {rec ? button(rec, true, "sm") : null}
          {rest.map((o) => button(o, false, "sm"))}
        </div>
        {timed ? <Part title={w.decIfNothing}>{timed}</Part> : null}
        {b.pending ? (
          <p className="text-xs text-muted-foreground">{w.decReading}</p>
        ) : b.source === "facts" && !item.startsWith("organise:") ? (
          // facts by default; your agent's words only when you ask (a model call each)
          <Button variant="ghost" size="xs" className="justify-self-start" title={w.decExplainHint} onClick={explain}>
            {w.decExplain}
          </Button>
        ) : null}
      </div>
      <BriefDetails b={b} />
    </section>
  );
}

/** Everything behind a card's one line: the facts with their links, the source text in full as Markdown, never cut. */
function BriefDetails({ b }: { b: Brief }) {
  const w = useWords();
  const wait = b.ifNothing && !b.ifNothing.at ? b.ifNothing.text : "";
  if (!b.evidence.length && !b.detail && !wait) return null;
  return (
    <details className="text-sm" data-decision-details>
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{w.decDetails}</summary>
      <div className="mt-2 grid gap-2 text-foreground/90">
        {b.evidence.length ? (
          <ul className="grid gap-0.5 text-xs text-muted-foreground">
            {b.evidence.map((e) => (
              <li key={`${e.text}${e.url}`} className="break-words">
                {e.url ? (
                  <a className="hover:underline" href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.text} ↗
                  </a>
                ) : (
                  e.text
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {b.detail ? <Markdown blocks={parseMarkdown(b.detail)} /> : null}
        {wait ? <Part title={w.decIfNothing}>{wait}</Part> : null}
        {b.source === "facts" && !b.pending ? <p className="text-xs text-muted-foreground">{w.decFromFacts}</p> : null}
      </div>
    </details>
  );
}

/** A plan waiting for your go-ahead, in full: what changes, and what you'll see when it's done. */
/** A long answer's words, beside its short button: three lines, and the rest on Show all. */
function AnswerWords({ text }: { text: string }) {
  const w = useWords();
  const [all, setAll] = useState(false);
  return (
    <div className="min-w-0 border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
      <p className={cn("break-words whitespace-pre-wrap", !all && "line-clamp-3")}>{text}</p>
      {!all && text.length > 160 ? (
        <button type="button" className="mt-0.5 text-foreground underline-offset-2 hover:underline" onClick={() => setAll(true)}>
          {w.decShowAll}
        </button>
      ) : null}
    </div>
  );
}

function PlanParts({ plan }: { plan: PlanPoints }) {
  const w = useWords();
  const parts = [
    { title: w.planChanges, points: plan.changes },
    { title: w.planSee, points: plan.see },
  ].filter((p) => p.points.length);
  return (
    <div className="grid gap-2" data-plan>
      {parts.map((p) => (
        <Part key={p.title} title={p.title}>
          <ul className="grid list-disc gap-0.5 pl-4">
            {p.points.map((x) => (
              <li key={x} className="break-words">
                {x}
              </li>
            ))}
          </ul>
        </Part>
      ))}
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 text-sm">
      <h4 className="font-display text-xs tracking-widest text-muted-foreground uppercase">{title}</h4>
      <div className="text-foreground/90">{children}</div>
    </div>
  );
}

/** Where an insight's next step takes you, with the dashboard's own actions. */
function useInsightGo() {
  const ui = useUi();
  const { run } = useActions();
  return (i: Insight) => {
    const to = i.go?.to;
    if (!to) return;
    if (to.kind === "link") window.open(to.url, "_blank", "noopener,noreferrer");
    else if (to.kind === "drawer") ui.openDrawer({ kind: to.drawer });
    else if (to.kind === "work") ui.openDrawer({ kind: "work", project: to.project });
    else if (to.kind === "settings") ui.openDrawer({ kind: "settings", tab: to.tab });
    else void run({ name: "plan" });
  };
}

/** What an empty pane says instead of nothing: one insight from the state, and its one next step. */
export function InsightLine({ m, surface, fallback, className }: { m: Model; surface: Surface; fallback?: ReactNode; className?: string }) {
  const w = useWords();
  const go = useInsightGo();
  const i = insightFor(surface, m.s, w);
  if (!i) return fallback ?? null;
  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-muted-foreground", className)}
      data-insight={surface}
    >
      <span className="min-w-0">{i.text}</span>
      {i.go ? (
        <Button variant="outline" size="xs" onClick={() => go(i)}>
          {i.go.label}
        </Button>
      ) : null}
    </div>
  );
}
