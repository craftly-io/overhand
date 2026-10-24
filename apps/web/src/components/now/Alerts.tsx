import type { ActionCard } from "@overhand/contract";
import { ChevronRight } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useActions } from "@/app/actions";
import { type Model, useModel } from "@/app/data";
import { Term, useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Alert } from "@/lib/alerts";
import { post } from "@/lib/api";
import { BUTTON_WORDS } from "@/lib/decide";
import { explainCalls } from "@/lib/explain";
import { ago, fmt, hm } from "@/lib/format";
import type { InboxItem } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { AssignButton } from "../AssignButton";
import { DecisionCard, InsightLine, useBrief } from "../DecisionCard";
import { Explain } from "../Explain";
import { LeakActions, SelfCheckActions } from "../Outward";
import { Pane } from "../Pane";
import { useQuickSave } from "../QuickSettings";
import { AccountSignIn } from "../SignIn";

/** One thing in the inbox: a Slack request about to be filed (veto it with the switch), a reply with its suggested answer, or a note. */
export function InboxRow({ x, className }: { x: InboxItem; className?: string }) {
  const w = useWords();
  const { toggle } = useActions();
  if (x.kind === "new") {
    const when =
      x.when === "at"
        ? fmt(w.pendingAt, { t: hm(x.at) })
        : x.when === "filed"
          ? w.pendingFiled
          : x.when === "skipped"
            ? w.pendingSkipped
            : w.pendingFiling;
    return (
      <li className={cn("grid grid-cols-[auto_1fr] items-start gap-3 py-2", !x.on && "opacity-70", className)}>
        <Switch className="mt-0.5" checked={x.on} aria-label={`${w.newTicket}: ${x.title}`} onCheckedChange={() => void toggle(x.line)} />
        <div className="min-w-0">
          <p className="text-sm">
            <span className="mr-1.5 text-xs font-medium text-primary">
              <Term k="newTicket" />
            </span>
            {x.title}
          </p>
          <p className="text-xs text-muted-foreground">{when}</p>
        </div>
      </li>
    );
  }
  if (x.kind === "note") return <li className={cn("py-2 text-sm text-muted-foreground", className)}>{x.text}</li>;
  return (
    <li className={cn("py-2", className)}>
      <p className="text-sm">{x.text}</p>
      <blockquote className="my-1.5 border-l-2 border-warn bg-warn/10 px-3 py-1.5 text-sm" aria-label={w.suggested}>
        {x.suggested}
      </blockquote>
      {x.link ? (
        <a className="text-xs text-primary hover:underline" href={x.link} target="_blank" rel="noopener noreferrer">
          {w.replyInSlack} ↗
        </a>
      ) : null}
    </li>
  );
}

/** Colour is state: red when something is broken, amber when it waits on you, starlight when it's for your information. */
const tone = (a: Alert) => (a.broken ? "var(--bad)" : a.sev === 1 ? "var(--primary)" : "var(--warn)");

/** One entry in Needs you: an alert, or someone in the inbox waiting on a reply or a veto. */
export type Need = { sev: Alert["sev"]; alert: Alert } | { sev: 2; item: InboxItem };

/**
 * Everything that needs you in one list, most urgent first: the alerts (lead questions and review requests among them)
 * and, from the inbox, replies with their suggested answers and Slack requests still in their veto window.
 */
export function needs(m: Model): Need[] {
  const items = m.inbox.filter((x) => x.kind === "reply" || (x.kind === "new" && x.when !== "filed"));
  const all: Need[] = [...m.alerts.map((alert) => ({ sev: alert.sev, alert })), ...items.map((item) => ({ sev: 2 as const, item }))];
  return all.sort((a, b) => b.sev - a.sev);
}

/** A need's stable id for the calls count: the item it's about, else what it says. */
const callId = (n: Need): string =>
  "alert" in n
    ? (n.alert.item ?? `${n.alert.target.kind}:${n.alert.title}`)
    : `inbox:${n.item.kind}:${n.item.kind === "new" ? n.item.title : n.item.text}`;

/** Whether anything that needs you is broken (the count goes red, here and beside the menu bar's mark). */
export const anyBroken = (list: readonly Need[]): boolean => list.some((n) => "alert" in n && n.alert.broken);
/** The colour of the Needs you count: red if anything is broken, else amber. */
export const needsTone = (list: readonly Need[]) => (anyBroken(list) ? "var(--bad)" : "var(--warn)");

/** One alert; clicking it opens whatever it's about (a link, a ticket, a lead…). */
function AlertCard({ a, brief, className }: { a: Alert; brief?: string; className?: string }) {
  const ui = useUi();
  const { quiet, run, selfUpdate } = useActions();
  // once its brief is in, the brief's what says what's asked, in place of the title and line (a plan keeps its request);
  // the decision card under it adds the one line of context and the choices
  const { data: b } = useBrief(brief);
  const asked = b && !b.plan ? b.what : "";
  // a chamfered slab tinted by its state, with a lit edge that throbs when it's urgent
  const cls = cn(
    "need-card relative block w-full min-w-0 border border-(--c)/45 bg-linear-120 from-(--c)/18 to-background/70 to-70% py-2.5 pr-3 pl-4 text-left backdrop-blur-md transition-transform [clip-path:polygon(0_0,calc(100%-12px)_0,100%_12px,100%_100%,0_100%)] hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:-outline-offset-4",
    className,
  );
  const style = { "--c": tone(a) } as CSSProperties;
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn("need-edge absolute inset-y-0 left-0 w-[3px] bg-(--c) shadow-[0_0_12px_var(--c)]", a.sev === 3 && "hud-throb")}
      />
      <b className="block text-sm font-semibold [overflow-wrap:anywhere] text-foreground">{asked || a.title}</b>
      {a.sub && !asked ? <small className="mt-0.5 block truncate text-xs text-muted-foreground">{a.sub}</small> : null}
      {/* a default can be a paragraph: three lines here, the whole of it on hover and in its card */}
      {a.notes?.map((n) => (
        <small key={n} title={n.length > 120 ? n : undefined} className="mt-0.5 line-clamp-3 text-xs break-words text-muted-foreground">
          {n}
        </small>
      ))}
    </>
  );
  const t = a.target;
  if (t.kind === "link")
    return (
      <a className={cls} style={style} href={t.url} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  const onClick = () => {
    if (t.kind === "ticket") ui.openDrawer({ kind: "ticket", key: t.key });
    else if (t.kind === "lead" || t.kind === "crashed" || t.kind === "cantstart") ui.openDrawer({ kind: "lead", key: t.key });
    else if (t.kind === "review") ui.openDrawer({ kind: "review", key: t.key });
    else if (t.kind === "notes" || t.kind === "sweep") ui.openDrawer({ kind: t.kind });
    else if (t.kind === "settings") ui.openDrawer({ kind: "settings", tab: t.tab, project: t.project });
    else if (t.kind === "rule") ui.openDrawer({ kind: "instructions", project: t.project });
    else if (t.kind === "held" && t.key) ui.openDrawer({ kind: "ticket", key: t.key });
    else if (t.kind === "card") ui.openDrawer({ kind: "crew" });
    else if (t.kind === "update") void selfUpdate();
    else if (t.kind === "restart") void run({ name: "restart" });
    else if (t.kind === "quiet") void quiet(t.hours);
    else toast(a.sub || a.title);
  };
  return (
    <button type="button" className={cls} style={style} onClick={onClick}>
      {body}
    </button>
  );
}

/**
 * What you can do about an alert without leaving the story: answer a lead's question in place, or hand a ticket you've
 * answered in the tracker back to the agent. Other alerts open where they're explained.
 */
function QuickActions({ a }: { a: Alert }) {
  const actions = <Actions a={a} />;
  return a.assign ? (
    <div className="grid gap-1">
      {actions}
      <div className="flex justify-end">
        <AssignButton offer={a.assign} variant="outline" />
      </div>
    </div>
  ) : (
    actions
  );
}

function Actions({ a }: { a: Alert }) {
  const w = useWords();
  const ui = useUi();
  const { gitAllow, heldDismiss, heldPost, leadAnswer, leadStart, quiet, ruleAdd, ruleDismiss, run, selfUpdate } = useActions();
  const save = useQuickSave();
  const [open, setOpen] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const [text, setText] = useState("");
  const t = a.target;
  // every problem's card has its fix as a button: one that acts, or one that opens exactly where the fix is
  const one = (label: string, act: () => void, variant: "primary" | "outline" = "primary") => (
    <div className="flex justify-end">
      <Button size="xs" variant={variant} onClick={act}>
        {label}
      </Button>
    </div>
  );
  if (t.kind === "card") return <CardButtons card={t.card} />;
  if (t.kind === "restart") return one(w.confirmRestartGo, () => void run({ name: "restart" }));
  if (t.kind === "quiet") return one(fmt(w.decQuiet, { h: t.hours }), () => void quiet(t.hours), "outline");
  if (t.kind === "replan") return one(w.signInRetry, () => void run({ name: "plan" }));
  if (t.kind === "git") return one(w.alGitAllow, () => void gitAllow(t.dir), "outline");
  if (t.kind === "raise") return one(fmt(w.alBudgetRaiseTo, { cap: `$${t.usd}` }), () => void save({ budgetUsd: t.usd }));
  if (t.kind === "update") return one(a.go ?? w.open, () => void selfUpdate());
  if (t.kind === "link") return one(a.go ?? w.open, () => void window.open(t.url, "_blank", "noopener,noreferrer"));
  if (t.kind === "settings")
    return one(a.go ?? w.decOpenSettings, () => ui.openDrawer({ kind: "settings", tab: t.tab, project: t.project }), "outline");
  if (t.kind === "notes" || t.kind === "sweep") return one(a.go ?? w.open, () => ui.openDrawer({ kind: t.kind }), "outline");
  if (t.kind === "cantstart")
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="outline" size="xs" onClick={() => ui.openDrawer({ kind: "settings", tab: "accounts" })}>
          {fmt(w.alFixAccount, { account: t.account })}
        </Button>
        <Button size="xs" onClick={() => void leadStart(t.key)}>
          {w.signInRetry}
        </Button>
      </div>
    );
  if (t.kind === "crashed")
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={() => ui.openDrawer({ kind: "lead", key: t.key })}>
          {w.log}
        </Button>
        <Button size="xs" onClick={() => void leadStart(t.key)}>
          {w.startLead}
        </Button>
      </div>
    );
  if (t.kind === "signin")
    return (
      <div className="flex justify-end">
        <AccountSignIn account={t.account} tool={t.tool} label={fmt(w.addAccountSignIn, { tool: t.tool })} />
      </div>
    );
  if (t.kind === "leak") return <LeakActions f={t.finding} />;
  if (t.kind === "selfcheck") return <SelfCheckActions />;
  if (t.kind === "held")
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={() => void heldDismiss(t.id)}>
          {w.heldDismiss}
        </Button>
        {t.post ? (
          <Button variant="ghost" size="xs" onClick={() => void heldPost(t.id, t.key)}>
            {w.heldPost}
          </Button>
        ) : null}
      </div>
    );
  if (t.kind === "rule")
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="outline" size="xs" onClick={() => void ruleDismiss(t.id, "never")}>
          {w.ruleNever}
        </Button>
        <Button variant="outline" size="xs" onClick={() => void ruleDismiss(t.id, "later")}>
          {w.ruleLater}
        </Button>
        <Button variant="outline" size="xs" onClick={() => void ruleAdd(t.id)}>
          {w.ruleAdd}
        </Button>
      </div>
    );
  if (t.kind === "review")
    return (
      <div className="flex justify-end">
        <Button variant="ghost" size="xs" onClick={() => ui.openDrawer({ kind: "review", key: t.key })}>
          {w.review}
        </Button>
      </div>
    );
  if (t.kind === "ticket")
    return (
      <div className="flex justify-end">
        <AssignButton offer={{ project: "", key: t.key }} />
      </div>
    );
  if (t.kind !== "lead") return null;
  if (elsewhere) return <AnsweredElsewhere leadKey={t.key} onDone={() => setElsewhere(false)} />;
  if (!open)
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {a.stale ? (
          <Button variant="outline" size="xs" onClick={() => void leadAnswer(t.key, "", "dismiss")}>
            {w.dismissQuestion}
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" onClick={() => setElsewhere(true)}>
          {w.answeredElsewhere}
        </Button>
        <Button variant="answer" size="xs" onClick={() => setOpen(true)}>
          {w.yourAnswer}
        </Button>
      </div>
    );
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void leadAnswer(t.key, text.trim()).then(() => {
          setText("");
          setOpen(false);
        });
      }}
    >
      <Textarea aria-label={w.yourAnswer} value={text} onChange={(e) => setText(e.target.value)} className="min-h-20 text-sm" autoFocus />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
          {w.cancel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setOpen(false);
            setElsewhere(true);
          }}
        >
          {w.answeredElsewhere}
        </Button>
        <Button type="submit" variant="answer" size="xs" disabled={!text.trim()}>
          {w.sendAnswer}
        </Button>
      </div>
    </form>
  );
}

/** An action card's buttons: Overhand does what each says, with your authority; Show and Connect open Crew. */
function CardButtons({ card }: { card: ActionCard }) {
  const w = useWords();
  const ui = useUi();
  const { cardAct } = useActions();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {card.buttons.map((b) => (
        <Button
          key={b}
          variant={b === card.buttons[0] ? "outline" : "ghost"}
          size="xs"
          disabled={busy}
          onClick={() => {
            if (b === "show" || b === "connect") return ui.openDrawer({ kind: "crew" });
            setBusy(true);
            void cardAct(card.id, b).finally(() => setBusy(false));
          }}
        >
          {fmt(w[BUTTON_WORDS[b]], card.facts)}
        </Button>
      ))}
    </div>
  );
}

/**
 * "I answered elsewhere": you settled it outside Overhand (a terminal session, a chat), so the lead resumes. The one line
 * of what you decided is optional; without it the lead is told to re-read the current state.
 */
export function AnsweredElsewhere({ leadKey, onDone }: { leadKey: string; onDone: () => void }) {
  const w = useWords();
  const { leadAnswer } = useActions();
  const [note, setNote] = useState("");
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void leadAnswer(leadKey, note.trim(), "elsewhere").then(onDone);
      }}
    >
      <Label htmlFor={`elsewhere-${leadKey}`} className="text-xs text-muted-foreground">
        {w.answeredElsewhereNote}
      </Label>
      <Input
        id={`elsewhere-${leadKey}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={w.answeredElsewherePlaceholder}
        className="h-8 text-sm"
        autoFocus
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          {w.cancel}
        </Button>
        <Button type="submit" variant="outline" size="xs">
          {w.answeredElsewhereGo}
        </Button>
      </div>
    </form>
  );
}

/** Needs-you entries as one list: alerts as cards with what you can do in place, inbox items with their switch or reply. */
export function NeedsList({ list }: { list: readonly Need[] }) {
  const m = useModel();
  // an alert keyed by what it says (repeats numbered), not its place: answering one doesn't replay the entrance of every
  // card below it, and a new call arrives on its own
  const seen = new Map<string, number>();
  const keyOf = (a: Alert): string => {
    const base = `a-${a.item ?? a.title}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return `${base}-${k}`;
  };
  return (
    <ul className="grid gap-4">
      {list.map((n, i) =>
        "alert" in n ? (
          <li key={keyOf(n.alert)} data-id={n.alert.item} className="m-enter grid gap-2" style={{ "--i": Math.min(i, 6) } as CSSProperties}>
            {n.alert.explain ? (
              // the ? sits beside the card, not in it: the card is itself a button
              <div className="flex min-w-0 items-start gap-2">
                <AlertCard a={n.alert} brief={m ? n.alert.item : undefined} className="min-w-0 flex-1" />
                <Explain x={n.alert.explain} about={n.alert.title} className="mt-3" />
              </div>
            ) : (
              <AlertCard a={n.alert} brief={m ? n.alert.item : undefined} />
            )}
            {/* what it is, why, and the recommended action; the row's own actions when there's no brief */}
            {m && n.alert.item ? (
              <DecisionCard m={m} item={n.alert.item} compact fallback={<QuickActions a={n.alert} />} />
            ) : (
              <QuickActions a={n.alert} />
            )}
          </li>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: inbox lines have no id and keep their order
          <InboxRow key={`i-${i}`} x={n.item} className="need-row border-l-[3px] border-warn/70 pr-2 pl-3" />
        ),
      )}
    </ul>
  );
}

/** When Slack was last read, beside the list it fills: "Reading Slack…" while a pass runs, nothing before Slack is set up. */
export function SlackRead({ m, className }: { m: Model; className?: string }) {
  const w = useWords();
  const at = m.s.slackReadAt;
  if (!at) return null;
  const reading = m.s.running.some((r) => r.name === "inbox");
  return (
    <p className={cn("text-xs whitespace-nowrap text-muted-foreground", className)} data-slack-read aria-live="polite">
      {reading ? w.slackReading : fmt(w.slackReadAgo, { ago: ago(at) })}
    </p>
  );
}

/**
 * The first thing the eye lands on: everything that needs you in one list (alerts, lead questions, reviews, Slack
 * replies and requests), most urgent first. "All N" opens every one of them, with Slack's notes and filed requests.
 * `slice` picks the ones shown (a live piece on the site shows its own few); by default the first six.
 */
export function NeedsYou({ m, slice = (l) => l.slice(0, 6) }: { m: Model; slice?: (list: Need[]) => Need[] }) {
  const w = useWords();
  const ui = useUi();
  const list = needs(m);
  const shown = slice(list);
  // each call Needs you shows is counted once by the daemon (calls.ts); this week's number should keep falling
  const ids = list.map(callId).sort().join("\n");
  useEffect(() => {
    if (ids) void post("/api/calls", { ids: ids.split("\n") }, z.object({})).catch(() => {});
  }, [ids]);
  const { week, last } = m.s.calls;
  const calls =
    week || last ? fmt(last ? (week <= last ? w.callsWeekDown : w.callsWeekUp) : w.callsWeek, { n: week, last }) : w.callsCounting;
  const cut = calls.lastIndexOf(" ") + 1;
  const [head, tail] = [calls.slice(0, cut), calls.slice(cut)];
  return (
    <Pane
      title="paneAlerts"
      dataId="needs"
      count={list.length}
      countTone={needsTone(list)}
      subtitle={
        // day one, before anything is counted, it says it has started rather than showing nothing
        <span className="text-pretty">
          {head}
          {/* the "?" stays with the last word instead of wrapping onto a line of its own */}
          <span className="whitespace-nowrap">
            {tail} <Explain x={explainCalls(week, last, w)} about={w.callsAbout} className="align-middle" />
          </span>
        </span>
      }
      extra={
        <>
          {list.length ? (
            <Button variant="ghost" size="xs" className="-mr-1 text-muted-foreground" onClick={() => ui.openDrawer({ kind: "alerts" })}>
              {fmt(w.allCount, { n: list.length })}
              <ChevronRight aria-hidden="true" />
            </Button>
          ) : null}
        </>
      }
    >
      {shown.length ? (
        <NeedsList list={shown} />
      ) : (
        <>
          <p className="py-2 text-sm text-muted-foreground">
            <Term k="calm" />
          </p>
          {/* calm isn't empty: one thing worth knowing, and its next step */}
          <InsightLine m={m} surface="now" className="pt-0" />
        </>
      )}
      {/* under the list it fills, never in the header beside its count */}
      <SlackRead m={m} className="mt-1 text-right" />
    </Pane>
  );
}
