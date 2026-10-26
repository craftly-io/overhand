import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { type Model, useNow } from "@/app/data";
import { setFieldTime, useFieldTime } from "@/app/fieldTime";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { dayScale } from "@/lib/dayScale";
import { fmt, hm } from "@/lib/format";
import { FeatureTip } from "../FeatureTip";
import { dayRuns, dayTicks, tone } from "./DayRibbon";

const QUARTER = 15 * 60_000;
/** How long Replay the day takes, start of the day's work to now. */
const REPLAY_MS = 8000;

/**
 * Today, along the foot of Now: the day on an elastic track (busy hours get the room, quiet ones fold), your meetings
 * above it, how many agents worked each quarter hour, and the day's events as marks. Drag along it, or Replay the
 * day, and the field above shows the work as it was then; let go near now, or Back to live, and it's live again.
 */
export function DayStrip({ m }: { m: Model }) {
  const w = useWords();
  const now = useNow(30_000);
  const [at] = useFieldTime();
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const start = new Date(now).setHours(0, 0, 0, 0);
  const runs = dayRuns(m, now).filter((r) => r.end > start);
  const scale = dayScale(start, runs, now);
  const cal = Array.isArray(m.s.status.calendar) ? m.s.status.calendar.filter((e) => !e.allDay && e.end > start) : [];
  const ticks = dayTicks(m.s.reports).map((t) => ({ ...t, ms: start + (t.at / 100) * 86_400_000 }));
  const t = at ?? now;
  const working = (ms: number) => runs.filter((r) => r.start <= ms && (r.live ? ms <= r.end : ms < r.end)).length;
  const bins = Array.from({ length: 96 }, (_, i) => ({ a: start + i * QUARTER, n: working(start + i * QUARTER + QUARTER / 2) })).filter(
    (b) => b.n && b.a < now,
  );
  const top = Math.max(1, ...bins.map((b) => b.n));
  const hours: { h: number; x: number }[] = [];
  for (let h = 0; h <= 24; h++) {
    const x = scale.x(start + h * 3_600_000);
    // an hour's label keeps clear of its neighbour and of the now line
    if (x - (hours.at(-1)?.x ?? -10) >= 3.2 && Math.abs(x - scale.x(now)) >= 1.6) hours.push({ h, x });
  }
  const done = runs.filter((r) => !r.live && r.end <= t).length;

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  };
  // a replay stops with the strip
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  const go = (ms: number) => setFieldTime(now - ms < 5 * 60_000 ? null : Math.max(start, Math.min(now, ms)));
  const play = () => {
    stop();
    const from = Math.min(now - 60 * 60_000, ...runs.map((r) => r.start));
    const step = (now - from) / (REPLAY_MS / 45);
    let ms = from;
    setPlaying(true);
    setFieldTime(ms);
    timer.current = setInterval(() => {
      ms += step;
      if (ms >= now) {
        stop();
        setFieldTime(null);
      } else setFieldTime(ms);
    }, 45);
  };
  const pct = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * 100;
  };
  const key = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -QUARTER, ArrowRight: QUARTER, PageDown: -3_600_000, PageUp: 3_600_000 }[e.key];
    if (step) {
      e.preventDefault();
      stop();
      go(t + step);
    } else if (e.key === "End" || e.key === "Escape") {
      e.preventDefault();
      stop();
      setFieldTime(null);
    } else if (e.key === "Home") {
      e.preventDefault();
      stop();
      go(start);
    }
  };

  // what the pointer (or the replay) is on: the nearest event, else how many were working then
  const p = dragging || playing || at !== null ? (hover === null ? scale.x(t) : hover) : hover;
  const tipAt = p === null ? null : dragging || playing ? t : scale.at(p);
  const near =
    tipAt === null ? undefined : ticks.map((k) => ({ k, d: Math.abs(scale.x(k.ms) - scale.x(tipAt)) })).sort((a, b) => a.d - b.d)[0];
  const hit = near && near.d < 0.9 ? near.k : undefined;
  return (
    <section aria-label={w.stripTitle} className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">{w.stripTitle}</h2>
        <Button variant="outline" size="xs" onClick={() => (playing ? stop() : play())}>
          {playing ? w.pauseShort : w.stripReplay}
        </Button>
        {at !== null ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              stop();
              setFieldTime(null);
            }}
          >
            {w.stripLive}
          </Button>
        ) : null}
        <span className="font-mono text-xs text-muted-foreground">{fmt(w.stripLine, { done, working: working(t) })}</span>
        <FeatureTip at="now-field" />
        <span className="ml-auto hidden text-xs text-muted-foreground xl:inline">{w.stripHint}</span>
      </div>
      <div className="flex gap-3">
        <div className="grid w-14 shrink-0 grid-rows-[16px_12px_30px] text-xs font-medium" aria-hidden="true">
          <span />
          <span className="text-muted-foreground">{w.mapYou}</span>
          <span className="self-end text-muted-foreground">{w.agents}</span>
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label={w.stripSlider}
          aria-valuemin={start}
          aria-valuemax={now}
          aria-valuenow={t}
          aria-valuetext={hm(t)}
          className="relative h-[58px] min-w-0 flex-1 cursor-ew-resize touch-none"
          onPointerDown={(e) => {
            stop();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            go(scale.at(pct(e)));
          }}
          onPointerMove={(e) => {
            const x = pct(e);
            if (dragging) go(scale.at(x));
            setHover(x);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onPointerLeave={() => !dragging && setHover(null)}
          onKeyDown={key}
        >
          <div className="absolute inset-x-0 top-0 h-4 font-mono text-[11px] text-muted-foreground" aria-hidden="true">
            {hours.map((x) => (
              <span key={x.h} className="absolute -translate-x-1/2 transition-[left] duration-500" style={{ left: `${x.x}%` }}>
                {String(x.h % 24).padStart(2, "0")}
              </span>
            ))}
          </div>
          <div className="absolute inset-x-0 top-4 bottom-0" aria-hidden="true">
            {scale.quiet.map((q) => (
              <div
                key={q.from}
                className="field-quiet absolute inset-y-0 flex items-center justify-center font-mono text-[11px] text-muted-foreground"
                style={{ left: `${scale.x(q.from)}%`, width: `${scale.x(q.to) - scale.x(q.from)}%` }}
              >
                {scale.x(q.to) - scale.x(q.from) > 4 ? w.stripQuiet : ""}
              </div>
            ))}
            {cal.map((e) => (
              <div
                key={`${e.start}-${e.title}`}
                className="absolute top-0.5 h-2 min-w-1 rounded-full border border-foreground/50"
                style={{ left: `${scale.x(e.start)}%`, width: `${Math.max(0.3, scale.x(e.end) - scale.x(e.start))}%` }}
              />
            ))}
            {bins.map((b) => (
              <div
                key={b.a}
                className="absolute bottom-0 rounded-t-[2px] bg-foreground transition-[left,width,height] duration-500"
                style={{
                  left: `${scale.x(b.a)}%`,
                  width: `${Math.max(0.1, scale.x(b.a + QUARTER) - scale.x(b.a) - 0.12)}%`,
                  height: `${Math.max(3, Math.round((b.n / top) * 26))}px`,
                  opacity: b.a <= t ? 0.3 : 0.12,
                }}
              />
            ))}
            {ticks.map((k) => (
              <span
                key={k.at}
                className="absolute top-3 size-[3px] -translate-x-1/2 rounded-full"
                style={{ left: `${scale.x(k.ms)}%`, background: tone(k.line), opacity: k.ms <= t ? 1 : 0.3 }}
              />
            ))}
            {at !== null ? <div className="absolute inset-y-0 right-0 bg-background/55" style={{ left: `${scale.x(at)}%` }} /> : null}
            <div className="absolute -top-4 bottom-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${scale.x(now)}%` }} />
            {at !== null ? (
              <>
                <div className="absolute -top-4 bottom-0 w-0.5 -translate-x-1/2 bg-muted-foreground" style={{ left: `${scale.x(at)}%` }} />
                <div
                  className="absolute -top-6 size-3 -translate-x-1/2 rounded-full bg-foreground ring-3 ring-background"
                  style={{ left: `${scale.x(at)}%` }}
                />
              </>
            ) : null}
            {hover !== null && !dragging ? (
              <div className="absolute -top-4 bottom-0 w-px bg-foreground/45" style={{ left: `${hover}%` }} />
            ) : null}
          </div>
          {p !== null && tipAt !== null ? (
            <div
              role="status"
              className="pointer-events-none absolute bottom-[calc(100%+14px)] z-20 w-max max-w-80 rounded-xl bg-foreground px-3 py-2 text-background shadow-lg"
              style={{ left: `${p}%`, transform: `translateX(${p < 10 ? "-12px" : p > 88 ? "calc(-100% + 12px)" : "-50%"})` }}
            >
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="size-2 rounded-full" style={{ background: hit ? tone(hit.line) : "var(--muted-foreground)" }} />
                {hm(hit ? hit.ms : tipAt)}
                <span className="opacity-75">{tipAt > now ? "" : fmt(w.stripWorkingAt, { n: working(hit ? hit.ms : tipAt) })}</span>
              </div>
              <div className="mt-0.5 text-sm whitespace-pre-line">{hit ? hit.text : tipAt > now ? w.stripLater : w.stripNothing}</div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
