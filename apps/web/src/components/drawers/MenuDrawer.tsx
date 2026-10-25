import { plainWords, type WordKey } from "@overhand/themes";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { FeatureTip } from "@/components/FeatureTip";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DrawerHead } from "./DrawerHost";

/** How long the menu's quiet mode lasts; `overhand quiet <n>h` sets any other length. */

type Tone = "primary" | "secondary" | "state" | "quiet" | "danger";

const TONE: Record<Tone, { variant: "primary" | "outline" | "state" | "ghost"; className?: string }> = {
  primary: { variant: "primary" },
  secondary: { variant: "outline" },
  state: { variant: "state" },
  quiet: { variant: "ghost" },
  danger: { variant: "ghost", className: "border border-bad/45 text-bad hover:text-bad" },
};

/** One action: its name in the theme's words and, under it, what it does in plain ones. */
function Row({ title, sub, tone, go, onClick }: { title: ReactNode; sub?: string; tone: Tone; go?: boolean; onClick: () => void }) {
  const t = TONE[tone];
  return (
    <Button
      variant={t.variant}
      className={cn("h-auto min-h-11 w-full justify-between gap-3 py-2 text-left whitespace-normal", t.className)}
      onClick={onClick}
    >
      <span className="grid min-w-0 leading-tight">
        <span>{title}</span>
        {sub ? <span className="mt-0.5 text-xs font-normal opacity-75">{sub}</span> : null}
      </span>
      {go ? <ChevronRight aria-hidden="true" className="opacity-60" /> : null}
    </Button>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5" aria-label={label}>
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

/**
 * Actions only, never navigation or preferences (those are Now's sentence, the header's Pause and Settings): the next step first (resume, run what the next pass would start, or
 * plan the day when there's no plan), then today, running the agents, upkeep, and the
 * system behind a divider, with What's new (the feature registry) beside Suggest or report. Its length doesn't grow
 * with leads or themes.
 */
export function MenuDrawer({ m }: { m: Model }) {
  const w = useWords();
  const { run } = useActions();
  const ui = useUi();
  /** What a row does in plain words: the plain name when the theme renames it, else the hint. */
  const says = (k: WordKey, hint: string) => (w[k] === plainWords[k] ? hint : plainWords[k]);
  // nothing the next pass would start (armed tickets already in review don't count): with no plan yet, planning is next
  const unplanned = !m.s.paused && !m.armed && !Object.values(m.plan.clients).some((c) => c.agent.length);
  return (
    <>
      <DrawerHead kicker={w.menuKicker} named="menuTitle" />
      <div className="mt-4 grid gap-4">
        {m.s.paused ? (
          <Section label={w.menuNext}>
            <Row tone="primary" title={w.resume} sub={w.pausedResumes} onClick={() => run({ name: "resume" })} />
          </Section>
        ) : m.armed ? (
          <Section label={w.menuNext}>
            <Row tone="primary" title={fmt(w.startArmed, { n: m.armed })} sub={w.menuArmedHint} onClick={() => run({ name: "work" })} />
          </Section>
        ) : unplanned ? (
          <Section label={w.menuNext}>
            <Row tone="primary" title={w.planDay} sub={says("planDay", w.cmdPlan)} onClick={() => run({ name: "plan" })} />
          </Section>
        ) : null}
        <Section label={w.menuToday}>
          <Row tone="secondary" title={w.briefMe} sub={says("briefMe", w.cmdBrief)} onClick={() => run({ name: "brief" })} />
          <FeatureTip at="menu-brief" />
          <Row tone="secondary" title={w.share} sub={says("share", w.shareHint)} onClick={() => run({ name: "share" })} />
          {unplanned ? null : (
            <Row tone="secondary" title={w.planDay} sub={says("planDay", w.cmdPlan)} onClick={() => run({ name: "plan" })} />
          )}
        </Section>
        {/* pausing is a switch under the header's Pause; the views open from Now's sentence */}
        <Section label={w.menuRun}>
          <Row tone="secondary" title={`${w.overdrive}…`} sub={w.menuOverdriveHint} onClick={() => run({ name: "overdrive" })} />
          <Row tone="quiet" title={`${w.sweep}…`} sub={says("sweep", w.cmdSweep)} onClick={() => run({ name: "sweep" })} />
          <FeatureTip at="menu-sweep" />
        </Section>
        <hr className="border-border" />
        <Section label={w.menuSystem}>
          <Row tone="quiet" title={w.whatsNew} sub={w.whatsNewHint} go onClick={() => ui.openDrawer({ kind: "news" })} />
          <Row tone="quiet" title={`${w.feedback}…`} sub={w.feedbackHint} onClick={() => run({ name: "feedback" })} />
          <FeatureTip at="menu-feedback" />
          <Row tone="quiet" title={`${w.restartOps}…`} onClick={() => run({ name: "restart" })} />
          <Row tone="danger" title={w.shutdown} sub={w.shutdownHint} onClick={() => run({ name: "shutdown" })} />
        </Section>
      </div>
    </>
  );
}
