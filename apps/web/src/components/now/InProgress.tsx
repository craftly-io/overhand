import type { Client, DashboardState } from "@overhand/contract";
import type { Words } from "@overhand/themes";
import { ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useActions } from "@/app/actions";
import { type Model, useNow } from "@/app/data";
import { useWords } from "@/app/theme";
import { type Drawer, useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { fmt, hm, uptime } from "@/lib/format";
import { readyItems } from "@/lib/plan";
import { leadName, listedLeads, saying } from "@/lib/sessions";
import { Dot, Pane } from "../Pane";
import { checks } from "../work/Pipeline";

/** One line in In progress: "Online shop: fixing the slow booking page · 12 min · Open". */
export interface Row {
  id: string;
  /** The project it's in; "" when it's in none (a plan of the day). */
  project: string;
  text: string;
  /** How long it has run, or what it waits on (a pull request's checks). */
  meta: string;
  open: Drawer;
  /** Its state colour; the project's hue when it's simply working. */
  color?: string;
  /** A task run's name: the row carries its Stop. */
  stop?: string;
  /** A task run's share of its time limit used, 0 to 1: the field's In progress draws it as a bar. */
  used?: number;
}

/** A task key at the start of a run's name ("SHOP-142 fix round" → "SHOP-142"). */
const keyOf = (name: string) => /^[A-Z][A-Z0-9]+-\d+\b/.exec(name)?.[0] ?? "";
const clientOf = (s: DashboardState, key: string): Client | undefined => s.clients.find((c) => key.startsWith(`${c.prefix}-`));
/** A task's title from its project's tracker, when the tracker answered. */
function titleOf(s: DashboardState, project: string, key: string): string {
  const tix = s.tickets[project];
  return Array.isArray(tix) ? (tix.find((t) => t.key === key)?.title ?? "") : "";
}

/**
 * Every agent at work, as one list: task runs, project agents and your own sessions, then the pull requests the agents
 * opened and the onboarding guides being written. Pure, so it can be tested; `now` is the clock the minutes count from.
 */
export function rowsOf(m: Model, now: number, w: Words): Row[] {
  const s = m.s;
  const runs = s.running.map((cur): Row => {
    const key = keyOf(cur.name);
    const project = clientOf(s, key)?.name ?? "";
    const session = s.sessions.find((x) => x.pid === cur.pid);
    return {
      id: `run:${cur.pid}`,
      project,
      text: titleOf(s, project, key) || (session?.lastAction ? saying(session.lastAction) : "") || cur.name,
      meta: uptime(Math.max(0, (now - cur.startedAt) / 1000)),
      open: key ? { kind: "ticket", key } : { kind: "crew" },
      stop: cur.name,
      used: Math.min(1, Math.max(0, (now - cur.startedAt) / (s.taskTimeoutMin * 60_000))),
    };
  });
  const leads = listedLeads(s.godmode)
    .filter((g) => g.running)
    .map((g): Row => {
      const session = s.sessions.find((x) => x.kind === "lead" && x.label === g.label);
      const says = session?.lastAction ? saying(session.lastAction) : "";
      return {
        id: `lead:${g.key}`,
        project: g.project || session?.client || "",
        text: says ? `${leadName(g, s.names)}, ${says}` : leadName(g, s.names),
        meta: uptime(Math.max(0, (now - g.since) / 1000)),
        open: { kind: "lead", key: g.key },
      };
    });
  // your own sessions, and agents Overhand didn't start; a task run's own session is its run's row
  const mine = s.sessions
    .filter((x) => x.kind !== "lead" && !s.running.some((r) => r.pid === x.pid))
    .map(
      (x): Row => ({
        id: `session:${x.pid}`,
        project: x.client === "Other" ? "" : x.client,
        text: x.kind === "you" ? x.name || w.kindYou : x.lastAction ? saying(x.lastAction) : x.label,
        meta: uptime(x.upSec),
        open: x.client === "Other" ? { kind: "crew" } : { kind: "crew", project: x.client },
        color: x.active ? undefined : "var(--muted-foreground)",
      }),
    );
  const prs = s.prs.map((p): Row => {
    const { gh, color, word } = checks(m, p.url);
    return {
      id: p.key,
      project: clientOf(s, p.key)?.name ?? "",
      text: gh?.title || titleOf(s, clientOf(s, p.key)?.name ?? "", p.key) || p.key,
      meta: [p.key, word ? w[word] : ""].filter(Boolean).join(" · "),
      open: { kind: "review", key: p.key },
      color,
    };
  });
  const guides = s.guides
    .filter((g) => g.run === "queued" || g.run === "running")
    .map(
      (g): Row => ({
        id: `guide:${g.project}`,
        project: g.project,
        text: fmt(w.guideInFlight, { project: g.project }),
        meta: g.run === "running" ? w.guideRunning : w.guideQueued,
        open: { kind: "guide", project: g.project },
      }),
    );
  return [...runs, ...leads, ...mine, ...prs, ...guides];
}

/** Rows by project, in the order each project first appears; rows in no project come last. */
export function groupsOf(rows: Row[]): [string, Row[]][] {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.project, [...(by.get(r.project) ?? []), r]);
  return [...by].sort((a, b) => Number(!a[0]) - Number(!b[0]));
}

/** Today's finished runs, newest first: what folds into "Done today". */
export function doneOf(m: Model, now: number): Row[] {
  const s = m.s;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return s.runs
    .filter((r) => (r.end ?? 0) >= midnight)
    .sort((a, b) => (b.end ?? 0) - (a.end ?? 0))
    .map((r, i): Row => {
      const key = r.key || keyOf(r.name);
      const project = r.project || clientOf(s, key)?.name || "";
      return {
        id: `done:${i}:${r.name}`,
        project,
        text: titleOf(s, project, key) || r.name,
        meta: hm(r.end ?? now),
        open: key ? { kind: "ticket", key } : { kind: "crew" },
        color: r.ok ? "var(--ok)" : "var(--bad)",
      };
    });
}

function Line({ r, m, grouped }: { r: Row; m: Model; grouped?: boolean }) {
  const w = useWords();
  const ui = useUi();
  const { runStop } = useActions();
  const hue = r.project ? m.hue(r.project) : "var(--primary)";
  const actions = (
    <span className="flex shrink-0 gap-1">
      {r.stop ? (
        <Button variant="danger" size="xs" onClick={() => void runStop(r.stop ?? "")}>
          {w.stopLead}
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={() => ui.openDrawer(r.open)}>
        {w.open}
      </Button>
    </span>
  );
  // under its project's heading a row needs no project name, so the task gets the room to read whole
  if (grouped)
    return (
      <li
        data-id={r.id}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-border py-2 text-sm first:border-0"
      >
        <span className="pt-1.5">
          <Dot color={r.color ?? hue} />
        </span>
        <span className="grid min-w-0 gap-1">
          <span className="line-clamp-2 break-words">{r.text}</span>
          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            {r.used !== undefined ? (
              <span className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
                <span className="block h-full bg-foreground transition-[width] duration-500" style={{ width: `${r.used * 100}%` }} />
              </span>
            ) : null}
            {r.meta}
          </span>
        </span>
        {actions}
      </li>
    );
  return (
    <li
      data-id={r.id}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-border py-1.5 text-sm first:border-0"
      style={{ "--c": hue } as CSSProperties}
    >
      <Dot color={r.color ?? hue} />
      <span className="min-w-0 truncate">
        {r.project ? <b className="font-medium text-(--c)">{r.project}: </b> : null}
        {r.text}
        <span className="text-muted-foreground"> · {r.meta}</span>
      </span>
      {actions}
    </li>
  );
}

/**
 * Now's third block: every agent at work in one list, each row its project, what it's doing, for how long and Open; a
 * task run's row carries its Stop. Queued tasks are one line that opens Work; today's finished runs fold into "Done
 * today (N)". `grouped` (the field's side pane) puts the rows under their project's name, a heading that stays put as
 * the pane scrolls, and gives each task run a bar of its time limit used.
 */
export function InProgress({
  m,
  extra,
  grouped,
}: {
  m: Model;
  /** Beside the count: the field's Hide. */
  extra?: ReactNode;
  grouped?: boolean;
}) {
  const w = useWords();
  const ui = useUi();
  const now = useNow(60_000);
  const rows = rowsOf(m, now, w);
  const done = doneOf(m, now);
  const queued = readyItems(m.plan, m.s).length;
  return (
    <Pane title="paneInProgress" dataId="in-progress" count={rows.length} countTone="var(--primary)" extra={extra}>
      {rows.length && grouped ? (
        <div className="grid gap-1">
          {groupsOf(rows).map(([project, list]) => (
            <section key={project} aria-label={project || w.otherWork}>
              <h3
                className="sticky top-0 z-[1] bg-card py-1 text-xs font-semibold"
                style={{ color: project ? m.hue(project) : "var(--muted-foreground)" }}
              >
                {project || w.otherWork}
              </h3>
              <ul className="grid">
                {list.map((r) => (
                  <Line key={r.id} r={r} m={m} grouped />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : rows.length ? (
        <ul className="grid">
          {rows.map((r) => (
            <Line key={r.id} r={r} m={m} />
          ))}
        </ul>
      ) : (
        <p className="py-1 text-sm text-muted-foreground">{w.emptyInProgress}</p>
      )}
      {queued ? (
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 justify-self-start text-muted-foreground"
          onClick={() => ui.openDrawer({ kind: "work" })}
        >
          {fmt(w.armedCount, { n: queued })}
          <ChevronRight aria-hidden="true" />
        </Button>
      ) : null}
      {done.length ? (
        <details className="group border-t border-border pt-2">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
            {fmt(w.doneToday, { n: done.length })}
          </summary>
          <ul className="mt-1 grid">
            {done.map((r) => (
              <Line key={r.id} r={r} m={m} />
            ))}
          </ul>
        </details>
      ) : null}
    </Pane>
  );
}
