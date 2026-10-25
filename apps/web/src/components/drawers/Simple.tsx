import { newestFirst, SITE } from "@overhand/contract";
import { Square } from "lucide-react";
import { useEffect } from "react";
import type { Model } from "@/app/data";
import { Term, useTheme, useWords } from "@/app/theme";
import { cardSpanNow, useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/format";
import { speak, stopSpeaking, useSpeaking } from "@/lib/voice";
import { InboxRow, NeedsList, needs, SlackRead } from "../now/Alerts";
import { DrawerHead } from "./DrawerHost";

/** Needs you in full: every item, then what Slack brought that needs nothing (notes, requests already filed or skipped). */
export function AlertsDrawer({ m }: { m: Model }) {
  const w = useWords();
  const list = needs(m);
  const rest = m.inbox.filter((x) => x.kind === "note" || (x.kind === "new" && x.when === "filed"));
  return (
    <>
      <DrawerHead kicker={fmt(w.alertsCount, { n: list.length })} named="paneAlerts" />
      <div className="absolute top-4 right-12">
        <SlackRead m={m} />
      </div>
      <div className="m-enter mt-4 grid gap-4">
        {list.length ? <NeedsList list={list} /> : <p className="text-sm text-muted-foreground">{w.calm}</p>}
        {rest.length ? (
          <ul className="divide-y divide-border border-t border-border">
            {rest.map((x, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: inbox lines have no id and keep their order
              <InboxRow key={i} x={x} />
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

/** The planner's notes: risks and tracker drift. */
export function NotesDrawer({ m }: { m: Model }) {
  const w = useWords();
  return (
    <>
      <DrawerHead kicker={w.notesKicker} title={w.notesTitle} />
      <p className="m-enter mt-4 text-sm leading-relaxed whitespace-pre-wrap">{m.plan.notes.join("\n\n")}</p>
    </>
  );
}

/**
 * The briefing, read aloud while it's open and written down, and a way to share the night it tells. Closing it, or
 * going anywhere else, stops the voice.
 */
export function BriefDrawer({ text }: { text: string }) {
  const { words: w, theme } = useTheme();
  const ui = useUi();
  const { voice } = theme;
  const talking = useSpeaking();
  useEffect(() => {
    speak(text, { voice });
    return stopSpeaking;
  }, [text, voice]);
  return (
    <>
      <DrawerHead kicker={w.briefKicker} title={w.briefTitle} />
      <p className="m-enter mt-4 leading-relaxed">{text}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {talking ? (
          <Button variant="outline" title={w.briefStopHint} onClick={stopSpeaking}>
            <Square aria-hidden="true" />
            {w.briefStop}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => ui.openDrawer({ kind: "share", span: cardSpanNow(new Date(Date.now())) })}>
          <Term k="share" />
        </Button>
      </div>
    </>
  );
}

/** After "Turn Overhand off": how to start it again. */
export function ShutdownDrawer({ busy, startAgain }: { busy: boolean; startAgain: string }) {
  const w = useWords();
  return (
    <>
      <DrawerHead kicker={w.shutdownKicker} title={busy ? w.shutdownTitleBusy : w.shutdownTitle} />
      <p className="mt-4 text-sm text-muted-foreground">{w.startAgainHint}</p>
      <pre className="mt-2 overflow-x-auto bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{startAgain}</pre>
    </>
  );
}

/** What's new: every feature in the registry (packages/contract/src/features.ts), newest first, each with its docs. */
export function NewsDrawer() {
  const w = useWords();
  return (
    <>
      <DrawerHead kicker={w.whatsNewKicker} title={w.whatsNew} />
      <ul className="m-enter mt-4 divide-y divide-border border-t border-border">
        {newestFirst().map((f) => (
          <li key={f.id} className="grid gap-0.5 py-2.5 text-sm">
            <b className="font-medium">{f.name}</b>
            <span className="text-muted-foreground">{f.line}</span>
            <a
              className="justify-self-start text-xs text-primary underline-offset-2 hover:underline"
              href={`${SITE}/${f.docs.replace(".html", "")}`}
              target="_blank"
              rel="noreferrer"
            >
              {w.whatsNewHow}
              <span className="sr-only">: {f.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
