import { Ellipsis, Search, Settings, Volume2, VolumeX } from "lucide-react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useSound } from "@/app/sound";
import { Named, useTheme } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmt, hm, uptime } from "@/lib/format";
import { resumesAt } from "@/lib/pipeline";
import { cn } from "@/lib/utils";
import { stopSpeaking, useSpeaking } from "@/lib/voice";
import { Logo } from "./Logo";
import { Dot } from "./Pane";
import { QuickSettings } from "./QuickSettings";
import { Facepile } from "./team/Facepile";

/** The status line: is ops online, paused, working? */
function StatusLine({ m, unreachable }: { m: Model | undefined; unreachable: boolean }) {
  const w = useTheme().words;
  const ui = useUi();
  // only while the processor or memory is red: a quiet signal that opens This machine in Health
  const busy = m?.s.governor.strain.gauges.some((g) => (g.what === "cpu" || g.what === "mem") && g.level === "bad") ?? false;
  let color = "var(--ok)";
  let text = w.stateIdle;
  let live = false;
  if (unreachable || !m) {
    color = "var(--bad)";
    text = unreachable ? w.stateUnreachable : w.loading;
  } else if (!m.s.daemon) {
    color = "var(--bad)";
    text = w.stateOffline;
  } else if (m.s.paused) {
    color = "var(--warn)";
    text = m.s.pauseReason || w.statePaused;
  } else if (m.s.governor.quietUntil > Date.now()) {
    color = "var(--warn)";
    text = fmt(w.stateQuiet, { left: uptime((m.s.governor.quietUntil - Date.now()) / 1000) });
  } else if (m.s.running.length) {
    text = w.stateAgentWorking;
    live = true;
  } else if (resumesAt(m.s)) {
    color = "var(--warn)";
    text = fmt(w.stateWaitLimit, { t: hm(resumesAt(m.s)) });
  } else {
    const n = m.s.godmode.filter((g) => g.running).length;
    if (n) text = n > 1 ? w.stateLeadsWorking : w.stateLeadWorking;
    live = n > 0;
  }
  return (
    <div
      className="flex min-w-0 shrink items-center gap-2 text-sm whitespace-nowrap text-muted-foreground xl:shrink-0"
      role="status"
      aria-live="polite"
      title={text}
    >
      <Dot color={color} on={live} />
      {/* on a phone the actions need the room: the status is its dot, its words still read out (and on hover), never
          cut to "C…"; from 768 its words show */}
      <span className="truncate max-md:sr-only">{text}</span>
      {busy ? (
        <button type="button" className="shrink-0 text-(--bad) hover:underline" onClick={() => ui.openDrawer({ kind: "health" })}>
          · {w.stateBusy}
        </button>
      ) : null}
    </div>
  );
}

/** An icon button with a visible tooltip and an accessible name. */
function IconAction({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} aria-pressed={pressed} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Night report, read aloud; while the voice reads, this is its Stop. One button, so focus stays on it as it turns.
 * The header holds it on a computer; on a phone it sits beside Now's sentence.
 */
export function NightReport({ className }: { className?: string }) {
  const w = useTheme().words;
  const { run } = useActions();
  const talking = useSpeaking();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          key={talking ? "stop" : "brief"}
          variant="outline"
          size="sm"
          className={cn("hdr-act m-enter shrink-0 max-2xl:[&_.named-plain]:hidden", className)}
          onClick={() => (talking ? stopSpeaking() : void run({ name: "brief" }))}
        >
          {talking ? <Named k="briefStop" inline /> : <Named k="briefMe" inline />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{talking ? w.briefStopHint : w.cmdBrief}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Top bar, calm: the logo and status, then the Night report, Pause (quiet mode and the day-to-day switches inside it),
 * the command bar (every other action lives there), Settings and more. Now's sentence carries the money and the next
 * meeting. On a phone: logo, status dot, Pause, the command icon, Settings and more; the Night report sits on Now.
 */
export function Header({ m, unreachable }: { m: Model | undefined; unreachable: boolean }) {
  const { words: w } = useTheme();
  const { run } = useActions();
  const ui = useUi();
  const sound = useSound();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="app-header sticky top-0 z-40 border-b border-primary/15 bg-background/75 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[3200px] items-center gap-3 px-4 short:h-11 lg:h-16 lg:gap-2.5 lg:px-6">
        <Logo />
        <StatusLine m={m} unreachable={unreachable} />
        <div className="flex-1" />
        {/* who's here: teammates online, each one click from following */}
        {m && !m.s.setup ? <Facepile m={m} /> : null}
        {/* before setup there's nothing to plan, pause or brief on: the wizard is the only thing to do */}
        {!m || m.s.setup ? (
          <IconAction label={sound.on ? w.soundOff : w.soundOn} pressed={sound.on} onClick={sound.toggle}>
            {sound.on ? <Volume2 /> : <VolumeX />}
          </IconAction>
        ) : (
          <div className="m-enter flex shrink-0 items-center gap-1.5">
            {m.s.clients.length ? <NightReport className="max-lg:hidden" /> : null}
            <QuickSettings m={m} />
            <Button
              variant="outline"
              size="sm"
              aria-label={w.askAnything}
              // a search button until 1280: at 1024 who's here and the actions need its room; from 1280 the field is wide
              // enough to say "Ask or do anything" whole
              className="hdr-act hdr-ask max-xl:size-8 max-xl:px-0 xl:w-60 xl:justify-start xl:font-normal 2xl:w-64"
              onClick={() => ui.setPaletteOpen(true)}
            >
              <Search aria-hidden="true" />
              <span className="hidden truncate xl:inline">{w.askAnything}</span>
              <kbd className="ml-auto hidden rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground xl:inline">
                {mac ? "⌘K" : "Ctrl K"}
              </kbd>
            </Button>
            <IconAction label={w.settings} onClick={() => ui.openDrawer({ kind: "settings" })}>
              <Settings />
            </IconAction>
            <IconAction label={w.more} onClick={() => run({ name: "menu" })}>
              <Ellipsis />
            </IconAction>
          </div>
        )}
      </div>
    </header>
  );
}
