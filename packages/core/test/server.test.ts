import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannelSchema } from "@overhand/contract";
import { loadConfig, saveConfig } from "../src/config";
import { applyConfig, CFG, OPS, SLACK_MCP, UI_PORT } from "../src/env";
import { handle, markCleanup, stateKey, withoutBrowser } from "../src/server";
import { localRequest } from "./local";

const origin = `http://127.0.0.1:${UI_PORT}`;
const post = (path: string, body: object = {}, headers: Record<string, string> = {}) =>
  handle(
    localRequest(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

test("plan, inbox and work requests each leave their request for the daemon", async () => {
  for (const name of ["plan", "inbox", "work"]) {
    const file = join(OPS, `.request-${name}`);
    rmSync(file, { force: true });
    const r = await post(`/api/request/${name}`);
    expect(r.status).toBe(200);
    expect(existsSync(file)).toBe(true);
    rmSync(file, { force: true });
  }
});

test("the app's automatic Slack asks cost one pass, however many tabs ask, and only when the last read is old", async () => {
  const file = join(OPS, ".request-inbox");
  const readAt = join(OPS, ".inbox-at");
  const had = existsSync(SLACK_MCP);
  if (!had) writeFileSync(SLACK_MCP, "{}");
  try {
    rmSync(file, { force: true });
    writeFileSync(readAt, String(Date.now() - 2 * 60_000)); // read two minutes ago
    expect(await (await post("/api/request/inbox", { auto: true })).json()).toEqual({ ok: true, skipped: true });
    expect(existsSync(file)).toBe(false);
    writeFileSync(readAt, String(Date.now() - 45 * 60_000)); // read 45 minutes ago: the first tab's ask goes through
    expect(await (await post("/api/request/inbox", { auto: true })).json()).toEqual({ ok: true });
    expect(existsSync(file)).toBe(true);
    rmSync(file, { force: true });
    // a second tab, or a phone, a moment later
    expect(await (await post("/api/request/inbox", { auto: true })).json()).toEqual({ ok: true, skipped: true });
    expect(existsSync(file)).toBe(false);
    // the palette's own ask always goes through
    expect((await post("/api/request/inbox")).status).toBe(200);
    expect(existsSync(file)).toBe(true);
  } finally {
    rmSync(file, { force: true });
    rmSync(readAt, { force: true });
    if (!had) rmSync(SLACK_MCP, { force: true });
  }
});

test("actions need the dashboard's own origin", async () => {
  expect((await post("/api/request/plan", {}, { origin: "https://evil.example" })).status).toBe(403);
});

test("a request for another host is refused, so DNS rebinding can't read the dashboard", async () => {
  const r = await handle(localRequest(`${origin}/api/settings`, { headers: { host: "attacker.example:4317" } }));
  expect(r.status).toBe(403);
});

test("a ready-made lead is added to a project, switched on and asleep until its own kind of work; twice is refused", async () => {
  const before = structuredClone(CFG);
  const pause = join(OPS, "PAUSE");
  const paused = existsSync(pause);
  writeFileSync(pause, ""); // so the supervisor doesn't start a real agent from a test
  try {
    const ci = { project: "Honeycrust", template: "ci", name: "Keep CI green · Honeycrust" };
    expect((await post("/api/lead/template", ci)).status).toBe(200);
    const g = loadConfig(OPS).godmode.find((x) => x.key === "honeycrust-ci");
    // it sleeps until a red build, red checks or a failed deploy, and wakes for nothing else
    expect(g).toMatchObject({
      project: "Honeycrust",
      dir: "honeycrust",
      supervised: true,
      onDemand: true,
      watch: ["ci"],
      label: "Keep CI green · Honeycrust",
    });
    expect((await post("/api/lead/template", ci)).status).toBe(409);
    expect((await post("/api/lead/template", { ...ci, project: "Nope" })).status).toBe(400);
    // the old niche templates are gone; a name is required
    expect((await post("/api/lead/template", { ...ci, template: "flaky" })).status).toBe(400);
    expect((await post("/api/lead/template", { ...ci, template: "errors", name: " " })).status).toBe(400);
    expect((await post("/api/lead/template", { ...ci, template: "errors" }, { origin: "https://evil.example" })).status).toBe(403);
  } finally {
    applyConfig(saveConfig(OPS, before));
    if (!paused) rmSync(pause, { force: true });
  }
});

test("a status update's webhook must be an https URL, and only a saved channel can be tested", async () => {
  const before = CFG.updates;
  const project = CFG.clients[0]?.name ?? "";
  CFG.updates = [UpdateChannelSchema.parse({ id: "client", name: "Client", kind: "slack", projects: [project] })];
  try {
    const r = await post("/api/secret", { service: "status-update-client", value: "http://hooks.example.com/abc" });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain("hooks.example.com");
    expect((await post("/api/updates/test", { id: "nope" })).status).toBe(404);
  } finally {
    CFG.updates = before;
  }
});

test("readings that drift on every read don't count as the state changing (each change re-sends the whole state)", () => {
  const s = { now: 1, disk: { freeGb: 25.152577, floorGb: 5 }, sessions: [{ upSec: 10, procs: 3 }], reports: ["- 10:00 a"] };
  expect(stateKey({ ...s, now: 2, disk: { ...s.disk, freeGb: 25.1523 }, sessions: [{ upSec: 12, procs: 3 }] })).toBe(stateKey(s));
  expect(stateKey({ ...s, sessions: [{ upSec: 10, procs: 4 }] })).not.toBe(stateKey(s));
  expect(stateKey({ ...s, reports: [...s.reports, "- 10:01 b"] })).not.toBe(stateKey(s));
});

test("with no browser here, Codex signs in with its device code; other commands are shown as they are", () => {
  expect(withoutBrowser("codex login")).toBe("codex login --device-auth");
  expect(withoutBrowser("curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login")).toEndWith("&& codex login --device-auth");
  expect(withoutBrowser("codex login status")).toBe("codex login status");
  expect(withoutBrowser("gh auth login --web")).toBe("gh auth login --web");
});

test("Add an agent account signs in without a terminal: the app gets the link, sends the code, sees it signed in", async () => {
  // a fake `claude` first on PATH: its sign-in prints a link and reads a code, its status says whether that worked
  const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `if [ "$2" = status ]; then [ -f "$CLAUDE_CONFIG_DIR/ok" ]; exit $?; fi`,
      "printf 'visit: https://example.test/oauth?x=1\\nPaste code here if prompted > '",
      "read code",
      `[ "$code" = abc ] && touch "$CLAUDE_CONFIG_DIR/ok"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(":");
  try {
    const account = CFG.accounts[0] ?? "";
    const r = (await (await post("/api/accounts/login", { account })).json()) as { id: string; url: string; asks: boolean };
    expect(r.url).toBe("https://example.test/oauth?x=1");
    expect(r.asks).toBe(true);
    expect((await post("/api/accounts/login/code", { id: "someone-else", code: "abc" })).status).toBe(409);
    expect((await post("/api/accounts/login/code", { id: r.id, code: "abc" })).status).toBe(200);
    const state = async () =>
      (await (await handle(localRequest(`${origin}/api/accounts/login?id=${r.id}`))).json()) as { state: string; why: string };
    for (let i = 0; i < 100 && (await state()).state === "waiting"; i++) await Bun.sleep(50);
    expect(await state()).toEqual({ state: "done", why: "" });
  } finally {
    process.env.PATH = path;
  }
});

test("a cleanup is marked started before its worker loads, so a second Scan in that gap is refused", async () => {
  const file = join(OPS, ".cleanup.json");
  markCleanup("plan");
  try {
    const r = await post("/api/cleanup/plan");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("cleanup is already planning");
  } finally {
    rmSync(file, { force: true });
  }
});

test("the Slack sign-in opens only while the Slack inbox waits for one", async () => {
  const r = await post("/api/slack-login");
  expect(r.status).toBe(404);
});
