import type { CSSProperties } from "react";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { fmt, money } from "@/lib/format";
import { accountWeek, billingLabel, budgetApplies, headline, perMerge, spendKind } from "@/lib/spend";
import { cn } from "@/lib/utils";
import { Pane } from "../Pane";

/**
 * The week's spend per account: each account by the name the person gave it and in their order (Settings', and Agent
 * accounts' above), an account that spent nothing at $0; spend on an account removed since follows, biggest first.
 */
export function spendByAccount(spent: Record<string, number>, accounts: readonly string[]): [string, number][] {
  const gone = Object.entries(spent)
    .filter(([name]) => !accounts.includes(name))
    .sort((a, b) => b[1] - a[1]);
  return [...accounts.map((name): [string, number] => [name, spent[name] ?? 0]), ...gone];
}

/**
 * Every dollar in one place, each named for what it is: billed (an estimate), included in plans (their usage windows),
 * and at API prices (a comparison), today, this week, per merged PR, per day and per account.
 */
export function Spend({ m }: { m: Model }) {
  const w = useWords();
  const wk = m.s.week;
  const max = Math.max(0.01, ...wk.days.map((d) => d.cost));
  const byAccount = spendByAccount(
    wk.byAccount,
    m.s.accounts.map((a) => a.name),
  );
  const ui = useUi();
  const head = headline(m.s, w);
  const billed = spendKind(m.s) === "billed";
  const lines: [string, string][] = [
    [w.quickBudget, !budgetApplies(m.s) ? w.budgetNA : m.s.budgetUsd > 0 ? money(m.s.budgetUsd) : w.budgetNone],
    ...(billed ? [[w.weekBilled, money(wk.billed)] satisfies [string, string]] : []),
    [w.todayApi, money(m.s.cost)],
    [w.weekApi, money(wk.cost)],
    ...(wk.merged ? [[w.weekPerMerge, perMerge(m.s, wk, w)] satisfies [string, string]] : []),
  ];
  return (
    <Pane title="paneSpend">
      <div className="flex flex-col-reverse">
        <p className="mt-1 text-xs text-muted-foreground">{head.label}</p>
        <p className="readout hud-glow text-3xl leading-none font-semibold">{head.value}</p>
      </div>
      {billed ? <p className="mt-1 text-xs text-muted-foreground">{w.billedEstimate}</p> : null}
      <div
        className="mt-3 flex h-16 items-end gap-1.5"
        role="img"
        aria-label={`${w.spendPerDay}: ${wk.days.map((d) => `${d.date} ${money(d.cost)}`).join(", ")}`}
      >
        {wk.days.map((d, i) => (
          <div
            key={d.date}
            title={`${d.date}: ${fmt(w.runApiPrice, { cost: money(d.cost) })}${billed ? `, ${fmt(w.spendAccBilled, { cost: money(d.billed) })}` : ""}, ${d.done} PRs`}
            className={cn(
              "hud-rise flex-1 bg-linear-to-b",
              i === wk.days.length - 1
                ? "from-primary to-primary/30 shadow-[0_0_10px_-2px_var(--primary)]"
                : "from-primary/55 to-primary/10",
            )}
            style={{ height: `${Math.max(4, (d.cost / max) * 100)}%`, "--n": i } as CSSProperties}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-center text-[11px] text-muted-foreground" aria-hidden="true">
        {wk.days.map((d) => (
          <span key={d.date} className="flex-1">
            {new Date(d.date).toLocaleDateString(undefined, { weekday: "narrow" })}
          </span>
        ))}
      </div>
      <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
        {lines.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0">{k}</dt>
            <dd className="text-right font-mono text-foreground tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-[11px] text-muted-foreground">{w.apiPriceNote}</p>
      {/* accounts are names, not labels: their own list, each written as the person named it, as in Agent accounts */}
      {byAccount.length ? (
        <section aria-label={w.spendByAccount} className="mt-3">
          <h3 className="text-xs text-muted-foreground">{w.spendByAccount}</h3>
          <dl className="mt-1 grid gap-1 text-xs">
            {byAccount.map(([name, cost]) => {
              const a = m.s.accounts.find((x) => x.name === name);
              return (
                <div key={name} className="flex justify-between gap-2">
                  <dt className="min-w-0 truncate text-sm font-medium">
                    {name}
                    {a ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{billingLabel(a, w)}</span> : null}
                  </dt>
                  <dd className="shrink-0 font-mono text-foreground tabular-nums">{accountWeek(a, cost, w)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ) : null}
      {/* the cap itself is a switch under the header's Pause; this opens where it and the other limits live */}
      <Button variant="link" size="xs" className="mt-1 px-0" onClick={() => ui.openDrawer({ kind: "settings", tab: "schedule" })}>
        {w.budgetChange}
      </Button>
    </Pane>
  );
}
