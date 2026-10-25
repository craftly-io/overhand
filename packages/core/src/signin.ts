/**
 * A CLI's own sign-in (an agent's, or GitHub's `gh`), run by the daemon instead of in a terminal: the CLI runs in a
 * pseudo-terminal (it behaves as it would in one), or on plain pipes where it then asks less. Overhand reads its output
 * only for the sign-in link (and a one-time code it shows), and keeps it waiting. The app opens the link on whatever
 * device you're on. Nothing the CLI prints is logged or kept past the link; the credential stays with the CLI.
 * Claude Code on a plan never runs here: Anthropic's terms say sign-in to a Claude account "must complete through
 * Anthropic's own flow", so you run its command in your own terminal and Overhand only watches its status (`watchSignIn`).
 */
import type { Subprocess } from "bun";

/** How long a sign-in may wait for you before it's stopped. */
export const SIGN_IN_MS = 10 * 60_000;
/** How long a CLI has to show its sign-in link. */
const URL_MS = 30_000;
/** How much of a CLI's first output is read for the link; the rest is never kept. */
const READ_MAX = 16_384;
/** How often a sign-in you run yourself is checked. */
const WATCH_MS = 3000;

export const SIGNIN_NO_LINK = "The sign-in stopped before it showed a link.";
export const SIGNIN_SLOW = "The sign-in didn't show a link in time.";
export const SIGNIN_TIMED_OUT = "The sign-in waited 10 minutes and stopped.";
export const SIGNIN_UNFINISHED = "The sign-in didn't finish.";
export const SIGNIN_GONE = "That sign-in has ended. Try again.";

/** What the app needs to show a sign-in: its link, and a code to enter there ("" if none). */
export type SignInStart = { id: string; url: string; code: string };
/** Where a sign-in is: waiting for you, signed in (checked by the CLI itself), or ended with why, in a line. */
export type SignInState = { state: "waiting" | "done" | "failed"; why: string };

type Live = SignInState & { key: string; by: string; end: () => void };
const LIVE = new Map<string, Live>();

/** Every web address in terminal output ends at a space, a quote or an escape code (OSC 8 links wrap them in those). */
const URL_RE = /https?:\/\/[^\s\p{Cc}"'<>]+/gu;

/** The first web address a CLI printed. */
export const signInUrl = (out: string): string => out.match(URL_RE)?.[0] ?? "";

/** A one-time code the CLI shows for you to type in the browser (Codex's device code: ABCD-12345), "" when none. */
export const shownCode = (out: string): string => /(?:^|\s)([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?=\s|$)/.exec(out.replace(URL_RE, " "))?.[1] ?? "";

/**
 * A new sign-in for `key` (stopping the one before), kept in LIVE, and how it ends: once, after `ms` at the latest,
 * calling `stop` with why. An ended sign-in stays readable a minute, for the app's last look.
 */
function track(key: string, by: string, ms: number, stop: (why: string) => void) {
  for (const [id, s] of LIVE) if (s.key === key) stopSignIn(id);
  const id = crypto.randomUUID();
  const timer = setTimeout(() => end("failed", SIGNIN_TIMED_OUT), ms);
  const end = (state: "done" | "failed", why = "") => {
    clearTimeout(timer);
    if (live.state === "waiting") Object.assign(live, { state, why });
    stop(why);
    setTimeout(() => LIVE.get(id) === live && LIVE.delete(id), 60_000).unref();
  };
  const live: Live = { key, by, state: "waiting", why: "", end: () => end("failed", SIGNIN_GONE) };
  LIVE.set(id, live);
  return { id, live, end };
}

/**
 * Starts a CLI's sign-in and answers once it shows its link. One per `key` (an account): starting again stops the one
 * before. `by` is who started it (a paired device's id, or "local"): only they see how it ends. When the CLI exits,
 * `verify` (its own status check) decides whether you're signed in.
 */
export async function startSignIn(o: {
  key: string;
  by: string;
  argv: string[];
  env: Record<string, string>;
  verify: () => Promise<boolean>;
  ms?: number;
  urlMs?: number;
  /** Runs it without a terminal: a CLI that asks more in one (gh asks about Git first) then asks nothing. */
  pipes?: boolean;
}): Promise<SignInStart | { error: string }> {
  let out = "";
  let reading = true;
  let shown: (r: SignInStart | { error: string }) => void = () => {};
  const started = new Promise<SignInStart | { error: string }>((r) => {
    shown = r;
  });
  let settle: Timer | undefined;
  let id = "";
  const decoder = new TextDecoder();
  const feed = (chunk: Uint8Array) => {
    if (!reading || out.length >= READ_MAX) return;
    out += decoder.decode(chunk, { stream: true });
    // a beat after the link, for the lines that follow it (a code to enter)
    if (signInUrl(out) && !settle)
      settle = setTimeout(() => {
        shown({ id, url: signInUrl(out), code: shownCode(out) });
        reading = false;
        out = "";
      }, 400);
  };
  // the CLI opens no browser here: the app opens the link on the device you're on
  const env = { ...process.env, ...o.env, BROWSER: "true", NO_OPEN_BROWSER: "1" };
  let proc: Subprocess;
  try {
    if (o.pipes) {
      const p = Bun.spawn(o.argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      // read to the end, so a CLI that goes on printing never waits on a full pipe; past the link nothing is kept
      for (const s of [p.stdout, p.stderr])
        void (async () => {
          for await (const c of s) feed(c);
        })().catch(() => {});
      proc = p;
    } else
      proc = Bun.spawn(o.argv, {
        env,
        terminal: { cols: 1000, rows: 50, data: (_t, chunk) => feed(chunk) }, // wide, so a long link never wraps
      });
  } catch {
    return { error: SIGNIN_NO_LINK };
  }
  const slow = setTimeout(() => shown({ error: SIGNIN_SLOW }), o.urlMs ?? URL_MS);
  const t = track(o.key, o.by, o.ms ?? SIGN_IN_MS, (why) => {
    clearTimeout(slow);
    clearTimeout(settle);
    reading = false;
    out = "";
    proc.kill();
    shown({ error: why || SIGNIN_NO_LINK });
  });
  id = t.id;
  void proc.exited.then(async (code) => {
    if (t.live.state !== "waiting") return;
    const ok = code === 0 && (await o.verify().catch(() => false));
    t.end(ok ? "done" : "failed", ok ? "" : settle ? SIGNIN_UNFINISHED : SIGNIN_NO_LINK);
  });
  const r = await started;
  if ("error" in r) {
    t.end("failed", r.error);
    LIVE.delete(id);
  }
  return r;
}

/**
 * Watches a sign-in you run yourself in a terminal on this computer (Claude Code's on a plan, through Anthropic's own
 * flow: nothing of it passes through Overhand): `verify`, the CLI's own status check, every few seconds until it says
 * signed in, or 10 minutes pass. One per `key`, seen only by `by`, as a started one is; returns its id.
 */
export function watchSignIn(o: { key: string; by: string; verify: () => Promise<boolean>; ms?: number; everyMs?: number }): string {
  let looking = false;
  const look = setInterval(() => {
    if (looking) return;
    looking = true;
    void o
      .verify()
      .catch(() => false)
      .then((ok) => {
        looking = false;
        if (ok) t.end("done");
      });
  }, o.everyMs ?? WATCH_MS);
  const t = track(o.key, o.by, o.ms ?? SIGN_IN_MS, () => clearInterval(look));
  return t.id;
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
