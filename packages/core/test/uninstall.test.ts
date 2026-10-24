/** `overhand uninstall`: what it removes and keeps. Only dry runs here, so the machine's own service is never touched. */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallService } from "../src/platform";
import { uninstallCli, uninstallPlan, type Where } from "../src/uninstall";

/** A scratch HOME laid out as the curl installer leaves it. */
function curlInstall(): Where {
  const home = mkdtempSync(join(tmpdir(), "overhand-uninstall-"));
  const ops = join(home, ".overhand");
  mkdirSync(join(ops, "releases", "abc"), { recursive: true });
  writeFileSync(join(ops, "releases", "abc", "overhand"), "");
  symlinkSync(join(ops, "releases", "abc"), join(ops, "app"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(ops, "app", "overhand"), join(home, ".local", "bin", "overhand"));
  return { home, ops, kind: "curl", src: join(ops, "app") };
}

test("uninstall removes the link, the app and its releases, and keeps the state folder unless asked", () => {
  const w = curlInstall();
  const { remove, keep } = uninstallPlan(false, w);
  expect(remove).toEqual([join(w.home, ".local", "bin", "overhand"), join(w.ops, "app"), join(w.ops, "releases")]);
  expect(keep[0]).toContain(`Your settings, history and logs in ${w.ops}`);
  expect(uninstallPlan(true, w).remove.at(-1)).toBe(w.ops);
});

test("uninstall leaves another program's overhand on PATH and a checkout's state folder alone", () => {
  const w = curlInstall();
  const other = join(w.home, ".local", "bin", "overhand.other");
  writeFileSync(other, "");
  const home = mkdtempSync(join(tmpdir(), "overhand-uninstall-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(other, join(home, ".local", "bin", "overhand"));
  const checkout: Where = { home, ops: join(home, "code", "overhand"), kind: "checkout", src: join(home, "code", "overhand") };
  const plan = uninstallPlan(true, checkout);
  expect(plan.remove).toEqual([]);
  expect(plan.keep.join("\n")).toContain(`The checkout at ${checkout.src}`);
  expect(uninstallPlan(false, { ...w, kind: "brew" }).keep).toContain("The Homebrew package: brew uninstall overhand");
});

test("uninstall --dry-run lists what it would remove and keep, and changes nothing", async () => {
  const w = curlInstall();
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    expect(await uninstallCli(["--dry-run", "--remove-data"], w)).toBe(0);
  } finally {
    console.log = log;
  }
  const out = lines.join("\n");
  expect(out).toContain("overhand uninstall would remove:");
  expect(out).toContain("The login service, so it doesn't start again");
  expect(out).toContain(`  ${w.ops}\n`);
  expect(out).toContain("and keep:");
  expect([existsSync(join(w.ops, "app")), existsSync(join(w.home, ".local", "bin", "overhand"))]).toEqual([true, true]);
});

test.skipIf(process.platform !== "linux")(
  "stopping on Linux removes the unit file, and the old ops.service a checkout's setup wrote",
  () => {
    // a systemctl that does what it's asked and reports the unit inactive afterwards
    const dir = mkdtempSync(join(tmpdir(), "overhand-units-"));
    writeFileSync(join(dir, "systemctl"), '#!/bin/sh\n[ "$2" = is-active ] && exit 3\nexit 0\n');
    chmodSync(join(dir, "systemctl"), 0o755);
    const units = join(dir, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    for (const u of ["overhand.service", "ops.service"]) writeFileSync(join(units, u), "");
    const path = process.env.PATH;
    process.env.PATH = [dir, path].join(":");
    try {
      expect(uninstallService(dir, join(dir, "logs")).ok).toBe(true);
    } finally {
      process.env.PATH = path;
    }
    expect([existsSync(join(units, "overhand.service")), existsSync(join(units, "ops.service"))]).toEqual([false, false]);
  },
);
