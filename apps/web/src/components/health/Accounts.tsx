import { type Account, comboLabel, comboOf } from "@overhand/contract";
import type { CSSProperties } from "react";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { fmt, pct, until } from "@/lib/format";
import { billingLabel } from "@/lib/spend";
import { Pane } from "../Pane";

/** Colour by how close a window is to its limit. */
const tone = (f: number) => (f >= 0.85 ? "var(--bad)" : f >= 0.6 ? "var(--warn)" : "var(--ok)");

/**
 * One account's line: its name (left out under a card that already names it), agent and how it's paid for, ready or
 * cooling down, and its usage as a bar.
 */
export function AccountRow({ a, m, named = true }: { a: Account; m: Model; named?: boolean }) {
  const w = useWords();
  const now = m.s.now;
  const u = a.usage;
  const busy = m.s.running.some((r) => r.account === a.name);
  const cooling = a.coolUntil > now;
  const five = u ? u.fiveHour : -1;
  const week = u ? u.sevenDay : -1;
  const color = cooling ? "var(--bad)" : five >= 0 ? tone(five) : busy ? "var(--warn)" : "var(--ok)";
  const lit = five >= 0 ? Math.max(five > 0 ? 1 : 0, Math.round(five * 20)) : cooling ? 20 : 0;
  const when = (ms: number) => until(ms, now);
  const left = cooling ? Math.ceil((a.coolUntil - now) / 60000) : 0;
  const status = cooling
    ? left < 120
      ? fmt(w.accBackIn, { n: left })
      : fmt(w.accBackAt, { t: when(a.coolUntil) })
    : busy
      ? w.accWorking
      : w.accReady;
  const tip = u
    ? fmt(w.accTip, {
        five: pct(five),
        fiveAt: when(u.fiveHourResetsAt),
        week: pct(week),
        weekAt: when(u.sevenDayResetsAt),
        n: Math.max(0, Math.round((now - u.at) / 60000)),
      })
    : w.accNoReading;
  return (
    <li className="py-1.5" title={tip}>
      <div className="flex items-baseline justify-between gap-2">
        {/* the name and its agent wrap; how it's paid for is never cut */}
        <b className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
          {named ? a.name : null}
          {/* every account names its agent and model the same way, the default one included */}
          <span className={`${named ? "ml-1.5 " : ""}font-normal text-xs text-muted-foreground`}>
            {comboLabel(comboOf(a.runtime, a.provider, a.model))} · <span className="whitespace-nowrap">{billingLabel(a, w)}</span>
          </span>
        </b>
        <span className="shrink-0 text-xs" style={{ color }}>
          {status}
          {/* only Claude subscriptions in Claude Code report 5-hour and weekly windows */}
          {a.provider === "claude" && a.runtime === "claude-code" ? (
            <>
              {" "}
              · {fmt(w.accFive, { pct: pct(five) })} ·{" "}
              <span style={{ color: week >= 0 ? tone(week) : undefined }}>{fmt(w.accWeek, { pct: pct(week) })}</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-[repeat(20,1fr)] gap-[3px]" aria-hidden="true">
        {Array.from({ length: 20 }, (_, n) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 20 cells
            key={n}
            className={n < lit ? "hud-cell h-1.5" : "h-1.5 bg-primary/8"}
            style={n < lit ? ({ background: color, boxShadow: `0 0 6px ${color}`, "--n": n } as CSSProperties) : undefined}
          />
        ))}
      </div>
      <p className="sr-only">{tip}</p>
    </li>
  );
}

/** Each account: ready, working or cooling down, and how much of its windows it has used. */
export function Accounts({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  return (
    <Pane title="paneAccounts">
      <ul>
        {m.s.accounts.map((a) => (
          <AccountRow key={a.name} a={a} m={m} />
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap gap-x-4">
        <Button variant="link" size="xs" className="px-0" onClick={() => ui.openDrawer({ kind: "settings", tab: "agents" })}>
          {w.manageAccounts}
        </Button>
      </div>
    </Pane>
  );
}
