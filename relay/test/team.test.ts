import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  daemonProof,
  newKeyPair,
  parseTeamSend,
  readToken,
  SEAT_GRACE_MS,
  sign,
  signingKey,
  signToken,
  type TeamIncoming,
  TeamRosterSchema,
  verifyingKey,
} from "@overhand/contract";
import { EUR_PER_USD, monthlyCostWithTeams, TEAM_TEN_K, TEN_K } from "../src/cost";
import type { D1 } from "../src/paddle";
import { RATE_PER_MINUTE, ROOM_CHECK_MS, TeamRoom } from "../src/room";
import { access } from "../src/team";
import { type Env, relayKeys, route } from "../src/worker";
import { type FakeSocket, fakeD1, fakeRoomState, socket } from "./fakes";

const keys = await newKeyPair();
const APP = "https://app.example";
let db: D1;
/** What the Worker told teams' rooms: [team, x-room]. */
const told: [string, string][] = [];
const env = (): Env => ({
  WORKSPACE: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("signal") }) },
  TEAM: {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (req) => {
        told.push([
          String(id),
          req.headers.get("x-room") ?? (req.headers.get("upgrade") ? `ws:${req.headers.get("x-user")}:${req.headers.get("x-since")}` : ""),
        ]);
        return new Response(null, { status: 204 });
      },
    }),
  },
  DB: db,
  SIGNING_KEY: keys.priv,
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  TURN_KEY_ID: "turn",
  TURN_KEY_API_TOKEN: "token",
  PADDLE_ENV: "sandbox",
  PADDLE_CLIENT_TOKEN: "test_token",
  PADDLE_API_KEY: "pdl_sdbx",
  PADDLE_WEBHOOK_SECRET: "pdl_ntfset_secret",
  SITE_ORIGIN: "https://www.example",
});

/** WorkOS as the relay sees it: organisations and memberships, recorded. */
const workosCalls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  db = fakeD1();
  told.length = 0;
  workosCalls.length = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      workosCalls.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
      if (u.endsWith("/organizations")) return Response.json({ id: `org_${workosCalls.length}` });
      if (u.includes("organization_memberships?")) return Response.json({ data: [{ id: "om_1" }] });
      return Response.json({ id: "om_1" });
    },
    { preconnect: realFetch.preconnect },
  );
});
// the fake stays inside this file: other suites in the same run use the real fetch
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function plan(ws: string, seats: number, planName = "team", status = "active") {
  await db
    .prepare(
      "INSERT OR REPLACE INTO entitlements VALUES (?, ?, 'month', ?, ?, 'sub_1', 'ctm_1', 'pri_1', NULL, '2026-01-01T00:00:00Z', NULL, NULL)",
    )
    .bind(ws, planName, seats, status)
    .run();
}

/** A person with a signed-in browser and a linked daemon. */
async function person(user: string, email = `${user}@x.dev`) {
  const k = await relayKeys(env());
  const session = await signToken(k.sign, { typ: "session", ws: user, email, iat: Date.now(), exp: Date.now() + 60_000 });
  const dk = await newKeyPair();
  const cert = await signToken(k.sign, { typ: "link", ws: user, email, pub: dk.pub, name: "Mac", iat: Date.now() });
  /** A request from their browser (same origin unless `origin` says otherwise). */
  const browser = (method: string, path: string, body?: unknown, origin = APP) =>
    route(
      new Request(`${APP}${path}`, {
        method,
        headers: { cookie: `hl_session=${session}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env(),
    );
  /** A request from their daemon, signed with its device key. */
  const daemon = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const ts = Date.now();
    const url = new URL(`${APP}${path}`);
    return route(
      new Request(url, {
        method,
        headers: {
          "x-overhand-cert": cert,
          "x-overhand-ts": String(ts),
          "x-overhand-sig": await sign(await signingKey(dk.priv), daemonProof(method, url.pathname, ts)),
          ...extra,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env(),
    );
  };
  /** Opens an invite link and joins, as this person's browser. */
  const join = async (link: string) => {
    const t = new URL(link).searchParams.get("t") ?? "";
    const form = new FormData();
    form.set("t", t);
    return route(
      new Request(`${APP}/relay/join`, { method: "POST", headers: { cookie: `hl_session=${session}`, origin: APP }, body: form }),
      env(),
    );
  };
  return { user, email, session, browser, daemon, join };
}

/** Owner with a Team plan of `seats` and a team called Crew. */
async function teamOf(seats = 5) {
  const owner = await person("user_owner", "owner@x.dev");
  await plan(owner.user, seats);
  const r = await owner.browser("POST", "/relay/team/create", { name: "Crew" });
  expect(r.status).toBe(200);
  const roster = TeamRosterSchema.parse(await r.json());
  return { owner, roster };
}

async function invite(by: Awaited<ReturnType<typeof person>>, email: string, role = "member") {
  const r = await by.browser("POST", "/relay/team/invite", { email, role });
  return { status: r.status, body: (await r.json()) as { link?: string; id?: string; error?: string } };
}

async function member(owner: Awaited<ReturnType<typeof person>>, user: string, role = "member") {
  const p = await person(user);
  const inv = await invite(owner, p.email, role);
  expect(inv.status).toBe(200);
  const j = await p.join(inv.body.link ?? "");
  expect(j.status).toBe(200);
  return p;
}

describe("creating a team", () => {
  test("needs the Team plan; makes a WorkOS organisation whose id is the team's; the creator is the owner", async () => {
    const solo = await person("user_solo");
    expect((await solo.browser("POST", "/relay/team/create", { name: "Crew" })).status).toBe(402);
    await plan(solo.user, 3, "pro");
    expect((await solo.browser("POST", "/relay/team/create", { name: "Crew" })).status).toBe(402);
    const { roster } = await teamOf(3);
    expect(roster.team.id).toMatch(/^org_/);
    expect(roster.role).toBe("owner");
    expect(roster.seats).toBe(3);
    expect(workosCalls).toContain("POST /organizations");
    expect(workosCalls).toContain("POST /user_management/organization_memberships");
  });

  test("one team per person", async () => {
    const { owner } = await teamOf();
    expect((await owner.browser("POST", "/relay/team/create", { name: "Again" })).status).toBe(409);
  });

  test("two creates at once make one team; the other answers 409 and its organisation is deleted again", async () => {
    const owner = await person("user_owner", "owner@x.dev");
    await plan(owner.user, 3);
    // WorkOS answers both only once both asked: each create passed the "in a team already?" check before either wrote
    const fake = globalThis.fetch;
    let release = () => {};
    const bothAsked = new Promise<void>((r) => {
      release = r;
    });
    let asked = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/organizations") && ++asked === 2) release();
        if (String(input).endsWith("/organizations")) await bothAsked;
        return fake(input, init);
      },
      { preconnect: fake.preconnect },
    );
    const both = await Promise.all([
      owner.browser("POST", "/relay/team/create", { name: "Crew" }),
      owner.browser("POST", "/relay/team/create", { name: "Crew" }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM teams").first())?.n).toBe(1);
    expect(workosCalls.filter((c) => c.startsWith("POST /organizations")).length).toBe(2);
    expect(workosCalls.filter((c) => c.startsWith("DELETE /organizations/")).length).toBe(1);
  });
});

describe("authorisation at every team route", () => {
  test("anonymous and cross-site requests are refused; non-members see no team", async () => {
    const { owner } = await teamOf();
    const anon = await route(new Request(`${APP}/relay/team`), env());
    expect(anon.status).toBe(401);
    const stranger = await person("user_stranger");
    expect((await stranger.browser("GET", "/relay/team")).status).toBe(404);
    for (const path of ["/relay/team/invite", "/relay/team/invite/revoke", "/relay/team/role", "/relay/team/remove", "/relay/team/project"])
      expect((await stranger.browser("POST", path, {})).status, path).toBe(404);
    // a browser write from another site rides no cookie into the team
    expect((await owner.browser("POST", "/relay/team/invite", { email: "a@x.dev" }, "https://evil.example")).status).toBe(401);
    // a daemon whose signature doesn't match its certificate is nobody
    const forged = await route(
      new Request(`${APP}/relay/team`, {
        headers: { "x-overhand-cert": "x.y", "x-overhand-ts": String(Date.now()), "x-overhand-sig": "z" },
      }),
      env(),
    );
    expect(forged.status).toBe(401);
  });

  test("members read and leave; only admins invite, set roles and owners; only the owner touches admins", async () => {
    const { owner } = await teamOf(6);
    const ann = await member(owner, "user_ann");
    const bob = await member(owner, "user_bob", "admin");
    const cat = await member(owner, "user_cat");
    // a member: read yes; admin actions no
    expect((await ann.browser("GET", "/relay/team")).status).toBe(200);
    expect((await ann.daemon("GET", "/relay/team")).status).toBe(200);
    expect((await ann.browser("POST", "/relay/team/invite", { email: "z@x.dev" })).status).toBe(403);
    expect((await ann.browser("POST", "/relay/team/role", { user: cat.user, role: "admin" })).status).toBe(403);
    expect((await ann.browser("POST", "/relay/team/project", { project: "Shop", owner: ann.user, backup: null })).status).toBe(403);
    expect((await ann.browser("POST", "/relay/team/remove", { user: cat.user })).status).toBe(403);
    expect((await ann.browser("POST", "/relay/team/invite/revoke", { id: "x" })).status).toBe(403);
    // members don't see invites
    await invite(owner, "pending@x.dev");
    expect(TeamRosterSchema.parse(await (await ann.browser("GET", "/relay/team")).json()).invites).toEqual([]);
    expect(TeamRosterSchema.parse(await (await bob.browser("GET", "/relay/team")).json()).invites.length).toBe(1);
    // an admin: members yes, admins and the owner no
    expect((await bob.browser("POST", "/relay/team/role", { user: cat.user, role: "admin" })).status).toBe(200);
    expect((await bob.browser("POST", "/relay/team/role", { user: cat.user, role: "member" })).status).toBe(403);
    expect((await bob.browser("POST", "/relay/team/remove", { user: cat.user })).status).toBe(403);
    expect((await bob.browser("POST", "/relay/team/remove", { user: owner.user })).status).toBe(403);
    expect((await bob.browser("POST", "/relay/team/role", { user: owner.user, role: "member" })).status).toBe(403);
    expect((await bob.browser("POST", "/relay/team/project", { project: "Shop", owner: ann.user, backup: bob.user })).status).toBe(200);
    // owners and backups must be members, and two different people
    expect((await bob.browser("POST", "/relay/team/project", { project: "Shop", owner: "user_stranger", backup: null })).status).toBe(400);
    expect((await bob.browser("POST", "/relay/team/project", { project: "Shop", owner: ann.user, backup: ann.user })).status).toBe(400);
    // the owner may change an admin; nobody removes the owner, not even the owner
    expect((await owner.browser("POST", "/relay/team/role", { user: cat.user, role: "member" })).status).toBe(200);
    expect((await owner.browser("POST", "/relay/team/remove", { user: owner.user })).status).toBe(403);
    // a member may leave
    expect((await cat.browser("POST", "/relay/team/remove", { user: cat.user })).status).toBe(200);
    expect((await cat.browser("GET", "/relay/team")).status).toBe(404);
  });

  test("only a member's daemon opens the room; their browser can't", async () => {
    const { owner, roster } = await teamOf();
    expect((await owner.browser("GET", "/relay/team/ws", undefined)).status).toBe(403);
    told.length = 0;
    const r = await owner.daemon("GET", "/relay/team/ws?since=7", undefined, { upgrade: "websocket", "x-user": "user_spoofed" });
    expect(r.status).toBe(204);
    // the room hears who the Worker authenticated, never a header the client sent
    expect(told).toEqual([[roster.team.id, `ws:${owner.user}:7`]]);
  });
});

describe("invites", () => {
  test("a link joins only the invited address, once, before it expires; the member then sees the team", async () => {
    const { owner, roster } = await teamOf();
    const ann = await person("user_ann", "ann@x.dev");
    // addresses match whatever their case
    const inv = await invite(owner, "ANN@x.dev");
    expect(inv.status).toBe(200);
    const link = inv.body.link ?? "";
    expect(link).toMatch(/\/relay\/join\?t=[0-9a-f]{48}$/);
    // only the hash is stored
    const stored = await db.prepare("SELECT id FROM team_invites").first();
    expect(String(stored?.id)).not.toContain(new URL(link).searchParams.get("t") ?? "");
    // signed out: sign in first
    const anon = await route(new Request(link), env());
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toStartWith("/relay/login?next=");
    // the wrong person
    const eve = await person("user_eve");
    expect((await eve.join(link)).status).toBe(403);
    // the right person: a confirmation page, then joining (same origin only)
    const page = await route(new Request(link, { headers: { cookie: `hl_session=${ann.session}` } }), env());
    expect(await page.text()).toContain("Join Crew as a member?");
    const cross = new FormData();
    cross.set("t", new URL(link).searchParams.get("t") ?? "");
    const forged = await route(
      new Request(`${APP}/relay/join`, {
        method: "POST",
        headers: { cookie: `hl_session=${ann.session}`, origin: "https://evil.example" },
        body: cross,
      }),
      env(),
    );
    expect(forged.status).toBe(403);
    expect((await ann.join(link)).status).toBe(200);
    expect(told).toContainEqual([roster.team.id, "roster"]);
    const seen = TeamRosterSchema.parse(await (await ann.daemon("GET", "/relay/team")).json());
    expect(seen.members.map((m) => m.user)).toEqual([owner.user, ann.user]);
    // used up
    expect((await ann.join(link)).status).toBe(410);
  });

  test("an expired or withdrawn invite doesn't work", async () => {
    const { owner } = await teamOf();
    const ann = await person("user_ann");
    const inv = await invite(owner, ann.email);
    await db.prepare("UPDATE team_invites SET expires_at = 1").run();
    expect((await ann.join(inv.body.link ?? "")).status).toBe(410);
    const again = await invite(owner, ann.email);
    expect((await owner.browser("POST", "/relay/team/invite/revoke", { id: again.body.id })).status).toBe(200);
    expect((await ann.join(again.body.link ?? "")).status).toBe(410);
  });
});

describe("seats", () => {
  test("invites stop at the seats, a pending invite holds one, and a seated member gets hosted access", async () => {
    const { owner } = await teamOf(3);
    const ann = await member(owner, "user_ann");
    expect((await invite(owner, "bob@x.dev")).status).toBe(200);
    const full = await invite(owner, "cat@x.dev");
    expect(full.status).toBe(402);
    expect(full.body.error).toContain("All 3 seats");
    // re-inviting the same address replaces its invite rather than taking another seat
    expect((await invite(owner, "bob@x.dev")).status).toBe(200);
    // Ann has no plan of her own: her seat gives her daemon a Team entitlement
    const ent = await ann.daemon("POST", "/relay/entitlement");
    expect(ent.status).toBe(200);
    const token = ((await ent.json()) as { token: string }).token;
    const claim = await readToken(await verifyingKey((await relayKeys(env())).pub), token, "ent");
    expect(claim).toMatchObject({ ws: ann.user, plan: "team", seats: 3 });
  });

  test("past the seats everyone keeps working through the grace, then the newest members stop", async () => {
    const { owner } = await teamOf(3);
    const ann = await member(owner, "user_ann");
    const bob = await member(owner, "user_bob");
    // the owner cuts the plan to 2 seats in Billing; the webhook records it
    await plan(owner.user, 2);
    const now = Date.now();
    expect(await access(db, bob.user, now)).not.toBeNull();
    const r = TeamRosterSchema.parse(await (await bob.browser("GET", "/relay/team")).json());
    expect(r.over?.until).toBeGreaterThan(now);
    expect(r.members.every((m) => m.seated)).toBe(true);
    // after the grace: the owner and Ann (who joined first) keep their seats
    const later = now + SEAT_GRACE_MS + 1;
    expect(await access(db, ann.user, later)).not.toBeNull();
    expect(await access(db, bob.user, later)).toBeNull();
    await db
      .prepare("UPDATE teams SET over_since = ?")
      .bind(now - SEAT_GRACE_MS - 1)
      .run();
    expect((await bob.daemon("GET", "/relay/team/ws", undefined, { upgrade: "websocket" })).status).toBe(402);
    expect((await bob.daemon("POST", "/relay/entitlement")).status).toBe(402);
    expect((await ann.daemon("GET", "/relay/team/ws", undefined, { upgrade: "websocket" })).status).toBe(204);
    // a seat added back ends it
    await plan(owner.user, 3);
    expect(await access(db, bob.user, later)).not.toBeNull();
    expect((await db.prepare("SELECT over_since FROM teams").first())?.over_since).toBeNull();
  });

  test("a lapsed plan closes the room after the grace", async () => {
    const { owner } = await teamOf(2);
    await plan(owner.user, 2, "team", "canceled");
    expect((await owner.daemon("GET", "/relay/team/ws", undefined, { upgrade: "websocket" })).status).toBe(402);
    expect((await invite(owner, "x@x.dev")).status).toBe(402);
  });
});

describe("removal", () => {
  test("removing a member revokes everything at once: their socket, the routes, ownership and hosted access", async () => {
    const { owner, roster } = await teamOf(4);
    const ann = await member(owner, "user_ann");
    const bob = await member(owner, "user_bob");
    await owner.browser("POST", "/relay/team/project", { project: "Shop", owner: ann.user, backup: bob.user });
    expect(await access(db, ann.user, Date.now())).not.toBeNull();
    told.length = 0;
    expect((await owner.browser("POST", "/relay/team/remove", { user: ann.user })).status).toBe(200);
    expect(told).toEqual([
      [roster.team.id, `kick:${ann.user}`],
      [roster.team.id, "roster"],
    ]);
    expect(workosCalls).toContain("DELETE /user_management/organization_memberships/om_1");
    expect((await ann.daemon("GET", "/relay/team")).status).toBe(404);
    expect((await ann.daemon("GET", "/relay/team/ws", undefined, { upgrade: "websocket" })).status).toBe(404);
    expect(await access(db, ann.user, Date.now())).toBeNull();
    expect((await ann.daemon("POST", "/relay/entitlement")).status).toBe(402);
    const after = TeamRosterSchema.parse(await (await bob.browser("GET", "/relay/team")).json());
    expect(after.projects).toEqual([{ project: "Shop", owner: null, backup: bob.user }]);
  });
});

// ── the room ──

type Sock = FakeSocket<TeamIncoming>;
const presence = (agents: number) => ({ k: "presence" as const, agents, quiet: false, viewing: null, claims: [], projects: [] });
const question = (id: string, text = "Which payment provider should the checkout use?") => ({
  k: "question",
  id,
  project: "Shop",
  lead: "Shop lead",
  text,
  fallback: "",
});

function room(clock = () => Date.now()) {
  const st = fakeRoomState<TeamIncoming>();
  return { st, r: new TeamRoom(st, { DB: db }, clock) };
}
const join = async (r: TeamRoom, user: string, since = 0, team = "team_1"): Promise<Sock> => {
  const s = socket<TeamIncoming>();
  await r.accept(s, user, team, since);
  return s;
};

describe("access while connected", () => {
  /** A team of the owner, Ann and Bob, each with a room socket. */
  async function connected(seats: number, clock: () => number) {
    const { owner, roster } = await teamOf(3);
    const ann = await member(owner, "user_ann");
    const bob = await member(owner, "user_bob");
    await plan(owner.user, seats);
    const { st, r } = room(clock);
    const [o, a, b] = [
      await join(r, owner.user, 0, roster.team.id),
      await join(r, ann.user, 0, roster.team.id),
      await join(r, bob.user, 0, roster.team.id),
    ];
    return { owner, st, r, o, a, b };
  }

  test("a lapsed plan closes every socket on the billing check, with the reason", async () => {
    const { owner, r, o, a, b } = await connected(3, () => Date.now());
    await r.check();
    expect([o.closed, a.closed, b.closed]).toEqual([null, null, null]);
    await plan(owner.user, 3, "team", "canceled");
    const res = await r.fetch(new Request("https://room/control", { method: "POST", headers: { "x-room": "check" } }));
    expect(res.status).toBe(204);
    expect([o.closed, a.closed, b.closed]).toEqual([4001, 4001, 4001]);
  });

  test("fewer seats: everyone stays through the grace; when it ends the timer closes the newest member only", async () => {
    let t = Date.now();
    const { st, r, o, a, b } = await connected(2, () => t);
    expect(st.alarm).toBe(t + ROOM_CHECK_MS);
    await r.alarm();
    expect([o.closed, a.closed, b.closed]).toEqual([null, null, null]);
    t += SEAT_GRACE_MS + 1;
    await r.alarm();
    expect([o.closed, a.closed, b.closed]).toEqual([null, null, 4001]);
    expect(o.sent.at(-1)).toMatchObject({ k: "leave", by: "user_bob" });
    // still connected members keep the timer going
    expect(st.alarm).toBe(t + ROOM_CHECK_MS);
  });

  test("a member removed from D1 is closed on the next check; a valid member stays", async () => {
    const { r, o, a, b } = await connected(3, () => Date.now());
    await db.prepare("DELETE FROM team_members WHERE user = ?").bind("user_ann").run();
    await r.check();
    expect([o.closed, a.closed, b.closed]).toEqual([null, 4001, null]);
  });
});

describe("the team room", () => {
  test("presence fans out to the others, stamped, and is never logged; events are logged and reach everyone", async () => {
    const { r } = room();
    const a = await join(r, "user_a");
    const b = await join(r, "user_b");
    expect(a.sent.at(-1)).toMatchObject({ k: "join", by: "user_b" });
    // a client can't say who it is: a message naming its sender is dropped whole
    await r.webSocketMessage(a, JSON.stringify({ ...presence(3), by: "user_b" }));
    expect(b.sent.at(-1)).toMatchObject({ k: "hello" });
    await r.webSocketMessage(a, JSON.stringify(presence(3)));
    expect(b.sent.at(-1)).toMatchObject({ k: "presence", agents: 3, by: "user_a" });
    expect(a.sent.filter((m) => m.k === "presence")).toEqual([]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM team_events").first())?.n).toBe(0);
    await r.webSocketMessage(a, JSON.stringify(question("q-1")));
    expect(a.sent.at(-1)).toMatchObject({ k: "question", id: "q-1", by: "user_a", seq: 1 });
    expect(b.sent.at(-1)).toMatchObject({ k: "question", id: "q-1", by: "user_a", seq: 1 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM team_events").first())?.n).toBe(1);
  });

  test("a member who was offline catches up in one hello: who's online, and what they missed since their last event", async () => {
    const { r } = room();
    const a = await join(r, "user_a");
    await r.webSocketMessage(a, JSON.stringify(presence(2)));
    await r.webSocketMessage(a, JSON.stringify(question("q-1")));
    await r.webSocketMessage(a, JSON.stringify({ k: "answer", id: "q-1", text: "Use the existing one." }));
    const c = await join(r, "user_c");
    const hello = c.sent[0];
    expect(hello?.k).toBe("hello");
    if (hello?.k !== "hello") throw new Error("no hello");
    expect(hello.online).toEqual([{ by: "user_a", at: expect.any(Number), presence: presence(2) }]);
    expect(hello.log.map((e) => [e.k, e.seq])).toEqual([
      ["question", 1],
      ["answer", 2],
    ]);
    expect(hello.truncated).toBe(false);
    // reconnecting from its last sequence number gets nothing old
    const again = await join(r, "user_c", 2);
    expect(again.sent[0]).toMatchObject({ k: "hello", log: [] });
    // the replaced socket is closed
    expect(c.closed).toBe(4000);
  });

  test("the log is bounded: trimmed to the newest 500, and a reconnect gets at most 200 with truncated set", async () => {
    // two seconds apart: inside the per-minute budget
    let t = 0;
    const { r } = room(() => (t += 2000));
    const a = await join(r, "user_a");
    for (let i = 0; i < 600; i++)
      await r.webSocketMessage(a, JSON.stringify({ k: "result", project: "Shop", title: `Fix ${i}`, outcome: "merged", pr: null }));
    expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM team_events").first())?.n)).toBeLessThanOrEqual(550);
    const late = await join(r, "user_late");
    const hello = late.sent[0];
    if (hello?.k !== "hello") throw new Error("no hello");
    expect(hello.log.length).toBe(200);
    expect(hello.truncated).toBe(true);
    expect(hello.log.at(-1)).toMatchObject({ title: "Fix 599" });
  }, 30_000);

  test("a removed member's socket is closed and the others are told", async () => {
    const { r } = room();
    const a = await join(r, "user_a");
    const b = await join(r, "user_b");
    r.kick("user_b");
    expect(b.closed).toBe(4001);
    expect(a.sent.at(-1)).toMatchObject({ k: "leave", by: "user_b" });
    await r.webSocketMessage(a, JSON.stringify(question("q-2")));
    expect(b.sent.some((m) => m.k === "question")).toBe(false);
  });

  test("a flood is cut at the per-minute budget", async () => {
    let t = 1_000_000;
    const { r } = room(() => t);
    const a = await join(r, "user_a");
    const b = await join(r, "user_b");
    for (let i = 0; i < RATE_PER_MINUTE + 20; i++) await r.webSocketMessage(a, JSON.stringify(presence(i)));
    expect(b.sent.filter((m) => m.k === "presence").length).toBe(RATE_PER_MINUTE);
    t += 60_000;
    await r.webSocketMessage(a, JSON.stringify(presence(1)));
    expect(b.sent.filter((m) => m.k === "presence").length).toBe(RATE_PER_MINUTE + 1);
  });
});

describe("nothing but metadata enters the feed", () => {
  const unsafe = [
    "```ts\nconst key = process.env.KEY\n```",
    "diff --git a/src/pay.ts b/src/pay.ts",
    "@@ -1,4 +1,5 @@ export function pay()",
    "my key is sk-ant-api03-abcdefghijklmnopqrstu",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    "use 4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a as the secret",
  ];

  test("code, diffs and secret-shaped text are refused in every text field", () => {
    for (const bad of unsafe) {
      expect(parseTeamSend(JSON.stringify(question("q-1", bad))), bad).toBeNull();
      expect(parseTeamSend(JSON.stringify({ k: "answer", id: "q-1", text: bad })), bad).toBeNull();
      expect(parseTeamSend(JSON.stringify({ k: "comment", id: "c-1", item: "q:q-1", text: bad, mentions: [] })), bad).toBeNull();
      expect(
        parseTeamSend(JSON.stringify({ k: "handoff", id: "h-1", to: "user_b", project: "Shop", title: "Fix it", key: null, note: bad })),
        bad,
      ).toBeNull();
      expect(
        parseTeamSend(JSON.stringify({ k: "result", project: "Shop", title: bad.split("\n")[0], outcome: "merged", pr: null })),
        bad,
      ).toBeNull();
    }
    expect(parseTeamSend(JSON.stringify(question("q-1")))).not.toBeNull();
  });

  test("fields outside the allowlist fail the whole message: no diffs, transcripts, env or files ride along", () => {
    for (const extra of [{ diff: "+a" }, { transcript: "user: hi" }, { env: { KEY: "v" } }, { files: ["a.ts"] }, { code: "x" }])
      expect(parseTeamSend(JSON.stringify({ ...question("q-1"), ...extra })), Object.keys(extra)[0]).toBeNull();
    expect(
      parseTeamSend(JSON.stringify({ ...presence(1), projects: [{ name: "Shop", state: "working", agents: 1, path: "/Users/a/shop" }] })),
    ).toBeNull();
    expect(parseTeamSend(JSON.stringify({ k: "transcript", text: "hello" }))).toBeNull();
    expect(parseTeamSend("x".repeat(3000))).toBeNull();
  });

  test("the room drops them: nothing is logged or fanned out", async () => {
    const { r } = room();
    const a = await join(r, "user_a");
    const b = await join(r, "user_b");
    const before = b.sent.length;
    for (const bad of unsafe) await r.webSocketMessage(a, JSON.stringify(question("q-9", bad)));
    await r.webSocketMessage(a, JSON.stringify({ ...question("q-9"), transcript: "user: here is the code" }));
    expect(b.sent.length).toBe(before);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM team_events").first())?.n).toBe(0);
  });
});

describe("cost", () => {
  test("Teams on top of the relay stays far under the €100 cap at 10,000 users, with D1 inside its allowance", () => {
    const c = monthlyCostWithTeams(TEN_K, TEAM_TEN_K);
    expect(c.usd * EUR_PER_USD).toBeLessThan(20);
    expect(c.lines.d1).toBe(0);
    expect(c.lines.doDuration).toBe(0);
    expect(c.perTeam).toBeLessThan(0.05);
    // five times the events still fits
    expect(monthlyCostWithTeams(TEN_K, { ...TEAM_TEN_K, eventsPerDay: 100, presencePerDay: 600 }).usd * EUR_PER_USD).toBeLessThan(100);
  });
});
