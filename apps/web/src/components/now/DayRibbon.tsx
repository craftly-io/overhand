import type { CSSProperties } from "react";
import { type Model, useNow } from "@/app/data";
import { useWords } from "@/app/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmt, hm, money } from "@/lib/format";

/** Position on a 24-hour track, in percent. */
export const dayPct = (ms: number) => {
  const d = new Date(ms);
  return ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
};
/** Colour of an activity line, from the emoji ops logs it with. */
export const tone = (line: string) =>
  /✅|🎉|🎫/.test(line) ? "var(--ok)" : /✗|⚠|🛑/.test(line) ? "var(--bad)" : /❓|⏸/.test(line) ? "var(--warn)" : "var(--muted-foreground)";

/** Lines and runs this close together share one mark: a mark each grew the page all day (hundreds by evening). */
const MARK_MIN = 5;
const SEVERITY = ["var(--muted-foreground)", "var(--ok)", "var(--warn)", "var(--bad)"];

/**
 * The day's activity lines as ticks on the 24-hour track: where (percent), the time and lines, and the line that sets
 * its colour (the most severe). Lines within `bucketMin` of each other share a tick, so a day has at most 1440 /
 * `bucketMin` of them however busy it gets.
 */
export function dayTicks(reports: readonly string[], bucketMin = MARK_MIN): { at: number; text: string; line: string }[] {
  const out = new Map<number, { at: number; texts: string[]; line: string }>();
  for (const l of reports) {
    const x = l.match(/^- (\d\d):(\d\d) (.*)$/);
    if (!x) continue;
    const slot = Math.floor((Number(x[1]) * 60 + Number(x[2])) / bucketMin);
    const text = `${x[1]}:${x[2]} ${x[3]}`;
    const had = out.get(slot);
    if (!had) out.set(slot, { at: ((slot * bucketMin) / 1440) * 100, texts: [text], line: l });
    else {
      had.texts.push(text);
      if (SEVERITY.indexOf(tone(l)) > SEVERITY.indexOf(tone(had.line))) had.line = l;
    }
  }
  return [...out.values()].map(({ at, texts, line }) => ({
    at,
    text: texts.length > 3 ? [...texts.slice(0, 3), `and ${texts.length - 3} more`].join("\n") : texts.join("\n"),
    line,
  }));
}

export interface Bar {
  name: string;
  account?: string;
  start: number;
  end: number;
  cost: number;
  ok: boolean;
  live: boolean;
}

/**
 * Runs as bars below the track: runs that touch or overlap (within `gapMin`) and ended the same way (live, done,
 * failed) are one bar named for how many it holds, so a busy day draws a few dozen bars rather than one per run.
 */
export function runBars(runs: readonly Bar[], gapMin = MARK_MIN): (Bar & { count: number })[] {
  const out: (Bar & { count: number })[] = [];
  const kind = (r: Bar) => (r.live ? "live" : r.ok ? "ok" : "bad");
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    const same = out.findLast((b) => kind(b) === kind(r));
    if (same && r.start - same.end <= gapMin * 60_000) {
      same.end = Math.max(same.end, r.end);
      same.cost += r.cost;
      same.count++;
    } else out.push({ ...r, count: 1 });
  }
  return out;
}

/** Today's runs as spans: the finished ones, and each one under way running to `now`. */
export function dayRuns(m: Model, now: number): Bar[] {
  const runs: Bar[] = m.s.runs.flatMap((r) => (r.start && r.end ? [{ ...r, start: r.start, end: r.end, live: false }] : []));
  for (const cur of m.s.running)
    runs.push({ name: cur.name, account: cur.account, start: cur.startedAt, end: now, cost: 0, ok: true, live: true });
  return runs;
}

/**
 * One mark on the ribbon: named for screen readers and on hover, but not a control. The marks sit a few pixels apart,
 * so as buttons they were dozens of overlapping tab stops and too small to tap; every line is also in the day so far.
 */
function Mark({ label, className, style }: { label: string; className: string; style: CSSProperties }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className={`absolute ${className}`} style={style} />
      </TooltipTrigger>
      <TooltipContent className="max-w-80 whitespace-pre-line">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The day as one ribbon: meetings above the track, agent runs below, activity as ticks, the hours behind you lit. */
export function DayRibbon({ m }: { m: Model }) {
  const now = useNow(30_000);
  const w = useWords();
  const cal = Array.isArray(m.s.status.calendar) ? m.s.status.calendar.filter((e) => !e.allDay) : [];
  const runs = dayRuns(m, now);
  const ticks = dayTicks(m.s.reports);
  const bars = runBars(runs);
  return (
    <div className="relative h-16">
      <div
        aria-hidden="true"
        className="hud-sweep absolute top-6 left-0 h-px bg-linear-to-r from-transparent via-primary/60 to-warn shadow-[0_0_8px_var(--primary)]"
        style={{ width: `${dayPct(now)}%` }}
      />
      {cal.map((e) => (
        <Mark
          key={`${e.start}-${e.title}`}
          label={`${hm(e.start)}–${hm(e.end)} ${e.title}`}
          className="top-0 h-3.5 min-w-1 border border-foreground/50 bg-foreground/15"
          style={{ left: `${dayPct(e.start)}%`, width: `${Math.max(0.3, dayPct(e.end) - dayPct(e.start))}%` }}
        />
      ))}
      <div className="absolute inset-x-0 top-6 h-px bg-border" />
      {ticks.map((t) => (
        <Mark
          key={t.at}
          label={t.text}
          className="top-[18px] h-3 w-1 -translate-x-1/2"
          style={{ left: `${t.at}%`, background: tone(t.line) }}
        />
      ))}
      {bars.map((r) => (
        <Mark
          key={`${r.name}-${r.start}`}
          label={`${hm(r.start)}–${hm(r.end)} ${r.count > 1 ? `${r.count} runs` : r.name}${r.count === 1 && r.account ? ` · ${r.account}` : ""}${r.cost ? ` · ${fmt(w.runApiPrice, { cost: money(r.cost) })}` : ""}`}
          className="top-8 h-2 min-w-[3px]"
          style={{
            left: `${dayPct(r.start)}%`,
            width: `${Math.max(0.15, dayPct(r.end) - dayPct(r.start))}%`,
            background: r.live ? "var(--primary)" : r.ok ? "var(--primary)" : "var(--bad)",
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute top-1 h-10 w-px bg-primary shadow-[0_0_10px_var(--primary)]"
        style={{ left: `${dayPct(now)}%` }}
      >
        <span
          className={`absolute top-[19px] -left-[3px] size-[7px] rounded-full bg-primary shadow-[0_0_10px_var(--primary)] ${m.s.running.length ? "m-pulse" : ""}`}
        />
        {/* the time sits on its own patch of paper so a calendar block behind it never runs through the digits */}
        <span className="absolute -top-1 left-1 z-10 rounded-sm bg-background px-1 font-mono text-[11px] text-primary">{hm(now)}</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex justify-between font-mono text-[11px] text-muted-foreground" aria-hidden="true">
        {["00", "03", "06", "09", "12", "15", "18", "21", "24"].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </div>
  );
}
