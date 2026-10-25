import { AUTONOMY_LEVELS, type QuickSetting } from "@overhand/contract";
import { useQueryClient } from "@tanstack/react-query";
import { Pause } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useActions } from "@/app/actions";
import { type Model, STATE_KEY } from "@/app/data";
import { useTheme } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { post } from "@/lib/api";
import { fmt, hm, uptime } from "@/lib/format";
import { LEVEL_WORDS, MEANS_WORDS } from "@/lib/leads";

const Ok = z.object({});
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

/** Quiet mode's switch, live: under the header's Pause and on the menu bar item's popover. */
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
 * level means in one line, the same words Settings uses. Live on the site as the rules piece.
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
 * Pause, one tap from the header: pausing new work and quiet mode, each live (no Save). Every other setting has its one
 * home in Settings, one link away. Paused, the button says so in amber.
 */
export function QuickSettings({ m }: { m: Model }) {
  const { words: w } = useTheme();
  const { run } = useActions();
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={m.s.paused ? "state" : "ghost"}
              size="sm"
              aria-label={w.quickSettings}
              data-hot={m.s.paused ? "" : undefined}
              className="hdr-act max-xl:size-8 max-xl:px-0"
            >
              <Pause aria-hidden="true" />
              <span className="hidden xl:inline">{m.s.paused ? w.pausedShort : w.pauseShort}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{w.quickSettings}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" aria-label={w.quickSettings} className="grid max-h-[80dvh] w-80 gap-3 overflow-y-auto">
        <b data-heading="" className="font-display text-sm">
          {w.quickSettings}
        </b>
        <Row label={w.pause} hint={w.pauseHint}>
          <Switch aria-label={w.pause} checked={m.s.paused} onCheckedChange={(on) => void run({ name: on ? "pause" : "resume" })} />
        </Row>
        <QuietRow m={m} />
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
