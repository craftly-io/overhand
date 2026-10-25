import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { shAsync, untilExit } from "../src/env";

// a first win's agent was done in 36 s, and its pull request never opened: a process it left running held the pipes
test("a command that exits but leaves a process holding its output returns within the grace, with what it printed", async () => {
  const started = Date.now();
  const r = await shAsync(["sh", "-c", "echo done; echo note >&2; sleep 30 &"], tmpdir());
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(r).toEqual({ ok: true, out: "done", err: "note" });
  const left = Bun.spawn(["sh", "-c", "echo partial; sleep 30 & exit 3"], { stdout: "pipe", stderr: "pipe" });
  const { texts, code } = await untilExit(left.exited, [left.stdout, left.stderr], 200);
  expect(texts).toEqual(["partial\n", ""]);
  expect(code).toBe(3);
});
