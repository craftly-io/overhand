import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The design catalog (apps/design) is Overhand's own tool: it's served at overhand.dev/docs/design and never ships in a
 * customer's install. A release package is the daemon binary (run.ts) and the dashboard build (apps/web/dist), so this
 * pins both: build.ts copies nothing else, the dashboard build has no way in, and the binary bundles nothing from it.
 */
const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("a release package holds the binary and the dashboard build only, and a Mac's the menu bar helper too", () => {
  const build = read("release/build.ts");
  expect([...build.matchAll(/cpSync\((join\([^)]*\)|\w+),/g)].map((m) => m[1])).toEqual(['join(ROOT, "apps", "web", "dist")', "MENUBAR"]);
  expect(build).toContain('"-C", dir, "overhand", "web", ...helper]');
  expect(build).toContain('os === "darwin" && MENUBAR');
  expect(build).not.toMatch(/design/);
});

test("the dashboard build never reaches into the catalog", () => {
  expect(read("apps/web/vite.config.ts")).not.toMatch(/design/);
  const web = [...new Bun.Glob("apps/web/src/**/*.{ts,tsx,css}").scanSync({ cwd: ROOT })];
  expect(web.filter((f) => /(?:from|import)\s*\(?\s*["'][^"']*(?:apps\/design|\.\.\/design\/)/.test(read(f)))).toEqual([]);
});

test("the daemon binary bundles nothing from the catalog", () => {
  // the CLI, as release/build.ts compiles it (Bun.build inside a test run resolves workspace packages differently)
  const out = mkdtempSync(join(tmpdir(), "overhand-bundle-"));
  const r = Bun.spawnSync(["bun", "build", "run.ts", "--target=bun", `--outdir=${out}`, `--metafile=${join(out, "meta.json")}`], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const inputs = Object.keys(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")).inputs);
  rmSync(out, { recursive: true, force: true });
  expect(inputs.length).toBeGreaterThan(50);
  expect(inputs.filter((f) => f.includes("apps/design"))).toEqual([]);
}, 30_000);

// a built package (release/out/*.tar.gz, when one exists): its entries are the binary and the dashboard build, nothing else
const built = [...new Bun.Glob("release/out/*.tar.gz").scanSync({ cwd: ROOT })];
test.skipIf(!built.length)("a built package holds the binary and the dashboard build only", () => {
  for (const tar of built) {
    const r = Bun.spawnSync(["tar", "-tzf", tar], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const entries = r.stdout.toString().split("\n").filter(Boolean);
    expect(entries).toContain("overhand");
    expect(entries.filter((e) => e !== "overhand" && !/^web(\/|$)/.test(e))).toEqual([]);
    expect(entries.filter((e) => /design/.test(e))).toEqual([]);
  }
});
