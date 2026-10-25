import { CheckIcon } from "lucide-react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { changedText, proofLine, STEP_WORDS, stepStates, winSpent } from "@/lib/firstwin";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Checkup } from "../Checkup";
import { Dot, Muted, Pane } from "../Pane";
import { Tonight } from "./Tonight";

/**
 * "Your first win": the one small safe task Overhand picked from your repos right after setup, and where it stands.
 * While it runs, a checklist that ticks over as the run reaches each step (read from its own output; what it last did
 * behind Details) and three cards that set up tonight. Done is its own state: in green, with how long it took, what it
 * cost, what changed and the proof in a sentence, and Review. Gone a few days after it ends.
 */
export function FirstWin({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  const { run } = useActions();
  const win = m.s.firstWin;
  if (!win) return null;
  const live = m.s.running.find((r) => r.name === win.key);
  const minutes = live ? Math.max(1, Math.round((m.s.now - live.startedAt) / 60_000)) : 0;
  const tracked = m.s.prs.find((p) => p.key === win.key);
  const said = live ? m.s.sessions.find((x) => x.pid === live.pid && live.pid)?.lastAction : "";
  const done = win.state === "pr" || win.state === "report";
  const line = {
    looking: w.winLooking,
    queued: m.s.paused ? w.winWaiting : w.winQueued,
    running: minutes ? fmt(w.winRunningFor, { n: minutes }) : w.winRunning,
    pr: "",
    report: w.winReport,
    failed: w.winFailed,
    none: fmt(w.winNone, { label: m.s.labels.queue }),
  }[win.state];
  const spent = done ? winSpent(win, w) : "";
  const proof = tracked?.proof;
  return (
    <Pane title="paneFirstWin" dataId="first-win">
      {/* the pane's body is one block: the win (marked green once done), then tonight or the rest of the check-up */}
      <div className="grid gap-4">
        <div className={cn("grid gap-3", done && "border-l-2 border-ok pl-3")}>
          <div className="grid gap-1.5" aria-live="polite">
            {win.state === "pr" ? (
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ok">
                <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
                {w.winPr}
              </p>
            ) : null}
            {win.title ? (
              <p className="flex items-baseline gap-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                {win.state === "running" ? <Dot color="var(--primary)" on /> : null}
                {win.title}
              </p>
            ) : null}
            {win.repo ? <p className="text-xs text-muted-foreground">{fmt(w.winWhere, { project: win.project, repo: win.repo })}</p> : null}
            {spent ? <p className="text-xs text-muted-foreground tabular-nums">{spent}</p> : null}
            {line ? <Muted>{line}</Muted> : null}
          </div>
          {win.state === "running" ? (
            <>
              <ol className="grid gap-1 text-sm" aria-label={w.paneFirstWin}>
                {stepStates(win.step).map(({ step, at }) => (
                  <li
                    key={step}
                    aria-current={at === "now" ? "step" : undefined}
                    className={cn("flex items-center gap-2", at === "next" && "text-muted-foreground")}
                  >
                    {at === "done" ? (
                      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
                    ) : (
                      <span className="flex size-3.5 shrink-0 items-center justify-center">
                        <Dot color={at === "now" ? "var(--primary)" : "var(--border)"} on={at === "now"} />
                      </span>
                    )}
                    {w[STEP_WORDS[step]]}
                  </li>
                ))}
              </ol>
              {said ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
                    {w.decDetails}
                  </summary>
                  <p className="mt-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{said}</p>
                </details>
              ) : null}
            </>
          ) : null}
          {/* done: what changed and the proof, in words a newcomer reads */}
          {win.state === "pr" && proof ? (
            <div className="grid gap-1 text-sm">
              <p>
                {changedText(proof, w)}
                {proof.areas.length ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{proof.areas.join(" · ")}</span>
                ) : null}
              </p>
              {proofLine(proof, w) ? <p>{proofLine(proof, w)}</p> : null}
            </div>
          ) : null}
          {/* what the agent did and how it proved it (its summary), a watch project's report, or why it failed */}
          {win.message && (done || win.state === "failed") ? (
            <p className="line-clamp-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{win.message}</p>
          ) : null}
          {win.state === "pr" ? (
            <div className="flex justify-end">
              {tracked ? (
                <Button size="sm" onClick={() => ui.openDrawer({ kind: "review", key: win.key })}>
                  {w.review}
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <a href={win.url} target="_blank" rel="noopener noreferrer">
                    {w.openPr}
                  </a>
                </Button>
              )}
            </div>
          ) : win.state === "none" ? (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => void run({ name: "plan" })}>
                {w.planDay}
              </Button>
            </div>
          ) : null}
        </div>
        {/* while it runs and once it's done: tonight, one click each; after a miss, the rest of the check-up */}
        {["queued", "running", "pr", "report"].includes(win.state) ? <Tonight m={m} win={win} /> : null}
        {["failed", "none"].includes(win.state) ? <Checkup only={win.repo || undefined} tasksOnly limit={3} /> : null}
      </div>
    </Pane>
  );
}
