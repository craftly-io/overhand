import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    writeFileSync(join(pkg, "overhand"), `#!/bin/sh\necho ${[p, tag].filter(Boolean).join(" ")}\n`);
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
}

/** Writes an executable shell script. */
const script = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

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
  // output goes to a file, not a pipe: reading the pipes of a quickly exiting process can fail on Linux (EBADF, epoll_ctl)
  const log = join(mkdtempSync(join(tmpdir(), "overhand-install-log-")), "out");
  const p = Bun.spawn(["sh", "-c", 'sh "$0" >"$1" 2>&1', INSTALLER, log], {
    cwd: home,
    env: {
      PATH: [bin, process.env.PATH].join(":"),
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
