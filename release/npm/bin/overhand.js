#!/usr/bin/env node
// `npx overhand` / `bunx overhand`: on first run downloads this version's release package for the machine (the same file
// the curl installer gets), checks its SHA-256 against the release's SHA256SUMS (and, with cosign 2.5 or newer
// installed, the release workflow's signature on SHA256SUMS, as the installer does), unpacks it into
// ~/.overhand/npm/<version>, then runs it with the given arguments. It downloads here rather than in a postinstall
// script because bunx skips those. OVERHAND_DOWNLOAD points at another copy of the release files.
// ~/.overhand/npm/current links to the newest version fetched; the login service runs it from there.
// ponytail: older versions stay in ~/.overhand/npm; prune if anyone asks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const os = { darwin: "darwin", linux: "linux" }[process.platform];
const arch = { arm64: "arm64", x64: "x64" }[process.arch];
const home = join(homedir(), ".overhand");
const dir = join(home, "npm", version);
const bin = join(dir, "overhand");
// who signs a release's SHA256SUMS (RELEASE_SIGNER in packages/contract/src/links.ts): this repository's release
// workflow, run for a version tag, which only an admin can push
const SIGNER = "^https://github\\.com/craftly-io/overhand/\\.github/workflows/release\\.yml@refs/tags/v";

/** Prints why and exits non-zero. */
function fail(message) {
  console.error(`overhand: ${message}`);
  process.exit(1);
}

/** Fetches one release file, failing with its URL when it doesn't answer 200. */
async function get(url) {
  const r = await fetch(url).catch(() => undefined);
  if (!r?.ok) fail(`download failed: ${url}${r ? ` (${r.status})` : ""}`);
  return Buffer.from(await r.arrayBuffer());
}

/** True when cosign on PATH is 2.5 or newer, which reads the release's signature; null when there's no cosign. */
function cosignReads() {
  const r = spawnSync("cosign", ["version"], { encoding: "utf8" });
  if (r.error) return null;
  const [, major, minor] = (r.stdout ?? "").match(/^GitVersion:\D*(\d+)\.(\d+)/m) ?? [];
  return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 5);
}

/**
 * With cosign 2.5 or newer installed, SHA256SUMS must carry the release workflow's signature (SIGNER), or nothing
 * installs; an older cosign can't read the signature's format (it fails on every release), so it's skipped and said,
 * and only the checksum is checked, as without cosign.
 */
async function checkSignature(base, sums) {
  const reads = cosignReads();
  if (reads === null) return;
  if (!reads) {
    console.error(
      "overhand: cosign here is older than 2.5 and can't read the release's signature; checking the checksum only (update cosign to check it)",
    );
    return;
  }
  const bundle = await get(`${base}/SHA256SUMS.sigstore.json`);
  const at = mkdtempSync(join(tmpdir(), "overhand-sums-"));
  writeFileSync(join(at, "SHA256SUMS"), sums);
  writeFileSync(join(at, "SHA256SUMS.sigstore.json"), bundle);
  const v = spawnSync(
    "cosign",
    [
      "verify-blob",
      "--bundle",
      join(at, "SHA256SUMS.sigstore.json"),
      "--certificate-identity-regexp",
      SIGNER,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      join(at, "SHA256SUMS"),
    ],
    { encoding: "utf8" },
  );
  rmSync(at, { recursive: true, force: true });
  if (v.status !== 0) {
    process.stderr.write(`${v.stdout ?? ""}${v.stderr ?? ""}`);
    fail("SHA256SUMS isn't signed by Overhand's release workflow; not installing.");
  }
  console.error("overhand: signature verified (Sigstore)");
}

if (!os || !arch) fail(`there's no Overhand build for ${process.platform}/${process.arch}; it runs on macOS and Linux.`);
if (!existsSync(bin)) {
  const pkg = `overhand-${os}-${arch}.tar.gz`;
  const base = process.env.OVERHAND_DOWNLOAD ?? `https://get.overhand.dev/download/v${version}`;
  console.error(`overhand: downloading ${pkg} (v${version}), once`);
  const [tar, sums] = await Promise.all([get(`${base}/${pkg}`), get(`${base}/SHA256SUMS`)]);
  await checkSignature(base, sums);
  const want = sums
    .toString()
    .split("\n")
    .find((l) => l.endsWith(`  ${pkg}`))
    ?.split(" ")[0];
  if (!want || want !== createHash("sha256").update(tar).digest("hex")) fail(`checksum mismatch for ${pkg}; not installing.`);
  // unpack beside the target and rename, so a half-written folder never looks installed
  const tmp = `${dir}.${process.pid}`;
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, pkg), tar);
  const x = spawnSync("tar", ["-xzf", pkg], { cwd: tmp, stdio: "inherit" });
  rmSync(join(tmp, pkg));
  if (x.status !== 0) fail("couldn't unpack the package (is tar installed?)");
  if (existsSync(bin)) rmSync(tmp, { recursive: true });
  else renameSync(tmp, dir);
}
// the login service runs npm/current/overhand, so it moves on to the newest version any run fetched (and never back
// to an older one run by name); the daemon notices and restarts on it
const current = join(home, "npm", "current");
let at = "";
try {
  at = readlinkSync(current);
} catch {}
if (!at || version.localeCompare(at, undefined, { numeric: true }) > 0) {
  const link = `${current}.${process.pid}`;
  symlinkSync(version, link);
  renameSync(link, current); // replaces the old link in one step
}
const run = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(run.status ?? 1);
