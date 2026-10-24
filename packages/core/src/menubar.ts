/**
 * The menu bar item on a Mac: a small native helper (apps/menubar) the daemon starts and watches, which holds the
 * dashboard's glance page (apps/web/glance.html) in a popover and shows its count beside the mark. Every word and rule on
 * it is the dashboard's own; the helper only draws the item and passes messages. It never reads the local key: when its
 * page isn't signed in it asks here and gets a fresh open link.
 *
 * One line per message. To the helper (stdin): `load <url>`. From it (stdout): `link` (sign the page in again),
 * `open <query>` (open the dashboard in the browser, e.g. `?drawer=…`), `hide` (switch the item off).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { saveConfig } from "./config";
import { openLink } from "./devices";
import { applyConfig, BUNDLED, CFG, DASHBOARD, OPS, SRC, WEB_DIST } from "./env";
import { report } from "./notify";
import { openBrowser } from "./platform";

/** The helper's binary on this computer: beside the release's own, or built in a checkout (`bun run menubar`); else "". */
export function menubarHelper(platform = process.platform, src = SRC, bundled = BUNDLED): string {
  if (platform !== "darwin") return "";
  const p = bundled ? join(src, "overhand-menubar") : join(src, "apps", "menubar", ".build", "release", "overhand-menubar");
  return existsSync(p) ? p : "";
}

/** The query `open` may carry: a drawer to open, or the Night report. Anything else is dropped. */
const OPEN_KEYS = ["drawer", "run"];

/** The dashboard address `open <query>` asks for, keeping only the keys it may carry; null for a bad line. */
export function openTarget(query: string, base = DASHBOARD): string | null {
  if (!query.startsWith("?")) return null;
  const asked = new URLSearchParams(query.slice(1));
  const u = new URL(`${base}/`);
  for (const k of OPEN_KEYS) {
    const v = asked.get(k);
    if (v) u.searchParams.set(k, v);
  }
  return u.toString();
}

/** What the helper's page loads: the glance page, signed in by a fresh open link. */
const glance = (): string => openLink(`${DASHBOARD}/glance.html`);
/** The sign-in links the helper may ask for: one every 10 seconds, so a page that keeps failing can't spin. */
const LINK_EVERY_MS = 10_000;

let child: Subprocess<"pipe", "pipe", "ignore"> | null = null;
let linkedAt = 0;

function send(line: string): void {
  try {
    child?.stdin.write(`${line}\n`);
    void child?.stdin.flush();
  } catch {
    // gone already; the next sync starts it again
  }
}

/** One line from the helper. */
export function onHelperLine(line: string, now = Date.now()): void {
  const [verb = "", ...rest] = line.trim().split(" ");
  if (verb === "link" && now - linkedAt >= LINK_EVERY_MS) {
    linkedAt = now;
    send(`load ${glance()}`);
  } else if (verb === "open") {
    const to = openTarget(rest.join(" "));
    if (to) openBrowser(openLink(to));
  } else if (verb === "hide") {
    applyConfig(saveConfig(OPS, { ...CFG, menubar: false }));
    report("Menu bar item hidden. Turn it on again in Quick settings.");
    syncMenubar();
  }
}

async function listen(p: NonNullable<typeof child>): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of p.stdout) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      onHelperLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
}

/**
 * Starts the helper when the item is on and isn't running, and stops it when it's off. The daemon calls this every few
 * seconds, so a helper that crashed comes back. ponytail: one that crashes at once restarts every tick; count crashes
 * and back off if that's ever seen.
 */
export function syncMenubar(helper = menubarHelper()): void {
  const on = CFG.menubar && Boolean(helper);
  if (!on) {
    child?.kill();
    child = null;
    return;
  }
  if (child) return;
  const p = Bun.spawn([helper, "--icon", join(WEB_DIST, "menubar.png")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  child = p;
  void p.exited.then(() => {
    if (child === p) child = null;
  });
  void listen(p).catch(() => {});
  linkedAt = Date.now();
  send(`load ${glance()}`);
}
