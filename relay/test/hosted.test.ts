import { beforeEach, describe, expect, test } from "bun:test";
import {
  daemonProof,
  HOSTED_ALLOWANCE,
  type HostedJob,
  type HostedRunAnswer,
  newKeyPair,
  sign,
  signingKey,
  signToken,
} from "@overhand/contract";
import { billingPage } from "../src/billing";
import { keepsMargin, RUN_COST_PER_MIN_USD, RUN_MARGIN, RUN_PACKS } from "../src/cost";
import { appJwt, mintToken, minutesOf, type RunDeps, Runner, type RunnerState, recentRuns, reserve, runJob, settle } from "../src/hosted";
import { applyEvent, type D1, selectPacks } from "../src/paddle";
import { type Env, relayKeys, route } from "../src/worker";
import { type FakeSocket, fakeD1, fakeState, socket } from "./fakes";
import catalog from "./packs.json";

let db: D1;
const keys = await newKeyPair();
const nowhere = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 404 }) }) };
/** The relay's env for these tests: hosted runs switched on or off, nothing else reachable. */
const env = (on: boolean): Env => ({
  WORKSPACE: nowhere,
  TEAM: nowhere,
  DB: db,
  SIGNING_KEY: keys.priv,
  WORKOS_CLIENT_ID: "",
  WORKOS_API_KEY: "",
  TURN_KEY_ID: "",
  TURN_KEY_API_TOKEN: "",
  PADDLE_ENV: "sandbox",
  PADDLE_CLIENT_TOKEN: "",
  PADDLE_API_KEY: "",
  PADDLE_WEBHOOK_SECRET: "",
  SITE_ORIGIN: "",
  ...(on ? { HOSTED_RUNS: "1" } : {}),
});
beforeEach(() => {
  db = fakeD1();
});

const NOW = Date.parse("2026-10-25T12:00:00Z");
const job = (key = "HONEY-1"): HostedJob => ({
  key,
  project: "Honeycrust",
  repo: "acme/honeycrust",
  base: "main",
  title: "Fix the thing",
  brief: "",
  autonomy: "act",
  runtime: "claude-code",
  model: "",
  apiKey: "sk-ant-secret",
});

const credit = async (ws: string, minutes: number) =>
  db.prepare("INSERT INTO hosted_minutes (workspace, balance) VALUES (?, ?)").bind(ws, minutes).run();

describe("what a run minute costs and sells for", () => {
  test("our cost is about $0.00215 a full-CPU minute on standard-2", () => {
    expect(RUN_COST_PER_MIN_USD).toBeCloseTo(0.0021504, 6);
  });

  test("every pack, in RUN_PACKS and in the catalog, sells at least 2.5 times our cost", () => {
    const packs = selectPacks(catalog);
    expect(packs.map((p) => p.minutes)).toEqual(RUN_PACKS.map((p) => p.minutes));
    for (const p of packs) expect(keepsMargin(p.amount, p.currency, p.minutes)).toBe(true);
    for (const p of RUN_PACKS) expect(keepsMargin(p.eur * 100, "EUR", p.minutes)).toBe(true);
    // the check bites: at cost × 2 a pack is refused, and so is a currency it can't compare
    const atTwice = Math.floor(RUN_COST_PER_MIN_USD * 2 * 1000 * 100);
    expect(keepsMargin(atTwice, "USD", 1000)).toBe(false);
    expect(keepsMargin(Math.ceil(RUN_COST_PER_MIN_USD * RUN_MARGIN * 1000 * 100), "USD", 1000)).toBe(true);
    expect(keepsMargin(100_000, "JPY", 1000)).toBe(false);
  });

  test("packs are one-time prices tagged pack: minutes; plans and untagged prices aren't packs", () => {
    const plan = { ...catalog[0], id: "pri_plan", billing_cycle: { interval: "month", frequency: 1 } };
    const untagged = { ...catalog[0], id: "pri_x", custom_data: null };
    expect(selectPacks([plan, untagged, { junk: true }])).toEqual([]);
  });
});

/** A completed transaction webhook body, as Paddle sends one. */
const transaction = (id: string, ws: string, items: { minutes?: number; quantity?: number }[]) => ({
  event_id: id,
  event_type: "transaction.completed",
  occurred_at: "2026-10-25T10:00:00Z",
  data: {
    custom_data: { workspace: ws },
    items: items.map((i) => ({
      quantity: i.quantity ?? 1,
      price: { custom_data: i.minutes ? { pack: "minutes", minutes: i.minutes } : { plan: "pro", cycle: "month" } },
    })),
  },
});

describe("buying minutes", () => {
  test("a completed pack purchase credits the workspace once, however often Paddle sends it", async () => {
    expect(await applyEvent(db, transaction("evt_1", "user_A", [{ minutes: 1000, quantity: 2 }]), NOW)).toBe("applied");
    expect(await applyEvent(db, transaction("evt_1", "user_A", [{ minutes: 1000, quantity: 2 }]), NOW)).toBe("duplicate");
    expect(await applyEvent(db, transaction("evt_2", "user_A", [{ minutes: 5000 }]), NOW)).toBe("applied");
    expect((await minutesOf(db, "user_A", "pro", NOW)).balance).toBe(7000);
  });

  test("a plan's own transaction credits nothing", async () => {
    expect(await applyEvent(db, transaction("evt_3", "user_A", [{}]), NOW)).toBe("ignored");
    expect((await minutesOf(db, "user_A", "pro", NOW)).balance).toBe(0);
  });
});

describe("reserving minutes", () => {
  test("the allowance goes first, then bought minutes; too few and nothing is taken", async () => {
    await credit("w", 100);
    const r = await reserve(db, "w", "pro", 60, NOW);
    expect(r).toMatchObject({ fromAllowance: 60, fromBalance: 0 });
    // use up the allowance: 300 - 60 left = 240
    expect(await reserve(db, "w", "pro", 240, NOW)).toMatchObject({ fromAllowance: 240, fromBalance: 0 });
    expect(await reserve(db, "w", "pro", 60, NOW)).toMatchObject({ fromAllowance: 0, fromBalance: 60 });
    expect(await reserve(db, "w", "pro", 60, NOW)).toBeNull(); // 40 bought left
    expect(await minutesOf(db, "w", "pro", NOW)).toEqual({ balance: 40, allowanceLeft: 0, allowance: HOSTED_ALLOWANCE.pro });
  });

  test("what a run didn't use goes back, to bought minutes first; a new month brings the allowance back", async () => {
    await credit("w", 100);
    await reserve(db, "w", "pro", 300, NOW);
    const r = await reserve(db, "w", "pro", 60, NOW);
    expect(r).toMatchObject({ fromBalance: 60 });
    if (r) await settle(db, "w", r, 7, NOW);
    expect(await minutesOf(db, "w", "pro", NOW)).toMatchObject({ balance: 93, allowanceLeft: 0 });
    const next = Date.parse("2026-11-01T00:00:00Z");
    expect(await minutesOf(db, "w", "team", next)).toMatchObject({ balance: 93, allowanceLeft: HOSTED_ALLOWANCE.team });
  });
});

/** A run's world, with a container and GitHub that only record what they were asked. */
function fakeDeps(o: { plan?: "pro" | "team" | null; answer?: HostedRunAnswer | Error; ms?: number } = {}) {
  const calls = { box: 0, minted: [] as string[], revoked: [] as string[] };
  let t = NOW;
  const deps: RunDeps = {
    db,
    plan: async () => (o.plan === undefined ? "pro" : o.plan),
    mint: async (repo) => {
      calls.minted.push(repo);
      return "ghs_token";
    },
    revoke: async (token) => calls.revoked.push(token),
    box: async () => {
      calls.box++;
      t += o.ms ?? 4 * 60_000 + 1;
      if (o.answer instanceof Error) throw o.answer;
      return (
        o.answer ?? {
          status: "done",
          pr: "https://github.com/acme/honeycrust/pull/7",
          branch: "overhand/HONEY-1",
          draft: false,
          summary: "Fixed it.",
        }
      );
    },
    maxMin: 60,
    now: () => t,
  };
  return { deps, calls };
}

describe("one hosted run", () => {
  test("runs, charges the minutes it took (rounded up), gives back the rest and revokes its token", async () => {
    const { deps, calls } = fakeDeps();
    const r = await runJob("w", job(), deps);
    expect(r).toMatchObject({ status: "done", pr: "https://github.com/acme/honeycrust/pull/7", minutes: 5 });
    expect(calls).toEqual({ box: 1, minted: ["acme/honeycrust"], revoked: ["ghs_token"] });
    expect((await minutesOf(db, "w", "pro", NOW)).allowanceLeft).toBe(HOSTED_ALLOWANCE.pro - 5);
    expect((await recentRuns(db, "w")).map((x) => x.status)).toEqual(["done"]);
  });

  test("without the minutes for its longest length it never starts, and costs nothing", async () => {
    await reserve(db, "w", "pro", HOSTED_ALLOWANCE.pro - 10, NOW);
    const { deps, calls } = fakeDeps();
    expect(await runJob("w", job(), deps)).toMatchObject({ status: "no-minutes", minutes: 0 });
    expect(calls.box).toBe(0);
    expect(calls.minted).toEqual([]);
  });

  test("without a plan it never starts", async () => {
    const { deps, calls } = fakeDeps({ plan: null });
    expect(await runJob("w", job(), deps)).toMatchObject({ status: "not-started" });
    expect(calls.box).toBe(0);
  });

  test("a run that fails says so in one line, with its key and token taken out, and still revokes the token", async () => {
    const { deps, calls } = fakeDeps({ answer: new Error("push refused for ghs_token using sk-ant-secret") });
    const r = await runJob("w", job(), deps);
    expect(r.status).toBe("failed");
    expect(r.summary).toBe("push refused for [hidden] using [hidden]");
    expect(calls.revoked).toEqual(["ghs_token"]);
    const stored = JSON.stringify(await db.prepare("SELECT * FROM hosted_runs").all());
    expect(stored).not.toContain("sk-ant-secret");
    expect(stored).not.toContain("ghs_token");
  });
});

/** A Runner's state: the hibernation API's sockets, storage as a map, and the one alarm. */
function runnerState() {
  const st = fakeState();
  const data = new Map<string, unknown>();
  const alarm = { at: null as number | null };
  const state: RunnerState = {
    ...st,
    storage: {
      get: async <T>(k: string) => data.get(k) as T | undefined,
      put: async (k, v) => {
        data.set(k, structuredClone(v));
      },
      delete: async (k) => data.delete(k),
      setAlarm: async (at) => {
        alarm.at = at;
      },
      deleteAlarm: async () => {
        alarm.at = null;
      },
    },
  };
  return { state, data, alarm };
}

describe("the Runner", () => {
  const runner = (grace = 120_000) => {
    const ran: string[] = [];
    const { deps } = fakeDeps();
    const s = runnerState();
    const r = new Runner(s.state, env(true), {
      grace,
      hold: 0,
      deps: () => ({
        ...deps,
        box: async (j, t, m) => {
          ran.push(`${j.key}:${j.apiKey}`);
          return deps.box(j, t, m);
        },
      }),
    });
    return { r, ran, ...s };
  };
  const hand = (jobs: HostedJob[]) => JSON.stringify({ type: "hand", jobs });
  const close = async (r: Runner, sock: FakeSocket) => {
    sock.closed = 1006;
    await r.webSocketClose(sock);
  };

  test("a close sets the alarm for the grace's end; a reconnect cancels it", async () => {
    const { r, alarm } = runner();
    const sock = socket();
    await r.accept(sock, "w");
    const before = Date.now();
    await close(r, sock);
    expect(alarm.at).toBeGreaterThanOrEqual(before + 120_000);
    await r.accept(socket(), "w");
    expect(alarm.at).toBeNull();
  });

  test("the list is stored without its keys; at the alarm, each ticket runs on the key its socket carried", async () => {
    const { r, ran, data } = runner();
    const sock = socket();
    await r.accept(sock, "w");
    await r.webSocketMessage(sock, hand([job("HONEY-1"), job("HONEY-2")]));
    expect(JSON.stringify([...data.entries()])).not.toContain("sk-ant-secret");
    expect(JSON.stringify(sock.attachment)).toContain("sk-ant-secret"); // held with the socket, in the runtime's memory
    await close(r, sock);
    await r.alarm();
    expect(ran).toEqual(["HONEY-1:sk-ant-secret", "HONEY-2:sk-ant-secret"]);
    expect(data.has("jobs")).toBe(false);
    const back = socket();
    await r.accept(back, "w");
    expect(back.sent[0]).toEqual({ type: "taken", keys: ["HONEY-1", "HONEY-2"] });
  });

  test("an alarm with the computer back runs nothing", async () => {
    const { r, ran } = runner();
    const sock = socket();
    await r.accept(sock, "w");
    await r.webSocketMessage(sock, hand([job()]));
    await r.accept(socket(), "w"); // a second connection before the first closes
    await close(r, sock);
    await r.alarm();
    expect(ran).toEqual([]);
  });

  test("evicted during the grace, the keys are gone: nothing runs, and each ticket is recorded as not started", async () => {
    const s = runnerState();
    const { deps, calls } = fakeDeps();
    const first = new Runner(s.state, env(true), { deps: () => deps, hold: 0 });
    const sock = socket();
    await first.accept(sock, "w");
    await first.webSocketMessage(sock, hand([job()]));
    sock.closed = 1006;
    await first.webSocketClose(sock);
    // a fresh object, woken by the alarm, has the stored list and no keys
    await new Runner(s.state, env(true), { deps: () => deps }).alarm();
    expect(calls.box).toBe(0);
    expect((await recentRuns(db, "w")).map((x) => x.status)).toEqual(["not-started"]);
  });

  test("an empty or broken hand-off holds nothing", async () => {
    const { r, ran } = runner();
    const sock = socket();
    await r.accept(sock, "w");
    await r.webSocketMessage(sock, hand([job()]));
    await r.webSocketMessage(sock, hand([]));
    await r.webSocketMessage(sock, "not json");
    await close(r, sock);
    await r.alarm();
    expect(ran).toEqual([]);
  });
});

describe("the GitHub App's token", () => {
  test("a JWT signed by the App's key, then a token for that one repository only", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
    const jwt = await appJwt("123", pem, NOW);
    const [h, p, sig] = jwt.split(".");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      Buffer.from(sig ?? "", "base64url"),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(p ?? "", "base64url").toString())).toMatchObject({ iss: "123" });

    const asked: { url: string; body: unknown }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith("/repos/acme/honeycrust/installation")) return Response.json({ id: 9 });
        if (url.endsWith("/app/installations/9/access_tokens")) return Response.json({ token: "ghs_x" });
        return new Response(null, { status: 404 });
      },
      { preconnect: real.preconnect },
    );
    try {
      expect(await mintToken({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem }, "acme/honeycrust", NOW)).toBe("ghs_x");
      expect(asked[1]?.body).toEqual({
        repositories: ["honeycrust"],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      });
      await expect(mintToken({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem }, "acme/other", NOW)).rejects.toThrow(
        "isn't installed on acme/other",
      );
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("the daemon's routes", () => {
  const daemon = async (ws: string) => {
    const dk = await newKeyPair();
    const cert = await signToken((await relayKeys(env(true))).sign, {
      typ: "link",
      ws,
      email: "e",
      pub: dk.pub,
      name: "Mac",
      iat: Date.now(),
    });
    return async (method: string, path: string) => {
      const ts = Date.now();
      return {
        "x-overhand-cert": cert,
        "x-overhand-ts": String(ts),
        "x-overhand-sig": await sign(await signingKey(dk.priv), daemonProof(method, path, ts)),
      };
    };
  };

  test("switched off, every hosted route is a 404", async () => {
    const h = await daemon("w");
    const r = await route(
      new Request("https://app.example/relay/hosted/runs", { headers: await h("GET", "/relay/hosted/runs") }),
      env(false),
    );
    expect(r.status).toBe(404);
  });

  test("finished runs come back once, then not after they're marked taken in", async () => {
    const { deps } = fakeDeps();
    await runJob("w", job(), deps);
    const h = await daemon("w");
    const get = async () =>
      (await (
        await route(new Request("https://app.example/relay/hosted/runs", { headers: await h("GET", "/relay/hosted/runs") }), env(true))
      ).json()) as {
        runs: { key: string; at: number }[];
      };
    const first = await get();
    expect(first.runs.map((r) => r.key)).toEqual(["HONEY-1"]);
    const seen = await route(
      new Request("https://app.example/relay/hosted/seen", {
        method: "POST",
        headers: { ...(await h("POST", "/relay/hosted/seen")), "content-type": "application/json" },
        body: JSON.stringify({ upTo: first.runs[0]?.at ?? 0 }),
      }),
      env(true),
    );
    expect(seen.status).toBe(200);
    expect((await get()).runs).toEqual([]);
  });

  test("the hand-off socket needs a paid plan", async () => {
    const h = await daemon("w");
    const r = await route(
      new Request("https://app.example/relay/hosted/ws", { headers: { ...(await h("GET", "/relay/hosted/ws")), upgrade: "websocket" } }),
      env(true),
    );
    expect(r.status).toBe(402);
  });
});

describe("the billing page", () => {
  test("shows the minutes left, the packs and each run's minutes where hosted runs are on", async () => {
    const { deps } = fakeDeps();
    await runJob("w", job(), deps);
    const html = billingPage({
      session: { typ: "session", ws: "w", email: "a@b", iat: 0, exp: 0 },
      catalog: null,
      entitlement: null,
      active: true,
      linked: true,
      clientToken: "",
      environment: "sandbox",
      picked: "",
      site: "https://x",
      nonce: "n",
      hosted: {
        minutes: await minutesOf(db, "w", "pro", NOW),
        runs: await recentRuns(db, "w"),
        packs: selectPacks(catalog),
        maxMin: 60,
        plan: true,
      },
    });
    expect(html).toContain("295 run minutes");
    expect(html).toContain("Buy 1,000 run minutes · €6");
    expect(html).toContain("HONEY-1 in Honeycrust · 5 min · PR opened");
    expect(billingPage({ ...pageArgs(), hosted: null })).not.toContain("Run minutes");
  });
});

const pageArgs = () => ({
  session: { typ: "session" as const, ws: "w", email: "a@b", iat: 0, exp: 0 },
  catalog: null,
  entitlement: null,
  active: false,
  linked: true,
  clientToken: "",
  environment: "sandbox",
  picked: "",
  site: "https://x",
  nonce: "n",
});
