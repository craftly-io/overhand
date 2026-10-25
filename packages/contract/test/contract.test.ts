import { expect, test } from "bun:test";
import { DashboardStateSchema, isNewerVersion, localOnly, localOnlyChange } from "../src/index";

/** A small but complete state, the shape the daemon sends; made-up names only. */
const state = {
  now: 1_792_330_000_000,
  today: "2026-10-18",
  paused: false,
  pauseReason: "",
  daemon: true,
  running: [
    { name: "HONEY-12", account: "work", cwd: "/code/honeycrust", startedAt: 1_792_329_000_000, pid: 4242, model: "", mode: "auto" },
  ],
  accounts: [{ name: "work", coolUntil: 0, usage: null }],
  prs: [{ key: "HONEY-11", url: "https://github.com/honeycrust/app/pull/7", fixes: 1, branch: "HONEY-11" }],
  pending: [],
  splits: { "HONEY-13": [{ title: "Add the API", scope: "Endpoint and tests" }] },
  plan: ["# Plan 2026-10-18", "### Agent", "- [x] HONEY-12 Fix login"],
  reports: ["- 09:00 📋 plan written"],
  cost: 3.5,
  sessions: [
    {
      pid: 4242,
      kind: "agent",
      label: "HONEY-12 on work",
      client: "Honeycrust",
      cwd: "~/code/honeycrust",
      upSec: 120,
      active: true,
      name: "",
      model: "claude-opus-5-5",
      mode: "auto",
      lastAction: "→ Bash: bun test",
      subagents: [{ name: "Review auth", description: "", color: "", active: false, lastAt: 1_792_329_500_000, model: "", mode: "" }],
    },
  ],
  tickets: {
    Honeycrust: [{ key: "HONEY-12", title: "Fix login", status: "In Progress", priority: "High", labels: ["agent"], url: "" }],
    Beta: "tracker timed out",
  },
  clients: [{ name: "Honeycrust", prefix: "HONEY", host: "github" }],
  godmode: [],
  labels: { queue: "agent", working: "agent-working", review: "agent-review", blocked: "needs-owner", fromSlack: "from-slack" },
  opsBehind: 0,
  taskTimeoutMin: 75,
  owner: "Sam",
  runs: [
    { name: "plan", account: "work", start: 1, end: 2, cost: 0.4, ok: true },
    { name: "lead-honeycrust", cost: 1, ok: true },
  ],
  week: {
    opened: 1,
    merged: 0,
    failed: 0,
    questions: 0,
    fixes: 0,
    successRate: null,
    cost: 3.5,
    byAccount: { work: 3.5 },
    byClient: { Honeycrust: 3.5 },
    days: [],
  },
  status: { at: 0, myPrs: [], reviews: [], ci: [], deploys: "Vercel token missing", sentry: [], calendar: [], errors: [] },
};

test("the contract accepts what the daemon sends", () => {
  expect(DashboardStateSchema.safeParse(state).success).toBe(true);
});

test("the contract rejects a drifted payload, naming the field", () => {
  const drifted = { ...state, sessions: [{ ...state.sessions[0], kind: "robot" }] };
  const r = DashboardStateSchema.safeParse(drifted);
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]?.path).toEqual(["sessions", 0, "kind"]);
});

test("an older daemon without the update field still validates, with an empty one", () => {
  const r = DashboardStateSchema.safeParse(state);
  expect(r.data?.update).toEqual({ latest: "", current: "", command: "overhand update" });
  // one from before the command: the curl install's, the only kind that existed then
  const older = DashboardStateSchema.safeParse({ ...state, update: { latest: "0.3.0", current: "0.2.0" } });
  expect(older.data?.update.command).toBe("overhand update");
});

test("release versions compare by number, with or without the v", () => {
  expect(isNewerVersion("v0.3.0", "0.2.0")).toBe(true);
  expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true); // not a string compare
  expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
  expect(isNewerVersion("v0.2.0", "0.2.0")).toBe(false);
  expect(isNewerVersion("0.1.9", "0.2.0")).toBe(false);
  expect(isNewerVersion("", "0.2.0")).toBe(false);
  expect(isNewerVersion("nightly", "0.2.0")).toBe(false);
  expect(isNewerVersion("1.0.0-rc.1", "0.2.0")).toBe(false); // prereleases aren't offered
});

test("the fields only the computer changes: commands the daemon runs, the sandbox, the allowed addresses", () => {
  for (const p of ["sandbox.mode", "sandbox.required", "dashboardOrigins", "clients.3.preview.command", "clients.0.sandbox"])
    expect(localOnly(p)).toBe(true);
  for (const p of ["clients.3.preview.url", "clients.0.name", "dashboard", "cleanup.schedule"]) expect(localOnly(p)).toBe(false);
});

test("a local-only change is found by project name; removing a project or saving the same again is none", () => {
  const before = {
    sandbox: { mode: "enforce", required: false },
    dashboardOrigins: ["https://a.example"],
    clients: [
      { name: "a", preview: { command: "bun run dev", url: "" } },
      { name: "b", sandbox: "off" },
    ],
  };
  expect(localOnlyChange(before, structuredClone(before))).toBe("");
  // one removed, an empty preview command and "inherit" are the same as left out
  expect(localOnlyChange(before, { ...before, clients: [{ name: "b", sandbox: "off" }] })).toBe("");
  const added = { name: "c", sandbox: "inherit", preview: { command: "" } };
  expect(localOnlyChange(before, { ...before, clients: [...before.clients, added] })).toBe("");
  expect(localOnlyChange(before, { ...before, sandbox: { mode: "off", required: false } })).toBe("sandbox");
  expect(localOnlyChange(before, { ...before, dashboardOrigins: [] })).toBe("dashboardOrigins");
  const evil = { preview: { command: "sh evil", url: "" } };
  expect(localOnlyChange(before, { ...before, clients: [{ name: "a", ...evil }] })).toBe("clients.a.preview.command");
  expect(localOnlyChange(before, { ...before, clients: [{ name: "new", ...evil }] })).toBe("clients.new.preview.command");
  const cleanup = { categories: { caches: { commands: ["rm"] } } };
  expect(localOnlyChange(before, { ...before, cleanup })).toBe("cleanup.categories.caches.commands");
});
