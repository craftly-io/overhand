/**
 * Builds Overhand's release packages: the dashboard once, then one single-file binary per platform
 * (`bun build --compile`), each packed with the dashboard beside it as overhand-<os>-<arch>.tar.gz, plus SHA-256 sums.
 * A Mac package also holds the menu bar item's helper when MENUBAR names its universal build (apps/menubar; the release
 * workflow builds it on a Mac).
 * Usage: bun release/build.ts [out-dir] [os-arch]   (default: release/out, every platform; the Dockerfile builds one)
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "release", "out"));
const ONLY = process.argv[3];
const MENUBAR = process.env.MENUBAR ? resolve(process.env.MENUBAR) : "";
const TARGETS = (
  [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ] as const
).filter(([os, arch]) => !ONLY || `${os}-${arch}` === ONLY);
if (!TARGETS.length) throw new Error(`no platform ${ONLY}: darwin-arm64, darwin-x64, linux-x64 or linux-arm64`);

function run(cmd: string[], cwd = ROOT): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

mkdirSync(OUT, { recursive: true });
run(["bun", "run", "build"], join(ROOT, "apps", "web"));
const sums: string[] = [];
for (const [os, arch] of TARGETS) {
  const name = `overhand-${os}-${arch}`;
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  // linux-x64 builds the baseline target: the default one needs AVX2, which pre-2013 CPUs and many VMs lack ("CPU lacks
  // AVX support, strange crashes may occur"). Bun's darwin-x64 baseline runtime is the same file as its default one.
  const target = `bun-${os}-${arch}${os === "linux" && arch === "x64" ? "-baseline" : ""}`;
  run(["bun", "build", "--compile", `--target=${target}`, "run.ts", "--outfile", join(dir, "overhand")]);
  cpSync(join(ROOT, "apps", "web", "dist"), join(dir, "web"), { recursive: true });
  const helper = os === "darwin" && MENUBAR ? ["overhand-menubar"] : [];
  if (helper.length) cpSync(MENUBAR, join(dir, "overhand-menubar"));
  const tar = `${name}.tar.gz`;
  // no xattrs: macOS tar adds its own (com.apple.provenance), which GNU tar warns about on every file
  run(["tar", "--no-xattrs", "-czf", tar, "-C", dir, "overhand", "web", ...helper], OUT);
  sums.push(`${new Bun.CryptoHasher("sha256").update(await Bun.file(join(OUT, tar)).arrayBuffer()).digest("hex")}  ${tar}`);
}
writeFileSync(join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Built ${TARGETS.length} packages in ${OUT}`);
