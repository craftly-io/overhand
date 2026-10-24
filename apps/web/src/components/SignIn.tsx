import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";

/** `POST /api/accounts/login`: the sign-in Overhand runs (its link, a code to enter, whether one comes back), or a terminal's command. */
const Started = z.union([
  z.object({ id: z.string(), url: z.string(), code: z.string(), asks: z.boolean() }),
  z.object({ command: z.string() }),
]);
const State = z.object({ state: z.enum(["waiting", "done", "failed"]), why: z.string() });
const Ok = z.object({ ok: z.boolean() });
/** How often the app looks whether the sign-in has finished. */
const POLL_MS = 2000;

/**
 * A tab opened on the click itself, before the sign-in link exists (one opened once it arrives is blocked as a pop-up);
 * null when the browser blocks it anyway, and the page's own link opens it instead.
 */
export function openTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

type Props = { account: string; tool: string; onSignedIn: () => void };

/**
 * An account's own sign-in without a terminal: the agent CLI runs on the daemon's machine, its sign-in page opens in
 * `tab` (opened on the click that started it) on the device you're on, and, when the CLI asks, the code the browser
 * gave you goes back to it. Signed in is the CLI's own status check saying so; `onSignedIn` then runs (the account
 * test). A CLI that can't be run this way opens in a terminal and its command shows.
 */
export function SignIn({ tab, ...p }: Props & { tab: Window | null }) {
  // Try again starts afresh, from its own click: a new sign-in and tab, nothing kept from the one before
  const [run, setRun] = useState({ n: 0, tab });
  return <Flow key={run.n} {...p} tab={run.tab} onRetry={() => setRun((r) => ({ n: r.n + 1, tab: openTab() }))} />;
}

function Flow({ account, tool, onSignedIn, tab, onRetry }: Props & { tab: Window | null; onRetry: () => void }) {
  const w = useWords();
  const [started, setStarted] = useState<z.infer<typeof Started> | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const told = useRef(false);
  const field = useId();

  useEffect(() => {
    let live = true;
    post("/api/accounts/login", { account }, Started)
      .then((r) => {
        if (!live) return; // a start this one replaced
        if ("url" in r && tab && !tab.closed) tab.location.href = r.url;
        else tab?.close();
        setStarted(r);
      })
      .catch((e: unknown) => {
        if (!live) return;
        tab?.close();
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [account, tab]);

  const id = started && "id" in started ? started.id : "";
  const state = useQuery({
    queryKey: ["sign-in", id],
    queryFn: () => get(`/api/accounts/login?id=${encodeURIComponent(id)}`, State),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "waiting" ? false : POLL_MS),
  });
  const now = state.data?.state ?? "waiting";
  useEffect(() => {
    if (now === "done" && !told.current) {
      told.current = true;
      onSignedIn();
    }
  }, [now, onSignedIn]);

  const send = async () => {
    setError("");
    try {
      await post("/api/accounts/login/code", { id, code: code.trim() }, Ok);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const why = error || (now === "failed" ? (state.data?.why ?? "") : "");

  return (
    <div className="grid gap-2" aria-live="polite">
      {why ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-bad">
            {why}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {w.signInRetry}
          </Button>
        </div>
      ) : !started ? (
        // the waiting line it's about to be
        <div role="status">
          <span className="sr-only">{fmt(w.signInStarting, { tool })}</span>
          <Skeleton className="h-5 w-56" />
        </div>
      ) : "command" in started ? (
        <>
          <p className="text-sm">{w.addAccountWaiting}</p>
          <code className="w-fit max-w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] break-all select-all">
            {started.command}
          </code>
        </>
      ) : now === "done" ? (
        <p className="text-sm text-ok">{w.signInDone}</p>
      ) : (
        <>
          <p className="text-sm">
            {w.signInWaiting}{" "}
            <a href={started.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">
              {w.signInOpenAgain}
            </a>
          </p>
          {started.code ? (
            <p className="text-sm">
              {w.signInEnterCode} <code className="font-mono text-base tracking-wider select-all">{started.code}</code>
            </p>
          ) : null}
          {started.asks ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor={field} className="grid gap-1 text-sm">
                {w.signInPasteCode}
                <Input
                  id={field}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sent}
                  className="w-72 max-w-full font-mono text-sm"
                />
              </label>
              <Button type="submit" variant="outline" disabled={sent || !code.trim()}>
                {sent ? w.signInChecking : w.signInSend}
              </Button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What an account's test call answers (`/api/accounts/test`). */
export const Tested = z.object({ ok: z.boolean(), message: z.string() });

/**
 * An account's Sign in: its CLI's own sign-in, run by Overhand (SignIn), in its own folder where it has one; the login
 * stays with the CLI. Once signed in, the account's test call runs and says how it went.
 */
export function AccountSignIn({ account, tool, label }: { account: string; tool: string; label: string }) {
  const w = useWords();
  // the sign-in page's tab, opened on the click itself (one opened once the link arrives is blocked as a pop-up)
  const [open, setOpen] = useState<{ tab: Window | null } | null>(null);
  const test = async () => {
    try {
      const t = await post("/api/accounts/test", { account }, Tested);
      toast(t.ok ? fmt(w.addAccountReady, { account }) : fmt(w.addAccountFailed, { account, why: t.message }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return open ? (
    <SignIn account={account} tool={tool} tab={open.tab} onSignedIn={() => void test()} />
  ) : (
    <Button size="xs" variant="outline" className="justify-self-start" onClick={() => setOpen({ tab: openTab() })}>
      {label}
    </Button>
  );
}
