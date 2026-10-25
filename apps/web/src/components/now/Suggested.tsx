import { ChevronDown } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { FeatureTip } from "@/components/FeatureTip";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/format";
import { LEAD_WORDS, previewRows, type Suggestion, suggestions } from "@/lib/leads";

/** What a ready-made lead would do here, before it exists: the first click's answer. Start is the second click. */
function Preview({ m, x, close }: { m: Model; x: Suggestion; close: () => void }) {
  const w = useWords();
  const { leadTemplate } = useActions();
  const mode = m.s.clients.find((c) => c.name === x.project)?.autonomy ?? "act";
  const rows = previewRows(x, mode, m.s.labels.queue, w);
  return (
    <div className="mt-2 grid gap-3 rounded-md border border-border p-3">
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-muted-foreground sm:pt-0.5">{k}</dt>
            <dd className="[overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void leadTemplate(x.project, x.kind, `${w[LEAD_WORDS[x.kind].name]} · ${x.project}`).then(close)}>
          {w.leadPreviewStart}
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          {w.cancel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Ready-made leads worth starting, from each project's own work right now: on a project's view, every one it could
 * use; on the bridge, the top one per project. A click previews what it would do; Start is on the preview.
 */
export function Suggested({ m, project }: { m: Model; project?: string }) {
  const w = useWords();
  const ui = useUi();
  const [open, setOpen] = useState("");
  const all = suggestions(m.s);
  const list = project
    ? all.filter((x) => x.project === project)
    : all.filter((x, i) => !x.needs && all.findIndex((y) => y.project === x.project) === i);
  if (!list.length) return null;
  return (
    <section className="grid gap-1.5 border-t border-border pt-2.5" aria-label={w.leadSuggested}>
      <h3 className="text-xs text-muted-foreground">{w.leadSuggested}</h3>
      <FeatureTip at="lead-suggested" />
      <ul className="grid gap-1.5">
        {list.map((x) => {
          const id = `${x.project}:${x.kind}`;
          const words = LEAD_WORDS[x.kind];
          if (x.needs)
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>{w.leadNeedsSentry}</span>
                <Button variant="outline" size="xs" onClick={() => ui.openDrawer({ kind: "settings", tab: "connections" })}>
                  {w.connectButton}
                </Button>
              </li>
            );
          return (
            <li key={id} style={{ "--c": m.hue(x.project) } as CSSProperties}>
              <button
                type="button"
                aria-expanded={open === id}
                className="group grid min-h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md border border-border px-2 py-1.5 text-left hover:bg-muted/40 aria-expanded:bg-(--c)/10"
                onClick={() => setOpen(open === id ? "" : id)}
              >
                <ChevronDown
                  aria-hidden="true"
                  className="col-start-2 row-span-2 row-start-1 size-4 text-muted-foreground transition-transform group-aria-expanded:rotate-180"
                />
                <span className="col-start-1 row-start-1 text-sm font-medium">
                  {w[words.name]}
                  {project ? null : <span className="font-normal text-(--c)"> · {x.project}</span>}
                </span>
                <span className="col-start-1 row-start-2 text-xs text-muted-foreground">
                  {x.items.length === 1 ? w[words.whyOne] : fmt(w[words.why], { n: x.items.length })}
                </span>
              </button>
              {open === id ? <Preview m={m} x={x} close={() => setOpen("")} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
