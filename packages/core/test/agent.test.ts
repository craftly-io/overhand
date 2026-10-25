/**
 * The ticket agent's failure paths (agent.ts): a PR whose status can't be read says so instead of reading as empty, a
 * failed fix round leaves the next one to run, and a run is told what an earlier one left uncommitted.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftoverLines, leftovers, prStatus, roundAnswered } from "../src/agent";
import type { TrackedPr } from "../src/state";
import { scratchWorktree } from "./fixtures/scratch-git";

// a fake gh on PATH: down (GitHub unreachable), or answering a PR with one red check and nothing said on it
const bin = mkdtempSync(join(tmpdir(), "overhand-fake-gh-"));
const modeFile = join(bin, "mode");
const FAKE = `#!/bin/sh
if [ "$(cat ${modeFile})" = down ]; then
  echo "error connecting to api.github.com" >&2
  echo "check your internet connection or https://githubstatus.com" >&2
  exit 1
fi
if [ "$1" = pr ]; then echo '{"state":"OPEN","headRefOid":"abc","statusCheckRollup":[{"name":"test","conclusion":"FAILURE"}]}'; else echo '[]'; fi
`;
const path = process.env.PATH;
beforeAll(() => {
  writeFileSync(join(bin, "gh"), FAKE);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = [bin, path].join(":");
});
afterAll(() => {
  process.env.PATH = path;
  rmSync(bin, { recursive: true, force: true });
});

const pr: TrackedPr = {
  url: "https://github.com/acme/web/pull/3",
  host: "github",
  repo: "acme/web",
  number: 3,
  branch: "agent/AC-1",
  mainRepo: "",
  repoPath: "",
  seen: "",
  fixes: 0,
};

test("a PR whose status GitHub doesn't answer throws with why, never reads as an empty PR", async () => {
  writeFileSync(modeFile, "down");
  await expect(prStatus(pr)).rejects.toThrow("gh pr view: error connecting to api.github.com");
  writeFileSync(modeFile, "up");
  const s = await prStatus(pr);
  expect(s).toMatchObject({ state: "open", needsFix: true, head: "abc" });
  expect(s.feedback).toContain("CI failing: test");
});

test("a fix round that failed doesn't count as answering its feedback, so another runs; a finished or stopped one does", () => {
  expect(roundAnswered({ status: "failed" }, "crashed")).toBe(false);
  expect(roundAnswered({ status: "failed" }, "timeout")).toBe(false);
  expect(roundAnswered({ status: "failed" })).toBe(false);
  expect(roundAnswered({ status: "done" })).toBe(true);
  expect(roundAnswered({ status: "failed" }, "stopped")).toBe(true);
});

test("a run is told what an earlier run left uncommitted in its worktree, and told nothing when it's clean", async () => {
  const wt = scratchWorktree("AC-2");
  expect(await leftovers(wt.path)).toEqual([]);
  expect(leftoverLines([])).toEqual([]);
  // a run that hit its limit mid-edit: a changed file and a new one
  writeFileSync(join(wt.path, "half.ts"), "export const half = 5;\n");
  const left = await leftovers(wt.path);
  expect(left).toEqual(["?? half.ts"]);
  const told = leftoverLines(left).join("\n");
  expect(told).toContain("stopped part-way");
  expect(told).toContain("?? half.ts");
  expect(told).toContain("Never commit any of it unseen");
});
