import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lsRemoteTag, taggedCommit } from "./tag";

const dir = mkdtempSync(join(tmpdir(), "overhand-tag-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .stdout.toString()
    .trim();

test("a resumed release finds the commit an annotated tag points at, not the tag's own object", () => {
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", origin);
  git(dir, "clone", "-q", origin, work);
  git(work, "commit", "-q", "--allow-empty", "-m", "release");
  git(work, "tag", "-a", "v9.9.9", "-m", "v9.9.9");
  git(work, "push", "-q", "origin", "HEAD", "v9.9.9");
  const head = git(work, "rev-parse", "HEAD");
  const [, ...args] = lsRemoteTag("v9.9.9");
  expect(taggedCommit(git(work, ...args))).toBe(head);
  const [, ...none] = lsRemoteTag("v0.0.0");
  expect(taggedCommit(git(work, ...none))).toBe("");
});
