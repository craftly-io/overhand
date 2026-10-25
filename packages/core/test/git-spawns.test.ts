/**
 * Every git command Overhand runs goes the one safe way (runtimes/runtime.ts safeCmd and gitEnv, env.ts gitRefused):
 * a git spawned some other way, in a folder a run wrote, could run a program that folder's git config names. A source
 * scan: a new raw git spawn anywhere in the code fails here.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { sh, shAsync } from "../src/env";
import { gitEnv, runsGit, safeCmd } from "../src/runtimes/runtime";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCES = ["*.ts", "packages/*/src/**/*.ts", "release/*.ts", "relay/src/**/*.ts"];
const files = SOURCES.flatMap((g) => [...new Glob(g).scanSync(ROOT)]).filter((f) => !f.endsWith(".test.ts") && !f.includes("node_modules"));

/** A spawn whose command is written out and starts with git, not passed through safeCmd. */
const RAW = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|execFileSync|execSync|spawn)\(\s*(?:\[\s*"git"|"git"\s*,)/;

test("no code spawns git except through the daemon's safe git path", () => {
  expect(files.length).toBeGreaterThan(50);
  const raw = files.filter((f) => RAW.test(readFileSync(join(ROOT, f), "utf8")));
  expect(raw).toEqual([]);
});

test("the wrappers that run whatever command they're handed send git through safeCmd", () => {
  // each one spawns `cmd` it was given, git included: the safe path must be in it
  for (const [file, wrapper] of [
    ["packages/core/src/env.ts", "export function sh("],
    ["packages/core/src/env.ts", "export async function shAsync("],
    ["packages/core/src/cleanup.ts", "const run = ("],
    ["packages/core/src/cleanup.ts", "const runAsync = async ("],
    ["packages/core/src/worktrees.ts", "async function out("],
    ["release/launch.ts", "function read("],
  ] as const) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const body = src.slice(src.indexOf(wrapper), src.indexOf("\n}", src.indexOf(wrapper)));
    expect([file, wrapper, body.includes("safeCmd(")]).toEqual([file, wrapper, true]);
  }
});

test("the check catches a raw git spawn", () => {
  expect(RAW.test('Bun.spawnSync(["git", "status"], { cwd })')).toBe(true);
  expect(RAW.test('spawn("git", ["status"])')).toBe(true);
  expect(RAW.test('Bun.spawnSync(safeCmd(["git", "status"]), { cwd })')).toBe(false);
});

test("gh's own git runs the safe way too: a repo's hooksPath and fsmonitor are overridden for it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "overhand-gh-git-"));
  Bun.spawnSync(safeCmd(["git", "init", "-q", repo]), { env: gitEnv() });
  writeFileSync(join(repo, ".git", "config"), "[core]\n\thooksPath = /tmp/evil\n\tfsmonitor = /tmp/evil-monitor\n", { flag: "a" });
  // a stand-in gh that, like the real one, starts git in the folder it's run in
  const bin = mkdtempSync(join(tmpdir(), "overhand-gh-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\ngit config core.hooksPath; git config core.fsmonitor; echo end\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(sh(["gh"], repo).out.split("\n")).toEqual(["/dev/null", "", "end"]);
    expect((await shAsync(["gh"], repo)).out.split("\n")).toEqual(["/dev/null", "", "end"]);
  } finally {
    process.env.PATH = path;
  }
  expect([runsGit(["gh", "pr", "list"]), runsGit(["git", "status"]), runsGit(["bun", "test"])]).toEqual([true, true, false]);
});
