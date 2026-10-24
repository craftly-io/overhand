import { type CSSProperties, Fragment, type ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { Model } from "@/app/data";
import { useFocus } from "@/app/focus";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { post } from "@/lib/api";
import { beats, restarts } from "@/lib/beats";
import { fmt, hm, money, pick } from "@/lib/format";
import { nth, useCountUp } from "@/lib/motion";
import { leadName, leadNamed, withNames } from "@/lib/sessions";
import { spendKind } from "@/lib/spend";
import { leadsIn, newestBeat } from "@/lib/world";
import { TONE } from "./Activity";
import { needs, needsTone } from "./Alerts";

const Undone = z.object({ url: z.string() });

/** Fills a word's `{placeholders}` with elements, so a fact inside a sentence can glow and be clicked. */
function fill(word: string, vars: Record<string, ReactNode>): ReactNode[] {
  return word.split(/(\{\w+\})/).map((part, i) => {
    const k = part.match(/^\{(\w+)\}$/)?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: a sentence's parts never reorder
    return <Fragment key={i}>{k && k in vars ? vars[k] : part}</Fragment>;
  });
}

/**
 * A live fact inside the prologue: lit in its colour, and a shortcut to where it's explained. It underlines on hover; on
 * a touch screen, with no hover, a faint dotted underline stays so it still reads as tappable.
 */
function Fact({ children, color = "var(--primary)", onClick }: { children: ReactNode; color?: string; onClick?: () => void }) {
  const cls =
    "font-medium whitespace-nowrap text-(--c) [text-shadow:0_0_18px_color-mix(in_srgb,var(--c)_55%,transparent)] decoration-(--c)/40 underline-offset-[0.2em]";
  const style = { "--c": color } as CSSProperties;
  return onClick ? (
    <button
      type="button"
      className={`${cls} cursor-pointer hover:underline pointer-coarse:underline pointer-coarse:decoration-dotted`}
      style={style}
      onClick={onClick}
    >
      {children}
    </button>
  ) : (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}

/** A number that counts up to its value, and glides when the value changes; it jumps when motion is reduced. */
function Count({ to, show }: { to: number; show: (n: number) => string }) {
  return <span className="tabular-nums">{show(useCountUp(to))}</span>;
}

/** Joins names as "A", "A and B", "A, B and C". */
function list(items: ReactNode[]): ReactNode {
  return items.map((x, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: names are already unique
    <Fragment key={i}>
      {i === 0 ? "" : i === items.length - 1 ? " and " : ", "}
      {x}
    </Fragment>
  ));
}

/** How many agents are at work in each client: its running leads and the ticket agent. */
function crewAt(m: Model): Map<string, number> {
  return new Map(
    m.s.clients.map((c) => [
      c.name,
      leadsIn(m.s.godmode, c.name).filter((g) => g.running).length + m.s.running.filter((r) => r.name.startsWith(`${c.prefix}-`)).length,
    ]),
  );
}

/**
 * The opening of the Now view: who's at work and where, what waits on you, what the week delivered and what it cost,
 * told as sentences built from live state, over a ribbon of the day.
 */
export function Prologue({ m, greeting = true }: { m: Model; greeting?: boolean }) {
  const w = useWords();
  const ui = useUi();
  const s = m.s;
  const now = new Date(s.now);
  const h = now.getHours();
  // the first variant of a spoken line: sentences on screen shouldn't change at every poll
  const first = (word: string) => pick(word, () => 0);

  const at = crewAt(m);
  const where = [...at.keys()].filter((c) => (at.get(c) ?? 0) > 0);
  const crew = s.godmode.filter((g) => g.running).length + s.running.length;
  const toCrew = () => ui.openDrawer({ kind: "crew" });

  const sentences: ReactNode[] = [];
  if (crew && !s.paused)
    sentences.push(
      fill(w.storyCrew, {
        crew: <Fact onClick={toCrew}>{crew === 1 ? w.storyCrewOne : fmt(w.storyCrewMany, { n: crew })}</Fact>,
        clients: where.length
          ? list(
              where.map((c) => (
                <Fact key={c} color={m.hue(c)}>
                  {c}
                </Fact>
              )),
            )
          : w.briefSomeTicket,
      }),
    );
  else sentences.push(first(s.paused ? w.brPaused : w.brIdle));

  const need = needs(m);
  sentences.push(
    need.length
      ? fill(w.storyNeeds, {
          things: (
            <Fact color={needsTone(need)} onClick={() => ui.openDrawer({ kind: "alerts" })}>
              {need.length === 1 ? w.storyThingsOne : fmt(w.storyThingsMany, { n: need.length })}
            </Fact>
          ),
        })
      : first(w.brCalm),
  );

  // the loudest restart loop today is part of the story: something is wrong and it costs runs
  const loop = [...restarts(beats(s.reports))]
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([who, count]) => ({ who, count }))[0];
  const looper = loop ? leadNamed(s.godmode, s.names, loop.who) : undefined;
  if (loop?.who)
    sentences.push(
      fill(w.storyLoop, {
        lead: (
          <Fact color="var(--warn)" onClick={looper ? () => ui.openDrawer({ kind: "lead", key: looper.key }) : undefined}>
            {looper ? leadName(looper, s.names) : loop.who}
          </Fact>
        ),
        n: (
          <Fact color="var(--warn)">
            <Count to={loop.count} show={(n) => String(Math.round(n))} />
          </Fact>
        ),
      }),
    );

  if (s.week.opened)
    sentences.push(
      fill(w.storyWeek, {
        prs: <Fact onClick={() => ui.openDrawer({ kind: "work" })}>{fmt(w.storyPrs, { n: s.week.opened })}</Fact>,
        merged: <Fact color="var(--ok)">{s.week.merged}</Fact>,
      }),
    );

  // every Ship merge is told, with its Undo: a revert PR for you to review
  // the sentence's last word and its Undo don't wrap apart (a button may start a line even after a no-break space), so
  // the Undo always ends its own sentence instead of looking like the start of the next one
  const cut = w.shipMerged.lastIndexOf(" ");
  const [head, tail] =
    cut > 0 && !w.shipMerged.slice(cut).includes("{") ? [w.shipMerged.slice(0, cut + 1), w.shipMerged.slice(cut + 1)] : [w.shipMerged, ""];
  for (const x of s.shipped.slice(0, 3))
    sentences.push(
      <>
        {fill(head, { key: <Fact color="var(--ok)">{x.key}</Fact> })}
        <span className="whitespace-nowrap" data-undo>
          {tail}
          {"\u00a0"}
          {x.revert ? (
            <a className="text-xs text-primary hover:underline" href={x.revert} target="_blank" rel="noopener noreferrer">
              {w.shipReverting} ↗
            </a>
          ) : (
            <button
              type="button"
              title={w.shipUndoHint}
              className="rounded-full border border-primary/40 px-2 py-px align-[0.1em] text-xs text-primary hover:bg-primary/10"
              onClick={() =>
                void post("/api/ship/undo", { url: x.url }, Undone)
                  .then((r) => toast(fmt(w.shipUndone, { url: r.url })))
                  .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
              }
            >
              {w.shipUndo}
            </button>
          )}
        </span>
      </>,
    );

  const cal = Array.isArray(s.status.calendar) ? s.status.calendar : [];
  const meeting = cal.find((e) => !e.allDay && e.start > s.now && e.start - s.now < 3 * 3600_000);
  if (meeting) sentences.push(fill(w.brMeeting, { title: <Fact color="var(--warn)">{meeting.title}</Fact>, at: hm(meeting.start) }));

  // billed money is a bill (an estimate); on plans the work is included, its API price only a comparison
  const kind = spendKind(s);
  sentences.push(
    kind === "local"
      ? w.storyLocal
      : fill(kind === "billed" ? w.storyBilled : w.storyInPlans, {
          cost: (
            <Fact onClick={() => ui.openDrawer({ kind: "health" })}>
              <Count to={kind === "billed" ? s.billed : s.cost} show={money} />
            </Fact>
          ),
        }),
  );

  const story = sentences.map((x, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: sentence order is fixed; keying by index keeps them still between polls
    <span key={i} className="m-enter" style={nth(i + 2)}>
      {x}{" "}
    </span>
  ));
  // the menu bar's popover has room for the story, not the date and greeting over it
  if (!greeting) return <p className="text-sm">{story}</p>;
  const hello = h < 5 ? w.brHelloNight : h < 12 ? w.brHelloMorning : h < 18 ? w.brHelloAfternoon : w.brHelloEvening;
  return (
    <section aria-labelledby="prologue" className="scrim relative max-w-[72ch]">
      <p className="m-enter text-xs text-muted-foreground" style={nth(0)}>
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
      </p>
      <h1
        id="prologue"
        className="m-enter readout hud-glow mt-1 font-display text-3xl font-semibold tracking-wide text-foreground 2xl:text-[clamp(2.25rem,2.2vw,4.5rem)]"
        style={nth(1)}
      >
        {fmt(first(hello), { name: s.owner || "there" })}
      </h1>
      <p className="story-text mt-2 max-w-[56ch]">{story}</p>
    </section>
  );
}

/**
 * The day's newest beat under the story, in its client's colour (or its tone's, when it's good or bad news). Focus leaves
 * it out: it's a step, and the day so far (its outcomes, then its steps) holds every beat.
 */
export function BeatCaption({ m }: { m: Model }) {
  const beat = newestBeat(m.s);
  const focus = useFocus();
  const ui = useUi();
  const w = useWords();
  if (!beat || focus) return null;
  const color = beat.tone === "quiet" || beat.tone === "info" ? (beat.client ? m.hue(beat.client) : undefined) : TONE[beat.tone];
  const text = <span style={{ color }}>{withNames(beat.text, m.s.godmode, m.s.names)}</span>;
  // something that went wrong is never a dead end: it opens its ticket or its lead, else Needs you, where its fix is
  const trouble = beat.tone === "bad" || beat.tone === "warn";
  const key = /^([A-Z][A-Z0-9]+-\d+)\b/.exec(beat.text)?.[1];
  const lead = beat.who ? leadNamed(m.s.godmode, m.s.names, beat.who) : undefined;
  const open = () =>
    key
      ? ui.openDrawer({ kind: "ticket", key })
      : lead
        ? ui.openDrawer({ kind: "lead", key: lead.key })
        : ui.openDrawer({ kind: "alerts" });
  return (
    <p key={beat.text} className="scrim m-enter max-w-[72ch] text-sm text-foreground/80" aria-live="polite">
      <time className="mr-2 font-mono text-xs text-muted-foreground">{beat.time}</time>
      {trouble ? (
        <button type="button" className="text-left hover:underline" onClick={open}>
          {text}
          <span className="ml-2 text-xs text-muted-foreground">{w.open} →</span>
        </button>
      ) : (
        text
      )}
    </p>
  );
}
