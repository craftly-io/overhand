import { Ellipsis, Search, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import { useActions } from "@/app/actions";
import { type Model, useNow } from "@/app/data";
import { useSound } from "@/app/sound";
import { Named, useTheme } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Command } from "@/lib/commands";
import { explainSpend } from "@/lib/explain";
import { fmt, hm, uptime } from "@/lib/format";
import { resumesAt } from "@/lib/pipeline";
import { headline } from "@/lib/spend";
import { stopSpeaking, useSpeaking } from "@/lib/voice";
import { Explain } from "./Explain";
import { Logo } from "./Logo";
import { Dot } from "./Pane";
import { PlaceNav } from "./PlaceBar";
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
      {/* below 1280 the places, who's here and the actions need the room: the status is its dot, its words still read
          out (and on hover), never cut to "C…"; from 1280 its words keep their width and a long meeting title gives way */}
      <span className="truncate max-xl:sr-only">{text}</span>
      {busy ? (
        <button type="button" className="shrink-0 text-(--bad) hover:underline" onClick={() => ui.openDrawer({ kind: "health" })}>
          · {w.stateBusy}
        </button>
      ) : null}
    </div>
  );
}

/** The next meeting from the calendar, if one is on today. */
function NextMeeting({ m, now }: { m: Model; now: number }) {
  const w = useTheme().words;
  const cal = Array.isArray(m.s.status.calendar) ? m.s.status.calendar : [];
  const next = cal.find((e) => !e.allDay && e.end > now);
  if (!next) return null;
  const mins = Math.round((next.start - now) / 60000);
  const when = next.start <= now ? w.meetingNow : mins < 90 ? fmt(w.meetingIn, { n: mins }) : hm(next.start);
  return (
    <span className="flex max-w-72 min-w-0 items-center gap-1.5 after:text-muted-foreground after:content-['·']">
      <b className="font-medium text-foreground">{when}</b>
      {/* a long meeting title may end in "…": the one cut the header allows (release/shots.ts) */}
      <span className="truncate" data-truncates>
        {next.title}
      </span>
    </span>
  );
}

/** The time, and under it the date; until the header is wide enough for its own line, today's money rides along. */
function Clock({ now, spent }: { now: number; spent?: { label: string; value: string } }) {
  const d = new Date(now);
  return (
    <div className="shrink-0 text-right whitespace-nowrap tabular-nums">
      <div className="readout hud-glow text-xl leading-none tracking-[0.08em] sm:text-2xl">{hm(now)}</div>
      <div className="hidden text-xs text-muted-foreground sm:block short:hidden">
        {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
        {/* plans with no usage reading yet have no figure: then nothing rides along, not a bare separator */}
        {spent?.value ? (
          <span className="2xl:hidden" title={spent.label}>
            {" "}
            · <b className="font-medium text-foreground">{spent.value}</b>
            <span className="sr-only"> {spent.label}</span>
          </span>
        ) : null}
      </div>
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
 * The one action most likely next, from the state: Resume while paused, Pause while agents work, Plan the day before
 * there's a plan, else Brief me; nothing before there's a project. Only Pause and Resume take the amber state colour.
 */
function SmartAction({ m }: { m: Model }) {
  const w = useTheme().words;
  const { run } = useActions();
  const talking = useSpeaking();
  const busy = m.s.running.length > 0 || m.s.godmode.some((g) => g.running);
  // while the voice reads, this is its Stop, whatever it was before
  const [cmd, label, hint]: [Command | null, ReactNode, string] = talking
    ? [null, <Named key="stop" k="briefStop" inline />, w.briefStopHint]
    : m.s.paused
      ? [{ name: "resume" }, <Named key="resume" k="resume" inline />, w.pausedResumes]
      : busy
        ? [{ name: "pause" }, <Named key="pause" k="pause" inline />, w.pauseHint]
        : !m.plan.top.length
          ? [{ name: "plan" }, <Named key="plan" k="planDay" inline />, w.planDayHint]
          : [{ name: "brief" }, <Named key="brief" k="briefMe" inline />, w.cmdBrief];
  const hot = cmd?.name === "pause" || cmd?.name === "resume";
  // with no projects there's nothing to plan or brief on: the first-run card holds the next step
  if (!m.s.clients.length && !hot && !talking) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          // Brief me and its Stop are one button, so focus stays on it as it turns
          key={cmd ? cmd.name : "brief"}
          variant={hot ? "state" : "outline"}
          size="sm"
          className="hdr-act m-enter shrink-0 max-2xl:[&_.named-plain]:hidden"
          data-hot={hot ? "" : undefined}
          onClick={() => (cmd ? run(cmd) : stopSpeaking())}
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Top bar, calm: the logo and status; the next event and spend in one quiet line; then one smart action, the command
 * button (every other action lives in the command bar), quick settings, more, and the clock. On a phone: logo, status dot,
 * the smart action, the command icon and more.
 */
export function Header({ m, unreachable }: { m: Model | undefined; unreachable: boolean }) {
  const { words: w } = useTheme();
  const { run } = useActions();
  const ui = useUi();
  const sound = useSound();
  const now = useNow(1000);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const head = m ? headline(m.s, w) : undefined;

  return (
    <header className="app-header sticky top-0 z-40 border-b border-primary/15 bg-background/75 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[3200px] items-center gap-3 px-4 short:h-11 lg:h-16 lg:gap-2.5 lg:px-6">
        <Logo />
        <StatusLine m={m} unreachable={unreachable} />
        {m && !m.s.setup && m.s.clients.length ? <PlaceNav m={m} /> : null}
        {m && !m.s.setup ? (
          <div className="hidden min-w-0 items-center gap-2 border-l border-border pl-3 text-xs whitespace-nowrap text-muted-foreground 2xl:flex">
            <NextMeeting m={m} now={now} />
            <span>
              {head?.label} <b className="font-medium text-foreground tabular-nums">{head?.value}</b>{" "}
              <Explain x={explainSpend(m.s, w)} about={head?.label ?? ""} />
            </span>
          </div>
        ) : null}
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
            <SmartAction m={m} />
            <Button
              variant="outline"
              size="sm"
              aria-label={w.askAnything}
              // a search button until 1280: at 1024 the places, who's here and the clock need its room; from 1280 the field
              // is wide enough to say "Ask or do anything" whole
              className="hdr-act hdr-ask max-xl:size-8 max-xl:px-0 xl:w-60 xl:justify-start xl:font-normal 2xl:w-64"
              onClick={() => ui.setPaletteOpen(true)}
            >
              <Search aria-hidden="true" />
              <span className="hidden truncate xl:inline">{w.askAnything}</span>
              <kbd className="ml-auto hidden rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground xl:inline">
                {mac ? "⌘K" : "Ctrl K"}
              </kbd>
            </Button>
            <QuickSettings m={m} />
            <IconAction label={w.more} onClick={() => run({ name: "menu" })}>
              <Ellipsis />
            </IconAction>
          </div>
        )}
        <span className="hidden sm:contents">
          <Clock now={now} spent={m && !m.s.setup ? head : undefined} />
        </span>
      </div>
    </header>
  );
}
