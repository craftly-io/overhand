/**
 * No leftover `overhand-*` folders in the temp folder. Tests are covered by the preload (test-home.ts), which points
 * TMPDIR at one folder per run and removes it after the run; every bunfig must preload it. Anything else that makes one
 * (release scripts, the relay's e2e, the daemon itself) must remove that same folder in the same file.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const files = (g: string) =>
  [...new Glob(g).scanSync({ cwd: ROOT })].filter((f) => !f.includes("node_modules") && !f.startsWith(".claude/"));

/** The folders a file makes with mkdtemp in the temp folder that the file never removes. */
export function leaked(src: string): string[] {
  return [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:realpathSync\()?mkdtempSync\(join\(tmpdir\(\),\s*["`]overhand-/g)]
    .map((m) => m[1] ?? "")
    .filter((name) => !new RegExp(`rmSync\\(${name}\\b`).test(src));
}

test("every bunfig preloads test-home.ts, and test-home.ts sends the run's temp folders to one folder it removes", () => {
  const bunfigs = files("**/bunfig.toml");
  expect(bunfigs.length).toBeGreaterThan(3);
  for (const f of bunfigs) expect(`${f}: ${readFileSync(join(ROOT, f), "utf8")}`).toMatch(/preload = \["(\.\.?\/)*test-home\.ts"\]/);
  const home = readFileSync(join(ROOT, "test-home.ts"), "utf8");
  expect(home).toContain("process.env.TMPDIR = runTmp");
  expect(home).toMatch(/afterAll\(\(\) => rmSync\(runTmp/);
});

test("outside tests, every overhand-* temp folder made is removed in the same file", () => {
  const scripts = files("**/*.ts").filter((f) => !/\.test\.tsx?$/.test(f) && f !== "test-home.ts");
  const bad = scripts.flatMap((f) => leaked(readFileSync(join(ROOT, f), "utf8")).map((name) => `${f}: ${name}`));
  expect(bad).toEqual([]);
});

test("the check catches a folder made and never removed", () => {
  const made = 'const home = mkdtempSync(join(tmpdir(), "overhand-x-"));';
  expect(leaked(made)).toEqual(["home"]);
  expect(leaked(`${made}\ntry {} finally { rmSync(home, { recursive: true }); }`)).toEqual([]);
});

test("a test that throws before its cleanup leaves PATH and other variables as they were for the next test", () => {
  // a child run of two tests: the first changes PATH, adds a variable and fails; the second checks
  const dir = mkdtempSync(join(tmpdir(), "overhand-env-leak-"));
  const file = join(dir, "leak.test.ts");
  writeFileSync(
    file,
    [
      'import { expect, test } from "bun:test";',
      "const path = process.env.PATH;",
      'test("leaves a mess", () => {',
      '  process.env.PATH = ["/nowhere", path].join(":");',
      '  process.env.OVERHAND_LEAK = "1";',
      '  throw new Error("deliberate");',
      "});",
      'test("finds it clean", () => {',
      "  expect(process.env.PATH).toBe(path);",
      "  expect(process.env.OVERHAND_LEAK).toBeUndefined();",
      "});",
    ].join("\n"),
  );
  try {
    const out = Bun.spawnSync(["bun", "test", file], { cwd: ROOT, env: process.env }).stderr.toString();
    expect(out).toContain("(fail) leaves a mess");
    expect(out).not.toContain("(fail) finds it clean");
    expect(out).toContain(" 1 pass\n 1 fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
