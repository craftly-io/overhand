import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { addRequest, forgetRun, insideRun, RUN_KEY_ENV, RUN_KEY_HEADER, recordRun, recordSpawn, runKey, saveBeat } from "../src/control";
import { heldForOwner } from "../src/control-api";
import { openCli } from "../src/daemon";
import {
  hasLocalKey,
  isLocal,
  LOCAL_HEADER,
  localKey,
  newPairing,
  OPEN_TTL_MS,
  openLink,
  PAIR_TTL_MS,
  redeem,
  resetLocalKey,
  useOpenLink,
} from "../src/devices";
import { CFG, OPS, UI_PORT } from "../src/env";
import { handle } from "../src/server";
import { localRequest } from "./local";

const LOCAL = `http://127.0.0.1:${UI_PORT}`;
const PHONE = "https://mac.example.ts.net:8443";
const saved = CFG.dashboardOrigins;
beforeAll(() => {
  CFG.dashboardOrigins = [PHONE];
  rmSync(join(OPS, ".devices.json"), { force: true });
});
afterAll(() => {
  CFG.dashboardOrigins = saved;
  rmSync(join(OPS, ".devices.json"), { force: true });
});

/** A request as `tailscale serve` hands it on: the tailnet name as Host, plus its forwarding headers. */
const remote = (path: string, init: { method?: string; body?: object; cookie?: string; origin?: string } = {}) =>
  handle(
    new Request(`${PHONE}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        host: "mac.example.ts.net:8443",
        "x-forwarded-for": "100.64.0.7",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1",
        ...(init.body ? { origin: init.origin ?? PHONE, "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
  );
const local = (path: string, body?: object) =>
  handle(
    localRequest(`${LOCAL}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { origin: LOCAL, "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

/** Pairs a phone through the API and returns its cookie (name=value). */
async function pair(): Promise<string> {
  const { code } = (await (await local("/api/devices/pair", {})).json()) as { code: string };
  const r = await remote("/api/pair", { body: { code } });
  expect(r.status).toBe(200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

test("this machine's browser needs no session; a proxied request or another host name does", () => {
  expect(isLocal(new Request(`${LOCAL}/api/state`))).toBe(true);
  expect(isLocal(new Request(`http://localhost:${UI_PORT}/`))).toBe(true);
  expect(isLocal(new Request(`${PHONE}/api/state`))).toBe(false);
  // tailscale serve passes a spoofed Host through, but always adds its forwarding headers
  expect(isLocal(new Request(`${LOCAL}/api/state`, { headers: { "x-forwarded-for": "100.64.0.7" } }))).toBe(false);
  expect(isLocal(new Request(`${LOCAL}/api/state`, { headers: { forwarded: "for=100.64.0.7" } }))).toBe(false);
});

test("loopback with the local key needs no session; a remote request without one gets 401 everywhere", async () => {
  expect((await local("/api/devices")).status).toBe(200);
  for (const path of ["/api/devices", "/api/settings", "/api/state", "/api/events", "/api/phone", "/"])
    expect((await remote(path)).status, path).toBe(401);
  expect((await remote("/api/pause", { body: {} })).status).toBe(401);
  expect((await remote("/api/settings", { body: { config: {} } })).status).toBe(401);
  // a spoofed loopback Host through the proxy is still remote
  const spoofed = await handle(new Request(`${LOCAL}/api/devices`, { headers: { "x-forwarded-for": "100.64.0.7" } }));
  expect(spoofed.status).toBe(401);
});

test("a program on this machine without the local key (an agent's curl) gets nothing: every API and the page answer 401", async () => {
  const bare = (path: string, init: RequestInit = {}) => handle(new Request(`${LOCAL}${path}`, init));
  for (const path of ["/api/state", "/api/settings", "/api/devices", "/api/phone", "/api/events", "/"])
    expect((await bare(path)).status, path).toBe(401);
  const post = { method: "POST", headers: { origin: LOCAL, "content-type": "application/json" } };
  expect((await bare("/api/settings", { ...post, body: JSON.stringify({ config: {} }) })).status).toBe(401);
  expect((await bare("/api/devices/pair", { ...post, body: "{}" })).status).toBe(401);
  // a wrong key, by header or cookie, is no key
  expect((await bare("/api/state", { headers: { [LOCAL_HEADER]: "x".repeat(43) } })).status).toBe(401);
  expect((await bare("/api/state", { headers: { cookie: `overhand_local=${"x".repeat(43)}` } })).status).toBe(401);
});

test("the local key lives in control/, readable only by you, and stays the same", () => {
  const key = localKey();
  expect(key.length).toBeGreaterThanOrEqual(43);
  expect(localKey()).toBe(key);
  expect(statSync(join(OPS, "control", "local-key")).mode & 0o777).toBe(0o600);
});

test("a looser key file is made yours alone; a broken one is replaced; two callers at once get one key", () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-key-"));
  const f = join(ops, "control", "local-key");
  const k = localKey(ops);
  chmodSync(f, 0o644);
  expect(localKey(ops)).toBe(k);
  expect(statSync(f).mode & 0o777).toBe(0o600);
  // too short to be a key (a crash mid-write): after a brief wait, a fresh one
  writeFileSync(f, "short");
  const fresh = localKey(ops);
  expect(fresh.length).toBeGreaterThanOrEqual(43);
  expect(readFileSync(f, "utf8")).toBe(fresh);
  // another caller made it first: its key is used, never written over
  const other = mkdtempSync(join(tmpdir(), "overhand-key-"));
  const exists = spyOn(fs, "statSync").mockImplementationOnce(() => {
    writeFileSync(join(other, "control", "local-key"), "k".repeat(43), { mode: 0o600 });
    throw new Error("ENOENT");
  });
  fs.mkdirSync(join(other, "control"), { recursive: true });
  expect(localKey(other)).toBe("k".repeat(43));
  exists.mockRestore();
  rmSync(ops, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("the key file is read once per change, not on every request", () => {
  const ops = mkdtempSync(join(tmpdir(), "overhand-key-"));
  const k = localKey(ops);
  expect(localKey(ops)).toBe(k); // read once since it was made
  const read = spyOn(fs, "readFileSync");
  try {
    for (let i = 0; i < 5; i++) expect(localKey(ops)).toBe(k);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
  const next = resetLocalKey(ops);
  expect(localKey(ops)).toBe(next);
  rmSync(ops, { recursive: true, force: true });
});

test("a browser's cookie is made from the key, never the key itself; the key as a cookie is refused", async () => {
  const set = (await handle(new Request(openLink(LOCAL)))).headers.get("set-cookie") ?? "";
  const value = set.split(";")[0]?.split("=")[1] ?? "";
  expect(value).not.toBe("");
  expect(value).not.toContain(localKey());
  const req = (headers: Record<string, string>) => new Request(`${LOCAL}/api/state`, { headers });
  expect(hasLocalKey(req({ cookie: `overhand_local=${value}` }))).toBe(true);
  expect(hasLocalKey(req({ cookie: `overhand_local=${localKey()}` }))).toBe(false);
  // the CLI's header carries the key itself, and a cookie's value there is no key
  expect(hasLocalKey(req({ [LOCAL_HEADER]: localKey() }))).toBe(true);
  expect(hasLocalKey(req({ [LOCAL_HEADER]: value }))).toBe(false);
});

test("overhand open --reset makes a new key: every browser is signed out and old links stop working", async () => {
  const old = localKey();
  const cookie = ((await handle(new Request(openLink(LOCAL)))).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const link = openLink(LOCAL);
  // what `overhand open --reset` does first (openCli itself would open a browser on a daemon running here)
  resetLocalKey();
  expect(localKey()).not.toBe(old);
  expect(statSync(join(OPS, "control", "local-key")).mode & 0o777).toBe(0o600);
  expect((await handle(new Request(`${LOCAL}/api/state`, { headers: { cookie } }))).status).toBe(401);
  expect((await handle(new Request(`${LOCAL}/api/state`, { headers: { [LOCAL_HEADER]: old } }))).status).toBe(401);
  expect((await handle(new Request(link))).status).toBe(401);
  expect((await handle(localRequest(`${LOCAL}/api/state`))).status).toBe(200);
});

test("overhand open gives nothing inside a run Overhand started: by its record, or a run its environment names", async () => {
  const said = spyOn(console, "error").mockImplementation(() => {});
  const refused = () => said.mock.calls.some(([m]) => String(m).includes("inside an agent's run"));
  try {
    const key = localKey();
    expect(await openCli(["--reset"], { OVERHAND_RUN: "HONEY-12" })).toBe(1);
    expect(refused()).toBe(true);
    expect(localKey()).toBe(key);
    expect(insideRun(OPS, {}, [])).toBe(false);
    said.mockClear();
    // this test's parent stands in for the agent: the CLI runs below it
    recordRun(OPS, process.ppid, { run: "HONEY-12", autonomy: "act", project: "" });
    try {
      expect(await openCli(["--reset"], {})).toBe(1);
      expect(refused()).toBe(true);
      expect(localKey()).toBe(key);
    } finally {
      forgetRun(OPS, process.ppid);
    }
  } finally {
    said.mockRestore();
  }
});

test("an open link signs this machine's browser in once, within two minutes, and only from loopback", async () => {
  const at = Date.now();
  const code = (link: string) => new URL(link).searchParams.get("open") ?? "";
  const link = openLink(LOCAL, at);
  const r = await handle(new Request(link));
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/");
  const set = r.headers.get("set-cookie") ?? "";
  for (const part of ["HttpOnly", "SameSite=Lax", "Path=/"]) expect(set).toContain(part);
  const cookie = set.split(";")[0] ?? "";
  expect((await handle(new Request(`${LOCAL}/api/state`, { headers: { cookie } }))).status).toBe(200);
  // used once: the same link again is just a page without the key
  expect((await handle(new Request(link))).status).toBe(401);
  // expired, from the future, forged, and through the phone's proxy: no cookie
  expect(useOpenLink(code(openLink(LOCAL, at - OPEN_TTL_MS - 1)), at)).toBe(false);
  expect(useOpenLink(code(openLink(LOCAL, at + 60_000)), at)).toBe(false);
  expect(useOpenLink(`${at}.${"A".repeat(43)}`, at)).toBe(false);
  expect(useOpenLink(code(openLink(LOCAL, at, "another install's key that is long enough")), at)).toBe(false);
  const viaPhone = await remote(`/?open=${code(openLink(LOCAL))}`);
  expect(viaPhone.status).toBe(401);
  expect(viaPhone.headers.get("set-cookie")).toBeNull();
});

test("the browser cookie alone reaches the sign-in returns, but a POST from a foreign Origin is still refused", async () => {
  const cookie = ((await handle(new Request(openLink(LOCAL)))).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const browser = (path: string, init: RequestInit = {}) =>
    handle(new Request(`${LOCAL}${path}`, { ...init, headers: { cookie, ...init.headers } }));
  // reached, not refused: each fails only on its own single-use state or nonce
  const oauth = await browser("/oauth/callback/abc?state=x&code=y");
  expect(oauth.status).toBe(400);
  expect(await oauth.text()).toContain("expired");
  const relay = await browser("/api/relay/linked?nonce=x&cert=y");
  expect(relay.status).toBe(400);
  expect(await relay.text()).toContain("expired");
  const post = { method: "POST", body: "{}" };
  expect(
    (await browser("/api/pause", { ...post, headers: { origin: "https://evil.example", "content-type": "application/json" } })).status,
  ).toBe(403);
  expect((await browser("/api/pause", { ...post, headers: { "content-type": "application/json" } })).status).toBe(403);
});

test("a run's own key opens only ask, ack, answer and a lead's git and gh, as that run; an unknown or ended run's key opens nothing", async () => {
  const key = runKey();
  recordSpawn(OPS, { pid: process.pid, exited: new Promise(() => {}) }, { OVERHAND_RUN: "T-7", [RUN_KEY_ENV]: key });
  const asRun = (path: string, body: object, k = key) =>
    handle(
      new Request(`${LOCAL}${path}`, {
        method: "POST",
        headers: { origin: LOCAL, "content-type": "application/json", [RUN_KEY_HEADER]: k },
        body: JSON.stringify(body),
      }),
    );
  // nothing else: not the state, not settings, not pairing
  expect((await handle(new Request(`${LOCAL}/api/state`, { headers: { [RUN_KEY_HEADER]: key } }))).status).toBe(401);
  expect((await asRun("/api/settings", { config: {} })).status).toBe(401);
  expect((await asRun("/api/devices/pair", {})).status).toBe(401);
  // ack: only a request sent to one of its own sessions
  const theirs = addRequest(OPS, { from: "owner", to: "someone-else", toLabel: "x", text: "stop", by: 0 });
  expect((await asRun("/api/requests/ack", { id: theirs.id, state: "done" })).status).toBe(404);
  saveBeat(OPS, {
    ...{ id: "s-t7", run: "T-7", project: "", pid: 0, cwd: "/x", home: "", transcript: "", startedAt: 1, lastAt: 1 },
    ...{ lastTool: "", files: [], rulesSeen: "", prs: [] },
  });
  const mine = addRequest(OPS, { from: "owner", to: "s-t7", toLabel: "T-7", text: "wrap up", by: 0 });
  expect((await asRun("/api/requests/ack", { id: mine.id, state: "done" })).status).toBe(200);
  // a key no live run holds
  expect((await asRun("/api/requests/ack", { id: theirs.id, state: "done" }, runKey())).status).toBe(401);
  // a lead's question: only that lead's own run answers it, never a ticket run
  const leadApp = parseConfig({ ...CFG, godmode: [{ key: "app", label: "App", dir: "app" }] }).godmode;
  CFG.godmode = [...CFG.godmode, ...leadApp];
  expect((await asRun("/api/lead/answer", { key: "app", text: "yes", kind: "answer" })).status).toBe(403);
  CFG.godmode = CFG.godmode.filter((g) => g.key !== "app");
  // a request to one of your own sessions goes to you first
  expect(heldForOwner("T-7", "")).toBe(true);
  expect(heldForOwner("T-7", "hand-1a2b3c4d")).toBe(true);
  expect(heldForOwner("T-7", "unrecorded")).toBe(true);
  expect(heldForOwner("T-7", "lead-app")).toBe(false);
  expect(heldForOwner("", "")).toBe(false);
  forgetRun(OPS, process.pid);
  expect((await asRun("/api/requests/ack", { id: theirs.id, state: "done" })).status).toBe(401);
});

test("a pairing code works once, gives a hardened cookie, and the cookie opens the dashboard", async () => {
  const { code, url } = (await (await local("/api/devices/pair", {})).json()) as { code: string; url: string };
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
  expect(url).toBe(`${PHONE}/?pair=${code}`);
  const r = await remote("/api/pair", { body: { code: code.toLowerCase() } });
  expect(r.status).toBe(200);
  const set = r.headers.get("set-cookie") ?? "";
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Strict");
  expect(set).toContain("Secure");
  const cookie = set.split(";")[0] ?? "";
  // only its hash is kept
  expect(readFileSync(join(OPS, ".devices.json"), "utf8")).not.toContain(cookie.split("=")[1] ?? "nope");
  expect((await remote("/api/pair", { body: { code } })).status).toBe(400); // used up
  const list = await remote("/api/devices", { cookie });
  expect(list.status).toBe(200);
  const { devices } = (await list.json()) as { devices: { name: string; current: boolean }[] };
  expect(devices.find((d) => d.current)?.name).toBe("iPhone, Safari");
  // a made-up or fixed cookie is nobody
  expect((await remote("/api/devices", { cookie: "overhand_session=attacker-chosen" })).status).toBe(401);
});

test("a pairing code expires, and five wrong tries burn it", () => {
  const old = newPairing(Date.now() - PAIR_TTL_MS - 1);
  expect("error" in redeem(old.code, "")).toBe(true);
  const p = newPairing();
  for (let i = 0; i < 5; i++) expect("error" in redeem("WRONGWRONG", "")).toBe(true);
  expect("error" in redeem(p.code, "")).toBe(true);
});

test("a paired phone can't mint codes or serve the tailnet, and its POSTs still need the dashboard's Origin", async () => {
  const cookie = await pair();
  expect((await remote("/api/devices/pair", { body: {}, cookie })).status).toBe(403);
  expect((await remote("/api/phone/serve", { body: {}, cookie })).status).toBe(403);
  expect((await remote("/api/devices/revoke", { body: { id: "x" }, cookie, origin: "https://evil.example" })).status).toBe(403);
  expect((await remote("/api/pair", { body: { code: "X" }, origin: "https://evil.example" })).status).toBe(403);
});

test("a revoked device is refused at once", async () => {
  const cookie = await pair();
  const { devices } = (await (await remote("/api/devices", { cookie })).json()) as { devices: { id: string; current: boolean }[] };
  const me = devices.find((d) => d.current);
  expect((await local("/api/devices/revoke", { id: me?.id })).status).toBe(200);
  expect((await remote("/api/devices", { cookie })).status).toBe(401);
});

test("the reply token route and the OAuth callback keep their own rules", async () => {
  // a quick reply needs no session: it reaches the token check (and fails it), never the 401
  const reply = await remote("/api/lead/reply?t=bogus&c=0", { method: "POST" });
  expect(reply.status).not.toBe(401);
  // the OAuth callback is this machine only, even for a paired phone
  const cookie = await pair();
  expect((await remote("/oauth/callback/abc?state=x&code=y", { cookie })).status).toBe(403);
  expect((await local("/oauth/callback/abc?state=x&code=y")).status).toBe(400); // reached: an unknown sign-in
});

test("a host the dashboard doesn't answer to is refused before anything else", async () => {
  const cookie = await pair();
  const r = await handle(new Request(`${PHONE}/api/devices`, { headers: { host: "attacker.example", cookie } }));
  expect(r.status).toBe(403);
});
