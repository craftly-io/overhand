/** Why a headless run gave no answer (claude.ts failureOf): each reason gets its own sentence and fix on the dashboard. */
import { expect, test } from "bun:test";
import { failureOf } from "../src/claude";

const run = (over: { text?: string; stdout?: string; stderr?: string; code?: number; timedOut?: boolean }) => ({
  out: { ok: false, text: over.text ?? "", structured: undefined, cost: 0, usage: null },
  stdout: over.stdout ?? "",
  stderr: over.stderr ?? "",
  code: over.code ?? 0,
  timedOut: over.timedOut ?? false,
});

test("a run with no answer says why: timed out, signed out, crashed, or output Overhand can't read", () => {
  expect(failureOf(run({ timedOut: true, code: 143 }))).toBe("timeout");
  expect(failureOf(run({ text: "OAuth token has expired. Please run /login", code: 1 }))).toBe("signed-out");
  expect(failureOf(run({ stdout: '{"type":"error","error":{"type":"authentication_error"}}' }))).toBe("signed-out");
  expect(failureOf(run({ stdout: '{"type":"system","subtype":"init"}', stderr: "TypeError: x is undefined", code: 1 }))).toBe("crashed");
  // exit 0 and no result Overhand recognises: the CLI changed how it reports
  expect(failureOf(run({ stdout: '{"type":"brand-new-event"}' }))).toBe("unreadable");
});
