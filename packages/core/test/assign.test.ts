import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPr } from "../src/agent";
import { assign, holdFinding, loadAssignments, loadFindings, runClient, type StoredAssignment } from "../src/assign";
import { levelFor, policyOf, prCreateFlags, ticketRules } from "../src/autonomy";
import { type Client, type Config, loadConfig, saveConfig } from "../src/config";
import { applyConfig, CFG, LABEL, OPS, today, UI_PORT } from "../src/env";
import { effectiveClients } from "../src/groups";
import { createPendingTickets } from "../src/inbox";
import { RUNTIMES } from "../src/runtimes";
import { handle } from "../src/server";
import { loadState } from "../src/state";
import { ownerAddedLabel } from "../src/trackers/github";
import { answerTicket, assertMayFile, comment, labelledByOwner, setLabels } from "../src/trackers/index";
import { viewerAddedLabel } from "../src/trackers/linear";
import type { Ticket } from "../src/trackers/types";
import { scratchWorktree } from "./fixtures/scratch-git";
import { localRequest } from "./local";

const ROOT = join(import.meta.dir, "..", "..", "..");

const client = (name: string, prefix: string, autonomy: Client["autonomy"], over: Partial<Client> = {}): Client => ({
  name,
  dir: name.toLowerCase(),
  prefix,
  host: "github",
  tracker: { kind: "github", repo: `o/${name.toLowerCase()}` },
  aliases: [],
  accounts: [],
  fallbackToAll: true,
  autonomy,
  assignedAutonomy: "act",
  status: { vercelSecrets: [], sentrySecrets: [] },
  ...over,
});

const ticket = (c: Client, n: number): Ticket => ({
  client: c,
  key: `${c.prefix}-${n}`,
  id: String(n),
  title: "Fix the thing",
  url: "",
  status: "Todo",
  statusType: "unstarted",
  priority: "",
  labels: [],
  description: "",
  comments: [],
});

// a fake gh on PATH that logs every call and answers with whatever the test put in `answer`
const bin = mkdtempSync(join(tmpdir(), "overhand-assign-gh-"));
const calls = join(bin, "calls.jsonl");
const answer = join(bin, "answer.txt");
const ghCalls = (): string[][] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];
const path = process.env.PATH;
let before: Config;

beforeAll(() => {
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bun",
      `const fs = require("node:fs");`,
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `if (fs.existsSync(${JSON.stringify(answer)})) process.stdout.write(fs.readFileSync(${JSON.stringify(answer)}, "utf8"));`,
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = [bin, path].join(":");
  before = structuredClone(CFG);
  applyConfig(
    saveConfig(OPS, {
      ...CFG,
      owner: { ...CFG.owner, githubLogin: "the-owner" },
      clients: [
        ...CFG.clients,
        client("Watchco", "WAT", "watch"),
        client("Draftco", "DRA", "propose", { assignedAutonomy: "propose" }),
        client("Actco", "ACT", "act"),
      ],
    }),
  );
});

afterAll(() => {
  process.env.PATH = path;
  applyConfig(saveConfig(OPS, before));
  rmSync(join(OPS, "assigned.json"), { force: true });
  rmSync(join(OPS, "findings.json"), { force: true });
});

const reset = () => {
  rmSync(calls, { force: true });
  rmSync(answer, { force: true });
  rmSync(join(OPS, "assigned.json"), { force: true });
  rmSync(join(OPS, "findings.json"), { force: true });
};

test("an assigned ticket runs at assignedAutonomy: env, prompt rules, PR flags and fix rounds; nothing else on the project moves", () => {
  const watch = client("Watchco", "WAT", "watch");
  const assigned: Record<string, StoredAssignment> = {
    "WAT-1": { key: "WAT-1", project: "Watchco", title: "", by: "dashboard", local: false, at: 0, brief: "", queued: false },
  };
  const run = runClient(watch, "WAT-1", assigned);
  expect(run.autonomy).toBe("act");
  expect(runClient(watch, "WAT-2", assigned).autonomy).toBe("watch"); // only that ticket
  expect(watch.autonomy).toBe("watch"); // the project itself is untouched
  expect(ticketRules(run.autonomy)).toBe("");
  expect(prCreateFlags(run.autonomy)).toEqual([]);
  expect(policyOf(run.autonomy)).toEqual({ write: true, pr: "open", fix: true });
  const env = (level: Client["autonomy"]) =>
    RUNTIMES["claude-code"].task({
      account: "a",
      cwd: "",
      prompt: "",
      schema: "",
      schemaFile: "/tmp/s.json",
      alias: "",
      provider: { kind: "claude", auth: "login" },
      model: "",
      attribution: true,
      args: [],
      configDir: "",
      instructions: "",
      read: () => null,
      autonomy: level,
    }).env.OVERHAND_AUTONOMY;
  expect(env(run.autonomy)).toBe("act");
  expect(env(runClient(watch, "WAT-2", assigned).autonomy)).toBe("watch");

  // "propose" when you assign: a draft PR, and its fix rounds still run
  const drafts = runClient({ ...watch, assignedAutonomy: "propose" }, "WAT-1", assigned);
  expect(prCreateFlags(drafts.autonomy)).toEqual(["--draft"]);
  expect(policyOf(drafts.autonomy).fix).toBe(true);
  expect(ticketRules(drafts.autonomy)).toContain("draft");
  // on act there is nothing to assign: it builds at its own level
  expect(levelFor({ autonomy: "act", assignedAutonomy: "propose" }, true)).toBe("act");
});

test("an assigned ticket's PR opens ready for review (or as a draft on propose); never merged", async () => {
  reset();
  writeFileSync(answer, "https://github.com/o/watchco/pull/9\n");
  const wt = scratchWorktree("WAT-1");
  const result = { status: "done" as const, pr_title: "fix: x (WAT-1)", pr_body: "b", message: "m" };
  const yes = { "WAT-1": { key: "WAT-1" } as StoredAssignment };
  expect(await openPr({ client: runClient(client("Watchco", "WAT", "watch"), "WAT-1", yes) }, wt, result)).toMatchObject({ draft: false });
  const drafts = client("Watchco", "WAT", "watch", { assignedAutonomy: "propose" });
  expect(await openPr({ client: runClient(drafts, "WAT-1", yes) }, wt, result)).toMatchObject({ draft: true });
  await expect(openPr({ client: client("Watchco", "WAT", "watch") }, wt, result)).rejects.toThrow("Plan and warn only");
  expect(ghCalls().every((c) => !c.includes("merge"))).toBe(true);
});

test("the queue label counts as assigned only when the owner added it", async () => {
  expect(ownerAddedLabel([{ label: "agent", actor: "The-Owner" }], "agent", "the-owner")).toBe(true);
  expect(ownerAddedLabel([{ label: "agent", actor: "client-dev" }], "agent", "the-owner")).toBe(false);
  // the newest add decides: the owner's earlier label, removed and re-added by someone else, doesn't count
  expect(
    ownerAddedLabel(
      [
        { label: "agent", actor: "the-owner" },
        { label: "agent", actor: "client-dev" },
      ],
      "agent",
      "the-owner",
    ),
  ).toBe(false);
  expect(ownerAddedLabel([{ label: "bug", actor: "the-owner" }], "agent", "the-owner")).toBe(false);
  expect(ownerAddedLabel([{ label: "agent", actor: "" }], "agent", "")).toBe(false); // no owner known: never
  const h = (at: string, actor: string, added: string[]) => ({ createdAt: at, actor: { id: actor }, addedLabelIds: added });
  expect(viewerAddedLabel([h("2026-01-02", "me", ["L"]), h("2026-01-01", "them", ["L"])], "L", "me")).toBe(true);
  expect(viewerAddedLabel([h("2026-01-01", "me", ["L"]), h("2026-01-02", "them", ["L"])], "L", "me")).toBe(false);

  // end to end through gh: the issue timeline's labeled events against owner.githubLogin
  reset();
  const tk = ticket(client("Watchco", "WAT", "watch"), 4);
  writeFileSync(answer, `${JSON.stringify({ label: "agent", actor: "the-owner" })}\n`);
  expect(await labelledByOwner(tk, "agent")).toBe(true);
  expect(ghCalls()[0]?.join(" ")).toContain("repos/o/watchco/issues/4/timeline");
  writeFileSync(
    answer,
    `${JSON.stringify({ label: "agent", actor: "the-owner" })}\n${JSON.stringify({ label: "agent", actor: "someone" })}\n`,
  );
  expect(await labelledByOwner(tk, "agent")).toBe(false);
  // Jira can't say who added a label: never assigned from the tracker there
  const jira = client("Jiraco", "JIR", "watch", { tracker: { kind: "jira", secret: "", site: "x", email: "", project: "JIR" } });
  expect(await labelledByOwner(ticket(jira, 1), "agent")).toBe(false);
});

test("on watch nothing is posted: comments are held as findings, labels and new tickets never reach the tracker", async () => {
  reset();
  const watch = client("Watchco", "WAT", "watch");
  const tk = ticket(watch, 7);
  await comment(tk, "Investigation, nothing changed yet");
  await setLabels(tk, ["agent-working"], []);
  expect(() => assertMayFile(watch, "auto")).toThrow("Plan and warn only"); // createTicket checks this first
  expect(() => assertMayFile(watch, "owner")).not.toThrow();
  expect(ghCalls()).toEqual([]);
  expect(tk.labels).toEqual([]);
  expect(loadFindings()).toMatchObject([{ project: "Watchco", key: "WAT-7", post: "Investigation, nothing changed yet", from: "agent" }]);
  // the same finding is kept once
  await comment(tk, "Investigation, nothing changed yet");
  expect(loadFindings()).toHaveLength(1);

  // a ticket you assigned runs at its assigned level, so its own PR comment does go out; you pressing a button always does
  await comment({ ...tk, client: runClient(watch, tk.key, { "WAT-7": { key: "WAT-7" } as StoredAssignment }) }, "PR ready");
  await comment(tk, "posted by you", "owner");
  expect(ghCalls().filter((c) => c[1] === "comment")).toHaveLength(2);
  // a task with no ticket never reaches a tracker, whatever the level
  reset();
  await setLabels({ ...ticket(client("Actco", "ACT", "act"), 1), local: true }, ["agent"], [], "owner");
  expect(ghCalls()).toEqual([]);
});

test("Slack feedback on a watch ticket is held, never commented, even after the veto window", async () => {
  reset();
  writeFileSync(answer, JSON.stringify({ number: 3, title: "t", url: "", body: "", state: "OPEN", labels: [], comments: [] }));
  const state = loadState();
  state.pending = {
    "new-abc": {
      client: "Watchco",
      title: "comment on WAT-3",
      details: "💬 Feedback from Sam on Slack: not sure what's being asked",
      permalink: "https://slack/x",
      from: "Sam",
      createAfter: Date.now() - 1000,
      ticket: "WAT-3",
    },
  };
  mkdirSync(join(OPS, "plans"), { recursive: true });
  const plan = join(OPS, "plans", `${today()}.md`);
  const had = existsSync(plan) ? readFileSync(plan, "utf8") : null;
  writeFileSync(plan, "## Inbox 09:00\n- [x] new-abc WAT-3: comment feedback from Sam\n");
  try {
    await createPendingTickets(state);
    expect(ghCalls().some((c) => c[1] === "comment")).toBe(false);
    expect(loadFindings()[0]).toMatchObject({ key: "WAT-3", from: "agent" });
    expect(state.pending["new-abc"]?.created).toBe("WAT-3");
  } finally {
    if (had === null) rmSync(plan, { force: true });
    else writeFileSync(plan, had);
  }
});

const origin = `http://127.0.0.1:${UI_PORT}`;
const post = (p: string, body: object, headers: Record<string, string> = {}) =>
  handle(
    localRequest(`${origin}${p}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

test("Assign an agent: the dashboard's own origin only, known watch or propose projects only, and idempotent", async () => {
  reset();
  expect((await post("/api/assign", { project: "Watchco", key: "WAT-5" }, { origin: "https://evil.example" })).status).toBe(403);
  expect((await post("/api/assign", { project: "Nope", key: "WAT-5" })).status).toBe(400);
  expect((await post("/api/assign", { project: "Actco", key: "ACT-5" })).status).toBe(400); // act builds already
  expect((await post("/api/assign", { project: "Watchco", key: "ACT-5" })).status).toBe(400); // another project's ticket
  expect((await post("/api/assign", { project: "Watchco" })).status).toBe(400); // nothing to build
  expect(loadAssignments()).toEqual({});

  const r = await post("/api/assign", { project: "Watchco", key: "wat-5", title: "Fix it" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, key: "WAT-5" });
  expect((await post("/api/assign", { project: "Watchco", key: "WAT-5", title: "Fix it" })).status).toBe(200);
  expect(Object.keys(loadAssignments())).toEqual(["WAT-5"]);
  expect(loadAssignments()["WAT-5"]).toMatchObject({ project: "Watchco", by: "dashboard", local: false, queued: true });

  // a finding with no ticket (a Slack ask): assigned as a task from its text, and the finding is done with
  const id = holdFinding({ project: "Draftco", key: "", title: "Add a CSV export", text: "They want CSV", post: "", from: "inbox" });
  const t = await post("/api/assign", { id });
  const { key } = (await t.json()) as { key: string };
  expect(key).toMatch(/^DRA-9\d{8}$/);
  expect(loadAssignments()[key]).toMatchObject({ local: true, brief: "They want CSV", project: "Draftco" });
  expect(loadFindings().some((f) => f.id === id)).toBe(false);
  expect((await post("/api/assign", { id })).status).toBe(404);
  expect(assign({ project: "Draftco", title: "Add a CSV export", brief: "They want CSV", by: "dashboard" }).key).toBe(key);

  // Dismiss drops a finding for good: the same one isn't filed again
  const gone = holdFinding({ project: "Watchco", key: "WAT-9", title: "x", text: "y", post: "y", from: "agent" });
  expect((await post("/api/finding/dismiss", { id: gone })).status).toBe(200);
  holdFinding({ project: "Watchco", key: "WAT-9", title: "x", text: "y", post: "y", from: "agent" });
  expect(loadFindings().some((f) => f.id === gone)).toBe(false);
});

test("start an agent from a sentence: it plans read-only on any project, Go ahead builds that task, Drop it removes it", async () => {
  reset();
  const act = client("Actco", "ACT", "act");
  // started from a sentence: allowed even where agents act on their own, and its first pass is read-only
  const r = await post("/api/assign", {
    project: "Actco",
    title: "Make the invite friendlier",
    brief: "Make the invite friendlier",
    plan: true,
  });
  expect(r.status).toBe(200);
  const { key } = (await r.json()) as { key: string };
  expect(key).toMatch(/^ACT-9\d{8}$/);
  expect(loadAssignments()[key]).toMatchObject({ plan: true, local: true, queued: true });
  expect(runClient(act, key).autonomy).toBe("watch");

  // the plan comes back held, tied to its task; Go ahead re-queues that same task at the project's level, plan included
  const id = holdFinding({
    project: "Actco",
    key: "",
    title: "Make the invite friendlier",
    text: "Change the copy",
    post: "",
    from: "agent",
    task: key,
  });
  expect((await post("/api/assign", { id })).status).toBe(200);
  const built = loadAssignments()[key];
  expect(built).toMatchObject({ plan: false, queued: true });
  expect(built?.brief).toContain("Change the copy");
  expect(runClient(act, key).autonomy).toBe("act");
  expect(Object.keys(loadAssignments())).toEqual([key]);

  // Drop it: dismissing a plan drops its task too
  const again = assign({ project: "Actco", title: "Tidy the footer", brief: "Tidy the footer", by: "dashboard", plan: true });
  const plan = holdFinding({
    project: "Actco",
    key: "",
    title: "Tidy the footer",
    text: "Remove two links",
    post: "",
    from: "agent",
    task: again.key,
  });
  expect((await post("/api/finding/dismiss", { id: plan })).status).toBe(200);
  expect(loadAssignments()[again.key]).toBeUndefined();
});

test("settings keep assignedAutonomy and the owner's GitHub login; an older config gets the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "assign-cfg-"));
  copyFileSync(join(ROOT, "overhand.config.example.json"), join(dir, "overhand.config.json"));
  const old = loadConfig(dir);
  expect(effectiveClients(old).map((c) => c.assignedAutonomy)).toEqual(["act", "act"]);
  expect(old.owner.githubLogin).toBe("");
  const saved = saveConfig(dir, {
    ...old,
    owner: { ...old.owner, githubLogin: "me" },
    clients: old.clients.map((c) => ({ ...c, autonomy: "watch", assignedAutonomy: "propose" })),
  });
  expect(saved.clients.map((c) => [c.autonomy, c.assignedAutonomy])).toEqual([
    ["watch", "propose"],
    ["watch", "propose"],
  ]);
  expect(loadConfig(dir).owner.githubLogin).toBe("me");
  // assigning never runs read-only: watch isn't a level an assignment can have
  expect(() => saveConfig(dir, { ...old, clients: old.clients.map((c) => ({ ...c, assignedAutonomy: "watch" })) })).toThrow();
});

test("Settings round-trips a project's assigned level and its leads' run controls; a lead saved without them keeps the defaults", async () => {
  const sent = structuredClone(CFG);
  const project = sent.clients.find((c) => c.name === "Watchco");
  if (!project) throw new Error("Watchco is set up above");
  project.assignedAutonomy = "propose";
  const raw = {
    ...sent,
    // as an older dashboard would send a lead: no onDemand, account or the rest
    godmode: [{ key: "watchco-lead", label: "Watchco lead", dir: "watchco", project: "Watchco", supervised: true }],
  };
  const r = await post("/api/settings", { config: raw });
  expect(r.status).toBe(200);
  const got = (await (await handle(localRequest(`${origin}/api/settings`))).json()) as { config: Config };
  expect(got.config.clients.find((c) => c.name === "Watchco")?.assignedAutonomy).toBe("propose");
  expect(got.config.godmode[0]).toMatchObject({ supervised: true, onDemand: false, account: "" });
  applyConfig(saveConfig(OPS, { ...got.config, godmode: [] }));
});

test("answering a ticket from its card: on act it's posted in your words and re-queued; on watch it's held, nothing sent", async () => {
  reset();
  const act = { ...ticket(client("Actco", "ACT", "act"), 4), labels: [LABEL.blocked] };
  expect(await answerTicket(act, "Show it as pending until it settles")).toBe("posted");
  const said =
    ghCalls()
      .find((c) => c[1] === "comment")
      ?.join(" ") ?? "";
  expect(said).toContain("Show it as pending until it settles");
  expect(said).toContain("answered through Overhand");
  expect(act.labels).toEqual([LABEL.queue]);

  reset();
  const watch = { ...ticket(client("Watchco", "WAT", "watch"), 5), labels: [LABEL.blocked] };
  expect(await answerTicket(watch, "Show it as pending until it settles")).toBe("held");
  expect(ghCalls()).toEqual([]);
  expect(watch.labels).toEqual([LABEL.blocked]);
  expect(loadFindings()).toMatchObject([{ project: "Watchco", key: "WAT-5" }]);
  expect(loadFindings()[0]?.post).toContain("Show it as pending until it settles");
});
