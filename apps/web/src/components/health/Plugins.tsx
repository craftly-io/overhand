import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { PLUGIN_KIND, pluginLine, severityColor } from "@/lib/plugins";
import { Dot, Pane } from "../Pane";

/** Each plugin's state and its last run's findings, every one with its fix: open the page it names, or run it again. */
export function Plugins({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  const { plugin } = useActions();
  const list = m.s.plugins;
  if (!list.length) return null;
  const bad = list.reduce((n, p) => n + p.findings.filter((f) => f.severity === "bad").length + (p.last?.ok === false ? 1 : 0), 0);
  return (
    <Pane title="panePlugins" count={bad} countTone="var(--bad)">
      <ul className="grid gap-3">
        {list.map((p) => (
          <li key={p.name} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <b className="font-medium">{p.name}</b>
              <span className="text-xs text-muted-foreground">{w[PLUGIN_KIND[p.kind]]}</span>
            </div>
            <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{pluginLine(p, w)}</span>
            {p.state === "on" ? (
              <ul className="mt-1 grid gap-1">
                {p.findings.map((f) => (
                  <li key={f.title} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 text-xs">
                    <Dot color={severityColor(f.severity)} label={f.severity} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {f.title}
                      {f.line ? <span className="block text-muted-foreground">{f.line}</span> : null}
                    </span>
                    {f.fix.kind === "link" ? (
                      <Button size="xs" variant="ghost" asChild>
                        <a href={f.fix.url} target="_blank" rel="noopener noreferrer">
                          {w.open}
                        </a>
                      </Button>
                    ) : (
                      <Button size="xs" variant="ghost" onClick={() => void plugin({ do: "run", name: p.name })}>
                        {w.plRunAgain}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {p.state === "on" && p.last?.ok === false ? (
              <Button className="mt-1" size="xs" onClick={() => void plugin({ do: "run", name: p.name })}>
                {w.plRunAgain}
              </Button>
            ) : p.state !== "on" && p.state !== "paused" ? (
              <Button className="mt-1" size="xs" variant="outline" onClick={() => ui.openDrawer({ kind: "settings", tab: "plugins" })}>
                {w.alPluginReview}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Pane>
  );
}
