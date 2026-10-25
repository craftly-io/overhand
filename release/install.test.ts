import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_SIGNER, REPO } from "../packages/contract/src/links";

const INSTALLER = join(import.meta.dir, "install.sh");
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const sha = (file: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

/** A scratch release: per platform, a package whose `overhand` prints that platform (and `tag`), plus SHA256SUMS. */
function fakeRelease(tag = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "overhand-release-"));
  const sums = PLATFORMS.map((p) => {
    const pkg = join(dir, p);
    mkdirSync(join(pkg, "web"), { recursive: true });
    writeFileSync(join(pkg, "web", "index.html"), "");
    // `start` says what the real one says on a desktop, where it opens the browser
    const opened = 'echo "Overhand is running. Opened http://127.0.0.1:4317 to set it up."';
    writeFileSync(join(pkg, "overhand"), `#!/bin/sh\n[ "$1" = start ] && ${opened}\necho ${[p, tag].filter(Boolean).join(" ")}\n`);
    chmodSync(join(pkg, "overhand"), 0o755);
    const tar = `overhand-${p}.tar.gz`;
    Bun.spawnSync(["tar", "-czf", join(dir, tar), "-C", pkg, "overhand", "web"]);
    return `${sha(join(dir, tar))}  ${tar}`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

interface Machine {
  /** A HOME to install into again (an update); a new scratch one when left out. */
  home?: string;
  /** What `sysctl -n sysctl.proc_translated` prints: "1" in a Rosetta terminal. */
  translated?: string;
  /** What `ldd --version` prints: musl's on Alpine. */
  ldd?: string;
  env?: Record<string, string>;
  /** Only the tools the installer needs on PATH, and none of gh, brew, apt-get, dnf or sudo but the `fakes`. */
  bare?: boolean;
  /** More fake commands, by name: each a shell script's body. */
  fakes?: Record<string, string>;
}

/** Writes an executable shell script. */
const script = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A folder of links to the plain tools the installer runs, for a PATH with nothing else on it. */
const TOOLS = (() => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-tools-"));
  const names =
    "sh cat chmod cp curl cut dirname basename grep gzip head ln ls mkdir mktemp mv readlink rm sed shasum sha256sum sleep tar touch tr unzip wc";
  for (const name of names.split(" ")) {
    const at = Bun.which(name);
    if (at) symlinkSync(at, join(dir, name));
  }
  return dir;
})();

/**
 * Runs the installer as a machine whose `uname -s` and `uname -m` say `os` and `machine` (and whose sysctl and ldd say
 * what `m` gives), in a scratch HOME. Async, so a server in this process can answer it.
 */
async function install(
  release: string,
  os: string,
  machine: string,
  m: Machine = {},
): Promise<{ code: number; out: string; home: string }> {
  const home = m.home ?? mkdtempSync(join(tmpdir(), "overhand-install-"));
  const bin = join(home, "fakebin");
  mkdirSync(bin, { recursive: true });
  script(join(bin, "uname"), `case "$1" in -s) echo ${os} ;; -m) echo ${machine} ;; esac`);
  script(join(bin, "sysctl"), `echo ${m.translated ?? "0"}`);
  script(join(bin, "ldd"), `echo '${m.ldd ?? "ldd (GNU libc) 2.36"}'`);
  // gh is there unless the machine is bare; not root, so installing it takes sudo
  const fakes = m.bare ? { id: 'case "$1" in -u) echo 1000 ;; *) echo tester ;; esac', ...m.fakes } : { gh: "exit 0", ...m.fakes };
  for (const [name, body] of Object.entries(fakes)) script(join(bin, name), body);
  // output goes to a file, not a pipe: reading the pipes of a quickly exiting process can fail on Linux (EBADF, epoll_ctl)
  const log = join(mkdtempSync(join(tmpdir(), "overhand-install-log-")), "out");
  const p = Bun.spawn(["/bin/sh", "-c", 'sh "$0" >"$1" 2>&1', INSTALLER, log], {
    cwd: home,
    env: {
      PATH: [bin, m.bare ? TOOLS : process.env.PATH].join(":"),
      HOME: home,
      OVERHAND_DOWNLOAD: `file://${release}`,
      OVERHAND_NO_START: "1",
      NO_COLOR: "1",
      ...m.env,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = await p.exited;
  return { code, out: readFileSync(log, "utf8"), home };
}

/** What the installed `overhand` prints (the fake package's platform). */
const installed = (home: string): string =>
  Bun.spawnSync([join(home, ".local", "bin", "overhand")])
    .stdout.toString()
    .trim();

test("the installer installs the package for each OS and CPU name uname reports, and the arm64 one under Rosetta", async () => {
  const release = fakeRelease();
  for (const [os, machine, want, translated] of [
    ["Darwin", "arm64", "darwin-arm64", "0"],
    ["Darwin", "x86_64", "darwin-x64", "0"],
    ["Darwin", "x86_64", "darwin-arm64", "1"], // a Rosetta terminal on Apple silicon
    ["Linux", "aarch64", "linux-arm64", "0"],
    ["Linux", "arm64", "linux-arm64", "0"],
    ["Linux", "x86_64", "linux-x64", "0"],
    ["Linux", "amd64", "linux-x64", "0"],
  ] as const) {
    const r = await install(release, os, machine, { translated });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Checksum verified");
    expect(installed(r.home), `${os} ${machine}`).toBe(want);
  }
}, 30_000); // seven installer runs (curl, tar, a checksum each) outlast the 5 s default under the full suite

test("the installer refuses other systems and CPUs, musl Linux, and a package whose checksum doesn't match", async () => {
  const release = fakeRelease();
  expect((await install(release, "FreeBSD", "amd64")).out).toContain("Overhand runs on macOS and Linux");
  expect((await install(release, "Linux", "i686")).out).toContain("No Overhand build for i686");
  const alpine = await install(release, "Linux", "x86_64", { ldd: "musl libc (x86_64) Version 1.2.4" });
  expect([alpine.code, alpine.out.includes("This Linux uses musl")]).toEqual([1, true]);
  expect(existsSync(join(alpine.home, ".overhand"))).toBe(false);
  writeFileSync(join(release, "overhand-linux-x64.tar.gz"), "tampered");
  const r = await install(release, "Linux", "x86_64");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("Checksum mismatch");
}, 30_000);

test("offline, the installer exits 1 with a plain message and changes nothing", async () => {
  const first = await install(fakeRelease(), "Linux", "x86_64");
  const r = await install("", "Linux", "x86_64", { home: first.home, env: { OVERHAND_DOWNLOAD: "http://127.0.0.1:1" } });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Download failed: http://127.0.0.1:1/overhand-linux-x64.tar.gz. The installed Overhand is unchanged.");
  expect(installed(first.home)).toBe("linux-x64");
});

test("downloads are HTTPS only: a plain-http mirror that isn't this machine fails closed", async () => {
  const r = await install("", "Linux", "x86_64", { env: { OVERHAND_DOWNLOAD: "http://mirror.invalid/overhand" } });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Download failed: http://mirror.invalid/overhand/overhand-linux-x64.tar.gz.");
  expect(r.out).toMatch(/[Pp]rotocol "?http"?.*(disabled|not supported)/); // curl's own words, which vary by version
});

test("with cosign installed, SHA256SUMS must carry the release workflow's signature; without it, the checksum alone", async () => {
  const release = fakeRelease();
  writeFileSync(join(release, "SHA256SUMS.sigstore.json"), "{}");
  // a stand-in cosign that says its version, logs what it was asked and answers `verdict`
  const cosign = (verdict: number, version = "v2.5.3") => ({
    cosign: `[ "$1" = version ] && { echo "GitVersion:    ${version}"; exit 0; }; echo "$*" >>"$HOME/cosign.log"; exit ${verdict}`,
  });
  const ok = await install(release, "Linux", "x86_64", { fakes: cosign(0) });
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain("Signature verified (Sigstore)");
  const args = log(ok.home, "cosign.log");
  expect(args).toStartWith("verify-blob --bundle ");
  expect(args).toContain(`--certificate-identity-regexp ^https://github\\.com/${REPO}/`);
  expect(args).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
  expect(args.trim()).toEndWith("/SHA256SUMS");

  const bad = await install(release, "Linux", "x86_64", { fakes: cosign(1) });
  expect([bad.code, bad.out.includes("SHA256SUMS isn't signed by Overhand's release workflow; not installing.")]).toEqual([1, true]);
  expect(existsSync(join(bad.home, ".overhand"))).toBe(false);

  const unsigned = await install(fakeRelease(), "Linux", "x86_64", { fakes: cosign(0) });
  expect(unsigned.code).toBe(1);
  expect(unsigned.out).toContain("Couldn't fetch the release's signature (SHA256SUMS.sigstore.json); not installing.");

  // a cosign older than 2.5 can't read the signature's format: skipped and said, the checksum still checked
  const old = await install(release, "Linux", "x86_64", { fakes: cosign(1, "v2.4.1") });
  expect(old.code, old.out).toBe(0);
  expect(old.out).toContain("older than 2.5");
  expect(existsSync(join(old.home, "cosign.log"))).toBe(false);
  expect((await install(release, "Linux", "x86_64", { fakes: cosign(0, "v3.1.4") })).out).toContain("Signature verified (Sigstore)");

  // no cosign: no signature is asked for
  const plain = await install(fakeRelease(), "Linux", "x86_64", { bare: true });
  expect([plain.code, plain.out.includes("Signature verified")]).toEqual([0, false]);
}, 30_000);

test("the signer the installer trusts is this repository's release workflow, run for a version tag", () => {
  const signer = readFileSync(INSTALLER, "utf8").match(/^SIGNER='(.+)'$/m)?.[1] ?? "";
  expect(signer).toBe(RELEASE_SIGNER);
  const at = (ref: string, file = "release.yml") => `https://github.com/${REPO}/.github/workflows/${file}@${ref}`;
  expect(new RegExp(signer).test(at("refs/tags/v0.0.2"))).toBe(true);
  expect(new RegExp(signer).test(at("refs/heads/main"))).toBe(false);
  expect(new RegExp(signer).test(at("refs/tags/v0.0.2", "ci.yml"))).toBe(false);
  expect(new RegExp(signer).test(`https://github.com/someone/overhand/.github/workflows/release.yml@refs/tags/v1.0.0`)).toBe(false);
  // the release workflow signs and checks with the same rule
  expect(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8")).toContain(
    "/\\.github/workflows/release\\.yml@refs/tags/v",
  );
});

test("a download cut off part way runs nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "overhand-install-"));
  const half = readFileSync(INSTALLER, "utf8").slice(0, 3000);
  const r = Bun.spawnSync(["sh"], { stdin: Buffer.from(half), env: { PATH: process.env.PATH ?? "", HOME: home } });
  expect(r.exitCode).not.toBe(0); // the function is never closed, so sh stops before calling it
  expect(readdirSync(home)).toEqual([]);
});

test("running the installer again swaps in the new version whole, keeps the one before, and a broken package changes nothing", async () => {
  const first = await install(fakeRelease("v1"), "Linux", "x86_64");
  const app = join(first.home, ".overhand", "app");
  expect(lstatSync(app).isSymbolicLink()).toBe(true);
  for (const tag of ["v2", "v3"]) {
    const r = await install(fakeRelease(tag), "Linux", "x86_64", { home: first.home });
    expect(r.code, r.out).toBe(0);
    expect(installed(first.home)).toBe(`linux-x64 ${tag}`);
  }
  expect(readdirSync(join(first.home, ".overhand", "releases")).length).toBe(2); // v3, and v2 that may still be running

  // a package that passes its checksum but doesn't unpack: the old install stays as it was, and no half folder is left
  const broken = fakeRelease("v4");
  writeFileSync(join(broken, "overhand-linux-x64.tar.gz"), "not a tarball");
  writeFileSync(join(broken, "SHA256SUMS"), `${sha(join(broken, "overhand-linux-x64.tar.gz"))}  overhand-linux-x64.tar.gz\n`);
  const r = await install(broken, "Linux", "x86_64", { home: first.home });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Couldn't unpack overhand-linux-x64.tar.gz; the installed Overhand is unchanged.");
  expect(installed(first.home)).toBe("linux-x64 v3");
  expect(readdirSync(join(first.home, ".overhand", "releases")).filter((d) => d.endsWith(".part"))).toEqual([]);
}, 30_000);

test("an install from before releases/ moves aside for the link, kept as the previous version", async () => {
  const home = mkdtempSync(join(tmpdir(), "overhand-install-"));
  mkdirSync(join(home, ".overhand", "app"), { recursive: true });
  script(join(home, ".overhand", "app", "overhand"), "echo old");
  const r = await install(fakeRelease("v2"), "Darwin", "arm64", { home });
  expect(r.code, r.out).toBe(0);
  expect(installed(home)).toBe("darwin-arm64 v2");
  expect(readFileSync(join(home, ".overhand", "releases", "previous", "overhand"), "utf8")).toContain("echo old");
});

test("rerun while Overhand runs, the installer leaves the restart to it rather than starting a second copy", async () => {
  const first = await install(fakeRelease("v1"), "Darwin", "arm64");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const r = await install(fakeRelease("v2"), "Darwin", "arm64", {
      home: first.home,
      env: { OVERHAND_NO_START: "", OVERHAND_PORT: String(server.port) },
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("The running Overhand restarts on it once no agent is running.");
    expect(r.out).not.toContain("Started");
  } finally {
    server.stop(true);
  }
});

test("for overhand update, the installer stops after its install lines: no Start it with box, no notes", async () => {
  const r = await install(fakeRelease(), "Linux", "x86_64", { env: { OVERHAND_QUIET: "1" } });
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("Installed Overhand");
  expect(r.out).not.toContain("Start it with");
  expect(r.out).not.toContain("isn't installed yet");
  // and leaves gh and the shell's startup files alone
  const quiet = await install(fakeRelease(), "Darwin", "arm64", {
    bare: true,
    fakes: { brew: 'echo "$*" >>"$HOME/brew.log"' },
    env: { OVERHAND_QUIET: "1", SHELL: "/bin/zsh" },
  });
  expect(readdirSync(quiet.home).sort()).toEqual([".local", ".overhand", "fakebin"]);
});

test("started on a server with no display, the installer ends with the one SSH tunnel that opens it", async () => {
  const env = { OVERHAND_NO_START: "", OVERHAND_PORT: "4399", DISPLAY: "", WAYLAND_DISPLAY: "" };
  const ssh = await install(fakeRelease(), "Linux", "x86_64", { env: { ...env, SSH_CONNECTION: "10.0.0.5 50000 203.0.113.7 22" } });
  expect(ssh.code, ssh.out).toBe(0);
  expect(ssh.out).toMatch(/ssh -N -L 4399:127\.0\.0\.1:4399 \S+@203\.0\.113\.7\n/);
  expect(ssh.out).toContain("overhand open");
  // a container: no SSH session to name the server by
  const container = await install(fakeRelease(), "Linux", "x86_64", { env });
  expect(container.out).toContain("ssh -N -L 4399:127.0.0.1:4399 you@your-server");
  // a desktop opens it itself
  const desktop = await install(fakeRelease(), "Linux", "x86_64", { env: { ...env, DISPLAY: ":0" } });
  expect(desktop.out).not.toContain("ssh -N");
  expect(desktop.out).toContain("It's open in your browser: finish setting up there.");
});

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH" # added by Overhand';

test("the installer puts ~/.local/bin on PATH in the shell's own startup file, once, and says so", async () => {
  const release = fakeRelease();
  for (const [os, shell, file, line] of [
    ["Darwin", "/bin/zsh", ".zshrc", PATH_LINE],
    ["Darwin", "/bin/bash", ".bash_profile", PATH_LINE],
    ["Linux", "/bin/bash", ".bashrc", PATH_LINE],
    ["Linux", "/usr/bin/fish", ".config/fish/config.fish", "fish_add_path $HOME/.local/bin # added by Overhand"],
    ["Linux", "", ".profile", PATH_LINE],
  ] as const) {
    const first = await install(release, os, "arm64", { env: { SHELL: shell } });
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain(`Added ~/.local/bin to your PATH in ~/${file}: new terminals find overhand`);
    expect(first.out).not.toContain("isn't on your PATH");
    // this terminal's PATH is as it was, so what it's told to run goes by the full path
    expect(first.out).toContain("Start it with: ~/.local/bin/overhand start");
    const again = await install(release, os, "arm64", { home: first.home, env: { SHELL: shell } });
    expect(again.out).not.toContain("Added ~/.local/bin");
    expect(readFileSync(join(first.home, file), "utf8")).toBe(`\n${line}\n`);
  }
}, 30_000);

test("a startup file that already sets ~/.local/bin is left alone, and OVERHAND_NO_PATH=1 edits none", async () => {
  const release = fakeRelease();
  const home = mkdtempSync(join(tmpdir(), "overhand-install-"));
  writeFileSync(join(home, ".zshrc"), "path+=(~/.local/bin)\n");
  const r = await install(release, "Darwin", "arm64", { home, env: { SHELL: "/bin/zsh" } });
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("path+=(~/.local/bin)\n");

  const ci = await install(release, "Darwin", "arm64", { env: { SHELL: "/bin/zsh", OVERHAND_NO_PATH: "1" } });
  expect(existsSync(join(ci.home, ".zshrc"))).toBe(false);
  expect(ci.out).toContain("~/.local/bin isn't on your PATH. Add this line to ~/.zshrc, then open a new terminal:");
});

/** A fake sudo that keeps what it was asked to run in ~/sudo.log; `password` makes it refuse to run without asking. */
const sudo = (password = false) =>
  password ? 'echo "$*" >>"$HOME/sudo.log"; exit 1' : 'echo "$*" >>"$HOME/sudo.log"; [ "$1 $2" = "-n true" ] || touch "$HOME/fakebin/gh"';
const log = (home: string, name: string): string => (existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : "");

test("with gh missing, the installer installs it the vendor's way for the machine, and leaves one that's there", async () => {
  const release = fakeRelease();
  // there already: nothing runs
  const there = await install(release, "Darwin", "arm64", { fakes: { brew: 'echo "$*" >>"$HOME/brew.log"' } });
  expect([there.out.includes("Installed GitHub's command tool"), log(there.home, "brew.log")]).toEqual([false, ""]);

  // a Mac with Homebrew
  const mac = await install(release, "Darwin", "arm64", { bare: true, fakes: { brew: 'echo "$*" >>"$HOME/brew.log"' } });
  expect(mac.code, mac.out).toBe(0);
  expect(log(mac.home, "brew.log")).toBe("install gh\n");
  expect(mac.out).toContain("Installed GitHub's command tool (gh)");

  // Debian or Ubuntu: GitHub's apt repository, as root through sudo that asks nothing
  const apt = await install(release, "Linux", "x86_64", { bare: true, fakes: { "apt-get": "exit 0", sudo: sudo() } });
  expect(apt.code, apt.out).toBe(0);
  const ran = log(apt.home, "sudo.log").split("\n")[1] ?? "";
  expect(ran).toStartWith("-n sh -c mkdir -p -m 755 /etc/apt/keyrings");
  expect(ran).toContain("https://cli.github.com/packages stable main");
  expect(ran).toEndWith("apt-get install -y gh");
  expect(apt.out).toContain("Installed GitHub's command tool (gh)");

  // Fedora: GitHub's dnf repository
  const dnf = await install(release, "Linux", "arm64", { bare: true, fakes: { dnf: "exit 0", sudo: sudo() } });
  expect(log(dnf.home, "sudo.log")).toContain("gh-cli.repo && dnf install -y gh --repo gh-cli");

  // sudo would ask for a password, which no one can type into a piped script: the one command, and the install goes on
  const asks = await install(release, "Linux", "x86_64", { bare: true, fakes: { "apt-get": "exit 0", sudo: sudo(true) } });
  expect(asks.code, asks.out).toBe(0);
  expect(asks.out).toContain(
    "GitHub's command tool (gh) needs an administrator to install. Run this, and the setup page goes on by itself:",
  );
  expect(asks.out).toMatch(/ {4}sudo sh -c 'mkdir -p -m 755 \/etc\/apt\/keyrings .*apt-get install -y gh'\n/);
  expect(log(asks.home, "sudo.log")).toBe("-n true\n");

  // no package manager it knows: the setup page has the rest
  const other = await install(release, "Linux", "x86_64", { bare: true });
  expect(other.out).toContain("gh isn't installed yet; the setup page shows how to get it.");
}, 30_000);

test.skipIf(!Bun.which("zip"))("a Mac without Homebrew gets GitHub's own build of gh, checked against its checksums", async () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-gh-release-"));
  const name = "gh_9.9.9_macOS_arm64";
  mkdirSync(join(dir, name, "bin"), { recursive: true });
  script(join(dir, name, "bin", "gh"), "echo gh version 9.9.9");
  Bun.spawnSync(["zip", "-qr", `${name}.zip`, name], { cwd: dir });
  const sums = { good: `${sha(join(dir, `${name}.zip`))}  ${name}.zip\n`, bad: `${"0".repeat(64)}  ${name}.zip\n` };
  let want: keyof typeof sums = "good";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/latest") return new Response(null, { status: 302, headers: { Location: "/tag/v9.9.9" } });
      if (path === "/tag/v9.9.9") return new Response("ok");
      if (path === `/download/v9.9.9/${name}.zip`) return new Response(Bun.file(join(dir, `${name}.zip`)));
      if (path === "/download/v9.9.9/gh_9.9.9_checksums.txt") return new Response(sums[want]);
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const env = { OVERHAND_GH_DOWNLOAD: `http://127.0.0.1:${server.port}` };
    const r = await install(fakeRelease(), "Darwin", "arm64", { bare: true, env });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Installed GitHub's command tool (gh)");
    expect(Bun.spawnSync([join(r.home, ".local", "bin", "gh")]).stdout.toString()).toBe("gh version 9.9.9\n");
    want = "bad";
    const tampered = await install(fakeRelease(), "Darwin", "arm64", { bare: true, env });
    expect(existsSync(join(tampered.home, ".local", "bin", "gh"))).toBe(false);
    expect(tampered.out).toContain("gh isn't installed yet");
  } finally {
    server.stop(true);
  }
});
