import { type FirstWin, isBilled, SettingsSchema } from "@overhand/contract";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { store } from "@/app/store";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { get } from "@/lib/api";
import { fmt, money } from "@/lib/format";
import { getAt } from "@/lib/json";
import { LEVEL_WORDS, MEANS_WORDS } from "@/lib/leads";
import { pickFinding, useCheckup } from "../Checkup";
import { useQuickSave } from "../QuickSettings";

/** The cards this browser has accepted, kept like Focus: once set, a card is gone. */
const KEY = "overhand-tonight";
const CARDS = ["report", "queue", "howFar"] as const;
type Card = (typeof CARDS)[number];
const accepted = (): Card[] => {
  try {
    const x: unknown = JSON.parse(store.get(KEY) ?? "[]");
    return Array.isArray(x) ? CARDS.filter((c) => x.includes(c)) : [];
  } catch {
    return [];
  }
};

/** Tonight's queue holds at most this many: a first night stays small enough to review in the morning. */
const QUEUE_MAX = 4;

/** One card: what's set for tonight, in a sentence or two, and its one-click accept beside Change. */
function TonightCard({ children, accept, change }: { children: ReactNode; accept: ReactNode; change: () => void }) {
  const w = useWords();
  return (
    <li className="m-enter grid gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="grid gap-1 text-sm [overflow-wrap:anywhere]">{children}</div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={change}>
          {w.tonightChange}
        </Button>
        {accept}
      </div>
    </li>
  );
}

/**
 * "Set up tonight": while the first win runs, the newcomer waits anyway, so three cards set up the first night, each
 * one click to accept and editable in Settings. When the night report arrives and where (`schedule.briefAtHour`,
 * ntfy), what agents take tonight (the check-up's other findings and tickets assigned to you, within the daily
 * budget), and how far agents go in the project (its autonomy). Nothing new is configured: each shows what's set.
 */
export function Tonight({ m, win }: { m: Model; win: FirstWin }) {
  const w = useWords();
  const ui = useUi();
  const { run } = useActions();
  const quick = useQuickSave();
  const [done, setDone] = useState<Card[]>(accepted);
  const [busy, setBusy] = useState(false);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings", SettingsSchema), staleTime: 60_000 });
  const checkup = useCheckup();
  const client = m.s.clients.find((c) => c.name === win.project);
  const accept = (c: Card) => {
    const next = [...done, c];
    setDone(next);
    store.set(KEY, JSON.stringify(next));
  };
  if (done.length === CARDS.length) return null;

  const config = settings.data?.config ?? {};
  const hour = getAt(config, "schedule.briefAtHour");
  const at = typeof hour === "number" ? hour : 8;
  const time = `${String(at).padStart(2, "0")}:00`;
  const phone = Boolean(getAt(config, "ntfySecret"));

  // the check-up's other findings in the first win's repo (the daemon already left its own out), then your tickets
  const findings = (checkup.data?.reports ?? [])
    .filter((r) => r.repo === win.repo)
    .flatMap((r) =>
      r.findings.flatMap((f) => (f.task ? [{ key: `${r.path}#${f.id}`, title: f.task.title, pick: { path: r.path, id: f.id } }] : [])),
    );
  const armed = new Set(Object.values(m.s.labels));
  const mine = (client ? [m.s.tickets[client.name] ?? []] : Object.values(m.s.tickets))
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((t) => !t.labels.some((l) => armed.has(l)))
    .map((t) => ({ key: t.key, title: t.title, pick: null }));
  const queue = [...findings, ...mine].slice(0, QUEUE_MAX);
  const billed = m.s.accounts.some((a) => a.billing && isBilled(a.billing));
  const cap = billed ? (m.s.budgetUsd > 0 ? fmt(w.tonightCapBilled, { money: money(m.s.budgetUsd) }) : "") : w.tonightCapPlan;
  const take = async () => {
    setBusy(true);
    try {
      // one at a time: each pick may become the next ticket in the project's tracker
      for (const q of queue) await (q.pick ? pickFinding(q.pick.path, q.pick.id).catch(() => null) : run({ name: "queue", key: q.key }));
      accept("queue");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-2" aria-label={w.tonightTitle}>
      <h3 className="font-display text-xs tracking-widest text-primary uppercase">{w.tonightTitle}</h3>
      <p className="text-xs text-muted-foreground">{w.tonightIntro}</p>
      <ul className="grid gap-2">
        {done.includes("report") ? null : (
          <TonightCard
            change={() => ui.openDrawer({ kind: "settings", tab: "schedule" })}
            accept={
              at >= 0 ? (
                <Button size="sm" variant="outline" onClick={() => accept("report")}>
                  {fmt(w.tonightReportKeep, { time })}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => ui.openDrawer({ kind: "settings", tab: "schedule" })}>
                  {w.tonightReportOn}
                </Button>
              )
            }
          >
            <p>{at >= 0 ? fmt(w.tonightReport, { time, where: phone ? w.tonightWherePhone : w.tonightWhereHere }) : w.tonightReportOff}</p>
          </TonightCard>
        )}
        {done.includes("queue") ? null : (
          <TonightCard
            change={() => ui.openDrawer({ kind: "settings", tab: "schedule" })}
            accept={
              checkup.isPending ? null : queue.length ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void take()}>
                  {w.tonightQueueGo}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => accept("queue")}>
                  {w.tonightKeep}
                </Button>
              )
            }
          >
            {checkup.isPending ? (
              // the check-up is still reading the repo: the list's shape until it answers
              <SkeletonRows rows={2} />
            ) : queue.length ? (
              <>
                <p>{w.tonightQueue}</p>
                <ul className="grid gap-0.5 pl-4 text-muted-foreground [list-style:disc]">
                  {queue.map((q) => (
                    <li key={q.key}>{q.title}</li>
                  ))}
                </ul>
                {cap ? <p className="text-xs text-muted-foreground">{cap}</p> : null}
              </>
            ) : (
              <p>{fmt(w.tonightQueueNone, { label: m.s.labels.queue })}</p>
            )}
          </TonightCard>
        )}
        {done.includes("howFar") || !client ? null : (
          <TonightCard
            change={() => ui.openDrawer({ kind: "settings", tab: "projects", project: client.name })}
            accept={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void quick({ project: client.name, autonomy: client.autonomy }).then(() => accept("howFar"))}
              >
                {w.tonightKeep}
              </Button>
            }
          >
            <p>{fmt(w.tonightHowFar, { project: client.name, level: w[LEVEL_WORDS[client.autonomy]] })}</p>
            <p className="text-xs text-muted-foreground">{w[MEANS_WORDS[client.autonomy]]}</p>
          </TonightCard>
        )}
      </ul>
    </section>
  );
}
