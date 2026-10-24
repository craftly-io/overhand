import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proof } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { blankConfig, saveConfig } from "../src/config";
import { applyConfig, CFG, OPS, today, UI_PORT } from "../src/env";
import { handle } from "../src/server";
import {
  disarmForPush,
  githubSlug,
  loadShips,
  proofOn,
  protectedFile,
  type Run,
  recentShips,
  repoGate,
  SHIP_DEFAULTS,
  shipCheck,
  shipMerged,
  shipRefusal,
  shipStep,
  shipSweep,
  shipVerdict,
  undoShip,
} from "../src/ship";
import { loadState, saveState, type TrackedPr } from "../src/state";
import { localRequest } from "./local";

const origin = `http://127.0.0.1:${UI_PORT}`;
const post = (path: string, body: object) =>
  handle(
    localRequest(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** A fake gh and git: answers by the first matching command fragment, and records every call. */
function fake(answers: [string, { ok?: boolean; out?: string; err?: string }][]) {
  const calls: string[] = [];
  const run: Run = async (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const a = answers.find(([frag]) => line.includes(frag))?.[1] ?? {};
    return { ok: a.ok ?? true, out: a.out ?? "", err: a.err ?? "" };
  };
  return { run, calls };
}

const protectedMain = JSON.stringify({ protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["ci"] } } });
const bare = JSON.stringify({ protection: { required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } });
/** A fake GitHub holding one PR: arming and disarming change it, as GitHub's own auto-merge would. */
function github(o: { files?: string; ungated?: boolean; armErr?: string; live?: Record<string, unknown> } = {}) {
  const live: Record<string, unknown> = {
    id: "PR_node",
    state: "OPEN",
    baseRefName: "main",
    headRefOid: "abc",
    reviewDecision: "",
    autoMergeRequest: null,
    ...o.live,
  };
  const calls: string[] = [];
  const run: Run = async (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const ok = (out = "") => ({ ok: true, out, err: "" });
    if (line.includes("/rules/")) return ok("[]");
    if (line.includes("/branches/")) return ok(o.ungated ? bare : protectedMain);
    if (line.startsWith("gh pr view")) return ok(JSON.stringify(live));
    if (line.includes("/files")) return ok(o.files ?? "src/app.ts\n");
    if (line.includes("enablePullRequestAutoMerge")) {
      if (o.armErr) return { ok: false, out: "", err: o.armErr };
      live.autoMergeRequest = { enabledAt: "now" };
      return ok();
    }
    if (line.includes("disablePullRequestAutoMerge")) {
      live.autoMergeRequest = null;
      return ok();
    }
    return ok();
  };
  return { run, calls, live };
}

const PROOF: Proof = {
  at: 0,
  transcript: true,
  checks: [{ kind: "test", command: "bun test", ok: true, summary: "", skipped: 0 }],
  files: 1,
  added: 1,
  removed: 0,
  areas: ["src"],
  ui: false,
  docsOnly: false,
  verified: "ran the tests",
  shots: { before: false, after: false, note: "" },
  gaps: [],
};

let n = 0;
const pr = (over: Partial<TrackedPr> = {}): TrackedPr => ({
  url: `https://github.com/o/r${++n}/pull/7`,
  host: "github",
  repo: `o/r${n}`, // a repo of its own per test: the gate is cached per repo
  number: 7,
  branch: "agent/HONEY-7",
  mainRepo: "/code/r",
  repoPath: "/code/r/.claude/worktrees/honey-7",
  seen: "",
  fixes: 0,
  base: "main",
  proof: PROOF,
  ...over,
});
const ship = { name: "Honeycrust", autonomy: "ship" as const };
const enabled = (calls: string[]) => calls.filter((c) => c.includes("enablePullRequestAutoMerge"));

beforeEach(() => rmSync(join(OPS, "ship.json"), { force: true }));
// Honeycrust (HONEY-) is on Ship in the live config, which Ship reads right before arming
const before = CFG;
beforeAll(() =>
  applyConfig({ ...before, clients: before.clients.map((c) => (c.name === "Honeycrust" ? { ...c, autonomy: "ship" as const } : c)) }),
);
afterAll(() => applyConfig(before));

test("the gate: a required status check on the base, from branch protection or a ruleset; else green means nothing", async () => {
  expect(await repoGate("o/r", "main", fake([["/branches/", { out: protectedMain }]]).run)).toBe("");
  const ruleset = JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
  expect(
    await repoGate(
      "o/r",
      "main",
      fake([
        ["/rules/", { out: ruleset }],
        ["/branches/", { out: bare }],
      ]).run,
    ),
  ).toBe("");
  const none = await repoGate(
    "o/r",
    "main",
    fake([
      ["/rules/", { out: "[]" }],
      ["/branches/", { out: bare }],
    ]).run,
  );
  expect(none).toBe("Green means nothing here yet: no required checks on main.");
  // a review rule alone gates nothing: only a required check makes green mean something
  const reviews = JSON.stringify([{ type: "pull_request", parameters: {} }]);
  expect(
    await repoGate(
      "o/r",
      "main",
      fake([
        ["/rules/", { out: reviews }],
        ["/branches/", { out: bare }],
      ]).run,
    ),
  ).toContain("Green means nothing");
  expect(await repoGate("o/r", "main", fake([["/branches/", { ok: false, err: "HTTP 404" }]]).run)).toContain("HTTP 404");
  // a private repo on GitHub's free plan: no rule can be added, so the reason says why
  const free = fake([
    ["/rules/", { out: "[]" }],
    ["/branches/", { out: bare }],
    ["repos/o/r ", { out: JSON.stringify({ private: true, allow_auto_merge: false }) }],
  ]);
  expect(await repoGate("o/r", "main", free.run)).toBe(
    "GitHub only enforces required checks on private repositories with a paid plan; this one stays on Open pull requests.",
  );
  const pub = fake([
    ["/rules/", { out: "[]" }],
    ["/branches/", { out: bare }],
    ["repos/o/r ", { out: JSON.stringify({ private: false, allow_auto_merge: true }) }],
  ]);
  expect(await repoGate("o/r", "main", pub.run)).toContain("Green means nothing");
});

test("Ship needs the gate on every repo to be turned on, GitHub only; a project already on Ship isn't asked again", async () => {
  const none = fake([
    ["/rules/", { out: "[]" }],
    ["/branches/", { out: bare }],
  ]);
  const one = () => [{ repo: "o/gate-none", base: "main" }];
  const why = await shipRefusal(
    [{ name: "A", autonomy: "act" }],
    [{ name: "A", host: "github", dir: "a", autonomy: "ship" }],
    none.run,
    one,
  );
  expect(why).toBe(`A: Green means nothing here yet: no required checks on main. ${plainWords.shipStays}`);
  const bb = await shipRefusal([], [{ name: "B", host: "bitbucket", dir: "b", autonomy: "ship" }], none.run, one);
  expect(bb).toContain(plainWords.shipNotGithub);
  const ok = fake([["/branches/", { out: protectedMain }]]);
  expect(
    await shipRefusal([], [{ name: "A", host: "github", dir: "a", autonomy: "ship" }], ok.run, () => [{ repo: "o/gate-ok", base: "main" }]),
  ).toBe("");
  const kept = fake([]);
  expect(
    await shipRefusal([{ name: "A", autonomy: "ship" }], [{ name: "A", host: "github", dir: "a", autonomy: "ship" }], kept.run, one),
  ).toBe("");
  expect(kept.calls).toEqual([]);
});

test("the config refuses Ship on Bitbucket and for a group; new projects never start on it", () => {
  const base = blankConfig("me");
  const project = { name: "Honeycrust", dir: "honeycrust", prefix: "HONEY", host: "github" as const, autonomy: "ship" as const };
  expect(saveConfig(OPS, { ...base, clients: [project] }).clients[0]?.autonomy).toBe("ship");
  expect(() => saveConfig(OPS, { ...base, clients: [{ ...project, host: "bitbucket" }] })).toThrow("Ship needs GitHub");
  const group = { name: "Clients", members: ["Honeycrust"], rules: { autonomy: "ship" } };
  expect(() => saveConfig(OPS, { ...base, clients: [{ ...project, autonomy: "act" }], groups: [group] })).toThrow("never for a group");
  // assigning an agent never reaches Ship
  expect(() => saveConfig(OPS, { ...base, clients: [{ ...project, assignedAutonomy: "ship" }] })).toThrow();
  saveConfig(OPS, CFG);
});

test("the verdict: proof first, then protected paths and the day's cap leave the merge to you", () => {
  const f = { asked: false, gate: "", proof: true, files: ["src/a.ts"], protect: SHIP_DEFAULTS.protect, today: 0, perDay: 5 };
  expect(shipVerdict(f)).toEqual({ merge: true });
  expect(shipVerdict({ ...f, proof: false })).toEqual({ merge: false, why: plainWords.shipNoProof, final: false });
  expect(proofOn(PROOF)).toBe(true);
  expect(proofOn({ ...PROOF, checks: [] })).toBe(false); // no checks run
  expect(proofOn({ ...PROOF, ui: true })).toBe(false); // a screen change without its screenshots
  expect(proofOn({ ...PROOF, ui: true, shots: { before: true, after: true, note: "" } })).toBe(true);
  expect(shipVerdict({ ...f, gate: "no gate" })).toEqual({ merge: false, why: "no gate", final: false });
  expect(shipVerdict({ ...f, files: [".github/workflows/ci.yml"] })).toMatchObject({ merge: false, final: true });
  expect(shipVerdict({ ...f, today: 5 })).toEqual({
    merge: false,
    why: "Today's Ship limit of 5 is reached, so the merge is yours.",
    final: true,
  });
  expect(shipVerdict({ ...f, asked: true })).toMatchObject({ merge: false, final: true });
  expect(protectedFile(["db/migrations/001.sql"], ["db/migrations/*.sql"])).toBe("db/migrations/001.sql");
  expect(protectedFile(["src/db.ts"], ["db/"])).toBe("");
  expect(githubSlug("git@github.com:o/r.git")).toBe("o/r");
  expect(githubSlug("https://github.com/o/r")).toBe("o/r");
  expect(githubSlug("https://bitbucket.org/o/r.git")).toBe("");
});

const disabled = (calls: string[]) => calls.filter((c) => c.includes("disablePullRequestAutoMerge"));

test("a Ship PR with its proof gets GitHub's auto-merge for the checked commit, recorded once; never merged by Overhand", async () => {
  const g = github();
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  expect(enabled(g.calls)).toHaveLength(1);
  expect(enabled(g.calls)[0]).toContain("id=PR_node");
  expect(enabled(g.calls)[0]).toContain("expectedHeadOid:$head");
  expect(enabled(g.calls)[0]).toContain("head=abc");
  expect(p.ship).toEqual({ on: true, why: "", head: "abc", final: false });
  expect(loadShips()).toMatchObject([{ key: "HONEY-7", project: "Honeycrust", url: p.url, day: today() }]);
  await shipStep("HONEY-7", p, ship, "abc", g.run); // already on: not asked again, not counted again
  expect(enabled(g.calls)).toHaveLength(1);
  expect(loadShips()).toHaveLength(1);
  expect(g.calls.some((c) => / pr merge |mergePullRequest/.test(c))).toBe(false);
});

test("off Ship, without proof, without a gate, on a draft or on a newer commit: nothing is armed", async () => {
  for (const level of ["watch", "propose", "act"] as const) {
    const g = github();
    await shipStep("HONEY-7", pr(), { name: "Honeycrust", autonomy: level }, "abc", g.run);
    expect(g.calls).toEqual([]);
  }
  const noProof = github();
  const p = pr({ proof: undefined });
  await shipStep("HONEY-7", p, ship, "abc", noProof.run);
  expect(enabled(noProof.calls)).toEqual([]);
  expect(p.ship).toMatchObject({ on: false, why: plainWords.shipNoProof, final: false }); // asked again once it's on
  const draft = github();
  await shipStep("HONEY-7", pr({ draft: true }), ship, "abc", draft.run);
  expect(draft.calls).toEqual([]);
  const ungated = github({ ungated: true });
  const q = pr();
  await shipStep("HONEY-7", q, ship, "abc", ungated.run);
  expect(enabled(ungated.calls)).toEqual([]);
  expect(q.ship?.why).toBe("Green means nothing here yet: no required checks on main.");
  // the files were checked at abc but GitHub's head moved on: the next pass checks the new one
  const moved = github({ live: { headRefOid: "def" } });
  await shipStep("HONEY-7", pr(), ship, "abc", moved.run);
  expect(enabled(moved.calls)).toEqual([]);
});

test("a base that isn't the checked one, or a diff too big to read, waits for a person", async () => {
  const based = github({ live: { baseRefName: "release" } });
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", based.run);
  expect(enabled(based.calls)).toEqual([]);
  expect(p.ship).toMatchObject({ why: plainWords.shipBaseMoved, final: true });
  const huge = github({ files: Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`).join("\n") });
  const q = pr();
  await shipStep("HONEY-7", q, ship, "abc", huge.run);
  expect(enabled(huge.calls)).toEqual([]);
  expect(q.ship).toMatchObject({ why: plainWords.shipTooBig, final: true });
  // the files come from the API, paginated, renames under both names
  expect(huge.calls.find((c) => c.includes("/files"))).toContain("--paginate");
  expect(huge.calls.find((c) => c.includes("/files"))).toContain("previous_filename");
});

test("protected paths, renamed out of them too, and the day's cap fall back to Build, and say so on the PR", async () => {
  const g = github({ files: ".github/workflows/ci.yml\nsrc/a.ts\n" });
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  expect(enabled(g.calls)).toEqual([]);
  expect(p.ship).toEqual({
    on: false,
    why: "It touches .github/workflows/ci.yml, which you protect, so the merge is yours.",
    head: "abc",
    final: true,
  });
  // a rename lists the old path too: moving a workflow out of .github/ is still touching it
  const renamed = github({ files: "ci.yml\n.github/workflows/ci.yml\n" });
  const r = pr();
  await shipStep("HONEY-7", r, ship, "abc", renamed.run);
  expect(r.ship?.final).toBe(true);
  // GitHub reads CODEOWNERS from docs/ too
  const owners = github({ files: "docs/CODEOWNERS\n" });
  const o = pr();
  await shipStep("HONEY-7", o, ship, "abc", owners.run);
  expect(o.ship?.why).toContain("docs/CODEOWNERS");
  const own = github({ files: "prisma/schema.prisma" });
  const q = pr();
  await shipStep("HONEY-7", q, { ...ship, ship: { protect: ["prisma/"] } }, "abc", own.run);
  expect(q.ship?.final).toBe(true);

  const capped = { ...ship, ship: { perDay: 2 } };
  for (let i = 0; i < 2; i++) await shipStep(`HONEY-${i}`, pr(), capped, "abc", github().run);
  const third = github();
  const t = pr();
  await shipStep("HONEY-9", t, capped, "abc", third.run);
  expect(enabled(third.calls)).toEqual([]);
  expect(t.ship?.why).toBe("Today's Ship limit of 2 is reached, so the merge is yours.");
});

test("auto-merge not allowed, or a PR already green: it waits for a person with a reason, never retried or merged", async () => {
  const off = github({ armErr: "GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" });
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", off.run);
  expect(p.ship).toEqual({ on: false, why: plainWords.shipNotAllowed, head: "abc", final: true });
  const clean = github({ armErr: "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)" });
  const q = pr();
  await shipStep("HONEY-7", q, ship, "abc", clean.run);
  expect(q.ship).toMatchObject({ on: false, why: plainWords.shipClean, final: true });
  await shipStep("HONEY-7", q, ship, "abc", clean.run);
  expect(enabled(clean.calls)).toHaveLength(1);
  expect(clean.calls.some((c) => /mergePullRequest| pr merge /.test(c))).toBe(false);
});

test("before an agent pushes a fix round, auto-merge goes off; it's armed again only after the new diff is read", async () => {
  const g = github();
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  await disarmForPush("HONEY-7", p, g.run);
  expect(disabled(g.calls)).toHaveLength(1);
  expect(g.live.autoMergeRequest).toBeNull();
  expect(p.ship).toBeUndefined();
  // the push lands on a protected path: the next pass reads it and leaves the merge to you
  Object.assign(g.live, { headRefOid: "def" });
  const next = github({ files: ".github/workflows/ci.yml", live: { headRefOid: "def" } });
  await shipStep("HONEY-7", p, ship, "def", next.run);
  expect(enabled(next.calls)).toEqual([]);
  expect(p.ship?.final).toBe(true);
});

test("an armed PR goes off without any run budget: a new commit, changes asked on GitHub, the project gone or off Ship", async () => {
  const armed = async (live: Record<string, unknown> = {}) => {
    rmSync(join(OPS, "ship.json"), { force: true }); // under the day's cap
    const g = github({ live });
    const p = pr();
    await shipStep("HONEY-7", p, ship, "abc", g.run);
    return { g, p };
  };
  const pushed = await armed();
  Object.assign(pushed.g.live, { headRefOid: "def" });
  expect(await shipCheck("HONEY-7", pushed.p, ship, pushed.g.run)).toBe(false);
  expect(pushed.g.live.autoMergeRequest).toBeNull();

  const asked = await armed();
  Object.assign(asked.g.live, { reviewDecision: "CHANGES_REQUESTED" });
  await shipCheck("HONEY-7", asked.p, ship, asked.g.run);
  expect(asked.p.ship).toMatchObject({ on: false, why: plainWords.shipAsked, final: true });

  const note = await armed();
  await shipCheck("HONEY-7", { ...note.p, extra: "make it blue" }, ship, note.g.run);
  expect(note.g.live.autoMergeRequest).toBeNull();

  const based = await armed();
  Object.assign(based.g.live, { baseRefName: "release" });
  await shipCheck("HONEY-7", based.p, ship, based.g.run);
  expect(based.p.ship).toMatchObject({ on: false, final: true });

  // the sweep runs over every armed PR: one whose project left the config, one whose project left Ship
  const gone = await armed();
  const left = await armed();
  await shipSweep({ "GONE-1": gone.p }, () => undefined, gone.g.run);
  await shipSweep({ "LEFT-1": left.p }, () => ({ name: "L", autonomy: "act" }), left.g.run);
  expect(gone.g.live.autoMergeRequest).toBeNull();
  expect(left.g.live.autoMergeRequest).toBeNull();
  expect(gone.p.ship?.on).toBe(false);

  // still fine: stays armed, nothing asked of GitHub but a read
  const fine = await armed();
  const before = fine.g.calls.length;
  expect(await shipCheck("HONEY-7", fine.p, ship, fine.g.run)).toBe(true);
  expect(disabled(fine.g.calls.slice(before))).toEqual([]);
});

test("every Ship merge is reported and Undo opens a revert PR from a new branch: never the base, never forced", async () => {
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", github().run);
  shipMerged("HONEY-7", p);
  expect(recentShips()).toMatchObject([{ key: "HONEY-7", url: p.url }]);
  // the first try pushes the revert branch, then opening the PR fails
  const first = fake([
    ["ls-remote", { ok: false }],
    ["mergeCommit", { out: "f00d" }],
    ["pr create", { ok: false, err: "HTTP 502" }],
  ]);
  await expect(undoShip(p.url, first.run)).rejects.toThrow("HTTP 502");
  const push = first.calls.find((c) => c.startsWith("git push")) ?? "";
  expect(push).toContain(`HEAD:refs/heads/${CFG.outward.branchPrefix}revert-7`);
  expect(first.calls.some((c) => c.includes("git revert --no-edit f00d"))).toBe(true);
  expect(first.calls.every((c) => !/--force\b|\s-f\b|refs\/heads\/main\b/.test(c) || c.startsWith("git worktree remove"))).toBe(true);
  // the retry finds the branch already pushed and opens the PR from it
  const retry = fake([
    ["ls-remote", { ok: true }],
    ["mergeCommit", { out: "f00d" }],
    ["pr create", { out: "https://github.com/o/r/pull/8\n" }],
  ]);
  expect(await undoShip(p.url, retry.run)).toBe("https://github.com/o/r/pull/8");
  expect(retry.calls.some((c) => c.startsWith("git push") || c.startsWith("git revert"))).toBe(false);
  expect(retry.calls.find((c) => c.startsWith("gh pr create"))).toContain("--base main");
  // asked again: the same revert PR, nothing pushed twice
  const again = fake([]);
  expect(await undoShip(p.url, again.run)).toBe("https://github.com/o/r/pull/8");
  expect(again.calls).toEqual([]);
  await expect(undoShip("https://github.com/o/r/pull/999", again.run)).rejects.toThrow("no Ship merge");
});

test("the dashboard stops auto-merge at once: Request changes, and a save that takes the project off Ship", async () => {
  const bin = mkdtempSync(join(tmpdir(), "overhand-ship-gh-"));
  const log = join(bin, "calls.jsonl");
  const view = JSON.stringify({ id: "PR_node", state: "OPEN", baseRefName: "main", headRefOid: "abc", autoMergeRequest: { at: 1 } });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bun",
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `if (process.argv.includes("view")) console.log(${JSON.stringify(view)});`,
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(":");
  const cfg = CFG;
  const state = loadState();
  const disables = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.includes("disablePullRequestAutoMerge")).length
      : 0;
  const armed = () => saveState({ ...state, prs: { "HONEY-7": pr({ ship: { on: true, why: "", head: "abc", final: false } }) } });
  try {
    applyConfig(saveConfig(OPS, { ...cfg, clients: cfg.clients.map((c) => (c.name === "Honeycrust" ? { ...c, autonomy: "ship" } : c)) }));
    armed();
    expect((await post("/api/pr/changes", { key: "HONEY-7", text: "Use the shared formatter" })).status).toBe(200);
    expect(disables()).toBe(1);
    armed();
    expect((await post("/api/settings/quick", { project: "Honeycrust", autonomy: "act" })).status).toBe(200);
    expect(disables()).toBe(2);
  } finally {
    process.env.PATH = path;
    applyConfig(saveConfig(OPS, cfg));
    saveState(state);
    rmSync(join(OPS, ".pr-review.json"), { force: true });
    rmSync(join(OPS, ".request-work"), { force: true });
  }
});

test("a PR waiting because you asked for changes keeps waiting after the agent's fix push", async () => {
  const g = github();
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  // you ask for changes: off, final; the fix round's push leaves it so, though the note is used up
  await shipCheck("HONEY-7", Object.assign(p, { extra: "make it blue" }), ship, g.run);
  await disarmForPush("HONEY-7", p, g.run);
  p.extra = undefined;
  Object.assign(g.live, { headRefOid: "def" });
  await shipStep("HONEY-7", p, ship, "def", g.run);
  expect(enabled(g.calls)).toHaveLength(1);
  expect(p.ship).toMatchObject({ why: plainWords.shipAsked, final: true });

  // armed, then the fix round for your note: still waits for you afterwards
  const h = github();
  const q = pr();
  await shipStep("HONEY-8", q, ship, "abc", h.run);
  q.extra = "rename it";
  await disarmForPush("HONEY-8", q, h.run);
  q.extra = undefined;
  Object.assign(h.live, { headRefOid: "def" });
  await shipStep("HONEY-8", q, ship, "def", h.run);
  expect(enabled(h.calls)).toHaveLength(1);
  expect(q.ship?.final).toBe(true);
});

test("auto-merge Ship didn't turn on is turned off whenever Ship says wait", async () => {
  const g = github({ files: ".github/workflows/ci.yml", live: { autoMergeRequest: { enabledBy: "someone" } } });
  const p = pr();
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  expect(disabled(g.calls)).toHaveLength(1);
  expect(g.live.autoMergeRequest).toBeNull();
  // already waiting for you: still checked every pass
  Object.assign(g.live, { autoMergeRequest: { enabledBy: "someone" } });
  await shipStep("HONEY-7", p, ship, "abc", g.run);
  expect(disabled(g.calls)).toHaveLength(2);
  expect(enabled(g.calls)).toEqual([]);
});

test("arming the same PR again doesn't take another of the day's slots", async () => {
  const one = { ...ship, ship: { perDay: 1 } };
  const g = github();
  const p = pr();
  await shipStep("HONEY-7", p, one, "abc", g.run);
  await disarmForPush("HONEY-7", p, g.run);
  Object.assign(g.live, { headRefOid: "def" });
  await shipStep("HONEY-7", p, one, "def", g.run);
  expect(enabled(g.calls)).toHaveLength(2);
  expect(p.ship?.on).toBe(true);
  const other = github();
  await shipStep("HONEY-8", pr(), one, "abc", other.run);
  expect(enabled(other.calls)).toEqual([]);
});

test("the live config decides right before arming, and one failing check doesn't stop the sweep", async () => {
  const cfg = CFG;
  try {
    applyConfig({ ...cfg, clients: cfg.clients.map((c) => (c.name === "Honeycrust" ? { ...c, autonomy: "act" } : c)) });
    const g = github();
    await shipStep("HONEY-7", pr(), ship, "abc", g.run); // the caller's copy still says ship
    expect(enabled(g.calls)).toEqual([]);
  } finally {
    applyConfig(cfg);
  }
  const broken = pr({ ship: { on: true, why: "", head: "abc", final: false } });
  const fine = github();
  const ok = pr({ ship: { on: true, why: "", head: "abc", final: false } });
  Object.assign(fine.live, { autoMergeRequest: { at: 1 } });
  const run: Run = async (cmd, cwd) => {
    if (cmd.includes(broken.repo)) throw new Error("boom");
    return fine.run(cmd, cwd);
  };
  await shipSweep({ "HONEY-1": broken, "HONEY-2": ok }, () => ({ name: "Honeycrust", autonomy: "act" }), run);
  expect(fine.live.autoMergeRequest).toBeNull();
});
