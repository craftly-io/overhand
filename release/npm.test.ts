import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_SIGNER } from "../packages/contract/src/links";

const LAUNCHER = join(import.meta.dir, "npm", "bin", "overhand.js");
const { version } = JSON.parse(readFileSync(join(import.meta.dir, "npm", "package.json"), "utf8"));
const PKG = `overhand-${process.platform}-${process.arch}.tar.gz`;

/** Writes an executable shell script. */
const script = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A scratch release for this machine: a package whose `overhand` prints "ran", its SHA256SUMS, and a signature file. */
function fakeRelease(signed = true): string {
  const dir = mkdtempSync(join(tmpdir(), "overhand-npm-release-"));
  const pkg = join(dir, "pkg");
  mkdirSync(pkg);
  script(join(pkg, "overhand"), "echo ran");
  Bun.spawnSync(["tar", "-czf", join(dir, PKG), "-C", pkg, "overhand"]);
  const sha = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, PKG))).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${sha}  ${PKG}\n`);
  if (signed) writeFileSync(join(dir, "SHA256SUMS.sigstore.json"), "{}");
  return dir;
}

/** A PATH with only node, tar and gzip on it, plus the `fakes` (each a shell script's body). */
function machine(fakes: Record<string, string>): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "overhand-npm-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const name of ["node", "tar", "gzip"]) {
    const at = Bun.which(name);
    if (at) symlinkSync(at, join(bin, name));
  }
  for (const [name, body] of Object.entries(fakes)) script(join(bin, name), body);
  return { home, path: bin };
}

/** Runs `npx overhand` against `release`, served over HTTP from this process. */
async function launch(release: string, fakes: Record<string, string> = {}): Promise<{ code: number; out: string; home: string }> {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const file = join(release, new URL(req.url).pathname);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("", { status: 404 });
    },
  });
  const { home, path } = machine(fakes);
  const p = Bun.spawn(["node", LAUNCHER, "version"], {
    env: { HOME: home, PATH: path, OVERHAND_DOWNLOAD: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  server.stop(true);
  return { code, out: `${out}${err}`, home };
}

/** A stand-in cosign that says its version, logs what it was asked and answers `verdict`. */
const cosign = (verdict: number, version = "v2.5.3") => ({
  cosign: `[ "$1" = version ] && { echo "GitVersion:    ${version}"; exit 0; }; echo "$*" >>"$HOME/cosign.log"; exit ${verdict}`,
});
const installed = (home: string): boolean => existsSync(join(home, ".overhand", "npm", version, "overhand"));

test.skipIf(!Bun.which("node"))(
  "npx overhand: with cosign 2.5+ SHA256SUMS must carry the release workflow's signature; older or none, the checksum alone",
  async () => {
    const release = fakeRelease();
    const ok = await launch(release, cosign(0));
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("signature verified (Sigstore)");
    expect(ok.out).toContain("ran");
    const args = readFileSync(join(ok.home, "cosign.log"), "utf8");
    expect(args).toStartWith("verify-blob --bundle ");
    expect(args).toContain(`--certificate-identity-regexp ${RELEASE_SIGNER} `);
    expect(args).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
    expect(args.trim()).toEndWith("/SHA256SUMS");

    // a signature that isn't the release workflow's: refused, nothing unpacked
    const bad = await launch(release, cosign(1));
    expect([bad.code, bad.out.includes("SHA256SUMS isn't signed by Overhand's release workflow; not installing.")]).toEqual([1, true]);
    expect(installed(bad.home)).toBe(false);

    // no signature in the release at all: refused too
    const unsigned = await launch(fakeRelease(false), cosign(0));
    expect([unsigned.code, unsigned.out.includes("SHA256SUMS.sigstore.json (404)")]).toEqual([1, true]);
    expect(installed(unsigned.home)).toBe(false);

    // a cosign older than 2.5 can't read the signature's format: skipped with the installer's own line
    const old = await launch(release, cosign(1, "v2.4.1"));
    expect(old.code, old.out).toBe(0);
    const line = readFileSync(join(import.meta.dir, "install.sh"), "utf8").match(/step "(cosign here is older than 2\.5[^"]+)"/)?.[1];
    expect(line).toBeTruthy();
    expect(old.out).toContain(`overhand: ${line}\n`);
    expect(existsSync(join(old.home, "cosign.log"))).toBe(false);
    expect((await launch(release, cosign(0, "v3.1.4"))).out).toContain("signature verified (Sigstore)");

    // no cosign: the checksum alone, which still refuses a package that doesn't match
    const plain = await launch(fakeRelease(false));
    expect([plain.code, plain.out.includes("signature verified")]).toEqual([0, false]);
    const tampered = fakeRelease(false);
    writeFileSync(join(tampered, "SHA256SUMS"), `${"0".repeat(64)}  ${PKG}\n`);
    expect((await launch(tampered)).out).toContain(`checksum mismatch for ${PKG}; not installing.`);
  },
  30_000,
);

test("the signer the launcher trusts is the installer's and the contract's", () => {
  const signer = readFileSync(LAUNCHER, "utf8").match(/^const SIGNER = "(.+)";$/m)?.[1] ?? "";
  expect(signer.replaceAll("\\\\", "\\")).toBe(RELEASE_SIGNER);
});
