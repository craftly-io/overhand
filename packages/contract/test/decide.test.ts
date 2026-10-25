/** A stopped run's decision card (decide.ts failedBrief): its reason's one sentence, and the button that fixes it. */
import { expect, test } from "bun:test";
import { FAILURE_REASONS, FAILURE_WORDS, type FailureReason, factsBrief } from "../src/index";
import { NOW, state } from "./fixtures/state";

// each sentence word stands for itself, so the brief shows which one it picked
const words = Object.fromEntries([
  ...Object.values(FAILURE_WORDS).map((k) => [k, `${k} {branch}`]),
  ["heldNoTicket", "no ticket"],
  ["failedIfNothing", "it stays stopped"],
]);

const stopped = (reason: FailureReason) =>
  state({
    clients: [{ name: "Honeycrust", prefix: "HONEY", host: "github", autonomy: "propose", assignedAutonomy: "act" }],
    findings: [
      {
        id: "f1",
        project: "Honeycrust",
        key: "",
        title: "Add a CSV export",
        text: '{"type":"system","subtype":"init"}',
        post: "",
        from: "agent",
        at: NOW,
        failed: { reason, task: "HONEY-900000001", account: "work", branch: "agent/HONEY-900000001" },
      },
    ],
  });

test("each reason says its own sentence, with its fix first and Close last; the raw text only under Details", () => {
  const fixes: Record<FailureReason, string[]> = {
    "no-changes": ["detail", "close"],
    "pr-open": ["reopen", "close"],
    "signed-out": ["signin", "retry", "close"],
    crashed: ["retry", "close"],
    timeout: ["retry", "close"],
    unreadable: ["retry", "close"],
    push: ["retry", "close"],
    stuck: ["retry", "close"],
  };
  for (const reason of FAILURE_REASONS) {
    const b = factsBrief(stopped(reason), "held:f1", {}, NOW, words);
    expect(b?.why).toBe(`${FAILURE_WORDS[reason]} agent/HONEY-900000001`);
    expect(b?.options.map((o) => o.id)).toEqual(fixes[reason]);
    expect(b?.recommend.option).toBe(fixes[reason][0] ?? "");
    expect(b?.detail).toContain('"type":"system"');
    expect(b?.why).not.toContain("Plan and warn only");
  }
  // Try again re-queues the same task through its finding, never as a new task from the failure's text
  const retry = factsBrief(stopped("crashed"), "held:f1", {}, NOW, words)?.options[0];
  expect(retry).toMatchObject({ do: "assign", finding: "f1", brief: "" });
});

test("something held for a task with no ticket isn't said to be on Plan and warn only unless the project is", () => {
  const s = stopped("crashed");
  const plain = { ...s, findings: s.findings.map(({ failed: _, ...f }) => f) };
  expect(factsBrief(plain, "held:f1", {}, NOW, words)?.why).toBe("no ticket");
  const watch = { ...plain, clients: plain.clients.map((c) => ({ ...c, autonomy: "watch" as const })) };
  expect(factsBrief(watch, "held:f1", {}, NOW, words)?.why).toContain("Plan and warn only");
});
