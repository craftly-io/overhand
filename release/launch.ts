/**
 * Ships an Overhand release in one command, from the public repo:
 *   preflight → tag → release built → sites deployed → real install verified → npm → Homebrew → Docker image → announce.
 * Every step checks whether it's already done, so after a failure, fix the cause and run it again: it resumes.
 * Usage: bun release/launch.ts [--dry-run]   (--dry-run reads state and prints every step; it changes nothing)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALLER as GET, IMAGE, REPO, REPO_URL, SITE as WWW } from "../packages/contract/src/links";
import { safeCmd } from "../packages/core/src/runtimes/runtime";
import { formula } from "./formula";

const ROOT = resolve(import.meta.dir, "..");
const DRY = process.argv.includes("--dry-run");
const TAP = "craftly-io/homebrew-tap";
const WRANGLER = ["bunx", "wrangler@4.151.1", "deploy"];
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
// the Dockerfile's image (IMAGE), for both Linux platforms; nothing pushes it but step 8 of a real run
const IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"];
const { version } = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
const TAG = `v${version}`;
const problems: string[] = [];

type Result = { ok: boolean; out: string };

/** Runs a read-only command (dry run too) and returns its trimmed output. */
function read(cmd: string[], cwd = ROOT, env: Record<string, string> = {}): Result {
  // git as the daemon runs it (SAFE_GIT): a release reads the checkout, never runs its fsmonitor or hooks
  const r = Bun.spawnSync(safeCmd(cmd), { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.exitCode === 0 ? "" : r.stderr.toString()}`.trim() };
}

/** A read-only command's JSON list output, or [] when it fails (the repo doesn't exist yet, gh signed out). */
function list<T>(cmd: string[]): T[] {
  const r = read(cmd);
  return r.ok && r.out ? (JSON.parse(r.out) as T[]) : [];
}

/** Runs a command that changes something, or in a dry run only prints it. Throws when it fails. */
function act(cmd: string[], cwd = ROOT): void {
  console.log(`    ${DRY ? "would run" : "$"} ${cmd.join(" ")}${cwd === ROOT ? "" : `   (in ${cwd.replace(`${ROOT}/`, "")})`}`);
  if (DRY) return;
  if (Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

/** A check that must hold: stops a real run; a dry run notes it and carries on, to show the whole plan. */
function need(ok: boolean, what: string, why = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${ok || !why ? "" : `: ${why}`}`);
  if (ok) return;
  if (!DRY) throw new Error(`${what}${why ? `: ${why}` : ""}`);
  problems.push(what);
}

const step = (n: number, title: string): void => console.log(`\n${n}. ${title}`);
const done = (what: string): void => console.log(`  ✓ ${what}, skipped`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const machine = `${process.platform}-${process.arch}`;

function preflight(): void {
  step(1, "Preflight");
  need(read(["gh", "repo", "view", REPO]).ok, `${REPO} exists`, "rename the GitHub org and repo to it first");
  need(read(["git", "remote", "get-url", "origin"]).out.includes(REPO), `origin is ${REPO}`, `git remote set-url origin ${REPO_URL}.git`);
  const branch = read(["git", "branch", "--show-current"]).out;
  need(branch === "main", "on main", `on ${branch || "a detached HEAD"}`);
  need(read(["git", "status", "--porcelain"]).out === "", "clean working tree");
  read(["git", "fetch", "-q", "origin", "main", "--tags"]);
  const head = read(["git", "rev-parse", "HEAD"]).out;
  need(head === read(["git", "rev-parse", "origin/main"]).out, "HEAD is origin/main", "pull or push first");

  // CI skips docs/site/markdown-only commits, so HEAD may have no run: then the newest run on main must be green and
  // everything since it must be paths CI ignores (.github/workflows/ci.yml)
  const runs = list<{ headSha: string; conclusion: string }>([
    "gh",
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    "ci.yml",
    "--branch",
    "main",
    "-L",
    "20",
    "--json",
    "headSha,conclusion",
  ]);
  const last = runs.find((r) => r.headSha === head) ?? runs.find((r) => r.conclusion);
  const since = last ? read(["git", "diff", "--name-only", last.headSha, head]).out.split("\n").filter(Boolean) : [];
  const ignored = since.every((f) => /\.md$|^docs\/|^site\//.test(f));
  need(
    last?.conclusion === "success" && ignored,
    "CI green on HEAD",
    last ? `${last.conclusion || "running"} on ${last.headSha.slice(0, 7)}` : "no run",
  );

  const leak = read(["bun", "release/leakcheck.ts"]);
  need(leak.ok && !leak.out.includes("skipped"), "leakcheck clean", leak.out.includes("skipped") ? "no .public-denylist here" : leak.out);
  packages();
  if (DRY) console.log("    would run: bun run test");
  else need(read(["bun", "run", "test"]).ok, "tests pass", "bun run test failed");
  // every screen at every size and theme: a page that scrolls sideways or controls on top of each other block the release
  if (DRY) console.log("    would run: bun run shots");
  else need(read(["bun", "run", "shots"]).ok, "responsive sweep clean", "bun run shots; see release/out/shots/index.html");
  // open all day: one tab on a scratch daemon through a compressed two and a half days must stay flat and near-free
  if (DRY) console.log("    would run: bun release/soak.ts --minutes 20");
  else
    need(
      read(["nice", "-n", "10", "bun", "release/soak.ts", "--minutes", "20", "--no-build"]).ok,
      "20-minute soak within budgets",
      "bun release/soak.ts --minutes 20; see release/out/soak/chart.html",
    );

  // an annotated tag lists its own object and, as <tag>^{}, the commit it points at
  const refs = read(["git", "ls-remote", "--tags", "origin", TAG]).out.split("\n").filter(Boolean);
  const tagged = (refs.find((l) => l.endsWith("^{}")) ?? refs[0] ?? "").split(/\s+/)[0] ?? "";
  need(!tagged || tagged === head, `${TAG} not released from another commit`, "bump package.json's version");
  if (tagged === head) console.log(`    ${TAG} already points at HEAD: resuming`);

  need(read(["gh", "repo", "view", TAP]).ok, `${TAP} exists`, `gh repo create ${TAP} --private --add-readme`);
  need(read(["bunx", "wrangler@4.151.1", "whoami"]).out.includes("You are logged in"), "wrangler signed in", "bunx wrangler login");
  need(read(["docker", "buildx", "version"]).ok, "docker buildx installed", "install Docker with buildx");
  need(read(["gh", "auth", "status"]).out.includes("write:packages"), "gh may push to GHCR", "gh auth refresh -s write:packages");
}

/**
 * Builds every package into a scratch folder (dry run too: it publishes nothing), checks SHA256SUMS against the files,
 * and smoke-tests this machine's package, so a broken build shows up before the tag rather than in the release workflow.
 */
function packages(): void {
  const out = mkdtempSync(join(tmpdir(), "overhand-build-"));
  try {
    const built = read(["bun", "release/build.ts", out]);
    need(built.ok, `the ${PLATFORMS.length} packages build`, built.out.split("\n").slice(-3).join(" "));
    if (!built.ok) return;
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    const wrong = PLATFORMS.filter((p) => {
      const tar = `overhand-${p}.tar.gz`;
      const sum = new Bun.CryptoHasher("sha256").update(readFileSync(join(out, tar))).digest("hex");
      return !sums.includes(`${sum}  ${tar}`);
    });
    need(!wrong.length && sums.length === PLATFORMS.length, "SHA256SUMS matches every package", `wrong for ${wrong.join(", ")}`);
    const smoke = read(["bash", "release/smoke.sh", join(out, `overhand-${machine}`)]);
    need(smoke.ok, `the ${machine} package starts (release/smoke.sh)`, smoke.out.split("\n").slice(-3).join(" "));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function tag(): void {
  step(2, `Tag ${TAG}`);
  if (read(["git", "ls-remote", "--tags", "origin", `refs/tags/${TAG}`]).out) {
    done(`${TAG} is on origin`);
    return;
  }
  if (!read(["git", "rev-parse", "-q", "--verify", `refs/tags/${TAG}`]).ok) act(["git", "tag", "-a", TAG, "-m", TAG]);
  act(["git", "push", "origin", TAG]);
}

/** The release's file names, or [] before it exists. */
function assets(): string[] {
  const r = read(["gh", "release", "view", TAG, "-R", REPO, "--json", "assets", "-q", ".assets[].name"]);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}
/** Every file a release carries. */
const FILES = ["SHA256SUMS", ...PLATFORMS.map((p) => `overhand-${p}.tar.gz`)];

/** The release workflow's run for the tag (undefined until GitHub starts it). */
function releaseRun(): string | undefined {
  const sha = read(["git", "rev-parse", `${TAG}^{commit}`]).out;
  const runs = list<{ databaseId: number; headSha: string }>([
    "gh",
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    "release.yml",
    "-L",
    "10",
    "--json",
    "databaseId,headSha",
  ]);
  return runs.find((r) => r.headSha === sha)?.databaseId.toString();
}

async function release(): Promise<void> {
  step(3, "Wait for the release workflow");
  const want = FILES;
  if (want.every((a) => assets().includes(a))) {
    done(`release ${TAG} has every package`);
    return;
  }
  if (DRY) {
    console.log(`    would wait: gh run watch <release run for ${TAG}>, then check the release has ${want.join(", ")}`);
    return;
  }
  let run = releaseRun();
  for (let i = 0; !run && i < 24; i++) {
    await sleep(5000);
    run = releaseRun();
  }
  need(run !== undefined, "release workflow started", "no run after 2 minutes");
  // the npm job may still fail; step 7 checks it, so wait without --exit-status and check the release itself
  if (run) act(["gh", "run", "watch", run, "-R", REPO, "-i", "10"]);
  const missing = want.filter((a) => !assets().includes(a));
  need(!missing.length, `release ${TAG} published`, `missing ${missing.join(", ")}; see gh run view ${run} -R ${REPO} --log-failed`);
}

async function deploy(): Promise<void> {
  step(4, "Deploy the site and the installer");
  // both read REPO's releases (site/wrangler.jsonc, site/get/worker.ts): with the release there they show the
  // install box and serve the real installer, so this deploy is the whole "restore"
  // the installer first: the site's build asks it whether a release is out
  act(WRANGLER, join(ROOT, "site", "get"));
  act(WRANGLER, join(ROOT, "site"));
  if (DRY) {
    console.log(`    then check ${GET} serves the installer`);
    return;
  }
  const script = await (await fetch(GET)).text();
  // the installer's shape, not its first line's wording: a shell script that fetches Overhand's releases
  need(
    script.startsWith("#!/bin/sh") && script.includes("overhand-") && script.includes("SHA256SUMS"),
    `${GET} serves the installer`,
    script.slice(0, 120),
  );
}

function verifyInstall(): void {
  step(5, `Install from ${GET} into a scratch HOME`);
  if (DRY) {
    console.log(`    would run: curl -fsSL ${GET} | OVERHAND_NO_START=1 sh, then ~/.local/bin/overhand version = ${version}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "overhand-launch-"));
  try {
    const env = { HOME: home, OVERHAND_NO_START: "1" };
    need(read(["sh", "-c", `curl -fsSL ${GET} | sh`], ROOT, env).ok, "the installer runs");
    const got = read([join(home, ".local", "bin", "overhand"), "version"], ROOT, env).out;
    need(got === version, `installed version is ${version}`, `got ${got}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function npm(): void {
  step(6, "npm: npx overhand / bunx overhand");
  if (read(["npm", "view", `overhand@${version}`, "version"]).out !== version) {
    // the release workflow's npm job publishes it (.github/workflows/release.yml)
    if (DRY) {
      console.log(`    overhand@${version} isn't on npm yet; the release workflow's npm job publishes it`);
      return;
    }
    need(
      false,
      `overhand@${version} on npm`,
      `the release workflow's npm job didn't publish it; fix it, then gh run rerun ${releaseRun()} -R ${REPO} --failed`,
    );
  }
  if (DRY) {
    done(`overhand@${version} is on npm`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "overhand-npx-"));
  try {
    const got = read(["npx", "-y", `overhand@${version}`, "version"], home, { HOME: home })
      .out.split("\n")
      .pop();
    need(got === version, `npx overhand@${version} runs`, `got ${got}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function brew(): void {
  step(7, `Homebrew: ${TAP}`);
  if (read(["gh", "repo", "view", TAP, "--json", "visibility", "-q", ".visibility"]).out === "PUBLIC") done("tap already public");
  else act(["gh", "repo", "edit", TAP, "--visibility", "public", "--accept-visibility-change-consequences"]);
  const now = read(["gh", "api", `repos/${TAP}/contents/Formula/overhand.rb`, "-H", "Accept: application/vnd.github.raw"]);
  if (now.ok && now.out.includes(`/v${version}/`)) {
    done(`Formula/overhand.rb is at ${version}`);
    return;
  }
  if (DRY) {
    console.log(`    would write Formula/overhand.rb from ${TAG}'s SHA256SUMS (bun release/formula.ts) and push it to ${TAP}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "overhand-tap-"));
  try {
    act(["gh", "release", "download", TAG, "-R", REPO, "-p", "SHA256SUMS", "-D", dir]);
    const rb = formula(version, readFileSync(join(dir, "SHA256SUMS"), "utf8"));
    act(["gh", "repo", "clone", TAP, join(dir, "tap"), "--", "-q"]);
    act(["mkdir", "-p", join(dir, "tap", "Formula")]);
    writeFileSync(join(dir, "tap", "Formula", "overhand.rb"), rb);
    act(["git", "add", "Formula/overhand.rb"], join(dir, "tap"));
    act(["git", "commit", "-q", "-m", `feat: overhand ${version}`], join(dir, "tap"));
    act(["git", "push", "-q", "origin", "HEAD"], join(dir, "tap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function image(): void {
  step(8, `Docker image: ${IMAGE}`);
  const tag = `${IMAGE}:${version}`;
  if (read(["docker", "buildx", "imagetools", "inspect", tag]).ok) {
    done(`${tag} is on GHCR`);
    return;
  }
  // a builder of its own: Docker's default one can't build for two platforms at once
  if (!read(["docker", "buildx", "inspect", "overhand"]).ok)
    act(["docker", "buildx", "create", "--name", "overhand", "--driver", "docker-container"]);
  act(["sh", "-c", 'gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin']);
  act([
    "docker",
    "buildx",
    "build",
    "--builder",
    "overhand",
    "--platform",
    IMAGE_PLATFORMS.join(","),
    "-t",
    tag,
    "-t",
    `${IMAGE}:latest`,
    "--push",
    ".",
  ]);
  if (DRY) return;
  const pushed = read(["docker", "buildx", "imagetools", "inspect", tag]).out;
  const missing = IMAGE_PLATFORMS.filter((p) => !pushed.includes(p));
  need(!missing.length, `${tag} on GHCR for ${IMAGE_PLATFORMS.join(" and ")}`, `missing ${missing.join(", ")}`);
}

function announce(): void {
  step(9, "Announce");
  console.log(`
  Overhand ${TAG} is out: stop babysitting your coding agents.

    curl -fsSL ${GET} | sh
    brew install craftly-io/tap/overhand
    npx overhand start        (or bunx overhand start)

  Site and demo:  ${WWW}
`);
}

console.log(`Overhand release ${TAG}${DRY ? " (dry run: nothing changes)" : ""}, from ${machine}`);
try {
  preflight();
  tag();
  await release();
  await deploy();
  verifyInstall();
  npm();
  brew();
  image();
  announce();
  if (problems.length) {
    console.log(`Dry run: a real run would stop at preflight: ${problems.join("; ")}.`);
    process.exit(1);
  }
} catch (e) {
  console.error(
    `\n✗ ${e instanceof Error ? e.message : String(e)}\nFix it and run bun release/launch.ts again; finished steps are skipped.`,
  );
  process.exit(1);
}
