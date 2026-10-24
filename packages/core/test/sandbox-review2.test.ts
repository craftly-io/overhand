/**
 * The second review's findings: a main checkout's git can't be pointed at a repository of a run's making, and the
 * daemon's git checks where it points before every call; the daemon runs a project's own files under its sandbox;
 * Codex's login counts only when Codex says so; the list of refused checkouts fails closed.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRefused, OPS, sh } from "../src/env";
import { codexSignedIn } from "../src/runtimes/codex";
import { gitEnv, gitPointersOk } from "../src/runtimes/runtime";
import { allowGit, flagRepo, gitFlagged, projectCommand, real, sandboxPolicy } from "../src/sandbox";

const scratch = () => real(mkdtempSync(join(tmpdir(), "overhand-review2-")));
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

test("a main checkout whose .git/commondir points elsewhere gets no daemon git: its filter never runs", () => {
  const root = scratch();
  const repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  expect(gitPointersOk(repo)).toBe(true);
  // a run's own bare repo with a clean filter, and the checkout pointed at it
  const evil = join(root, "evil.git");
  git(root, "init", "-q", "--bare", evil);
  const fired = join(root, "fired");
  git(evil, "config", "filter.x.clean", `touch ${fired}; cat`);
  writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(repo, ".git", "commondir"), `${evil}\n`);
  expect(gitPointersOk(repo)).toBe(false);
  expect(gitRefused(repo)).toBe(true);
  sh(["git", "status"], repo);
  sh(["git", "add", "-A"], repo);
  expect(existsSync(fired)).toBe(false);
});

test("a run can't write a checkout's git pointers, config or info, main checkout or worktree", () => {
  const root = scratch();
  const common = join(root, "app", ".git");
  const base = { gitCommon: common, runtime: "claude-code" as const, configDir: join(root, "h"), run: "L-1", readOnly: false };
  const lead = sandboxPolicy({ ...base, cwd: join(root, "app"), gitDir: common }, root, join(root, "ops"));
  for (const p of ["commondir", "gitdir", "config", "config.worktree", "info"]) expect(lead.deny).toContain(real(join(common, p)));
  const gitDir = join(common, "worktrees", "T-1");
  const ticket = sandboxPolicy({ ...base, cwd: join(root, "wt"), gitDir }, root, join(root, "ops"));
  for (const p of ["commondir", "gitdir", "config", "config.worktree", "info"]) expect(ticket.deny).toContain(real(join(gitDir, p)));
  // a project's own MCP servers file is never a run's to write
  expect(ticket.deny).toContain(real(join(root, "wt", ".mcp.json")));
});

test("the daemon's git reads no system config and only your own global one", () => {
  const env = gitEnv({ HOME: "/h" });
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(
    env.GIT_CONFIG_GLOBAL?.startsWith("/h/") || env.GIT_CONFIG_GLOBAL?.endsWith(".gitconfig") || env.GIT_CONFIG_GLOBAL === "/dev/null",
  ).toBe(true);
});

test("a corrupt list of refused checkouts refuses every one (fails closed)", () => {
  const file = join(scratch(), "git-tampered.json");
  writeFileSync(file, "{not json");
  expect(gitRefused(scratch(), file)).toBe(true);
  writeFileSync(file, "[]");
  expect(gitRefused(scratch(), file)).toBe(false);
});

test("flagging a checkout keeps an unreadable list as it is, so every earlier flag still holds", () => {
  const ops = scratch();
  const file = join(ops, "control", "git-tampered.json");
  mkdirSync(join(ops, "control"));
  writeFileSync(file, '["/code/a", "/code/b"');
  flagRepo(join(ops, "c"), "L-1", ops);
  expect(readFileSync(file, "utf8")).toBe('["/code/a", "/code/b"');
  expect(gitRefused(scratch(), file)).toBe(true);
});

test("a flagged checkout refuses git in itself and inside it, not in a neighbour sharing its name", () => {
  const root = scratch();
  for (const d of ["app", "app/src", "app-web"]) mkdirSync(join(root, d));
  const file = join(root, "git-tampered.json");
  writeFileSync(file, JSON.stringify([join(root, "app")]));
  expect(gitRefused(join(root, "app"), file)).toBe(true);
  expect(gitRefused(join(root, "app", "src"), file)).toBe(true);
  expect(gitRefused(join(root, "app-web"), file)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("a project's own command the daemon runs goes under its sandbox when on, as is when off", () => {
  const cwd = scratch();
  const st = (effective: "off" | "enforce", refuse = false) => ({ mode: effective, effective, ok: !refuse, why: "", refuse });
  expect(projectCommand(["npm", "outdated"], cwd, st("off")).argv).toEqual(["npm", "outdated"]);
  expect(projectCommand(["npm", "outdated"], cwd, st("enforce", true)).argv).toEqual(["false"]);
  const box = projectCommand(
    ["/bin/sh", "-c", `echo x > ${join(cwd, "ok")}; echo x > ${join(OPS, "overhand.config.json")}`],
    cwd,
    st("enforce"),
    "app",
  );
  expect(box.argv[0]).toBe("/usr/bin/sandbox-exec");
  const r = Bun.spawnSync(box.argv, { cwd, stderr: "pipe" });
  box.done();
  expect(existsSync(join(cwd, "ok"))).toBe(true); // its own folder
  expect(r.exitCode).not.toBe(0); // Overhand's config isn't
});

test("Codex counts as signed in only when `codex login status` says so in that folder", async () => {
  const dir = scratch();
  const fake = join(dir, "codex");
  writeFileSync(fake, '#!/bin/sh\n[ -f "$CODEX_HOME/ok" ] && echo "Logged in using ChatGPT" && exit 0\necho "Not logged in"; exit 1\n', {
    mode: 0o755,
  });
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, "auth.json"), "{}"); // a file alone isn't a login
  expect(await codexSignedIn(home, fake)).toBe(false);
  writeFileSync(join(home, "ok"), "");
  expect(await codexSignedIn(home, fake)).toBe(true);
});

test("a flagged checkout is listed until you allow it again; an unreadable list is everywhere, until allowed as a whole", () => {
  const ops = scratch();
  flagRepo(join(ops, "a"), "L-1", ops);
  flagRepo(join(ops, "b"), "L-1", ops);
  expect(gitFlagged(ops)).toEqual([real(join(ops, "a")), real(join(ops, "b"))]);
  allowGit(real(join(ops, "a")), ops);
  expect(gitFlagged(ops)).toEqual([real(join(ops, "b"))]);
  writeFileSync(join(ops, "control", "git-tampered.json"), "{cut");
  expect(gitFlagged(ops)).toEqual(["*"]);
  allowGit("*", ops);
  expect(gitFlagged(ops)).toEqual([]);
});
