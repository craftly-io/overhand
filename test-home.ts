/**
 * Preloaded before every `bun test` (bunfig.toml): tests get a fresh scratch OVERHAND_HOME with the example config, so no
 * test, however it is started, writes into the checkout's own state (the folder a dev daemon serves). A caller's own
 * OVERHAND_HOME is kept, unless it is the checkout itself.
 *
 * Every scratch folder a test makes in the temp folder, and every one the programs it starts make, lands in one folder
 * for the run (TMPDIR), removed when the run ends: a test can't leave `overhand-*` folders behind by forgetting.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = import.meta.dir;
if (process.env.OVERHAND_HOME && resolve(process.env.OVERHAND_HOME) === root)
  throw new Error("OVERHAND_HOME points at the checkout: tests would write into its live state");
const runTmp = mkdtempSync(join(tmpdir(), "overhand-tests-"));
process.env.TMPDIR = runTmp;
// in a preload, afterAll runs once after every file (bun test exits without an "exit" event)
afterAll(() => rmSync(runTmp, { recursive: true, force: true }));
process.env.OVERHAND_HOME ??= mkdtempSync(join(runTmp, "overhand-test-"));
const config = join(process.env.OVERHAND_HOME, "overhand.config.json");
if (!existsSync(config)) copyFileSync(join(root, "overhand.config.example.json"), config);

// Each test gets back the environment it started with, even when it throws before its own cleanup: a fake `gh` put
// first on PATH by one test must never answer for the next. Spies stay per file: withDom undoes its fetch stub after
// the file (render.test-util.tsx).
let env: Record<string, string | undefined> = {};
beforeEach(() => {
  env = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
});
