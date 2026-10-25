import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig, ignoredKeys, lastGoodFile, loadConfig, parseConfig, restoreConfig, saveConfig, startConfig } from "../src/config";

const scratch = (): string => mkdtempSync(join(tmpdir(), "overhand-config-"));
const good = { owner: { name: "n", keychainAccount: "n" }, accounts: ["main"], clients: [] };
const write = (dir: string, text: string) => writeFileSync(join(dir, "overhand.config.json"), text);

test("a config that loads is kept as the last good copy; a save keeps what it wrote", () => {
  const dir = scratch();
  write(dir, JSON.stringify(good));
  loadConfig(dir);
  expect(readFileSync(lastGoodFile(dir), "utf8")).toBe(JSON.stringify(good));
  saveConfig(dir, { ...good, accounts: ["main", "work"] });
  expect(JSON.parse(readFileSync(lastGoodFile(dir), "utf8")).accounts).toEqual(["main", "work"]);
});

test("a cut-short or empty config starts on the last good copy, keeps the broken text, and Restore puts the copy back", () => {
  for (const broken of ['{"owner": {"name": "n"', ""]) {
    const dir = scratch();
    write(dir, JSON.stringify(good));
    loadConfig(dir);
    write(dir, broken);
    const r = startConfig(dir, "me");
    expect(r.broken).toContain("overhand.config.json is invalid");
    expect(r.config.accounts).toEqual(["main"]);
    expect(readFileSync(join(dir, "control", "broken-config.json"), "utf8")).toBe(broken);
    expect(restoreConfig(dir).accounts).toEqual(["main"]);
    expect(startConfig(dir, "me").broken).toBe("");
  }
});

test("with no good copy yet, a broken config starts blank instead of exiting, and there's nothing to restore", () => {
  const dir = scratch();
  write(dir, "{");
  const r = startConfig(dir, "me");
  expect(r.broken).not.toBe("");
  expect(r.config).toEqual(blankConfig("me"));
  expect(existsSync(lastGoodFile(dir))).toBe(false);
  expect(() => restoreConfig(dir)).toThrow("nothing to restore");
});

test("settings the schema doesn't know are named, nested ones by their path; moved older layouts aren't", () => {
  const raw = { ...good, autonmy: "watch", limits: { taskTimeoutMn: 1 }, cleanup: { staleWorktreeDays: 9 } };
  expect(ignoredKeys(raw, parseConfig(raw))).toEqual(["autonmy", "limits.taskTimeoutMn"]);
  const dir = scratch();
  write(dir, JSON.stringify(raw));
  expect(startConfig(dir, "me").ignored).toEqual(["autonmy", "limits.taskTimeoutMn"]);
  expect(ignoredKeys(good, parseConfig(good))).toEqual([]);
});

test("plan accounts are paced through their week by default, and a config that turned pacing off keeps it off", () => {
  expect(parseConfig(good).limits.paceWeekly).toBe(true);
  expect(parseConfig({ ...good, limits: { paceWeekly: false } }).limits.paceWeekly).toBe(false);
});

test("a flat cleanup config keeps its disk floor and schedule when it moves into categories", () => {
  const c = parseConfig({ ...good, cleanup: { minFreeGb: 20, auto: { schedule: "daily" }, staleWorktreeDays: 9 } });
  expect(c.cleanup.minFreeGb).toBe(20);
  expect(c.cleanup.auto.schedule).toBe("daily");
  expect(c.cleanup.categories.worktrees.staleDays).toBe(9);
});
