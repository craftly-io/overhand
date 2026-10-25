import { AUTONOMY_LEVELS, type QuickSetting } from "@overhand/contract";
import { useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useActions } from "@/app/actions";
import { type Model, STATE_KEY } from "@/app/data";
import { setFocus, useFocus } from "@/app/focus";
import { useMapMode } from "@/app/mapMode";
import { useSound } from "@/app/sound";
import { store } from "@/app/store";
import { useTheme } from "@/app/theme";
import { useUi } from "@/app/ui";
import { FeatureTip } from "@/components/FeatureTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { post } from "@/lib/api";
import { fmt, hm, uptime } from "@/lib/format";
import { LEVEL_WORDS, MEANS_WORDS } from "@/lib/leads";
import { budgetApplies } from "@/lib/spend";

const Ok = z.object({});
/** The budget a switched-off cap comes back at: the last one set in this browser, else a first day's. */
const LAST_BUDGET = "overhand-last-budget";
/** How long "I need my laptop" lasts when switched on. */
const QUIET_HOURS = 3;

/** One switch row: the label, a line under it, the switch. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-sm">
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** Quiet mode's switch, live: in Quick settings and on the menu bar item's popover. */
export function QuietRow({ m }: { m: Model }) {
  const { words: w } = useTheme();
  const { quiet } = useActions();
  const quietUntil = m.s.governor.quietUntil;
  const quietOn = quietUntil > Date.now();
  return (
    <Row
      label={w.quiet}
      hint={
        quietOn
          ? fmt(w.quietEndHint, { time: hm(quietUntil), left: uptime((quietUntil - Date.now()) / 1000) })
          : fmt(w.quietHint, { n: QUIET_HOURS })
      }
    >
      <Switch aria-label={w.quiet} checked={quietOn} onCheckedChange={(on) => void quiet(on ? QUIET_HOURS : 0)} />
    </Row>
  );
}

/** Saves one quick setting, live, and refreshes the state; a refusal (the demo's, a daemon error) shows as a toast. */
export function useQuickSave(): (q: QuickSetting) => Promise<void> {
  const qc = useQueryClient();
  return async (q) => {
    try {
      await post("/api/settings/quick", q, Ok);
      void qc.invalidateQueries({ queryKey: STATE_KEY });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
}

/**
 * How far agents go on each project, one row each: its name, the level (saved as soon as it's picked) and what that
 * level means in one line, the same words Settings uses. In quick settings, and live on the site as the rules piece.
 */
export function ProjectRules({ m }: { m: Model }) {
  const { words: w } = useTheme();
  const save = useQuickSave();
  if (!m.s.clients.length) return null;
  return (
    <div className="grid gap-2">
      <span className="text-sm">{w.quickProjects}</span>
      {m.s.clients.map((c) => (
        <div key={c.name} data-id={c.name} className="grid gap-0.5">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{c.name}</span>
            <select
              className="h-8 max-w-44 rounded-(--radius-control) border border-input bg-(--ink-2) px-1.5 text-xs text-foreground"
              value={c.autonomy}
              onChange={(e) => {
                const level = AUTONOMY_LEVELS.find((l) => l === e.target.value);
                if (level) void save({ project: c.name, autonomy: level });
              }}
            >
              {[...AUTONOMY_LEVELS].reverse().map((l) => (
                // Ship can't be picked where green means nothing; a project already on it can still leave it
                <option
                  key={l}
                  value={l}
                  disabled={l === "ship" && Boolean(c.shipBlock) && c.autonomy !== "ship"}
                  title={l === "ship" ? c.shipBlock || undefined : undefined}
                >
                  {w[LEVEL_WORDS[l]]}
                </option>
              ))}
            </select>
          </label>
          {/* keyed by the mode: a new mode's meaning enters, rather than its words swapping in place */}
          <p key={c.autonomy} className="m-enter text-xs text-pretty text-muted-foreground">
            {w[MEANS_WORDS[c.autonomy]]}
            {c.shipBlock && c.host === "github" ? ` ${c.shipBlock}${c.autonomy === "ship" ? ` ${w.shipStays}` : ""}` : ""}
          </p>
          {/* hosted runs, only where this computer can use them (switched on, linked, on a plan) and on GitHub */}
          {m.s.hosted && c.host === "github" ? (
            <Row label={w.hostedHere} hint={w.hostedHereHint}>
              <Switch
                aria-label={`${w.hostedHere}: ${c.name}`}
                checked={Boolean(c.hosted)}
                onCheckedChange={(on) => void save({ project: c.name, hosted: on })}
              />
            </Row>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Quick settings, one tap from the header: the day-to-day switches, each one live (no Save) and each one the same
 * setting Settings shows: Focus, pause, quiet mode, the daily budget, pacing, the menu bar item, the scene, sound, and how far agents go on each
 * project. Everything else stays in Settings, one link away.
 */
export function QuickSettings({ m }: { m: Model }) {
  const { words: w } = useTheme();
  const { run } = useActions();
  const ui = useUi();
  const sound = useSound();
  const [motion, setMotion] = useMapMode();
  const focus = useFocus();
  const [open, setOpen] = useState(false);
  const budgetId = useId();

  const budget = m.s.budgetUsd;
  const [amount, setAmount] = useState("");

  const save = useQuickSave();
  const setBudget = (usd: number) => {
    if (usd > 0) store.set(LAST_BUDGET, String(usd));
    void save({ budgetUsd: usd });
  };
  // pacing reads the weekly window Claude Code reports; no Claude account, nothing to pace
  const paceable = m.s.accounts.some((a) => a.runtime === "claude-code");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={w.quickSettings}>
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{w.quickSettings}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="grid max-h-[80dvh] w-80 gap-3 overflow-y-auto">
        <b data-heading="" className="font-display text-sm">
          {w.quickSettings}
        </b>
        <Row label={w.focus} hint={w.focusHint}>
          <Switch aria-label={w.focus} checked={focus} onCheckedChange={setFocus} />
        </Row>
        <FeatureTip at="quick-focus" />
        <Row label={w.pause} hint={w.pauseHint}>
          <Switch aria-label={w.pause} checked={m.s.paused} onCheckedChange={(on) => void run({ name: on ? "pause" : "resume" })} />
        </Row>
        <QuietRow m={m} />
        {/* the budget caps billed money only: with every account on a plan or this computer, it says it doesn't apply */}
        <Row
          label={w.quickBudget}
          hint={[budgetApplies(m.s) ? w.quickBudgetHint : w.quickBudgetNA, w.budgetUnknown, w.plansLimit].join(" ")}
        >
          <Switch
            aria-label={w.quickBudget}
            checked={budget > 0}
            onCheckedChange={(on) => setBudget(on ? Number(store.get(LAST_BUDGET)) || 10 : 0)}
          />
        </Row>
        {budget > 0 ? (
          <label htmlFor={budgetId} className="-mt-1 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">$</span>
            <Input
              key={budget}
              id={budgetId}
              type="number"
              min={1}
              step={1}
              aria-label={w.quickBudgetAmount}
              defaultValue={budget}
              className="h-8 w-24"
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => {
                const usd = Number(amount);
                if (amount && usd > 0 && usd !== budget) setBudget(usd);
              }}
            />
          </label>
        ) : null}
        {paceable ? (
          <Row label={w.quickPace} hint={w.quickPaceHint}>
            <Switch aria-label={w.quickPace} checked={m.s.paceWeekly} onCheckedChange={(on) => void save({ paceWeekly: on })} />
          </Row>
        ) : null}
        {/* only where this computer has one: a Mac with the helper installed */}
        {m.s.menubar !== null ? (
          <Row label={w.menubar} hint={w.menubarHint}>
            <Switch aria-label={w.menubar} checked={m.s.menubar} onCheckedChange={(on) => void save({ menubar: on })} />
          </Row>
        ) : null}
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm">{w.sceneSetting}</legend>
          <div className="seg flex gap-1.5">
            {(
              [
                ["on", w.sceneOn],
                ["still", w.sceneStill],
              ] as const
            ).map(([v, name]) => (
              <Button key={v} variant="outline" size="xs" aria-pressed={motion === v} onClick={() => setMotion(v)}>
                {name}
              </Button>
            ))}
          </div>
        </fieldset>
        <Row label={w.soundSetting} hint={w.soundChimes}>
          <Switch aria-label={sound.on ? w.soundOff : w.soundOn} checked={sound.on} onCheckedChange={sound.toggle} />
        </Row>
        <ProjectRules m={m} />
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start px-0 text-muted-foreground"
          onClick={() => {
            setOpen(false);
            ui.openDrawer({ kind: "settings" });
          }}
        >
          {w.quickAll}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
