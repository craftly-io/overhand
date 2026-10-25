import { type Connection, ConnectionsSchema } from "@overhand/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { SignIn } from "@/components/SignIn";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { nth } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** A state's tone: ready (locks on), needs you (amber), nothing to do (ink), not known yet. */
export type Tone = "ok" | "warn" | "idle" | "pending";

/** A state mark: a ring that locks on with a tick when ready, amber when it needs you, ink while it waits. */
export function Mark({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border",
        tone === "ok" && "m-lockon border-ok/50 bg-ok/10 text-ok",
        tone === "warn" && "border-warn/70 bg-warn/10 text-warn",
        (tone === "idle" || tone === "pending") && "border-border text-muted-foreground",
      )}
    >
      {tone === "ok" ? (
        <Check className="m-tick size-3" strokeWidth={3} />
      ) : tone === "warn" ? (
        <span className="text-[11px] leading-none font-bold">!</span>
      ) : (
        <span className={cn("size-1.5 rounded-full bg-current", tone === "pending" && "m-pulse")} />
      )}
    </span>
  );
}

/** How long a Connect waits for the browser's approval before it stops looking. */
const WAIT_MS = 3 * 60_000;

/**
 * Each service as one row: connected (and how), connected only through an agent's MCP server, or a Connect button that
 * signs Overhand in over MCP in a new tab, with a quiet "Use a token instead". While a sign-in is open it looks again
 * every two seconds and locks on when it lands.
 */
export function Connections({ className, style }: { className?: string; style?: CSSProperties }) {
  const w = useWords();
  const [waiting, setWaiting] = useState("");
  const [tokenFor, setTokenFor] = useState("");
  const q = useQuery({
    queryKey: ["connections"],
    queryFn: () => get("/api/connections", ConnectionsSchema),
    refetchInterval: waiting ? 2000 : false,
  });
  const services = q.data?.services ?? [];

  useEffect(() => {
    if (!waiting) return;
    const s = services.find((x) => x.id === waiting);
    if (s?.via === "mcp") {
      setWaiting("");
      toast(fmt(w.connectDone, { service: s.label }));
    }
  }, [services, waiting, w.connectDone]);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setWaiting(""), WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  const connect = async (s: Connection) => {
    // opened inside the click, so the browser doesn't block it as a popup; pointed at the consent page once it's known
    const tab = window.open("", "_blank");
    try {
      const { url } = await post("/api/connect", { service: s.id }, z.object({ url: z.string() }));
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.location.assign(url);
      setWaiting(s.id);
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const disconnect = async (s: Connection) => {
    try {
      await post("/api/disconnect", { service: s.id }, z.object({ ok: z.boolean() }));
      toast(fmt(w.connectGone, { service: s.label }));
      await q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const how = (s: Connection): string =>
    s.via === "gh"
      ? fmt(w.connectGh, { detail: s.detail })
      : s.via === "cli"
        ? w.connectCli
        : s.via === "mcp"
          ? w.connectMcp
          : s.via === "token"
            ? w.connectStored
            : s.via === "inbox"
              ? fmt(w.connectInbox, { detail: s.detail })
              : s.detail;
  /** The one line a row without a sign-in of its own explains itself with (GitHub's is its sign-in button). */
  const hint = (s: Connection): string =>
    s.id === "github"
      ? ""
      : s.id === "vercel"
        ? w.connectVercelHint
        : !s.connect
          ? fmt(w.connectNoSignIn, { service: s.label })
          : tokenFor === s.id
            ? w.connectTokenHint
            : "";

  return (
    <section className={cn("hud-pane gap-3", className)} style={style} aria-labelledby="connections-title" aria-busy={q.isPending}>
      <header className="grid gap-1">
        <h2 id="connections-title" className="font-display text-base tracking-wide">
          {w.connectTitle}
        </h2>
        <p className="max-w-[33em] text-sm text-muted-foreground">{w.connectHint}</p>
      </header>
      {q.isError ? (
        <p role="alert" className="text-sm text-bad">
          {q.error.message}
        </p>
      ) : null}
      {q.isPending ? <SkeletonRows rows={4} row="h-5" /> : null}
      <ul className="m-stagger grid divide-y divide-border">
        {services.map((s, i) => {
          const own = s.state === "connected";
          const line = own ? "" : hint(s);
          return (
            <li key={s.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0" style={nth(i)}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Mark key={s.state} tone={s.state === "none" ? "idle" : "ok"} />
                <span className="w-16 shrink-0 text-sm font-medium">{s.label}</span>
                <span
                  className={cn("min-w-0 flex-1 text-sm sm:min-w-40", s.state === "none" ? "text-muted-foreground" : "text-foreground")}
                >
                  {own ? w.connectConnected : s.state === "agent" ? w.connectViaAgent : w.connectNone}
                  {s.state !== "none" && how(s) ? <span className="text-muted-foreground"> · {how(s)}</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 max-sm:basis-full max-sm:pl-8">
                  {waiting === s.id ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                      <span aria-hidden="true" className="m-pulse size-1.5 rounded-full bg-primary" />
                      {w.connectWaiting}
                    </span>
                  ) : s.connect && !own ? (
                    <Button size="sm" variant={s.state === "none" ? "outline" : "ghost"} onClick={() => void connect(s)}>
                      {s.state === "none" ? w.connectButton : w.connectAlso}
                    </Button>
                  ) : null}
                  {s.id === "github" && !own ? <GithubFix /> : null}
                  {s.via === "mcp" ? (
                    <Button size="sm" variant="ghost" onClick={() => void disconnect(s)}>
                      {w.connectDisconnect}
                    </Button>
                  ) : null}
                  {s.connect && !own && waiting !== s.id ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs text-muted-foreground"
                      aria-expanded={tokenFor === s.id}
                      onClick={() => setTokenFor((t) => (t === s.id ? "" : s.id))}
                    >
                      {w.connectToken}
                    </Button>
                  ) : null}
                </span>
              </div>
              {line ? <p className="m-enter max-w-[33em] text-xs text-muted-foreground sm:pl-8">{line}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The one fix for a GitHub command tool that's missing or signed out, wherever it shows: a link to its installer, or
 * GitHub's own device sign-in, run by Overhand (SignIn): its one-time code and an Open GitHub button, no terminal. Once
 * signed in, every view reads GitHub again. Where the sign-in can't start it shows the command to run instead.
 */
export function GithubFix({ installed = true }: { installed?: boolean }) {
  const w = useWords();
  const qc = useQueryClient();
  const [started, setStarted] = useState(false);
  return installed ? (
    started ? (
      <SignIn path="/api/github/signin" tool="GitHub" tab={null} onSignedIn={() => void qc.invalidateQueries()} />
    ) : (
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setStarted(true)}>
        {w.setupGhSignIn}
      </Button>
    )
  ) : (
    <a className="w-fit text-sm text-primary underline" href="https://cli.github.com" target="_blank" rel="noopener noreferrer">
      {w.setupGhGet}
    </a>
  );
}
