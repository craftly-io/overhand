import { RUNTIME_NAMES } from "@overhand/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { get, post, Refused } from "@/lib/api";
import { fmt } from "@/lib/format";

/**
 * `POST /api/accounts/login`: the sign-in Overhand runs (its link, a code to enter), or a command: one you run yourself
 * in your terminal (Claude Code's: Anthropic's own flow), watched as `id`, from this computer or not (`local`), or one
 * that opened in a terminal (no `id`).
 */
const Started = z.union([
  z.object({ id: z.string(), url: z.string(), code: z.string() }),
  z.object({ command: z.string(), id: z.string().default(""), local: z.boolean().default(true) }),
]);
const State = z.object({ state: z.enum(["waiting", "done", "failed"]), why: z.string() });
/** How often the app looks whether the sign-in has finished. */
const POLL_MS = 2000;

/** Claude Code signs in through Anthropic's own flow in your terminal, so its sign-in opens no page here. */
const ownTerminal = (tool: string): boolean => tool === RUNTIME_NAMES["claude-code"];

/**
 * A tab opened on the click itself, before the sign-in link exists (one opened once it arrives is blocked as a pop-up);
 * null when the browser blocks it anyway, and the page's own link opens it instead, or when `tool` opens no page.
 */
export function openTab(tool = ""): Window | null {
  if (ownTerminal(tool)) return null;
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/**
 * `account`: the agent account it signs in, at `/api/accounts/login`; `path` starts another sign-in the daemon runs the
 * same way (GitHub's, `/api/github/signin`). `via`: which of its sign-ins a CLI with more than one runs (OpenCode's,
 * OPENCODE_ACCOUNTS).
 */
type Props = { account?: string; path?: string; tool: string; onSignedIn: () => void; via?: string };

/**
 * An account's own sign-in without a terminal: the agent CLI runs on the daemon's machine and its sign-in page opens in
 * `tab` (opened on the click that started it) on the device you're on. Claude Code's is yours to run: its command shows,
 * with Copy, for your terminal on this computer. Signed in is the CLI's own status check saying so; `onSignedIn` then
 * runs (the account test). A CLI that can't be run either way opens in a terminal and its command shows.
 */
export function SignIn({ tab, ...p }: Props & { tab: Window | null }) {
  // Try again starts afresh, from its own click: a new sign-in and tab, nothing kept from the one before (GitHub's opens
  // none: its code shows first, and its page opens from the button beside it)
  const [run, setRun] = useState({ n: 0, tab });
  const again = () => (p.path ? null : openTab(p.tool));
  return <Flow key={run.n} {...p} tab={run.tab} onRetry={() => setRun((r) => ({ n: r.n + 1, tab: again() }))} />;
}

function Flow({
  account,
  path = "/api/accounts/login",
  tool,
  onSignedIn,
  tab,
  onRetry,
  via,
}: Props & { tab: Window | null; onRetry: () => void }) {
  const w = useWords();
  const [started, setStarted] = useState<z.infer<typeof Started> | null>(null);
  const [error, setError] = useState("");
  // the command to run by hand on the daemon's machine when the sign-in couldn't start there
  const [byHand, setByHand] = useState("");
  const [copied, setCopied] = useState(false);
  const told = useRef(false);

  useEffect(() => {
    let live = true;
    post(path, { ...(account ? { account } : {}), ...(via ? { via } : {}) }, Started)
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
        if (e instanceof Refused) setByHand(e.command);
      });
    return () => {
      live = false;
    };
  }, [account, path, tab, via]);

  const id = started?.id ?? "";
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

  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
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
          {byHand ? (
            <code className="w-fit max-w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] break-all select-all">
              {byHand}
            </code>
          ) : null}
        </div>
      ) : !started ? (
        // the waiting line it's about to be
        <div role="status">
          <span className="sr-only">{fmt(w.signInStarting, { tool })}</span>
          <Skeleton className="h-5 w-56" />
        </div>
      ) : now === "done" ? (
        <p className="text-sm text-ok">{w.signInDone}</p>
      ) : "command" in started ? (
        // run by you: the exact command, for your terminal on this computer (from a phone, finish there)
        <>
          <p className="text-sm">{!started.id ? w.addAccountWaiting : started.local ? w.signInYourTerminal : w.signInOnComputer}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="w-fit max-w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] break-all select-all">
              {started.command}
            </code>
            {started.id ? (
              <Button type="button" size="sm" variant="outline" onClick={() => copy(started.command)}>
                {copied ? w.hostedCopied : w.hostedCopy}
              </Button>
            ) : null}
          </div>
          {started.id ? <p className="text-xs text-muted-foreground">{w.signInWaiting}</p> : null}
        </>
      ) : !tab && started.code ? (
        // no page opened yet: the code first, then the one button that opens where it goes
        <>
          <p className="text-sm">
            {w.signInEnterCode} <code className="font-mono text-base tracking-wider select-all">{started.code}</code>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm" className="w-fit">
              <a href={started.url} target="_blank" rel="noopener noreferrer">
                {fmt(w.signInOpenTool, { tool })}
              </a>
            </Button>
            <span className="text-xs text-muted-foreground">{w.signInWaiting}</span>
          </div>
        </>
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
    <Button size="xs" variant="outline" className="justify-self-start" onClick={() => setOpen({ tab: openTab(tool) })}>
      {label}
    </Button>
  );
}
