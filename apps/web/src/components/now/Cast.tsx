import { type CurrentRun, type Lead, leadId, type Session, type Subagent, workId } from "@overhand/contract";
import type { CSSProperties } from "react";
import { useActions } from "@/app/actions";
import { type Model, useNow } from "@/app/data";
import { useFocus } from "@/app/focus";
import { Term, useTheme, useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { beats, restarts } from "@/lib/beats";
import { ago, clock, fmt, money, uptime } from "@/lib/format";
import { placeName, prFor } from "@/lib/leads";
import { leadCost, leadName, leadNamed, leadState, listedLeads, runKind, runsOn, saying, sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { leadsIn } from "@/lib/world";
import { AgentGlyph } from "@/map/AttentionMap";
import { Dot, Muted, Pane, Steps } from "../Pane";
import { Rename } from "../Rename";
import { Suggested } from "./Suggested";

/** A ticket agent run: an elapsed ring that fills toward the timeout, and what it's doing. */
function AgentRun({ cur, m }: { cur: CurrentRun; m: Model }) {
  const w = useWords();
  const now = useNow(1000);
  const session = m.s.sessions.find((x) => x.pid === cur.pid);
  const sec = Math.max(0, Math.floor((now - cur.startedAt) / 1000));
  const limit = m.s.taskTimeoutMin * 60;
  const dir =
    cur.cwd
      .replace(/\/\.claude\/worktrees\/.*$/, "")
      .split("/")
      .pop() ?? "";
  const where = [cur.account, runsOn({ model: cur.model || session?.model || "", mode: cur.mode ?? "" }), dir && fmt(w.runIn, { dir })]
    .filter(Boolean)
    .join(" · ");
  const world = useTheme().theme.world;
  // the same state the map gives it: a run with a question for you waits on you
  const asking = m.alerts.some(
    (a) =>
      a.sev >= 2 && (a.target.kind === "ticket" || a.target.kind === "review" || a.target.kind === "held") && a.target.key === cur.name,
  );
  return (
    <li data-id={cur.name} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 border-t border-border py-3 first:border-0 first:pt-0">
      <div className="grid justify-items-center gap-1" role="img" aria-label={`${w.elapsed} ${uptime(sec)}`}>
        <AgentGlyph world={world} state={asking ? "waiting" : "working"} name={cur.name} progress={Math.min(0.95, sec / limit)} />
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
          {clock(sec)}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-mono text-sm">{cur.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <Term k={runKind(cur.name)} />
          </span>
        </div>
        <Steps>
          {session?.lastAction ? <p className="mt-0.5 line-clamp-2 text-sm text-foreground/85">{saying(session.lastAction)}</p> : null}
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {where} · {fmt(w.stopsAt, { n: m.s.taskTimeoutMin })}
          </p>
        </Steps>
      </div>
    </li>
  );
}

/** Where something works, as "Online shop · SHOP-142", with its PR when Overhand opened one from that branch. */
function Where({ m, client, branch }: { m: Model; client: string; branch?: string }) {
  const w = useWords();
  const pr = prFor(m.s, client, branch ?? "");
  return (
    <span className="block min-w-0 truncate text-[11px] text-muted-foreground">
      {[client, branch].filter(Boolean).join(" · ")}
      {pr ? (
        <>
          {" · "}
          <a className="hit-area relative text-primary hover:underline" href={pr.url} target="_blank" rel="noreferrer">
            {w.openPr}
          </a>
        </>
      ) : null}
    </span>
  );
}

/** A subagent, and where it works when that's somewhere else than its session (a worktree of its own). */
function SubagentRow({ a, m, parent }: { a: Subagent; m: Model; parent: Session }) {
  const w = useWords();
  const elsewhere = a.cwd && a.cwd !== parent.cwd;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
      <Dot color={a.active ? a.color || "var(--ok)" : "var(--muted-foreground)"} on={a.active} />
      <span className="truncate">{a.name}</span>
      <span className="truncate text-muted-foreground">{a.description || (a.active ? w.working : ago(a.lastAt))}</span>
      {elsewhere ? <Where m={m} client={a.client || parent.client} branch={a.branch} /> : null}
    </li>
  );
}

/** A lead as a character: who they are and where, what they're saying right now, what they cost, and their controls. */
function Character({ g, m, loop, i }: { g: Lead; m: Model; loop: number; i: number }) {
  const w = useWords();
  const ui = useUi();
  const { leadStart, leadStop } = useActions();
  const session = m.s.sessions.find((x) => x.kind === "lead" && x.label === g.label);
  const client = g.project || session?.client || m.s.clients.find((c) => g.label.toLowerCase().includes(c.name.toLowerCase()))?.name || "";
  const hue = client ? m.hue(client) : "var(--primary)";
  const cost = leadCost(g, m.s.runs);
  const says = g.running && session?.lastAction ? saying(session.lastAction) : "";
  const open = () => ui.openDrawer({ kind: "lead", key: g.key });
  const lit = g.running || g.waiting || loop > 0;
  const world = useTheme().theme.world;
  // the state the map gives it, in the world's own glyph: its light and shape say it before the words do
  const state = g.waiting || g.open ? "waiting" : g.running ? "working" : "idle";
  const name = leadName(g, m.s.names);
  const focus = useFocus();
  const where = session ? <Where m={m} client={session.client} branch={session.branch} /> : null;
  return (
    <li
      className="m-enter relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 border-b border-border py-3 last:border-0"
      style={{ "--c": loop ? "var(--warn)" : hue, "--i": i } as CSSProperties}
    >
      <div className="grid justify-items-center pt-0.5">
        <AgentGlyph world={world} state={state} lead name={g.key} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <Rename id={leadId(g.key)} name={name}>
            <button
              type="button"
              className={cn(
                "min-w-0 text-left text-base font-medium text-pretty [overflow-wrap:anywhere] hover:underline pointer-coarse:min-w-8 pointer-coarse:py-1",
                !lit && "text-muted-foreground",
              )}
              onClick={open}
            >
              {name}
            </button>
          </Rename>
          {/* a name that already says its project ("Fix new errors · Booking app") needs no label beside it */}
          {g.project && name.includes(g.project) ? null : <span className="min-w-0 truncate text-xs text-(--c)">{g.label}</span>}
        </div>
        <p className={cn("text-xs", loop ? "text-warn" : "text-muted-foreground")}>
          {loop ? fmt(w.loopShort, { n: loop }) : leadState(g, w, Date.now())}
          {cost ? ` · ${fmt(w.leadCostToday, { cost: money(cost) })}` : ""}
        </p>
        {/* with Focus, where it works (and its PR) stays; what it says, its model and uptime, its subagents fold */}
        {focus && where ? <p className="mt-1 grid text-[11px] text-muted-foreground">{where}</p> : null}
        <Steps when={Boolean(says || session)}>
          {says ? <p className="mt-1.5 line-clamp-2 text-sm italic [overflow-wrap:anywhere]">“{says}”</p> : null}
          {session ? (
            <p className="mt-1 grid text-[11px] text-muted-foreground">
              <span>{[runsOn(session) || w.modelUnknown, fmt(w.upFor, { t: uptime(session.upSec) })].join(" · ")}</span>
              {focus ? null : where}
            </p>
          ) : null}
          {session?.subagents.length ? (
            <ul className="mt-2 grid gap-1 border-l border-(--c)/30 pl-3" aria-label={w.subagents}>
              {session.subagents.map((a) => (
                <SubagentRow key={`${a.name}-${a.lastAt}`} a={a} m={m} parent={session} />
              ))}
            </ul>
          ) : null}
        </Steps>
        <div className="mt-2 flex gap-1">
          <Button variant={g.open ? "outline" : "ghost"} size="xs" onClick={open}>
            {g.open ? w.leadQuestions : w.leadTalk}
          </Button>
          {g.supervised ? (
            g.running || !g.stopped ? (
              // stopping a running lead interrupts it (red, and it asks first); an asleep one just stays off
              <Button variant={g.running ? "danger" : "ghost"} size="xs" onClick={() => void leadStop(g.key)}>
                {w.stopLead}
              </Button>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => void leadStart(g.key)}>
                {w.startLead}
              </Button>
            )
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * A session that isn't a lead: yours, or an ops agent's. Its name is yours first (your rename, the name you gave it in
 * the agent, its branch, its ticket), then where it works; its subagents under it.
 */
function Extra({ x, m }: { x: Session; m: Model }) {
  const w = useWords();
  const branch = x.branch ?? "";
  const name = placeName(m.s, { project: x.client, branch, own: x.kind === "you" ? x.name : "", fallback: sessionTitle(x) });
  const title = <span className="truncate">{name}</span>;
  const focus = useFocus();
  const where = (
    <div className="pl-4">
      <Where m={m} client={x.client} branch={branch} />
    </div>
  );
  return (
    <li className="grid min-w-0 grid-cols-1 gap-0.5 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <Dot color={x.active ? "var(--ok)" : "var(--muted-foreground)"} on={x.active} label={x.active ? w.working : w.idle} />
        <span className="shrink-0 font-medium" style={{ color: m.hue(x.client) }}>
          <Term k={x.kind === "you" ? "kindYou" : "kindAgent"} />
        </span>
        {branch ? (
          <Rename id={workId(x.client, branch)} name={name}>
            {title}
          </Rename>
        ) : (
          title
        )}
      </div>
      {focus ? where : null}
      <Steps when={Boolean(x.lastAction || x.subagents.length)} className="pl-4">
        {x.lastAction ? <p className="truncate pl-4 text-muted-foreground italic">“{saying(x.lastAction)}”</p> : null}
        {focus ? null : where}
        {x.subagents.length ? (
          <ul className="ml-4 grid gap-1 border-l border-border pl-3" aria-label={w.subagents}>
            {x.subagents.map((a) => (
              <SubagentRow key={`${a.name}-${a.lastAt}`} a={a} m={m} parent={x} />
            ))}
          </ul>
        ) : null}
      </Steps>
    </li>
  );
}

/**
 * Who's in the story: the ticket agent on its clock, then each lead as a character (looping, waiting or working
 * first), then your own sessions on this machine. On the bridge (`glance`) it links to Crew; opened on a `project`
 * (from its place in the scene), it shows only who works there. With `max` (a live piece on the site) it shows that
 * many leads and nothing after them.
 */
export function Cast({ m, glance = false, project, max }: { m: Model; glance?: boolean; project?: string; max?: number }) {
  const w = useWords();
  const loops = restarts(beats(m.s.reports));
  const loopOf = (g: Lead) => [...loops].find(([who]) => leadNamed([g], m.s.names, who))?.[1] ?? 0;
  const rank = (g: Lead) => (loopOf(g) ? 0 : g.waiting || g.open ? 1 : g.running ? 2 : 3);
  const client = project ? m.s.clients.find((c) => c.name === project) : undefined;
  const here = client ? new Set(leadsIn(m.s.godmode, client.name).map((g) => g.key)) : null;
  const leads = [...listedLeads(m.s.godmode)]
    .filter((g) => !here || here.has(g.key))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, max);
  const runs = client ? m.s.running.filter((r) => r.name.startsWith(`${client.prefix}-`)) : m.s.running;
  const extras = max === undefined ? m.s.sessions.filter((x) => x.kind !== "lead" && (!client || x.client === client.name)) : [];
  return (
    <Pane title="storyCast" subtitle={client?.name} view={glance ? "crew" : undefined}>
      <div className="grid grid-cols-1 gap-3">
        {runs.length ? (
          <ul className="grid grid-cols-1" aria-label={w.storyCast}>
            {runs.map((cur) => (
              <AgentRun key={cur.pid} cur={cur} m={m} />
            ))}
          </ul>
        ) : (
          <Muted>
            <Term k="noAgentRun" /> {m.s.paused ? w.noAgentRunPaused : w.noAgentRunNext}
          </Muted>
        )}
        {leads.length ? (
          <ul className="grid grid-cols-1 border-t border-border pt-3">
            {leads.map((g, i) => (
              <Character key={g.key} g={g} m={m} loop={loopOf(g)} i={i} />
            ))}
          </ul>
        ) : (
          <Muted>
            <Term k="emptyLeads" />
          </Muted>
        )}
        {extras.length ? (
          <ul className="m-stagger border-t border-border pt-2">
            {extras.map((x) => (
              <Extra key={x.pid} x={x} m={m} />
            ))}
          </ul>
        ) : null}
        {max === undefined ? <Suggested m={m} project={client?.name} /> : null}
      </div>
    </Pane>
  );
}
