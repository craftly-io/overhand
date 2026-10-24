import { expect, test } from "bun:test";
import { beats, parseLine, restarts } from "./beats";

test("log lines become sentences, and chatter is dropped", () => {
  expect(parseLine("⚡ Ops lead started headless (pid 10128, work)")?.text).toBe("Ops lead woke up on work");
  expect(parseLine("⚡ Ops lead exited (while Overhand was restarting) after 43 min")?.tone).toBe("warn");
  expect(parseLine("⚡ PLAN exited (code 1) after 3 min")).toMatchObject({ text: "PLAN failed after 3 min", tone: "bad" });
  // a sandboxed lead's exit carries notes after its code: still a failure, or a finish
  expect(parseLine("⚡ Core exited (code 1, sandboxed, 2 sandbox refusals) after 1 min")).toMatchObject({
    text: "Core failed after 1 min",
    tone: "bad",
  });
  expect(parseLine("⚡ Research exited (0, sandboxed) after 1 min")).toMatchObject({
    text: "Research finished after 1 min",
    tone: "quiet",
  });
  expect(parseLine("💬 answered Bluekite lead")?.text).toBe("You answered Bluekite lead");
  expect(parseLine("📥 inbox: 1 items (personal, $0.12)")?.text).toBe("Slack checked: 1 new item");
  expect(parseLine('🌐 new AI word "Herding digital cats" (Gemini CLI latest): herding')).toBeNull();
  expect(parseLine("⚠ FERN-1: relabel failed")?.tone).toBe("bad");
  expect(parseLine("🆕 Honeycrust: app#4 opened: Add login")).toMatchObject({
    text: "Honeycrust: new pull request app#4, Add login",
    tone: "info",
  });
  expect(parseLine("🔴 Honeycrust: app#4 checks failing: Add login")?.tone).toBe("bad");
  expect(parseLine("🎉 Honeycrust: app#4 merged: Add login")?.text).toBe("Honeycrust: app#4 merged, Add login");
  expect(parseLine("🎉 HONEY-7 PR merged")?.text).toBe("HONEY-7's pull request merged");
  expect(parseLine("🎉 HONEY-8 PR merged on Ship https://github.com/o/r/pull/8")).toMatchObject({
    text: "HONEY-8's pull request merged on Ship, CI green",
    tone: "ok",
  });
  expect(parseLine("✗ HONEY-7 fix round 2 (work): tests still red")).toMatchObject({
    text: "HONEY-7 fix round 2: tests still red",
    tone: "bad",
  });
  expect(parseLine("💤 Mono lead found nothing to do; next look in 40 min")?.text).toBe(
    "Mono lead found nothing to do and rests for 40 min",
  );
});

test("a lead that keeps restarting is one beat; a lead that works is told as it is", () => {
  const loop = ["09:16", "09:17", "09:22", "09:23", "09:28", "09:29"].map(
    (t, i) => `- ${t} ⚡ Mono lead ${i % 2 ? "exited (0) after 1 min" : "started headless (pid 1, dev)"}`,
  );
  const day = [...loop, "- 10:00 ⚡ Ops lead started headless (pid 2, dev)", "- 10:43 ⚡ Ops lead exited (0) after 43 min"];
  const b = beats(day);
  expect(b).toHaveLength(3);
  expect(b[0]).toMatchObject({ time: "09:16–09:29", tone: "warn", count: 3, who: "Mono lead" });
  expect(b[1]?.text).toBe("Ops lead woke up on dev");
  expect(b[2]?.text).toBe("Ops lead finished after 43 min");
  const later = { time: "12:00–12:10", text: "", tone: "warn", who: "Mono lead", count: 3 } as const;
  expect(restarts([...b, later]).get("Mono lead")).toBe(6);
});

test("two restarts are not a loop", () => {
  const b = beats(["- 09:16 ⚡ A lead started headless (pid 1)", "- 09:17 ⚡ A lead exited (0) after 1 min"]);
  expect(b.map((x) => x.text)).toEqual(["A lead woke up", "A lead finished after 1 min"]);
});
