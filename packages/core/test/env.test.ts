import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig, parseConfig } from "../src/config";
import { cli, markSetupDone, migrateSetupDone, needsSetup, shAsync, untilExit } from "../src/env";

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
