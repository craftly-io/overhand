/** Self-update, restart and shutdown between work passes. This module owns the restart/shutdown flags. */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { INSTALLER, REPO } from "@overhand/contract";
import pkg from "../../../package.json";
import { BUNDLED, CFG, INSTALL, type InstallKind, OPS, SELF_EXEC, SRC, sh, shAsync } from "./env";
import { leadChildren } from "./leads";
import { report } from "./notify";
import { startAgainCommand, stopService } from "./platform";
import { readJson, writeJsonAtomic } from "./state";

// ---------- self-update: ops can ship changes to itself through PRs ----------

export let opsBehind = 0;
let restartWhenIdle = false;

/** This copy's version. */
export const VERSION = pkg.version;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_FILE = join(OPS, ".release.json");
const DAY = 24 * 60 * 60_000;
let releaseTriedAt = 0;

/** The latest release an installed copy last heard of ("" before the first answer), from the daily check's cache. */
export const latestRelease = (): string => readJson<{ latest?: string }>(RELEASE_FILE, {}).latest ?? "";

/**
 * An installed copy's daily look at the latest GitHub release, cached in .release.json. A failure (offline, rate
 * limited) is quiet: the cached answer stands and it tries again in an hour. `url` and `now` are for tests.
 */
async function checkRelease(url = RELEASES_API, now = Date.now()): Promise<void> {
  const cached = readJson<{ at?: number }>(RELEASE_FILE, {});
  if (now - (cached.at ?? 0) < DAY || now - releaseTriedAt < 60 * 60_000) return;
  releaseTriedAt = now;
  try {
    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
    const tag = r.ok ? ((await r.json()) as { tag_name?: unknown }).tag_name : undefined;
    if (typeof tag === "string" && tag) writeJsonAtomic(RELEASE_FILE, { at: now, latest: tag.replace(/^v/, "") });
  } catch {
    // offline or GitHub down: keep what we knew
  }
}

/**
 * What `overhand update` runs for each kind of install, and `say`: the command the dashboard and `status` suggest.
 * Homebrew's upgrade is non-interactive, so update runs it rather than only telling you to. The npx launcher fetches a
 * version on its first run and moves npm/current to it; `say` is a full update through the latest launcher, since
 * `overhand` itself isn't on PATH there. `npx`: whether npx is on PATH (bunx users may have only bunx); `installer` is
 * for tests.
 */
export function updateRoute(kind: InstallKind, npx = Bun.which("npx") !== null, installer = INSTALLER): { run: string[]; say: string } {
  if (kind === "brew") return { run: ["brew", "upgrade", "overhand"], say: "brew upgrade overhand" };
  if (kind === "npx") {
    const x = npx ? ["npx", "-y"] : ["bunx"];
    return { run: [...x, "overhand@latest", "version"], say: `${x[0]} overhand@latest update` };
  }
  if (kind === "checkout") return { run: [], say: "git pull" };
  // the installer goes to a file first: `curl | sh` exits 0 when the download fails, as sh runs the empty script
  const fetchThenRun = [
    'f="$(mktemp)" || exit 1',
    `if curl -fsSL "$1" -o "$f" && [ -s "$f" ]; then sh "$f"; s=$?; else echo "Couldn't download the installer from $1." >&2; s=1; fi`,
    'rm -f "$f"',
    'exit "$s"',
  ].join("; ");
  return { run: ["sh", "-c", fetchThenRun, "sh", installer], say: "overhand update" };
}

/** The binary this process started from, resolved, to notice when its stable path moves on to another one. */
const BOOT_BINARY = ((): string => {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
})();

/**
 * True when `stable` (the path the service runs) now leads to another binary than `boot`: someone ran `brew upgrade`
 * or a newer npx version by hand. False while it can't be resolved (mid-upgrade). Arguments are for tests.
 */
export function binaryMoved(stable = SELF_EXEC, boot = BOOT_BINARY): boolean {
  try {
    return realpathSync(stable) !== boot;
  } catch {
    return false;
  }
}

/** Commits on origin/main the running checkout doesn't have yet (0 when not on main or offline). `dir` is for tests. */
export async function checkOpsUpdate(dir = SRC): Promise<void> {
  // an installed binary isn't a checkout; it updates through its installer, so it watches releases instead
  if (BUNDLED) {
    void checkRelease();
    // updated outside `overhand update`: restart on the new binary, or the dashboard keeps serving the old one (or, after
    // `brew cleanup`, files that are gone)
    if (!restartWhenIdle && binaryMoved()) {
      report("⬆ Overhand was updated; restarting on the new version once no agent is running");
      restartWhenIdle = true;
    }
    return;
  }
  // async: the fetch is a network round trip, and this runs on the status timer
  if (
    (await shAsync(["git", "branch", "--show-current"], dir)).out !== "main" ||
    !(await shAsync(["git", "fetch", "-q", "origin", "main"], dir)).ok
  )
    return;
  opsBehind = Number((await shAsync(["git", "rev-list", "--count", "HEAD..origin/main"], dir)).out) || 0;
}

/** Fast-forwards main and reinstalls dependencies if the lockfile changed; the restart waits for any running agent. `dir` is for tests. */
export function updateOps(dir = SRC): { ok: boolean; message: string } {
  if (BUNDLED) return { ok: false, message: `Update from a terminal: ${updateRoute(INSTALL).say}` };
  if (sh(["git", "branch", "--show-current"], dir).out !== "main")
    return { ok: false, message: "ops isn't on main; switch back before updating" };
  if (sh(["git", "status", "--porcelain", "--untracked-files=no"], dir).out)
    return { ok: false, message: "ops has uncommitted changes; commit or discard them first" };
  const before = sh(["git", "rev-parse", "HEAD"], dir).out;
  const pull = sh(["git", "pull", "-q", "--ff-only", "origin", "main"], dir);
  if (!pull.ok) return { ok: false, message: `git pull failed: ${pull.err.slice(0, 200)}` };
  if (sh(["git", "diff", "--quiet", before, "HEAD", "--", "bun.lock", "package.json"], dir).ok === false) {
    const i = sh(["bun", "install", "--frozen-lockfile"], dir);
    if (!i.ok) return { ok: false, message: `bun install failed: ${i.err.slice(0, 200)}` };
  }
  opsBehind = 0;
  const log = sh(["git", "log", "--oneline", `${before}..HEAD`], dir)
    .out.split("\n")
    .filter(Boolean);
  report(`⬆ ops updated: ${log.length} commit(s), restarting${existsSync(join(OPS, ".lock")) ? " after the running agent finishes" : ""}`);
  restartWhenIdle = true;
  return { ok: true, message: `Updated ${log.length} commit(s). Overhand restarts as soon as no agent is running.` };
}

/** Exits so launchd or systemd starts the new code; only between work passes, so no agent is cut off. */
let shutdownWhenIdle = false;
export const START_AGAIN = startAgainCommand(SRC);

/** Restarts (the service manager brings it back) or shuts down between work passes, so no agent is cut off. */
export function restartIfRequested(): void {
  if (existsSync(join(OPS, ".lock"))) return;
  if (shutdownWhenIdle) {
    for (const [key, child] of leadChildren) {
      child.kill("SIGTERM");
      report(`⏹ ${CFG.godmode.find((g) => g.key === key)?.label ?? key} stopped because ops is turning off`);
    }
    report("⏻ ops turned off from Overhand");
    setTimeout(stopService, 500);
  } else if (restartWhenIdle) setTimeout(() => process.exit(0), 500);
}

/** Asks for a shutdown (off) or a restart, carried out by restartIfRequested once no agent is running. */
export function requestStop(off: boolean): void {
  if (off) shutdownWhenIdle = true;
  else restartWhenIdle = true;
}
