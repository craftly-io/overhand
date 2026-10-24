/**
 * An agent CLI's own sign-in, run by the daemon instead of in a terminal: the CLI runs in a pseudo-terminal (it behaves
 * as it would in one), Overhand reads its output only for the sign-in link (and a one-time code it shows, or whether it
 * asks for one back), and keeps it waiting. The app opens the link on whatever device you're on and sends back the code
 * the browser gives you. Nothing the CLI prints is logged or kept past the link; the credential stays with the CLI.
 */
import type { Subprocess } from "bun";

/** How long a sign-in may wait for you before it's stopped. */
export const SIGN_IN_MS = 10 * 60_000;
/** How long a CLI has to show its sign-in link. */
const URL_MS = 30_000;
/** How much of a CLI's first output is read for the link; the rest is never kept. */
const READ_MAX = 16_384;

export const SIGNIN_NO_LINK = "The sign-in stopped before it showed a link.";
export const SIGNIN_SLOW = "The sign-in didn't show a link in time.";
export const SIGNIN_TIMED_OUT = "The sign-in waited 10 minutes and stopped.";
export const SIGNIN_UNFINISHED = "The sign-in didn't finish.";
export const SIGNIN_GONE = "That sign-in has ended. Try again.";

/** What the app needs to show a sign-in: its link, a code to enter there ("" if none), and whether one comes back. */
export type SignInStart = { id: string; url: string; code: string; asks: boolean };
/** Where a sign-in is: waiting for you, signed in (checked by the CLI itself), or ended with why, in a line. */
export type SignInState = { state: "waiting" | "done" | "failed"; why: string };

type Live = SignInState & { key: string; by: string; proc: Subprocess; end: () => void };
const LIVE = new Map<string, Live>();

/** Every web address in terminal output ends at a space, a quote or an escape code (OSC 8 links wrap them in those). */
const URL_RE = /https?:\/\/[^\s\p{Cc}"'<>]+/gu;

/** The first web address a CLI printed. */
export const signInUrl = (out: string): string => out.match(URL_RE)?.[0] ?? "";

/** A one-time code the CLI shows for you to type in the browser (Codex's device code: ABCD-12345), "" when none. */
export const shownCode = (out: string): string => /(?:^|\s)([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?=\s|$)/.exec(out.replace(URL_RE, " "))?.[1] ?? "";

/** Whether the CLI waits for a code pasted back from the browser (Claude Code's "Paste code here"). */
export const asksForCode = (out: string): boolean => /paste\b.*\bcode/i.test(out);

/**
 * Starts a CLI's sign-in and answers once it shows its link. One per `key` (an account): starting again stops the one
 * before. `by` is who started it (a paired device's id, or "local"): only they can send the code or see it end. When the
 * CLI exits, `verify` (its own status check) decides whether you're signed in.
 */
export async function startSignIn(o: {
  key: string;
  by: string;
  argv: string[];
  env: Record<string, string>;
  verify: () => Promise<boolean>;
  ms?: number;
  urlMs?: number;
}): Promise<SignInStart | { error: string }> {
  for (const [id, s] of LIVE) if (s.key === o.key) stopSignIn(id);
  const id = crypto.randomUUID();
  let out = "";
  let reading = true;
  let shown: (r: SignInStart | { error: string }) => void = () => {};
  const started = new Promise<SignInStart | { error: string }>((r) => {
    shown = r;
  });
  let settle: Timer | undefined;
  const decoder = new TextDecoder();
  let proc: Subprocess;
  try {
    proc = Bun.spawn(o.argv, {
      // the CLI opens no browser here: the app opens the link on the device you're on
      env: { ...process.env, ...o.env, BROWSER: "true", NO_OPEN_BROWSER: "1" },
      terminal: {
        cols: 1000, // wide, so a long link never wraps
        rows: 50,
        data: (_t, chunk) => {
          if (!reading || out.length >= READ_MAX) return;
          out += decoder.decode(chunk, { stream: true });
          // a beat after the link, for the lines that follow it (a code to enter, a prompt for one)
          if (signInUrl(out) && !settle)
            settle = setTimeout(() => {
              shown({ id, url: signInUrl(out), code: shownCode(out), asks: asksForCode(out) });
              reading = false;
              out = "";
            }, 400);
        },
      },
    });
  } catch {
    return { error: SIGNIN_NO_LINK };
  }
  const timer = setTimeout(() => end("failed", SIGNIN_TIMED_OUT), o.ms ?? SIGN_IN_MS);
  const slow = setTimeout(() => shown({ error: SIGNIN_SLOW }), o.urlMs ?? URL_MS);
  const end = (state: "done" | "failed", why = "") => {
    clearTimeout(timer);
    clearTimeout(slow);
    clearTimeout(settle);
    reading = false;
    out = "";
    if (live.state === "waiting") Object.assign(live, { state, why });
    proc.kill();
    shown({ error: why || SIGNIN_NO_LINK });
    // an ended sign-in stays readable a minute, for the app's last look
    setTimeout(() => LIVE.get(id) === live && LIVE.delete(id), 60_000).unref();
  };
  const live: Live = { key: o.key, by: o.by, proc, state: "waiting", why: "", end: () => end("failed", SIGNIN_GONE) };
  LIVE.set(id, live);
  void proc.exited.then(async (code) => {
    if (live.state !== "waiting") return;
    const ok = code === 0 && (await o.verify().catch(() => false));
    end(ok ? "done" : "failed", ok ? "" : settle ? SIGNIN_UNFINISHED : SIGNIN_NO_LINK);
  });
  const r = await started;
  if ("error" in r) {
    end("failed", r.error);
    LIVE.delete(id);
  }
  return r;
}

/** Sends the code from the browser to the waiting sign-in that `by` started, as if typed and Enter pressed. */
export function sendSignInCode(id: string, by: string, code: string): { ok: true } | { error: string } {
  const s = LIVE.get(id);
  const clean = code.replace(/\p{Cc}/gu, "").trim();
  if (!s || s.by !== by || s.state !== "waiting") return { error: SIGNIN_GONE };
  if (!clean || clean.length > 4096) return { error: "Paste the code the browser showed." };
  // typed, then Enter a beat later, so a CLI that reads a fast burst as a paste still sees Enter on its own
  s.proc.terminal?.write(clean);
  setTimeout(() => s.proc.terminal?.write("\r"), 150);
  return { ok: true };
}

/** Where the sign-in that `by` started is; null for one that isn't theirs or has gone. */
export function signInState(id: string, by: string): SignInState | null {
  const s = LIVE.get(id);
  return s && s.by === by ? { state: s.state, why: s.why } : null;
}

/** Stops a sign-in and its CLI. */
export function stopSignIn(id: string): void {
  LIVE.get(id)?.end();
}

/**
 * Types an API key into OpenCode's key prompt, then Enter (a carriage return: its prompt ignores a newline), and waits
 * for its login to end; true when it ends well. The key goes to OpenCode's stdin only, never to a log or a file here.
 */
export async function opencodeKey(argv: string[], env: Record<string, string>, key: string, ms = 20_000): Promise<boolean> {
  try {
    const p = Bun.spawn(argv, { env: { ...process.env, ...env, BROWSER: "true" }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(`${key}\r`);
    await p.stdin.flush();
    const stop = setTimeout(() => p.kill(), ms);
    const code = await p.exited;
    clearTimeout(stop);
    return code === 0;
  } catch {
    return false; // its CLI isn't there, or can't start
  }
}
