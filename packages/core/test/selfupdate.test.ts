import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALLER } from "@overhand/contract";
import { installKind, moveOnce, stableExec } from "../src/env";
import * as self from "../src/selfupdate";

const git = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** origin (bare), ops (the checkout being updated) and dev (pushes new commits to origin). */
function scratch(): { ops: string; dev: string } {
  const root = mkdtempSync(join(tmpdir(), "overhand-update-"));
  const origin = join(root, "origin.git");
  const ops = join(root, "ops");
  const dev = join(root, "dev");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, dev);
  writeFileSync(join(dev, "a.txt"), "1");
  git(dev, "add", ".");
  git(dev, "commit", "-qm", "one");
  git(dev, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", origin, ops);
  return { ops, dev };
}

const push = (dev: string, msg: string): void => {
  writeFileSync(join(dev, "a.txt"), msg);
  git(dev, "commit", "-qam", msg);
  git(dev, "push", "-q", "origin", "HEAD:main");
};

test("checkOpsUpdate counts commits behind; updateOps fast-forwards them", async () => {
  const { ops, dev } = scratch();
  push(dev, "two");
  await self.checkOpsUpdate(ops);
  expect(self.opsBehind).toBe(1);
  const r = self.updateOps(ops);
  expect(r).toEqual({ ok: true, message: "Updated 1 commit(s). Overhand restarts as soon as no agent is running." });
  expect(self.opsBehind).toBe(0);
  expect(git(ops, "rev-parse", "HEAD")).toBe(git(dev, "rev-parse", "HEAD"));
});

test("updateOps refuses a dirty checkout or one off main, and leaves it untouched", () => {
  const { ops, dev } = scratch();
  push(dev, "two");
  const head = git(ops, "rev-parse", "HEAD");
  writeFileSync(join(ops, "a.txt"), "local edit");
  expect(self.updateOps(ops)).toEqual({ ok: false, message: "ops has uncommitted changes; commit or discard them first" });
  git(ops, "checkout", "-q", "--", "a.txt");
  git(ops, "switch", "-qc", "feature");
  expect(self.updateOps(ops).message).toBe("ops isn't on main; switch back before updating");
  expect(git(ops, "rev-parse", "HEAD")).toBe(head);
});

test("a requested restart exits between work passes, but waits while an agent holds the lock", () => {
  // a child process, because restartIfRequested calls process.exit
  const run = (locked: boolean): { code: number | null; out: string } => {
    const home = mkdtempSync(join(tmpdir(), "overhand-home-"));
    copyFileSync(resolve(import.meta.dir, "../../../overhand.config.example.json"), join(home, "overhand.config.json"));
    if (locked) writeFileSync(join(home, ".lock"), "");
    const script = [
      `const s = await import(${JSON.stringify(resolve(import.meta.dir, "../src/selfupdate"))});`,
      "s.requestStop(false); s.restartIfRequested();",
      `setTimeout(() => { console.log("alive"); process.exit(3); }, 1500);`,
    ].join("\n");
    const r = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, OVERHAND_HOME: home, XPC_SERVICE_NAME: "" } });
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  const free = run(false);
  expect(free.code).toBe(0);
  expect(free.out).not.toContain("alive");
  expect(run(true)).toEqual({ code: 3, out: "alive\n" });
});

test("each install kind is told apart by where its binary lives, and updates its own way", () => {
  const home = "/Users/u";
  const kinds = {
    "/Users/u/.overhand/app/overhand": "curl",
    "/opt/homebrew/Cellar/overhand/0.2.0/libexec/overhand": "brew",
    "/opt/homebrew/opt/overhand/libexec/overhand": "brew",
    "/home/linuxbrew/.linuxbrew/Cellar/overhand/0.2.0/libexec/overhand": "brew",
    "/Users/u/.overhand/npm/0.2.0/overhand": "npx",
    "/Users/u/.overhand/npm/current/overhand": "npx",
    "/opt/overhand/overhand": "curl", // unpacked by hand: the installer's way
  };
  for (const [exec, kind] of Object.entries(kinds)) expect([exec, installKind(exec, true, home)]).toEqual([exec, kind]);
  expect(installKind("/Users/u/.bun/bin/bun", false, home)).toBe("checkout");

  // the service runs a path that follows updates, never a versioned folder
  expect(stableExec("/opt/homebrew/Cellar/overhand/0.2.0/libexec/overhand", home)).toBe("/opt/homebrew/opt/overhand/libexec/overhand");
  expect(stableExec("/Users/u/.overhand/npm/0.2.0/overhand", home)).toBe("/Users/u/.overhand/npm/current/overhand");
  expect(stableExec("/Users/u/.overhand/app/overhand", home)).toBe("/Users/u/.overhand/app/overhand");
  expect(stableExec("/Users/u/.overhand/releases/0123abcd4567/overhand", home)).toBe("/Users/u/.overhand/app/overhand");
  expect(installKind("/Users/u/.overhand/releases/0123abcd4567/overhand", true, home)).toBe("curl");

  // never a second copy: only the curl install runs the installer
  const curl = self.updateRoute("curl");
  expect([curl.run.slice(0, 2), curl.run.at(-1), curl.say]).toEqual([["sh", "-c"], INSTALLER, "overhand update"]);
  expect(self.updateRoute("brew")).toEqual({ run: ["brew", "upgrade", "overhand"], say: "brew upgrade overhand" });
  expect(self.updateRoute("npx", true)).toEqual({ run: ["npx", "-y", "overhand@latest", "version"], say: "npx overhand@latest update" });
  expect(self.updateRoute("npx", false)).toEqual({ run: ["bunx", "overhand@latest", "version"], say: "bunx overhand@latest update" });
});

test("a stable path that moves on to another binary (brew upgrade, a newer npx) asks for a restart", () => {
  const npm = mkdtempSync(join(tmpdir(), "overhand-npm-"));
  for (const v of ["0.2.0", "0.3.0"]) {
    mkdirSync(join(npm, v));
    writeFileSync(join(npm, v, "overhand"), v);
  }
  symlinkSync("0.2.0", join(npm, "current"));
  const stable = join(npm, "current", "overhand");
  const boot = realpathSync(stable);
  expect(self.binaryMoved(stable, boot)).toBe(false);
  rmSync(join(npm, "current"));
  symlinkSync("0.3.0", join(npm, "current"));
  expect(self.binaryMoved(stable, boot)).toBe(true);
  expect(self.binaryMoved(join(npm, "gone", "overhand"), boot)).toBe(false); // mid-upgrade: wait
});

test("the installer's app link swapped to a new release folder reads as a moved binary, so a rerun restarts the daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "overhand-app-"));
  for (const id of ["aaaa", "bbbb"]) {
    mkdirSync(join(home, "releases", id), { recursive: true });
    writeFileSync(join(home, "releases", id, "overhand"), id);
  }
  symlinkSync(join(home, "releases", "aaaa"), join(home, "app"));
  const stable = join(home, "app", "overhand");
  const boot = realpathSync(stable);
  expect(self.binaryMoved(stable, boot)).toBe(false);
  symlinkSync(join(home, "releases", "bbbb"), join(home, "app.next"));
  renameSync(join(home, "app.next"), join(home, "app")); // what the installer's mv -T / mv -h does
  expect(self.binaryMoved(stable, boot)).toBe(true);
});

/** Runs the curl install's update route against `installer`; its exit code and what it printed. */
const runRoute = (installer: string): { code: number; out: string } => {
  const r = Bun.spawnSync(self.updateRoute("curl", true, installer).run);
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
};

test("an update whose installer can't be downloaded fails, rather than running an empty script and exiting 0", () => {
  const offline = runRoute("http://127.0.0.1:1/install.sh");
  expect(offline.code).toBe(1);
  expect(offline.out).toContain("Couldn't download the installer from http://127.0.0.1:1/install.sh.");
  const dir = mkdtempSync(join(tmpdir(), "overhand-installer-"));
  writeFileSync(join(dir, "empty.sh"), "");
  expect(runRoute(`file://${join(dir, "empty.sh")}`).code).toBe(1); // a 200 with nothing in it
});

test("an update runs the downloaded installer and passes on its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-installer-"));
  writeFileSync(join(dir, "ok.sh"), "echo installed\n");
  writeFileSync(join(dir, "bad.sh"), "echo 'checksum mismatch' >&2; exit 3\n");
  expect(runRoute(`file://${join(dir, "ok.sh")}`)).toEqual({ code: 0, out: "installed\n" });
  expect(runRoute(`file://${join(dir, "bad.sh")}`).code).toBe(3);
});

test("slack-mcp.json moves from beside the binary to the config folder once, and never over one already there", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-slack-"));
  const [from, to] = [join(dir, "app", "slack-mcp.json"), join(dir, "home", "slack-mcp.json")];
  mkdirSync(join(dir, "app"));
  mkdirSync(join(dir, "home"));
  writeFileSync(from, "old");
  moveOnce(from, to);
  expect([existsSync(from), readFileSync(to, "utf8")]).toEqual([false, "old"]);
  writeFileSync(from, "stale");
  moveOnce(from, to);
  expect(readFileSync(to, "utf8")).toBe("old");
});
