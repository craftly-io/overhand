import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { ago, fmt } from "@/lib/format";
import { Dot, Pane } from "../Pane";

const KIND = { slack: "Slack", teams: "Teams", discord: "Discord" } as const;

/** Each status update channel's last send; a failure in red with its error (which never holds the webhook URL). */
export function Updates({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  const { updateTest } = useActions();
  const list = m.s.updates;
  if (!list.length) return null;
  const failed = list.filter((u) => u.error).length;
  return (
    <Pane title="paneUpdates" count={failed} countTone="var(--bad)">
      <ul className="grid gap-2">
        {list.map((u) => (
          <li key={u.id} className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 text-sm">
            <Dot color={u.error ? "var(--bad)" : u.sentAt ? "var(--ok)" : "var(--muted-foreground)"} />
            <span className="min-w-0">
              <b className="font-medium">{u.name}</b> <span className="text-xs text-muted-foreground">{KIND[u.kind]}</span>
              <span className={`block text-xs [overflow-wrap:anywhere] ${u.error ? "text-bad" : "text-muted-foreground"}`}>
                {u.error
                  ? fmt(w.updatesFailed, { ago: ago(u.sentAt), error: u.error })
                  : u.sentAt
                    ? fmt(w.updatesSent, { ago: ago(u.sentAt) })
                    : w.updatesNever}
              </span>
            </span>
            {u.error ? (
              // a failed send's fix: try it now; the channel itself is edited in Settings
              <div className="col-start-2 mt-1 flex gap-1">
                <Button size="xs" onClick={() => void updateTest(u.id, u.name)}>
                  {w.updatesTest}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => ui.openDrawer({ kind: "settings", tab: "integrations" })}>
                  {w.decOpenSettings}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Pane>
  );
}
