import { type Lead, type LeadHears, LeadLogSchema, plainLine, type ThreadEntry, threadOf } from "@overhand/contract";
import type { WordKey } from "@overhand/themes";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { Term, useWords } from "@/app/theme";
import { FeatureTip } from "@/components/FeatureTip";
import { AnsweredElsewhere } from "@/components/now/Alerts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { askNotes } from "@/lib/alerts";
import { get } from "@/lib/api";
import { onWatch, reportTitle } from "@/lib/assign";
import { ago, fmt } from "@/lib/format";
import { parseMarkdown } from "@/lib/markdown";
import { leadName, leadState } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { AssignButton } from "../AssignButton";
import { DecisionCard } from "../DecisionCard";
import { Markdown } from "../Markdown";
import { Steps } from "../Pane";
import { DrawerHead } from "./DrawerHost";

/** The lead's live output, refreshed every 5 s while the drawer is open; stays pinned to the bottom unless you scroll up. */
function LiveLog({ leadKey }: { leadKey: string }) {
  const w = useWords();
  const box = useRef<HTMLPreElement>(null);
  const { data } = useQuery({
    queryKey: ["lead-log", leadKey],
    queryFn: () => get(`/api/lead/log?key=${encodeURIComponent(leadKey)}`, LeadLogSchema),
    refetchInterval: 5000,
  });
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <section className="mt-5">
      <h3 className="font-display text-xs tracking-widest text-primary uppercase">
        {w.liveOutput}{" "}
        {data?.at ? (
          <span className="ml-1 tracking-normal text-muted-foreground normal-case">{fmt(w.updatedAgo, { ago: ago(data.at) })}</span>
        ) : null}
      </h3>
      {data ? null : <SkeletonRows rows={4} className="mt-2 max-w-[80ch] bg-muted p-3" />}
      <pre
        ref={box}
        hidden={!data}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be reachable by keyboard
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
        }}
        className="mt-2 max-h-64 max-w-[80ch] overflow-auto bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {data ? data.text || w.logEmpty : null}
      </pre>
    </section>
  );
}

/** A lead's questions file, folded: its heading says when, the text opens as Markdown (tables as tables, code as code). */
function LeadText({ g }: { g: Lead }) {
  const w = useWords();
  if (!g.inbox) return null;
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer font-display text-xs tracking-widest text-primary uppercase select-none">
        {w.leadQuestions} · {ago(g.inbox.at)}
      </summary>
      <div className="mt-2 max-h-96 overflow-auto bg-muted/50 p-3">
        <Markdown blocks={parseMarkdown(g.inbox.text)} />
      </div>
    </details>
  );
}

/** When the lead reads a message, under the box (contract LEAD_HEARS). */
const HEARS = {
  now: "leadHearsNow",
  "after-run": "leadHearsAfterRun",
  starts: "leadHearsStarts",
} as const satisfies Record<LeadHears, WordKey>;

/**
 * The lead's questions file as a conversation, oldest first, kept scrolled to the newest. Each entry is one plain line
 * with its full words behind Details; a lead's words are text only, never links or buttons.
 */
function Thread({ text, lead }: { text: string; lead: string }) {
  const w = useWords();
  const box = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && text) el.scrollTop = el.scrollHeight; // to the newest each time the file changes, not on every render
  }, [text]);
  const who = { you: w.threadYou, overhand: w.brand, lead } as const;
  const kind: Partial<Record<ThreadEntry["kind"], string>> = { reply: w.threadReply, report: w.threadReport };
  return (
    <ol
      ref={box}
      aria-label={w.leadThread}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
      tabIndex={0}
      className="mt-2 grid max-h-96 gap-2 overflow-auto"
    >
      {threadOf(text).map((e, i) => {
        const line = e.title || plainLine(e.body, 200) || e.body;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: entries have no ids; the file only grows at its end
            key={i}
            className={cn("min-w-0 p-3 text-sm leading-relaxed", e.who === "you" ? "ml-8 bg-primary/10" : "mr-8 bg-muted/50")}
          >
            <p className="text-xs text-muted-foreground">{[who[e.who], kind[e.kind], e.at ? ago(e.at) : ""].filter(Boolean).join(" · ")}</p>
            <p className="mt-1 break-words">{line}</p>
            {e.body && e.body !== line ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{w.decDetails}</summary>
                <p className="mt-1 break-words whitespace-pre-wrap">{e.body}</p>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** One lead: its state, the conversation with it, a box to answer or message it, live output, start and stop. */
export function LeadDrawer({ m, leadKey }: { m: Model; leadKey: string }) {
  const w = useWords();
  const { leadAnswer, leadStart, leadStop } = useActions();
  const [answer, setAnswer] = useState("");
  const [elsewhere, setElsewhere] = useState(false);
  const g = m.s.godmode.find((x) => x.key === leadKey);
  if (!g) return <DrawerHead kicker={<Term k="lead" />} title={leadKey} />;
  const name = leadName(g, m.s.names);
  // with a question open the box answers it; otherwise what you send is a message, said when it reads it
  const hears = !g.open && g.hears && (g.supervised || g.running) ? w[HEARS[g.hears]] : "";
  return (
    <>
      <DrawerHead kicker={<Term k="lead" />} title={name} />
      <p className="mt-1 text-sm text-muted-foreground">{leadState(g, w, Date.now())}</p>
      {g.open && g.inbox ? <DecisionCard m={m} item={`lead:${g.key}`} here={`lead:${g.key}`} fallback={<LeadText g={g} />} /> : null}
      <section className="mt-4">
        {g.inbox ? (
          <>
            <h3 className="font-display text-xs tracking-widest text-primary uppercase">
              {w.leadThread} · {ago(g.inbox.at)}
            </h3>
            <Thread text={g.inbox.text} lead={name} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{w.leadNoQuestions}</p>
        )}
        {g.ask
          ? askNotes(g.ask, w, Date.now()).map((n) => (
              <p key={n} className="mt-1.5 text-xs text-muted-foreground">
                {n}
              </p>
            ))
          : null}
        {elsewhere ? (
          <div className="mt-3">
            <AnsweredElsewhere leadKey={g.key} onDone={() => setElsewhere(false)} />
          </div>
        ) : null}
        <div className="mt-3 grid gap-1.5">
          <Label htmlFor="lead-answer">{g.open ? w.yourAnswer : fmt(w.messageLead, { lead: name })}</Label>
          <Textarea
            id="lead-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={g.open ? w.answerPlaceholder : w.messagePlaceholder}
            className="min-h-24"
          />
          {hears ? <p className="text-xs text-muted-foreground">{hears}</p> : null}
          {g.open ? null : <p className="text-xs text-muted-foreground">{w.messageLimits}</p>}
          <FeatureTip at="lead-message" />
        </div>
      </section>
      {/* the outcome (its state, its question) leads; its live output is the steps, folded under Focus */}
      {g.supervised ? (
        <Steps className="mt-5">
          <LiveLog leadKey={g.key} />
        </Steps>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{w.leadOffHint}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!answer.trim()}
          onClick={() => {
            void leadAnswer(g.key, answer, "answer", !g.open);
            setAnswer("");
          }}
        >
          {g.open ? w.sendAnswer : w.sendMessage}
        </Button>
        {g.inbox && onWatch(m.s, g.project) ? (
          <AssignButton
            offer={{ project: g.project, title: `${leadName(g, m.s.names)}: ${reportTitle(g.inbox.text)}`, brief: g.inbox.text }}
            variant="outline"
          />
        ) : null}
        {g.open && !elsewhere ? (
          <Button variant="outline" onClick={() => setElsewhere(true)}>
            {w.answeredElsewhere}
          </Button>
        ) : null}
        {g.open && g.ask?.stale ? (
          <Button variant="outline" onClick={() => void leadAnswer(g.key, "", "dismiss")}>
            {w.dismissQuestion}
          </Button>
        ) : null}
        {g.supervised ? (
          g.running || !g.stopped ? (
            <Button variant={g.running ? "danger" : "outline"} onClick={() => void leadStop(g.key)}>
              {w.stopLead}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void leadStart(g.key)}>
              {w.startLead}
            </Button>
          )
        ) : null}
      </div>
    </>
  );
}
