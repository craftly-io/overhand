import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OPS } from "../src/env";
import {
  cachedVersions,
  checkScripts,
  findFirstWin,
  findTask,
  firstWinState,
  packageManager,
  patchUpgrade,
  readmeGap,
  saveWin,
  untestedPure,
  winToRun,
} from "../src/firstwin";

const README =
  "# App\n\nA small app that books rooms for the clinic and sends reminders to patients the day before.\n\n## Install\n\n`bun install`\n";

/** A fixture repo from relative path → contents (objects are written as JSON). */
function repo(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "firstwin-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

test("checkScripts runs only the repo's read-only checks, type checks first", () => {
  expect(
    checkScripts({
      lint: "biome check .",
      "lint:fix": "eslint --fix .",
      typecheck: "tsc --noEmit",
      build: "tsc",
      tsc: "tsc",
      format: "biome format --write .",
      test: "bun test",
    }),
  ).toEqual(["typecheck", "lint"]);
  expect(packageManager(["package.json", "pnpm-lock.yaml"])).toBe("pnpm");
  expect(packageManager(["package.json"])).toBe("npm");
});

test("patchUpgrade takes the highest patch of the same minor, and leaves wide or odd ranges alone", () => {
  const known: Record<string, string[]> = {
    "left-pad": ["1.3.2", "1.3.1", "1.4.0", "2.0.0", "1.3.3-beta.1"],
    zod: ["4.6.9"],
    ws: ["8.0.1"],
  };
  const installed = (n: string) => (n === "left-pad" ? "1.3.0" : null);
  expect(patchUpgrade({ "left-pad": "^1.3.0" }, installed, (n) => known[n] ?? [])).toEqual({
    name: "left-pad",
    from: "1.3.0",
    to: "1.3.2",
  });
  expect(patchUpgrade({ zod: "*", ws: "workspace:*" }, installed, (n) => known[n] ?? [])).toBeNull();
  expect(patchUpgrade({ ws: "~8.0.0" }, installed, (n) => known[n] ?? [])).toEqual({ name: "ws", from: "8.0.0", to: "8.0.1" });
});

test("readmeGap: missing, placeholder, no way to run it, or fine", () => {
  expect(readmeGap(null)).toBe("missing");
  expect(readmeGap("# app\n\nTODO")).toBe("placeholder");
  expect(readmeGap(README.replace("## Install\n\n`bun install`\n", "## Architecture\n\nRooms, slots and reminders.\n"))).toBe("no-run");
  expect(readmeGap(README)).toBeNull();
});

test("untestedPure finds a short pure export no test mentions", () => {
  const sources = [
    { path: "src/net.ts", text: "export function load(url: string) {\n  return fetch(url);\n}\n" },
    {
      path: "src/math.ts",
      text: "export function sum(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nexport function clamp(n: number, lo: number, hi: number) {\n  return Math.min(hi, Math.max(lo, n));\n}\n",
    },
  ];
  expect(untestedPure(sources, 'import { sum } from "../src/math";')).toEqual({ name: "clamp", path: "src/math.ts" });
  expect(untestedPure(sources, "sum clamp")).toBeNull();
});

test("cachedVersions reads Bun's cache, scoped packages too", () => {
  const cache = repo({ "left-pad@1.3.2@@@1/package.json": "{}", "@scope/x@2.0.1@@@1/package.json": "{}", "other@1.0.0@@@1/x": "" });
  expect(cachedVersions(cache, "left-pad")).toEqual(["1.3.2"]);
  expect(cachedVersions(cache, "@scope/x")).toEqual(["2.0.1"]);
  expect(cachedVersions(join(cache, "nope"), "left-pad")).toEqual([]);
});

test("findTask finds each kind in a fixture repo, read-only and local", async () => {
  const until = Date.now() + 30_000;
  const lint = repo({
    "package.json": { scripts: { lint: "echo 'src/a.ts:3 unused variable x' && exit 1", "lint:fix": "eslint --fix ." } },
    "bun.lock": "",
    "node_modules/.keep": "",
    "README.md": README,
  });
  const lintTask = await findTask(lint, "lint", until);
  expect(lintTask).toMatchObject({ kind: "lint", title: "Make `bun run lint` pass" });
  expect(lintTask?.brief).toContain("unused variable x");
  expect(await findTask(lint, "readme", until)).toBeNull();

  const cache = repo({ "left-pad@1.3.2@@@1/package.json": "{}" });
  const dep = repo({
    "package.json": { dependencies: { "left-pad": "^1.3.0" } },
    "node_modules/left-pad/package.json": { version: "1.3.0" },
  });
  expect(await findTask(dep, "dependency", until, cache)).toMatchObject({ title: "Upgrade left-pad from 1.3.0 to 1.3.2" });
  expect(await findTask(dep, "lint", until)).toBeNull(); // no check scripts
  expect(await findTask(dep, "readme", until)).toMatchObject({ title: "Add a README with how to install and run it" });

  const tested = repo({
    "package.json": { scripts: { test: "bun test" } },
    "README.md": README,
    "src/slug.ts": 'export function slug(s: string) {\n  return s.toLowerCase().replace(/\\W+/g, "-");\n}\n',
  });
  expect(await findTask(tested, "test", until)).toMatchObject({ title: "Add a test for slug" });
  writeFileSync(join(tested, "src", "slug.test.ts"), 'import { slug } from "./slug";\n');
  expect(await findTask(tested, "test", until)).toBeNull();
});

test("findFirstWin tries each kind across repos before the next, and says none when nothing fits", async () => {
  const placeholder = repo({ "README.md": "# x\n\nTODO" });
  const failing = repo({
    "package.json": { scripts: { typecheck: "exit 2" } },
    "node_modules/.keep": "",
    "bun.lock": "",
    "README.md": README,
  });
  const started = Date.now();
  const win = await findFirstWin([placeholder, failing]);
  expect(win?.repo).toBe(failing); // a failing check comes before a README, whichever repo has it
  expect(win?.task.kind).toBe("lint");
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(await findFirstWin([repo({ "README.md": README })])).toBeNull();
});

test("the dashboard sees the first win without its local path or brief", () => {
  saveWin({
    state: "queued",
    kind: "readme",
    title: "Add install and run steps to the README",
    project: "Honeycrust",
    repo: "shop",
    key: "HONEY-0",
    url: "",
    message: "",
    at: Date.now(),
    repoPath: "/Users/someone/code/shop",
    brief: "secret-ish details",
  });
  const shown = firstWinState();
  expect(shown).toMatchObject({ state: "queued", key: "HONEY-0", repo: "shop" });
  expect(JSON.stringify(shown)).not.toContain("/Users/");
  expect(firstWinState(Date.now() + 4 * 864e5)).toMatchObject({ state: "queued" }); // under way: always shown
  rmSync(join(OPS, "first-win.json"));
});

test("a first win left running by an Overhand that restarted runs again; one running now, or finished, doesn't", () => {
  const started = 1_000;
  expect(winToRun({ state: "queued", at: 2_000 }, started)).toBe(true);
  expect(winToRun({ state: "running", at: 500 }, started)).toBe(true);
  expect(winToRun({ state: "running", at: 2_000 }, started)).toBe(false);
  expect(winToRun({ state: "pr", at: 500 }, started)).toBe(false);
  expect(winToRun(null, started)).toBe(false);
});
