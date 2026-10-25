/**
 * Before/after screenshots for a PR that changes UI, when its project says how to render it (`preview`: a command that
 * serves it and the URL to open). Optional and governor-gated: it waits for nothing; when the machine is busy, quiet, low
 * on disk, or a browser or dev server slot is taken, it skips and says why. One muted headless browser with a silent
 * speechSynthesis, closed after; each preview server's whole process tree is killed after its shot.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proof } from "@overhand/contract";
import type { Client } from "./config";
import { CFG, OPS, sh } from "./env";
import { acquire, gate, killTree, quietUntil, readMachine, release } from "./governor";
import { diskFree } from "./notify";
import { projectCommand, projectSandbox, type SandboxState, SIGN_IN_ENV } from "./sandbox";

/** Where a PR's screenshots are kept: `<OPS>/proof/<key>/before.png`, `after.png`. */
export const shotsDir = (key: string): string => join(OPS, "proof", key.replace(/[^A-Za-z0-9-]/g, "_"));

/** The gap's reason when no headless browser can be had: playwright-core isn't installed, or no Chromium or Chrome. */
export const NO_BROWSER = "browser not available";

type Playwright = typeof import("playwright-core");
type Browser = Awaited<ReturnType<Playwright["chromium"]["launch"]>>;

/**
 * playwright-core, loaded only when a screenshot is taken. The specifier is a variable so `bun build --compile` leaves it
 * out of the shipped binary (it isn't bundled; a source checkout with it installed gets screenshots, the binary skips).
 */
export async function loadPlaywright(name = "playwright-core"): Promise<Playwright | null> {
  try {
    const mod: Playwright = await import(name);
    return mod;
  } catch {
    return null;
  }
}

/** One muted headless browser (Playwright's Chromium, else installed Chrome), or null when there's none. */
async function launchBrowser(): Promise<Browser | null> {
  const pw = await loadPlaywright();
  if (!pw) return null;
  const args = ["--mute-audio"];
  return pw.chromium
    .launch({ args })
    .catch(() => pw.chromium.launch({ channel: "chrome", args }))
    .catch(() => null);
}

/** How long a preview server may take to answer before its shot is given up. */
const READY_MS = 120_000;

/** A page script: test browsers never talk (speechSynthesis uses the OS voice even headless). */
const SILENT = `try{Object.defineProperty(window,"speechSynthesis",{value:{speak(){},cancel(){},getVoices:()=>[],pause(){},resume(){},speaking:false,pending:false,paused:false,onvoiceschanged:null,addEventListener(){},removeEventListener(){}}})}catch{}`;

/** Why screenshots can't be taken here at all (no preview, a protected port), or "" when they may be tried. */
function cannotShoot(preview: Client["preview"]): string {
  if (!preview?.command || !preview.url) return "no preview configured for this project";
  let port = 0;
  try {
    const u = new URL(preview.url);
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return "the preview URL isn't a URL";
  }
  return CFG.governor.protect.ports.includes(port) ? `the preview port ${port} is protected` : "";
}

async function waitUp(url: string, until: number): Promise<boolean> {
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return true;
    } catch {}
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * How a project's preview command starts in `dir`: it runs the project's own files, which a run may have changed, so
 * under the project's sandbox like Overhand's other checks there (projectCommand), and never with your sign-ins.
 */
export function previewCommand(
  cmd: string,
  dir: string,
  project: string,
  st: SandboxState = projectSandbox(project),
): { argv: string[]; env: Record<string, string>; done: () => void } {
  const box = projectCommand(["sh", "-c", cmd], dir, st, project);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SIGN_IN_ENV.includes(k)) env[k] = v;
  return { ...box, env };
}

/** One shot: start the preview in `dir`, wait for it, screenshot `url`, stop the preview's whole tree. */
async function shoot(
  page: { goto(u: string): Promise<unknown>; screenshot(o: { path: string }): Promise<unknown> },
  preview: { command: string; url: string; project: string },
  dir: string,
  file: string,
): Promise<boolean> {
  const { url } = preview;
  const box = previewCommand(preview.command, dir, preview.project);
  const [bin = "false", ...args] = box.argv;
  const proc = spawn(bin, args, { cwd: dir, detached: true, stdio: "ignore", env: box.env });
  try {
    if (!proc.pid || !(await waitUp(url, Date.now() + READY_MS))) return false;
    await page.goto(url);
    await page.screenshot({ path: file });
    return existsSync(file);
  } catch {
    return false;
  } finally {
    if (proc.pid) await killTree(proc.pid);
    box.done();
  }
}

/** A rectangle on a page, in page pixels. */
export type Clip = { x: number; y: number; width: number; height: number };

/** The tallest still taken of a page; longer pages are cut there (pins further down land on nothing). */
const STILL_MAX = 8000;

/**
 * Opens `url` at `viewport` in the headless browser and writes a full-page still (`still`) and/or crops of it (`crops`),
 * for reviewing a deployed preview. Holds a browser slot; never throws. The page's size comes back so pins can be placed.
 */
export async function captureStill(
  key: string,
  url: string,
  viewport: { width: number; height: number },
  out: { still?: string; crops?: { file: string; clip: Clip }[] },
): Promise<{ ok: true; width: number; height: number } | { ok: false; why: string }> {
  const slot = acquire(OPS, "browser", Math.max(1, CFG.governor.slots.browser), {
    pid: process.pid,
    run: `${key}-review`,
    cmd: "preview still",
    since: Date.now(),
  });
  if (slot === null) return { ok: false, why: "another browser is running; try again in a minute" };
  try {
    const browser = await launchBrowser();
    if (!browser) return { ok: false, why: NO_BROWSER };
    try {
      const phone = viewport.width < 600;
      const ctx = await browser.newContext({ viewport, reducedMotion: "reduce", isMobile: phone, hasTouch: phone });
      await ctx.addInitScript(SILENT);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(800); // late fonts and images settle
      const size = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      const width = Math.max(viewport.width, size.width);
      const height = Math.min(STILL_MAX, Math.max(viewport.height, size.height));
      if (out.still) await page.screenshot({ path: out.still, fullPage: true, clip: { x: 0, y: 0, width, height } });
      for (const c of out.crops ?? []) await page.screenshot({ path: c.file, fullPage: true, clip: c.clip });
      return { ok: true, width, height };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return { ok: false, why: `the preview didn't load (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
  } finally {
    release(OPS, "browser", slot, process.pid);
  }
}

/**
 * Takes `before` (the base branch, in a throwaway detached worktree) and `after` (the PR's worktree) screenshots of the
 * project's preview. Never throws; `note` says why one is missing.
 */
export async function takeShots(
  c: Pick<Client, "preview" | "name">,
  key: string,
  wt: { mainRepo: string; path: string; base: string },
  now = Date.now(),
): Promise<Proof["shots"]> {
  const none = (note: string) => ({ before: false, after: false, note });
  const preview = c.preview;
  const cannot = cannotShoot(preview);
  if (cannot || !preview) return none(cannot);
  const box = projectSandbox(c.name);
  if (box.refuse) return none(`skipped: the OS sandbox can't run here (${box.why})`);
  const g = CFG.governor;
  if (g.enabled) {
    const why = gate(g, readMachine(diskFree()), quietUntil(OPS, now), now);
    if (why) return none(`skipped: ${why}`);
  }
  const lock = { pid: process.pid, run: `${key}-shots`, cmd: preview.command, since: now };
  const browserSlot = acquire(OPS, "browser", Math.max(1, g.slots.browser), lock);
  if (browserSlot === null) return none("skipped: another browser is running");
  const serverSlot = acquire(OPS, "devserver", Math.max(1, g.slots.devserver), lock);
  if (serverSlot === null) {
    release(OPS, "browser", browserSlot, process.pid);
    return none("skipped: the dev server slots are taken");
  }
  const dir = shotsDir(key);
  mkdirSync(dir, { recursive: true });
  const baseDir = mkdtempSync(join(tmpdir(), "overhand-before-"));
  rmSync(baseDir, { recursive: true, force: true }); // git worktree add wants to create it
  try {
    const browser = await launchBrowser();
    if (!browser) return none(NO_BROWSER);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      await ctx.addInitScript(SILENT);
      const page = await ctx.newPage();
      const added = sh(["git", "worktree", "add", "--detach", baseDir, `origin/${wt.base}`], wt.mainRepo).ok;
      const shot = { command: preview.command, url: preview.url, project: c.name };
      const before = added && (await shoot(page, shot, baseDir, join(dir, "before.png")));
      const after = await shoot(page, shot, wt.path, join(dir, "after.png"));
      return { before, after, note: after ? "" : "the preview didn't come up" };
    } finally {
      await browser.close();
      sh(["git", "worktree", "remove", "--force", baseDir], wt.mainRepo);
    }
  } catch (e) {
    return none(`screenshots failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    release(OPS, "devserver", serverSlot, process.pid);
    release(OPS, "browser", browserSlot, process.pid);
  }
}
