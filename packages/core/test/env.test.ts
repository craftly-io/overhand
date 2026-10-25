import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig, parseConfig } from "../src/config";
import { cli, clonedAt, markSetupDone, migrateSetupDone, needsSetup, repoActive, shAsync, untilExit } from "../src/env";

// /docs/server has you save Extra origins and pair a phone before setup: that writes the config, and setup stays open
test("setup is done only once onboarding's Start marks it, however many settings were saved before", () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-setup-"));
  writeFileSync(join(ops, "overhand.config.json"), "{}");
  const early = { ...blankConfig("n"), dashboardOrigins: ["https://box.example.ts.net:8443"] };
  migrateSetupDone(ops, early);
  expect(needsSetup(ops)).toBe(true);
  markSetupDone(ops);
  expect(needsSetup(ops)).toBe(false);
});

test("an install from before the marker that finished setup counts as set up; one without a config doesn't", () => {
  const done = mkdtempSync(join(tmpdir(), "overhand-setup-"));
  const finished = parseConfig({ owner: { name: "n", keychainAccount: "n" }, accounts: ["main"], clients: [] });
  migrateSetupDone(done, finished, true);
  expect(needsSetup(done)).toBe(false);
  const fresh = mkdtempSync(join(tmpdir(), "overhand-setup-"));
  migrateSetupDone(fresh, finished, false);
  expect(needsSetup(fresh)).toBe(true);
});

test("printed commands run as Overhand was installed: npx's launcher isn't on PATH, a checkout runs from source", () => {
  expect(cli("start", "curl")).toBe("overhand start");
  expect(cli("start", "brew")).toBe("overhand start");
  expect(cli("start", "npx", "/x", true)).toBe("npx overhand start");
  expect(cli("open", "npx", "/x", false)).toBe("bunx overhand open");
  expect(cli("open", "checkout", "/code/overhand")).toBe("cd /code/overhand && bun run.ts open");
});

// a first win's agent was done in 36 s, and its pull request never opened: a process it left running held the pipes
test("a command that exits but leaves a process holding its output returns within the grace, with what it printed", async () => {
  const started = Date.now();
  const r = await shAsync(["sh", "-c", "echo done; echo note >&2; sleep 30 &"], tmpdir());
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(r).toEqual({ ok: true, out: "done", err: "note" });
  const left = Bun.spawn(["sh", "-c", "echo partial; sleep 30 & exit 3"], { stdout: "pipe", stderr: "pipe" });
  const { texts, code } = await untilExit(left.exited, [left.stdout, left.stderr], 200);
  expect(texts).toEqual(["partial\n", ""]);
  expect(code).toBe(3);
});

// a newcomer picked a repo last committed years ago, and its first win said nothing turned up
test("a repo you just cloned is active however old its last commit; one made here with old commits isn't", () => {
  const root = mkdtempSync(join(tmpdir(), "overhand-active-"));
  const old = Date.now() - 3 * 365 * 864e5;
  const src = join(root, "src");
  const when = `${Math.floor(old / 1000)} +0000`;
  Bun.spawnSync(["git", "init", "-q", src]);
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "old"], {
    cwd: src,
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
  const clone = join(root, "clone");
  Bun.spawnSync(["git", "clone", "-q", src, clone]);
  expect(Math.abs(clonedAt(clone) - Date.now())).toBeLessThan(60_000);
  expect(repoActive(clone, old)).toBe(true);
  expect(clonedAt(src)).toBe(0); // made here, not cloned: its commits decide
  expect(repoActive(src, old)).toBe(false);
  expect(repoActive(clone, old, Date.now() + 365 * 864e5)).toBe(false); // a year on, the clone is dormant too
  expect(clonedAt(join(root, "missing"))).toBe(0);
});
