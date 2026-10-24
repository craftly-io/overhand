import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guideDrift } from "@overhand/contract";
import { prCreateFlags } from "../src/autonomy";
import { OPS, sh } from "../src/env";
import {
  type GuideInputs,
  guideMerged,
  guideNext,
  guidePrompt,
  guideView,
  isGuideKey,
  loadGuides,
  mergedGuides,
  repoFacts,
  requestGuide,
  saveGuide,
} from "../src/guide";
import { buildSummary } from "../src/summary";

/** A committed fixture repo from relative path → contents (objects are written as JSON). */
function repo(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "guide-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  for (const cmd of [
    ["git", "init", "-q"],
    ["git", "add", "-A"],
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
  ])
    sh(cmd, dir);
  return dir;
}

const GUIDE = [
  "# Shop",
  "## Install and run",
  "```sh",
  "npm install",
  "npm run dev",
  "```",
  "## Test",
  "`npm test`, then `npm run e2e`. Routes live in `server/routes/`; pages in `app/page.tsx`.",
].join("\n");

test("drift on fixture repos: the guide against the committed tree", async () => {
  const drifted = repo({
    "ONBOARDING.md": GUIDE,
    "bun.lock": "",
    "package.json": { scripts: { dev: "next dev", test: "bun test" } },
    "app/page.tsx": "export default 1",
  });
  const fresh = repo({
    "ONBOARDING.md": GUIDE,
    "package-lock.json": "{}",
    "package.json": { scripts: { dev: "next dev", test: "jest", e2e: "playwright test" } },
    "app/page.tsx": "export default 1",
    "server/routes/index.ts": "export {}",
  });
  try {
    const f = await repoFacts(drifted, "HEAD");
    expect(f.dirs).toEqual(["app"]);
    expect([...f.files].sort()).toEqual(["ONBOARDING.md", "bun.lock", "package.json"]);
    expect(guideDrift(GUIDE, f)).toEqual([
      { kind: "pm", said: "npm", actual: "bun" },
      { kind: "script", said: "npm run e2e", actual: "package.json" },
      { kind: "folder", said: "server/", actual: "" },
    ]);
    expect(guideDrift(GUIDE, await repoFacts(fresh, "HEAD"))).toEqual([]);
  } finally {
    rmSync(drifted, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

const read = { text: "# Guide", branch: "main", at: 5, drift: [] };
const view = (over: Partial<GuideInputs>) => guideView({ project: "Shop", repo: "shop", remote: "", main: null, ...over });

test("Share with your team: the file on the code host at the default branch, or the PR while it's open", () => {
  expect(view({ remote: "git@github.com:acme/shop.git", main: read }).share).toBe("https://github.com/acme/shop/blob/HEAD/ONBOARDING.md");
  expect(view({ remote: "https://bitbucket.org/acme/shop.git", main: read }).share).toBe(
    "https://bitbucket.org/acme/shop/src/HEAD/ONBOARDING.md",
  );
  // a host Overhand can't link to: nothing to copy, rather than a wrong link
  expect(view({ remote: "git@gitlab.com:acme/shop.git", main: read }).share).toBe("");
  const open = view({
    remote: "git@github.com:acme/shop.git",
    main: read,
    pr: { key: "SHOP-ONBOARDING-A1", url: "https://github.com/acme/shop/pull/9", read: { ...read, branch: "overhand/SHOP-ONBOARDING-A1" } },
  });
  expect(open).toMatchObject({ source: "pr", branch: "overhand/SHOP-ONBOARDING-A1", share: "https://github.com/acme/shop/pull/9" });
  expect(view({ main: read }).source).toBe("default");
  // a watch report is shown, never shared: it isn't in the repo
  const watch = view({ stored: { run: "idle", key: "SHOP-ONBOARDING-B", repoPath: "", message: "", report: "# Draft", at: 3 } });
  expect(watch).toMatchObject({ source: "report", text: "# Draft", share: "" });
  expect(view({}).source).toBe("");
});

test("task creation: one guide run at a time per project, queued for the next work pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-repo-"));
  try {
    const g = await requestGuide("Honeycrust", 1_000, () => dir);
    expect(g.run).toBe("queued");
    expect(isGuideKey(g.key)).toBe(true);
    expect(g.key.startsWith("HONEY-ONBOARDING-")).toBe(true);
    expect(loadGuides().Honeycrust?.repoPath).toBe(dir);
    expect(existsSync(join(OPS, ".request-work"))).toBe(true);
    await expect(requestGuide("Honeycrust", 2_000, () => dir)).rejects.toThrow(/already being written/);
    saveGuide("Honeycrust", { ...g, run: "running" });
    await expect(requestGuide("Honeycrust", 2_000, () => dir)).rejects.toThrow(/already being written/);
    saveGuide("Honeycrust", { ...g, run: "failed" });
    expect((await requestGuide("Honeycrust", 3_000, () => dir)).key).not.toBe(g.key); // a refresh gets a branch of its own
    await expect(requestGuide("Nowhere")).rejects.toThrow(/No project/);
    await expect(requestGuide("Fernway", 1, () => null)).rejects.toThrow(/No active repo/);
    expect(isGuideKey("HONEY-12")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autonomy gating: watch reports the text, propose opens a draft, act a PR", () => {
  const done = { status: "done", message: "Wrote it", guide: "# Guide" };
  expect(guideNext("watch", done)).toBe("report");
  expect(guideNext("watch", { ...done, guide: " " })).toBe("failed");
  expect(guideNext("propose", done)).toBe("pr");
  expect(guideNext("act", done)).toBe("pr");
  expect(guideNext("propose", { ...done, status: "question" })).toBe("failed");
  expect(prCreateFlags("propose")).toEqual(["--draft"]);
  expect(prCreateFlags("watch")).toBeNull();
  const wt = { path: "/w", branch: "overhand/X-ONBOARDING-1", base: "main" };
  const watch = guidePrompt({ name: "Shop", autonomy: "watch" }, "X-ONBOARDING-1", "shop", wt);
  expect(watch).toContain("can't write files");
  expect(watch).not.toContain("Overhand pushes it");
  const propose = guidePrompt({ name: "Shop", autonomy: "propose" }, "X-ONBOARDING-1", "shop", wt);
  expect(propose).toContain("Overhand pushes it");
  expect(propose).toContain("draft");
  for (const p of [watch, propose]) {
    expect(p).toContain("ONBOARDING.md");
    expect(p).toContain("Never invent a command");
    expect(p).not.toMatch(/team-onboarding/);
  }
});

test("a merged guide PR becomes the status update's line, within its span", () => {
  saveGuide("Fernway", { run: "idle", key: "FERN-ONBOARDING-Z", repoPath: "", message: "", report: "", at: 0 });
  guideMerged("FERN-ONBOARDING-Z", "git@github.com:fernway/booking.git", 50_000);
  guideMerged("FERN-ONBOARDING-NOPE", "git@github.com:fernway/booking.git", 60_000); // not a guide run: ignored
  const merged = mergedGuides();
  expect(merged).toContainEqual({
    project: "Fernway",
    key: "FERN-ONBOARDING-Z",
    title: "ONBOARDING.md",
    url: "https://github.com/fernway/booking/blob/HEAD/ONBOARDING.md",
    at: 50_000,
  });
  const inputs = { history: [], prs: [], tickets: {}, labels: { blocked: "b", queue: "q" }, guides: merged };
  expect(buildSummary("day", 60_000, inputs).guides.map((g) => g.project)).toContain("Fernway");
  expect(buildSummary("day", 50_000 + 2 * 864e5, inputs).guides).toEqual([]);
});
