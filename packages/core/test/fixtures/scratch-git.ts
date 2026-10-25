/** Scratch git for tests: a repo on a branch with one commit, and a bare origin to push to. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git in `cwd` as a test's own setup (not the daemon's); throws with what git said. */
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/**
 * A run's worktree as openPr and the fix round see it: a repo whose `base` is on a bare `origin`, checked out on
 * `branch` with one commit of its own. `remote` is the bare repository's folder.
 */
export function scratchWorktree(
  branch: string,
  base = "main",
): { mainRepo: string; path: string; branch: string; base: string; remote: string } {
  // tests only: the preload (test-home.ts) removes the run's whole temp folder, this one with it
  const root = mkdtempSync(join(tmpdir(), "scratch-git-"));
  const remote = join(root, "origin.git");
  const path = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", base, remote);
  git(root, "init", "-q", "-b", base, path);
  git(path, "commit", "-q", "--allow-empty", "-m", "init");
  git(path, "remote", "add", "origin", remote);
  git(path, "push", "-q", "origin", base);
  git(path, "checkout", "-q", "-b", branch);
  git(path, "commit", "-q", "--allow-empty", "-m", "work");
  return { mainRepo: path, path, branch, base, remote };
}
