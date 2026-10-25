import { afterAll, expect, test } from "bun:test";
import type { HostedJob } from "@overhand/contract";
import { blankConfig, parseConfig, withQuick } from "../src/config";
import { applyConfig, CFG } from "../src/env";
import { githubSlug, hostedAccount } from "../src/hosted";
import { answerOf, hostedConfig, hostedTicket } from "../src/hosted-run";

const before = structuredClone(CFG);
afterAll(() => applyConfig(before));

test("a GitHub remote's owner/name, over https or ssh; anything else isn't one", () => {
  expect(githubSlug("https://github.com/acme/honeycrust.git")).toBe("acme/honeycrust");
  expect(githubSlug("git@github.com:acme/honey.crust.git\n")).toBe("acme/honey.crust");
  expect(githubSlug("https://bitbucket.org/acme/honeycrust.git")).toBeNull();
});

test("a hosted run uses an account on your own API key, never a sign-in", () => {
  applyConfig(
    parseConfig({
      ...blankConfig("me"),
      accounts: ["max", "api", "cx"],
      providers: { api: { kind: "claude", auth: "key" } },
      runtimes: { cx: { kind: "codex", model: "gpt-5" } },
    }),
  );
  const keys: Record<string, string> = { "anthropic-key-api": "sk-ant", "codex-key-cx": "sk-cx" };
  const read = (s: string) => keys[s] ?? null;
  // max is a Claude sign-in: passed over
  expect(hostedAccount({ accounts: [] }, read)).toEqual({ runtime: "claude-code", model: "", apiKey: "sk-ant" });
  expect(hostedAccount({ accounts: ["cx"] }, read)).toEqual({ runtime: "codex", model: "gpt-5", apiKey: "sk-cx" });
  expect(hostedAccount({ accounts: ["max"] }, read)).toBeNull();
  expect(hostedAccount({ accounts: [] }, () => null)).toBeNull();
});

test("the switch is saved per project, and a hosted run's config is one valid project at its own mode", () => {
  const c = parseConfig({
    ...blankConfig("me"),
    clients: [{ name: "Honeycrust", dir: "honey", prefix: "HONEY", host: "github", autonomy: "propose" }],
  });
  expect(withQuick(c, { project: "Honeycrust", hosted: true }).clients[0]?.hosted).toBe(true);
  expect(() => withQuick(c, { project: "Nope", hosted: true })).toThrow("no project Nope");
  const job: HostedJob = {
    key: "HONEY-3",
    project: "Honeycrust",
    repo: "acme/honeycrust",
    base: "main",
    title: "Fix the thing",
    brief: "It's broken",
    autonomy: "propose",
    runtime: "claude-code",
    model: "",
    apiKey: "sk-ant",
  };
  const h = parseConfig(hostedConfig(job, "/work"));
  expect(h.accounts).toEqual(["hosted"]);
  expect(h.providers.hosted).toMatchObject({ kind: "claude", auth: "key" });
  expect(h.clients).toMatchObject([{ name: "Honeycrust", dir: "honeycrust", prefix: "HONEY", host: "github", autonomy: "propose" }]);
  expect(JSON.stringify(h)).not.toContain("sk-ant"); // the key goes to the in-memory secrets file, never the config
  const stored = h.clients[0];
  if (!stored) throw new Error("no project");
  const tk = hostedTicket(job, { ...stored, accounts: [], fallbackToAll: true, autonomy: "propose", assignedAutonomy: "act" });
  expect(tk).toMatchObject({ key: "HONEY-3", local: true, description: "It's broken" });
});

test("the relay hears the PR when one opened, else the run's own first line", () => {
  expect(
    answerOf(
      { url: "https://github.com/a/b/pull/1", branch: "overhand/HONEY-1", draft: true },
      { status: "done", message: "Fixed.\nMore" },
    ),
  ).toEqual({
    status: "done",
    pr: "https://github.com/a/b/pull/1",
    branch: "overhand/HONEY-1",
    draft: true,
    summary: "Fixed.",
  });
  expect(answerOf(undefined, { status: "done", message: "\nIt's the cache." })).toMatchObject({
    status: "report",
    summary: "It's the cache.",
  });
  expect(answerOf(undefined, { status: "question", message: "Which repo?" })).toMatchObject({ status: "failed", summary: "Which repo?" });
  expect(answerOf(undefined, null)).toMatchObject({ status: "failed" });
});
