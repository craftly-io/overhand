/**
 * Overhand pushes a run's branch itself (agent.ts pushBranch), so a run needs none of your GitHub or SSH sign-ins
 * (sandbox.ts SIGN_INS): only its own branch, from its own worktree, never forced, never a protected branch.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushBranch } from "../src/agent";
import { AGENT_HOMES } from "../src/agent-home";
import { check } from "../src/guard";
import { real, SIGN_IN_ENV, sandboxSpawn, sandboxState } from "../src/sandbox";
import { git, scratchWorktree } from "./fixtures/scratch-git";

test("Overhand pushes the run's own branch to origin with your sign-in, and only that", async () => {
  const wt = scratchWorktree("T-1");
  await pushBranch(wt);
  expect(git(wt.remote, "rev-parse", "T-1")).toBe(git(wt.path, "rev-parse", "HEAD"));
  // a protected branch or the base: never, whatever the worktree says
  await expect(pushBranch({ ...wt, branch: "main" })).rejects.toThrow("protected branch");
  await expect(pushBranch({ ...wt, base: "T-1" })).rejects.toThrow("protected branch");
  // the run moved its worktree to another branch: nothing goes
  git(wt.path, "checkout", "-q", "-b", "elsewhere");
  await expect(pushBranch(wt)).rejects.toThrow("nothing pushed");
  expect(git(wt.remote, "branch", "--list", "elsewhere")).toBe("");
});

test("someone else pushed to the branch meanwhile: Overhand's push is refused, never forced", async () => {
  const wt = scratchWorktree("T-2");
  await pushBranch(wt);
  const theirs = git(wt.path, "rev-parse", "HEAD");
  git(wt.path, "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten");
  await expect(pushBranch(wt)).rejects.toThrow("git push");
  expect(git(wt.remote, "rev-parse", "T-2")).toBe(theirs);
});

test("a ticket run's git push is steered to Overhand's; a lead still pushes its own", () => {
  const bash = (command: string, run: string) => check("Bash", { command }, undefined, "act", run, []);
  expect(bash("git push -u origin T-1", "T-1")).toContain("Overhand pushes your branch");
  expect(bash("git push -u origin feature", "lead-app")).toBeNull();
  expect(bash("git commit -m x", "T-1")).toBeNull();
});

test("no run, a lead's neither, gets a GitHub or SSH sign-in in its environment, with the sandbox or without", () => {
  const cwd = real(mkdtempSync(join(tmpdir(), "overhand-push-")));
  const signIns = Object.fromEntries(SIGN_IN_ENV.map((k) => [k, "secret"]));
  const spawn = (run: string, project: "off" | "inherit") =>
    sandboxSpawn(
      {
        cwd,
        runtime: "claude-code",
        configDir: join(AGENT_HOMES, "claude-code"),
        run,
        readOnly: false,
        argv: ["true"],
        env: { PATH: "/usr/bin", ...signIns },
      },
      sandboxState({ mode: "enforce", required: false, project }, "darwin", () => ({ ok: true, why: "" })),
      () => "",
      join(cwd, "ops"),
    );
  for (const project of ["off", "inherit"] as const) {
    for (const run of ["T-1", "lead-app"]) {
      const r = spawn(run, project);
      for (const k of SIGN_IN_ENV) expect(r.env[k]).toBeUndefined();
      expect(r.env.GIT_TERMINAL_PROMPT).toBe("0");
      r.done(Date.now());
    }
  }
});
