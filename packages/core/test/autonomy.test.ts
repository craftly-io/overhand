import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPr } from "../src/agent";
import { guardHooks, hookCommand } from "../src/agent-home";
import { autonomyOf, leadRules, policyOf, prCreateFlags, ticketRules } from "../src/autonomy";
import { blankConfig, type Client, FIRST_DAY_BUDGET_USD, loadConfig, saveConfig } from "../src/config";
import { forgetRun, recordRun } from "../src/control";
import { OPS, UI_PORT } from "../src/env";
import { effectiveClients } from "../src/groups";
import { check } from "../src/guard";
import { configFromSetup, SetupSchema } from "../src/onboard";
import { capDiff } from "../src/review";
import { RUNTIMES } from "../src/runtimes";
import type { RunInput } from "../src/runtimes/runtime";
import { handle } from "../src/server";
import { loadPrReview, loadState, saveState } from "../src/state";
import type { Ticket } from "../src/trackers/types";
import { scratchWorktree } from "./fixtures/scratch-git";
import { localRequest } from "./local";

const ROOT = join(import.meta.dir, "..", "..", "..");

test("a config written before autonomy existed keeps acting; setup starts new projects on propose, and a billed account with a budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-"));
  copyFileSync(join(ROOT, "overhand.config.example.json"), join(dir, "overhand.config.json"));
  expect(effectiveClients(loadConfig(dir)).map((c) => c.autonomy)).toEqual(["act", "act"]);
  expect(loadConfig(dir).limits.dailyBudgetUsd).toBe(0); // and keeps no budget cap

  const setup = SetupSchema.parse({
    owner: "Me",
    codeRoot: "/code",
    projects: [{ name: "Honeycrust", dir: "honeycrust", prefix: "HONEY", trackerRepo: "honeycrust/web" }],
    credential: { kind: "login", value: "" },
  });
  const fresh = saveConfig(dir, configFromSetup(setup, blankConfig("me")));
  expect(fresh.clients[0]?.autonomy).toBe("propose");
  // a sign-in may be a plan or per use, so it starts with the first-day budget (which never holds a known plan); an API
  // key is billed, so it does too; a local model isn't charged, so it gets none
  expect(fresh.limits.dailyBudgetUsd).toBe(FIRST_DAY_BUDGET_USD);
  const keyed = SetupSchema.parse({ ...setup, credential: { kind: "key", value: "" } });
  expect(saveConfig(dir, configFromSetup(keyed, blankConfig("me"))).limits.dailyBudgetUsd).toBe(FIRST_DAY_BUDGET_USD);
  const local = SetupSchema.parse({ ...setup, backend: { kind: "ollama", model: "qwen3" } });
  expect(saveConfig(dir, configFromSetup(local, blankConfig("me"))).limits.dailyBudgetUsd).toBe(0);
  saveConfig(dir, fresh);

  const base = loadConfig(dir);
  const raw = (autonomy: unknown) => ({ ...base, clients: [{ ...base.clients[0], autonomy }] });
  expect(saveConfig(dir, raw("watch")).clients[0]?.autonomy).toBe("watch");
  expect(() => saveConfig(dir, raw("yolo"))).toThrow();
});

test("each level's decisions: watch never writes or opens a PR, propose opens drafts, act opens PRs", () => {
  expect(policyOf("watch")).toEqual({ write: false, pr: "none", fix: false });
  expect(policyOf("propose")).toEqual({ write: true, pr: "draft", fix: true });
  expect(policyOf("act")).toEqual({ write: true, pr: "open", fix: true });
  expect(prCreateFlags("watch")).toBeNull();
  expect(prCreateFlags("propose")).toEqual(["--draft"]);
  expect(prCreateFlags("act")).toEqual([]);
  const clients = [{ name: "Honeycrust", autonomy: "watch" as const }];
  expect(autonomyOf(clients, "Honeycrust")).toBe("watch");
  expect(autonomyOf(clients, "Unknown")).toBe("act");
  // act's prompts stay exactly as before; the others say what they may not do
  expect(ticketRules("act")).toBe("");
  expect(leadRules("act")).toBe("");
  expect(ticketRules("watch")).toContain("read-only");
  expect(leadRules("propose")).toContain("--draft");
  // on Ship a lead opens ready PRs and leaves the merge to Overhand's auto-merge step
  expect(leadRules("ship")).toContain("auto-merge");
});

const input = (autonomy: RunInput["autonomy"], over: Partial<RunInput> = {}): RunInput => ({
  account: "a",
  cwd: "",
  prompt: "Look",
  schema: "",
  schemaFile: "/tmp/s.json",
  alias: "",
  provider: { kind: "claude", auth: "login" },
  model: "",
  attribution: true,
  args: [],
  configDir: "",
  instructions: "",
  read: (s) => ({ "claude-token-a": "oat", "gemini-key-a": "gk" })[s] ?? null,
  autonomy,
  ...over,
});
const argvOf = (id: keyof typeof RUNTIMES, autonomy: RunInput["autonomy"]) => RUNTIMES[id].task(input(autonomy)).argv;
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

test("on watch every CLI runs read-only through its own switch; act keeps today's flags", () => {
  expect(flag(argvOf("claude-code", "watch"), "--permission-mode")).toBe("plan");
  expect(flag(argvOf("claude-code", "act"), "--permission-mode")).toBe("auto");
  expect(RUNTIMES["claude-code"].task(input("watch")).env.OVERHAND_AUTONOMY).toBe("watch");
  expect(flag(RUNTIMES["claude-code"].lead(input("watch")).argv, "--permission-mode")).toBe("plan");

  expect(flag(argvOf("codex", "watch"), "--sandbox")).toBe("read-only");
  expect(argvOf("codex", "watch").join(" ")).not.toContain("network_access");
  expect(flag(argvOf("codex", "act"), "--sandbox")).toBe("workspace-write");

  expect(flag(argvOf("gemini", "watch"), "--approval-mode")).toBe("default");
  expect(flag(argvOf("gemini", "act"), "--approval-mode")).toBe("yolo");

  expect(flag(argvOf("cursor", "watch"), "--mode")).toBe("plan");
  expect(argvOf("cursor", "watch")).not.toContain("-f");
  // headless, an untrusted folder exits at the trust prompt: watch runs trust the checkout without forcing commands
  expect(argvOf("cursor", "watch")).toContain("--trust");
  expect(argvOf("cursor", "act")).toContain("-f");

  const oc = RUNTIMES.opencode.task(input("watch")).env.OPENCODE_CONFIG_CONTENT ?? "{}";
  expect(JSON.parse(oc).permission).toEqual({ edit: "deny", bash: "deny" });
  expect(RUNTIMES.opencode.task(input("act")).env.OPENCODE_CONFIG_CONTENT).toBeUndefined();

  expect(flag(argvOf("aider", "watch"), "--chat-mode")).toBe("ask");
  expect(argvOf("aider", "watch")).toContain("--no-auto-commits");
  expect(argvOf("aider", "act")).not.toContain("--chat-mode");
});

test("ticket runs and leads on Claude Code carry the level to the guard: OVERHAND_AUTONOMY on the run, the hook in --settings", () => {
  const hooks = guardHooks();
  for (const level of ["watch", "propose", "act"] as const) {
    expect(RUNTIMES["claude-code"].task(input(level)).env.OVERHAND_AUTONOMY).toBe(level);
    const lead = RUNTIMES["claude-code"].lead(input(level, { hooks }));
    expect(lead.env.OVERHAND_AUTONOMY).toBe(level);
    expect(JSON.parse(flag(lead.argv, "--settings") ?? "{}").hooks).toEqual(hooks);
  }
  expect(RUNTIMES["claude-code"].task(input(undefined)).env.OVERHAND_AUTONOMY).toBe("act");
});

test("`overhand guard`, run as the hook runs it, blocks by the level Overhand recorded for the run", () => {
  // the hook's own command (run.ts guard from a checkout), with the tool call on stdin as Claude Code sends it
  const command = hookCommand().replace(/ \|\| exit 2$/, "");
  const verdict = (level: string, cmd: string): number | null => {
    recordRun(OPS, process.pid, { run: "AC-1", autonomy: level, project: "" });
    const code = Bun.spawnSync(["sh", "-c", command], {
      env: { ...process.env, OVERHAND_AUTONOMY: "act" }, // what the environment claims doesn't count
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } })),
      stderr: "pipe",
    }).exitCode;
    forgetRun(OPS, process.pid);
    return code;
  };
  expect(verdict("watch", "git push -u origin AC-1")).toBe(2);
  // on act a ticket run still doesn't push: Overhand pushes its branch when it returns done
  expect(verdict("act", "git push -u origin AC-1")).toBe(2);
  expect(verdict("act", "git commit -m x")).toBe(0);
  expect(verdict("propose", "gh pr create --title x")).toBe(2);
  expect(verdict("propose", "gh pr create --draft --title x")).toBe(0);
}, 30_000);

test("the guard enforces the level: watch blocks writes and pushes, propose blocks ready and non-draft PRs", () => {
  const bash = (command: string, level: string) => check("Bash", { command }, undefined, level);
  expect(bash("git push -u origin EW-1", "watch")).toContain("watch");
  expect(bash("git commit -m x", "watch")).toContain("watch");
  expect(bash("gh pr create --title x", "watch")).toContain("watch");
  expect(bash("gh api -X POST repos/o/r/issues/1/comments", "watch")).toContain("watch");
  expect(check("Write", { file_path: "/w/a.ts" }, undefined, "watch")).toContain("watch");
  expect(bash("git log -5 && gh pr view 3", "watch")).toBeNull();

  expect(bash("gh pr create --title x --body y", "propose")).toContain("--draft");
  expect(bash("gh pr create --draft --title x", "propose")).toBeNull();
  expect(bash("gh pr ready 12", "propose")).toContain("ready");
  expect(bash("git push -u origin EW-1", "propose")).toBeNull();

  expect(bash("gh pr create --title x", "act")).toBeNull();
  expect(bash("git push --force origin x", "act")).toBe("force push is never allowed");
});

const client = (autonomy: Client["autonomy"]): Client => ({
  name: "Honeycrust",
  dir: "honeycrust",
  prefix: "AC",
  host: "github",
  tracker: { kind: "github", repo: "o/r" },
  aliases: [],
  accounts: [],
  fallbackToAll: true,
  autonomy,
  assignedAutonomy: "act",
  status: { vercelSecrets: [], sentrySecrets: [] },
});

test("Overhand opens a draft on propose, a PR on act, and nothing on watch", async () => {
  const bin = mkdtempSync(join(tmpdir(), "overhand-gh-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bun",
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'console.log("https://github.com/o/r/pull/7");',
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(":");
  try {
    const wt = scratchWorktree("AC-1");
    const result = { status: "done" as const, pr_title: "feat: x (AC-1)", pr_body: "b", message: "m" };
    const tk = (autonomy: Client["autonomy"]): Ticket => ({
      client: client(autonomy),
      key: "AC-1",
      id: "1",
      title: "x",
      url: "",
      status: "Todo",
      statusType: "unstarted",
      priority: "",
      labels: [],
      description: "",
      comments: [],
    });
    const draft = await openPr(tk("propose"), wt, result);
    expect(draft).toMatchObject({ draft: true, repo: "o/r", number: 7 });
    expect(await openPr(tk("act"), wt, result)).toMatchObject({ draft: false });
    await expect(openPr(tk("watch"), wt, result)).rejects.toThrow("Plan and warn only");
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--draft");
    expect(calls[1]).not.toContain("--draft");
  } finally {
    process.env.PATH = path;
  }
});

test("a diff too big for the drawer is cut at a line", () => {
  expect(capDiff("a\nb", 10)).toEqual({ diff: "a\nb", truncated: false });
  expect(capDiff("aaaa\nbbbb\ncccc", 12)).toEqual({ diff: "aaaa\nbbbb", truncated: true });
});

const origin = `http://127.0.0.1:${UI_PORT}`;
const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  handle(
    localRequest(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

test("review routes: same origin only, a real agent PR, a note to send; a note waits for the next fix round", async () => {
  const before = loadState();
  const reviewFile = join(OPS, ".pr-review.json");
  rmSync(reviewFile, { force: true });
  saveState({
    ...before,
    prs: {
      "AC-1": {
        url: "https://github.com/o/r/pull/7",
        host: "github",
        repo: "o/r",
        number: 7,
        branch: "AC-1",
        mainRepo: "",
        repoPath: "",
        seen: "",
        fixes: 0,
        draft: true,
      },
      "BB-2": {
        url: "https://bitbucket.org/w/r/pull-requests/3",
        host: "bitbucket",
        repo: "r",
        number: 3,
        branch: "BB-2",
        mainRepo: "",
        repoPath: "",
        seen: "",
        fixes: 0,
      },
    },
  });
  try {
    expect((await post("/api/pr/ready", { key: "AC-1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/pr/close", { key: "AC-1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/pr/ready", { key: "not a key" })).status).toBe(400);
    expect((await post("/api/pr/ready", {})).status).toBe(400);
    expect((await post("/api/pr/ready", { key: "AC-99" })).status).toBe(404);
    expect((await post("/api/pr/ready", { key: "BB-2" })).status).toBe(400);
    expect((await post("/api/pr/changes", { key: "AC-1", text: "  " })).status).toBe(400);
    expect((await post("/api/pr/changes", { key: "AC-1", text: "x".repeat(4001) })).status).toBe(400);
    expect((await handle(localRequest(`${origin}/api/pr/review?key=nope`))).status).toBe(400);
    expect((await handle(localRequest(`${origin}/api/pr/review?key=AC-99`))).status).toBe(404);

    const r = await post("/api/pr/changes", { key: "ac-1", text: "Use the shared money formatter" });
    expect(r.status).toBe(200);
    expect(loadPrReview().notes["AC-1"]).toContain("Use the shared money formatter");
    expect(existsSync(join(OPS, ".request-work"))).toBe(true);
  } finally {
    saveState(before);
    rmSync(reviewFile, { force: true });
    rmSync(join(OPS, ".request-work"), { force: true });
  }
});
