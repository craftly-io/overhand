import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS } from "../src/env";
import { SIGN_IN_ENV } from "../src/sandbox";
import { previewCommand } from "../src/shots";

const st = (effective: "off" | "enforce", refuse = false) => ({ mode: effective, effective, ok: !refuse, why: "", refuse });

test("a preview command never gets your sign-ins, sandbox on or off", () => {
  const was = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "secret";
  try {
    const box = previewCommand("bun run dev", tmpdir(), "app", st("off"));
    expect(box.argv).toEqual(["sh", "-c", "bun run dev"]);
    for (const k of SIGN_IN_ENV) expect(box.env[k]).toBeUndefined();
    expect(box.env.PATH).toBe(process.env.PATH ?? "");
    expect(previewCommand("bun run dev", tmpdir(), "app", st("enforce", true)).argv).toEqual(["false"]);
  } finally {
    if (was === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = was;
  }
});

test.skipIf(process.platform !== "darwin")("a preview command runs under its project's sandbox: its folder, not Overhand's files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "overhand-shots-"));
  const box = previewCommand(`echo x > ${join(cwd, "ok")}; echo x > ${join(OPS, "overhand.config.json")}`, cwd, "app", st("enforce"));
  expect(box.argv[0]).toBe("/usr/bin/sandbox-exec");
  const r = Bun.spawnSync(box.argv, { cwd, env: box.env, stderr: "pipe" });
  box.done();
  expect(existsSync(join(cwd, "ok"))).toBe(true);
  expect(r.exitCode).not.toBe(0);
});
