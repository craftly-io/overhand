import { expect, test } from "bun:test";
import { join } from "node:path";
import { ancestors, startOf } from "../src/control";
import { lstart, procInfo } from "../src/platform";
import { projectCommand } from "../src/sandbox";

const MAC = process.platform === "darwin";

test.skipIf(!MAC)("libproc tells a process's parent and start the way ps does", () => {
  const me = procInfo(process.pid);
  expect(me?.ppid).toBe(process.ppid);
  // the start reads in UTC, whatever zone a process was given: ps is asked in UTC too
  const env = { ...process.env, TZ: "UTC" };
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe", env })
    .stdout.toString()
    .trim();
  expect(lstart(me?.startSec ?? 0)).toBe(ps);
  expect(startOf(process.pid)).toBe(ps);
  expect(ancestors()[0]).toBe(process.ppid);
});

test.skipIf(!MAC)("inside the OS sandbox, where ps can't run, the guard still finds its run's process tree and start times", () => {
  const probe = [
    `import { ancestors, startOf } from ${JSON.stringify(join(import.meta.dir, "..", "src", "control"))};`,
    "const chain = ancestors();",
    "console.log(JSON.stringify({ chain: chain.length, start: startOf(chain[0] ?? 0) }));",
  ].join("\n");
  const st = { mode: "enforce", effective: "enforce", ok: true, why: "", refuse: false } as const;
  const box = projectCommand([process.execPath, "-e", probe], import.meta.dir, st, "app");
  const r = Bun.spawnSync(box.argv, { stdout: "pipe", stderr: "pipe" });
  box.done();
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const out = JSON.parse(r.stdout.toString()) as { chain: number; start: string };
  expect(out.chain).toBeGreaterThan(1);
  expect(out.start).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
});
