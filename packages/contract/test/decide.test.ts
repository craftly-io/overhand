/** A stopped run's decision card (decide.ts failedBrief): its reason's one sentence, and the button that fixes it. */
import { expect, test } from "bun:test";
import { FAILURE_REASONS, FAILURE_WORDS, type FailureReason, factsBrief, outageOf } from "../src/index";
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
    stopped: ["retry", "close"],
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
  expect(factsBrief(watch, "held:f1", {}, NOW, words)?.why).toContain("Look only");
});

test("a pull request that only deletes code says what it removes, and isn't recommended to merge", () => {
  const proof = { at: NOW, transcript: true, checks: [], files: 5, removed: 5, areas: ["src"], ui: false, docsOnly: false, verified: "" };
  const shots = { before: false, after: false, note: "" };
  const pr = { key: "HONEY-1", url: "https://github.com/x/y/pull/1", fixes: 0, branch: "agent/HONEY-1", draft: false, corners: [] };
  const w = { prRemovesOnly: "{key} only removes", prRemovesOnlyWhy: "removes {lines} from {files}", prRemovesOnlyRec: "read it" };
  const s = (added: number) => state({ prs: [{ ...pr, preview: "", reviewRound: 0, proof: { ...proof, added, shots, gaps: [] } }] });
  const removes = factsBrief(s(0), "pr:HONEY-1", {}, NOW, w);
  expect(removes?.what).toBe("HONEY-1 only removes");
  expect(removes?.why).toBe("removes 5 lines from 5 files");
  expect(removes?.recommend.option).toBe("review");
  expect(removes?.options.find((o) => o.id === "open-pr")).toMatchObject({ what: "pr" });
  // one that adds as well is an ordinary PR, with Open the PR to merge
  expect(factsBrief(s(3), "pr:HONEY-1", {}, NOW, w)?.options.find((o) => o.id === "open-pr")).toMatchObject({ what: "merge" });
});

test("an outage is read from its error: network, rate limit or sign-in, each with its own fix", () => {
  expect(outageOf("Error: gh issue list on acme/web: error connecting to api.github.com")).toBe("network");
  expect(outageOf("GET https://api.linear.app → 503 Service Unavailable")).toBe("network");
  expect(outageOf("HTTP 403: API rate limit exceeded for user ID 1")).toBe("rate-limit");
  expect(outageOf("GET https://x.atlassian.net → 401 Unauthorized")).toBe("auth");
  expect(outageOf("HTTP 401: Bad credentials (https://api.github.com/graphql)")).toBe("auth");
  expect(outageOf("no such label: claude-queue")).toBe("other");
});
