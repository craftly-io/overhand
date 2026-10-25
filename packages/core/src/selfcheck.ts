/**
 * The dashboard self-check: every 15 minutes the daemon looks at its own dashboard with your real state. Always the
 * cheap part: the state parses with the contract and the page's files are there. Then, after a start (every update and
 * restart is one) until a render passes, and only when a browser is on this machine and the governor has room (not
 * strained, not quiet, a browser slot free), one muted headless tab renders it: the Now view has to show with no page
 * errors. A failure is a card in Needs you (Report, Reload) and one notification.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { DashboardStateSchema, NO_PROJECT, type SelfCheck, termHits } from "@overhand/contract";
import { z } from "zod";
import { ruleHold } from "./control";
import { redactSecrets } from "./corners";
import { openLink } from "./devices";
import { CFG, MIN, OPS, UI_PORT, WEB_DIST } from "./env";
import { acquire, gate, quietUntil, readMachine, release } from "./governor";
import { effectiveClients } from "./groups";
import { diskFree, notify } from "./notify";
import { VERSION } from "./selfupdate";

/** How often the daemon looks. */
export const SELF_CHECK_EVERY = 15 * MIN;

let last: SelfCheck = { ok: true, at: 0, mode: "none", error: "" };
/** The last result, for the dashboard state. */
export const lastSelfCheck = (): SelfCheck => last;

/**
 * The cheap check: the state, as the dashboard receives it, parses with the contract, and the page and every script and
 * stylesheet it loads are on disk. "" when it passes, else what's wrong.
 */
export function schemaCheck(state: unknown, dist = WEB_DIST): string {
  const r = DashboardStateSchema.safeParse(JSON.parse(JSON.stringify(state)));
  if (!r.success)
    return `the state doesn't match the dashboard's contract: ${r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ")}`;
  const index = join(dist, "index.html");
  if (!existsSync(index)) return "Overhand's page isn't built (index.html is missing)";
  const html = readFileSync(index, "utf8");
  const assets = [...html.matchAll(/(?:src|href)="\/([^"?#]+\.(?:js|css))"/g)].map((m) => m[1] ?? "");
  const missing = assets.find((a) => !existsSync(join(dist, a)));
  return missing ? `Overhand's ${missing} is missing` : "";
}

/** A browser Overhand may drive headless: OVERHAND_BROWSER, else a Chromium-family browser installed the usual way. */
export function findBrowser(env = process.env, exists = existsSync): string {
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  const linux = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  const list = [env.OVERHAND_BROWSER ?? "", ...(process.platform === "darwin" ? mac : linux)];
  return list.find((p) => p && exists(p)) ?? "";
}

/** Before the page's own scripts: speech says nothing (a replayed brief would speak aloud even headless). */
const SILENT = `try{Object.defineProperty(window,"speechSynthesis",{value:{speak(){},cancel(){},getVoices:()=>[],pause(){},resume(){},speaking:false,pending:false,paused:false,onvoiceschanged:null,addEventListener(){},removeEventListener(){}}})}catch{}`;
/** The Now view showed: the bridge's panes (or setup's) are in the page's main region. */
const RENDERED = `document.querySelectorAll("#main section, #main form").length`;

/**
 * A minimal DevTools Protocol client over the browser's pipe (`--remote-debugging-pipe`: it reads calls on its fd 3 and
 * writes answers and events on fd 4, each JSON message ending in a NUL): calls, to the browser or to one attached page
 * (`session`), and every event it sends. No port is opened, so no other program here can drive it.
 */
function cdp(input: Writable, output: Readable, onEvent: (method: string, params: Record<string, unknown>) => void) {
  let next = 0;
  let buf = "";
  const waiting = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  // every call still waiting fails (the browser closed, or it took too long)
  const stop = (why: string) => {
    for (const w of waiting.values()) w.fail(new Error(why));
    waiting.clear();
  };
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buf += chunk;
    for (let end = buf.indexOf("\0"); end >= 0; end = buf.indexOf("\0")) {
      const msg = buf.slice(0, end);
      buf = buf.slice(end + 1);
      let p: ReturnType<typeof CdpSchema.safeParse>;
      try {
        p = CdpSchema.safeParse(JSON.parse(msg));
      } catch {
        continue;
      }
      if (!p.success) continue;
      const r = p.data;
      if (r.id !== undefined) {
        const w = waiting.get(r.id);
        waiting.delete(r.id);
        if (r.error) w?.fail(new Error(r.error.message));
        else w?.ok(r.result ?? {});
      } else if (r.method) onEvent(r.method, r.params ?? {});
    }
  });
  output.on("close", () => stop("the headless browser closed"));
  input.on("error", () => stop("couldn't reach the headless browser"));
  const call = (method: string, params: Record<string, unknown> = {}, session = "") =>
    new Promise<Record<string, unknown>>((ok, no) => {
      const id = ++next;
      waiting.set(id, { ok, fail: no });
      input.write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`);
    });
  return { call, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The browser's open targets (`Target.getTargets`). */
const TargetsSchema = z.object({ targetInfos: z.array(z.object({ type: z.string(), targetId: z.string() })) });
/** A page error, as `Runtime.exceptionThrown` reports it. */
const ExceptionSchema = z.object({ text: z.string().optional(), exception: z.object({ description: z.string().optional() }).optional() });
/** One DevTools Protocol message: a call's answer (`id`) or an event (`method`). */
const CdpSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** The headless browser's flags: muted, a throwaway profile, DevTools over a pipe only (never a port others can reach). */
export const browserArgs = (profile: string): string[] => [
  "--headless=new",
  "--mute-audio",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--remote-debugging-pipe",
  `--user-data-dir=${profile}`,
  "about:blank",
];

/**
 * Renders the dashboard at `url` in one headless tab of `browser` (muted, speech stubbed, a throwaway profile) and waits
 * for the Now view. "" when it showed with no page errors, else the first error. The browser is always closed after.
 */
export async function renderCheck(url: string, browser: string, timeoutMs = 45_000): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), "overhand-selfcheck-"));
  // node's spawn, for the browser's fds 3 and 4 as pipes (the DevTools pipe)
  const proc = spawn(browser, browserArgs(profile), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  // a browser that can't start reports an error instead of exiting
  const exited = new Promise<void>((ok) => {
    proc.once("exit", () => ok());
    proc.once("error", () => ok());
  });
  const deadline = Date.now() + timeoutMs;
  const errors: string[] = [];
  const [, , , input, output] = proc.stdio;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(input instanceof Writable) || !(output instanceof Readable)) return "the headless browser didn't start";
    const page = cdp(input, output, (method, params) => {
      if (method !== "Runtime.exceptionThrown") return;
      const d = ExceptionSchema.safeParse(params.exceptionDetails).data;
      errors.push((d?.exception?.description ?? d?.text ?? "a page error").split("\n")[0] ?? "a page error");
    });
    timer = setTimeout(() => page.stop(`the headless browser didn't answer within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const targets = TargetsSchema.safeParse(await page.call("Target.getTargets"));
    const target = (targets.success ? targets.data.targetInfos : []).find((t) => t.type === "page")?.targetId ?? "";
    if (!target) return "the headless browser opened no tab";
    const attached = await page.call("Target.attachToTarget", { targetId: target, flatten: true });
    const session = z.object({ sessionId: z.string() }).safeParse(attached).data?.sessionId ?? "";
    if (!session) return "the headless browser opened no tab";
    await page.call("Page.addScriptToEvaluateOnNewDocument", { source: SILENT }, session);
    await page.call("Runtime.enable", {}, session);
    await page.call("Page.navigate", { url }, session);
    while (Date.now() < deadline) {
      if (errors.length) return `a page error: ${errors[0]}`;
      const r = await page.call("Runtime.evaluate", { expression: RENDERED, returnByValue: true }, session);
      const n = z.object({ value: z.number() }).safeParse(r.result).data?.value ?? 0;
      if (n > 0) return "";
      await sleep(500);
    }
    return errors.length ? `a page error: ${errors[0]}` : `the Now view didn't show within ${Math.round(timeoutMs / 1000)} s`;
  } catch (e) {
    return `the headless check failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}

/** What the self-check needs from outside; tests swap them. */
export interface SelfCheckDeps {
  state: () => Promise<unknown>;
  browser: () => string;
  /** Why no browser may start now (strain, quiet, a house rule), or null. */
  hold: () => string | null;
  /** Takes the governor's browser slot; a release function, or null when every slot is busy. */
  slot: () => (() => void) | null;
  render: (url: string, browser: string) => Promise<string>;
  notify: (title: string, body: string) => void;
}

/**
 * The headless render once per start: a daemon starts after every update and restart, which is when the page can
 * break, so once one render has passed there's no browser again until the next start (the cheap check goes on).
 */
export function oncePerStart(find: () => string, render: SelfCheckDeps["render"]): Pick<SelfCheckDeps, "browser" | "render"> {
  let passed = false;
  return {
    browser: () => (passed ? "" : find()),
    render: async (url, browser) => {
      const error = await render(url, browser);
      passed ||= !error;
      return error;
    },
  };
}

/** The live dependencies, given how to build the state (the dashboard's own function). */
export function liveDeps(state: () => Promise<unknown>): SelfCheckDeps {
  return {
    state,
    ...oncePerStart(() => findBrowser(), renderCheck),
    hold: () =>
      gate(CFG.governor, readMachine(diskFree()), quietUntil(OPS), Date.now()) ??
      ruleHold("browser", CFG.control, { ops: OPS, project: "", session: "" }),
    slot: () => {
      const n = acquire(OPS, "browser", CFG.governor.slots.browser, {
        pid: process.pid,
        run: "self-check",
        cmd: "dashboard self-check",
        since: Date.now(),
      });
      return n === null ? null : () => release(OPS, "browser", n, process.pid);
    },
    render: renderCheck,
    notify,
  };
}

/**
 * One look at the dashboard: the cheap check always, the headless render when a browser and the governor allow it.
 * Notifies once when it starts failing. Never throws. It opens a fresh open link each time: the headless browser's
 * throwaway profile has no local key until it opens one.
 */
export async function runSelfCheck(
  deps: SelfCheckDeps,
  url = openLink(`http://127.0.0.1:${UI_PORT}`),
  dist = WEB_DIST,
): Promise<SelfCheck> {
  const at = Date.now();
  let mode: SelfCheck["mode"] = "schema";
  let error: string;
  try {
    error = schemaCheck(await deps.state(), dist);
    const browser = error ? "" : deps.browser();
    const free = browser && !deps.hold() ? deps.slot() : null;
    if (free)
      try {
        mode = "browser";
        error = await deps.render(url, browser);
      } finally {
        free();
      }
  } catch (e) {
    error = `the state couldn't be built: ${e instanceof Error ? e.message : String(e)}`;
  }
  const was = last;
  last = { ok: !error, at, mode, error };
  if (error && was.ok) deps.notify("Overhand's page failed to render", error);
  return last;
}

/** `text` with secrets and every project's and your private words taken out. */
export function redactPrivate(
  text: string,
  cfg: Pick<typeof CFG, "clients" | "outward"> & Partial<Pick<typeof CFG, "groups">> = CFG,
): string {
  // every project's words (its group's private words included) count as another's
  const hits = termHits(text, [NO_PROJECT], effectiveClients({ clients: cfg.clients, groups: cfg.groups ?? [] }), cfg.outward.deny);
  let out = text;
  for (const h of [...hits].sort((a, b) => b.start - a.start)) out = `${out.slice(0, h.start)}[private]${out.slice(h.end)}`;
  return redactSecrets(out);
}

/** The operating system Overhand runs on, as Report and feedback name it. */
export const PLATFORM = `${process.platform} ${process.arch}`;

/** What the self-check saw, with nothing private in it (no project names, no secrets, no state values). */
export function diagnosticBundle(state: unknown, now = Date.now()) {
  const parsed = DashboardStateSchema.safeParse(JSON.parse(JSON.stringify(state)));
  return {
    at: new Date(now).toISOString(),
    version: VERSION,
    platform: PLATFORM,
    bun: Bun.version,
    selfCheck: { ...last, error: redactPrivate(last.error) },
    browser: findBrowser() ? "available" : "none",
    contract: parsed.success ? ("ok" as const) : parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
    built: existsSync(join(WEB_DIST, "index.html")),
  };
}

/**
 * Report: writes the diagnostic bundle to a file under diagnostics/ for you to look at or attach. Returns its path.
 */
export function writeDiagnostic(state: unknown, ops = OPS, now = Date.now()): string {
  const bundle = diagnosticBundle(state, now);
  const dir = join(ops, "diagnostics");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `dashboard-${bundle.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return file;
}
