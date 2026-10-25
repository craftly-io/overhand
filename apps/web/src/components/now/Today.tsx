import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";

/**
 * The planner's top three for today, the first one standing out: a short list at the foot of Needs you, since each is
 * something to see to. Nothing before there's a plan (Plan the day is in the command bar and the actions menu).
 */
export function Today({ m }: { m: Model }) {
  const w = useWords();
  const top = m.plan.top;
  if (!top.length) return null;
  return (
    <section className="grid gap-1.5 border-t border-border pt-2.5" aria-label={w.paneToday}>
      <h3 className="text-xs text-muted-foreground">{w.paneToday}</h3>
      <ol className="grid gap-2">
        {top.map((t, i) => (
          <li key={t} className="flex gap-2.5 text-sm first:text-base first:text-foreground">
            <span className="font-mono text-primary" aria-hidden="true">
              {i + 1}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{t}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
