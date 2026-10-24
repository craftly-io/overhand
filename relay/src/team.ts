/**
 * Teams at the relay (docs/teams.md): membership, roles, invites, project ownership and seats in D1, and the route that
 * puts a member's daemon in its team's room (room.ts). A team is a WorkOS organisation; D1 is the authority for who may
 * do what, read on every request, so removing someone takes effect on their next request and closes their socket now.
 *
 * Who may do what:
 * - any member: read the roster, join the room, leave;
 * - admin and owner: invite, revoke invites, remove members, make members admins, set project owners and backups;
 * - owner only: change or remove an admin. The owner (who pays) can't be removed or demoted.
 */
import { INVITE_MS, SEAT_GRACE_MS, type TeamRole, type TeamRoster } from "@overhand/contract";
import { z } from "zod";
import { activeEntitlement, type D1, type Entitlement } from "./paddle";
import { daemonOf, type Env, esc, html, json, sameOrigin, sessionOf } from "./worker";

/** Who is asking: a member's daemon (by its key) or their signed-in browser. */
type Actor = { user: string; email: string; via: "daemon" | "browser" };

type TeamRow = { id: string; name: string; billing_ws: string; over_since: number | null };
type MemberRow = { user: string; email: string; role: TeamRole; joined_at: number };

const Role = z.enum(["owner", "admin", "member"]);
const TeamRowSchema = z.object({ id: z.string(), name: z.string(), billing_ws: z.string(), over_since: z.number().nullable() });
const MemberRowSchema = z.object({ user: z.string(), email: z.string(), role: Role, joined_at: z.number() });

const rows = async <T>(db: D1, schema: z.ZodType<T>, sql: string, ...args: (string | number | null)[]): Promise<T[]> =>
  (
    await db
      .prepare(sql)
      .bind(...args)
      .all()
  ).results.flatMap((r) => {
    const p = schema.safeParse(r);
    return p.success ? [p.data] : [];
  });

/** The team a person belongs to and their role, or null. */
async function membershipOf(db: D1, user: string): Promise<{ team: TeamRow; me: MemberRow } | null> {
  const m = MemberRowSchema.safeParse(
    await db.prepare("SELECT user, email, role, joined_at FROM team_members WHERE user = ?").bind(user).first(),
  );
  if (!m.success) return null;
  const team = TeamRowSchema.safeParse(
    await db
      .prepare("SELECT id, name, billing_ws, over_since FROM teams WHERE id = (SELECT team FROM team_members WHERE user = ?)")
      .bind(user)
      .first(),
  );
  return team.success ? { team: team.data, me: m.data } : null;
}

/** The team's seats from its Team plan (Paddle's quantity), or 0 when the plan isn't active. */
async function seatsOf(db: D1, team: TeamRow): Promise<{ seats: number; plan: Entitlement | null }> {
  const e = await activeEntitlement(db, team.billing_ws);
  return e?.plan === "team" ? { seats: e.seats, plan: e } : { seats: 0, plan: null };
}

/**
 * Members in seat order (the owner first, then by joining) and which of them are seated. While members exceed the seats
 * everyone keeps working for SEAT_GRACE_MS from when it started; after that only the first `seats` do. Records the start
 * and end of being over (one write, only on a change).
 */
async function seating(db: D1, team: TeamRow, now: number) {
  const members = (await rows(db, MemberRowSchema, "SELECT user, email, role, joined_at FROM team_members WHERE team = ?", team.id)).sort(
    (a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.joined_at - b.joined_at,
  );
  const { seats, plan } = await seatsOf(db, team);
  const over = members.length > seats;
  let since = team.over_since;
  if (over && since === null) since = now;
  if (!over) since = null;
  if (since !== team.over_since) await db.prepare("UPDATE teams SET over_since = ? WHERE id = ?").bind(since, team.id).run();
  const grace = since !== null && now < since + SEAT_GRACE_MS;
  const seated = new Set(members.filter((_, i) => i < seats || grace).map((m) => m.user));
  return { members, seats, plan, seated, over: since === null ? null : { since, until: since + SEAT_GRACE_MS } };
}

/** A team by its id, or null. */
async function teamById(db: D1, id: string): Promise<TeamRow | null> {
  const t = TeamRowSchema.safeParse(await db.prepare("SELECT id, name, billing_ws, over_since FROM teams WHERE id = ?").bind(id).first());
  return t.success ? t.data : null;
}

/**
 * Who may hold a socket in a team's room: a member with a seat while the team's plan is active. Returns, per user, null
 * when they may, or why not. The one rule for connecting (/relay/team/ws) and for staying connected: the room checks it
 * again on a timer and whenever the team's billing changes, and closes the sockets it no longer admits.
 */
export async function roomRule(db: D1, team: string, now: number): Promise<(user: string) => string | null> {
  const t = await teamById(db, team);
  if (!t) return () => "The team no longer exists.";
  const s = await seating(db, t, now);
  return (user) => {
    if (!s.members.some((m) => m.user === user)) return "removed from the team";
    if (!s.plan) return "The team's plan isn't active.";
    return s.seated.has(user) ? null : "The team has more members than seats.";
  };
}

/**
 * Hosted access for a person: their own Pro or Team plan, or a seat on a team whose plan is active. The Team plan pays
 * per seat, so a seated member gets Access from anywhere too; removing them (or the grace ending) takes it away.
 */
export async function access(db: D1, user: string, now: number): Promise<Entitlement | null> {
  const own = await activeEntitlement(db, user);
  if (own) return own;
  const m = await membershipOf(db, user);
  if (!m) return null;
  const s = await seating(db, m.team, now);
  return s.plan && s.seated.has(user) ? s.plan : null;
}

const canAdmin = (r: TeamRole) => r === "owner" || r === "admin";
/** A string's SHA-256, as hex. */
export const sha256 = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** The roster as `me` may see it: invites only for admins and the owner. */
async function roster(db: D1, team: TeamRow, me: MemberRow, now: number): Promise<TeamRoster> {
  const s = await seating(db, team, now);
  const invites = canAdmin(me.role)
    ? await rows(
        db,
        z.object({ id: z.string(), email: z.string(), role: Role, expires_at: z.number() }),
        "SELECT id, email, role, expires_at FROM team_invites WHERE team = ? AND expires_at > ?",
        team.id,
        now,
      )
    : [];
  const projects = await rows(
    db,
    z.object({ project: z.string(), owner: z.string().nullable(), backup: z.string().nullable() }),
    "SELECT project, owner, backup FROM team_projects WHERE team = ? ORDER BY project",
    team.id,
  );
  return {
    team: { id: team.id, name: team.name },
    me: me.user,
    role: me.role,
    seats: s.seats,
    over: s.over,
    members: s.members.map((m) => ({ user: m.user, email: m.email, role: m.role, joinedAt: m.joined_at, seated: s.seated.has(m.user) })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at })),
    projects,
  };
}

/**
 * The team's room: tells online members the roster changed, closes one member's socket ("kick:<user>"), or checks every
 * socket against roomRule again ("check").
 */
export async function tellRoom(env: Env, team: string, what: "roster" | "check" | `kick:${string}`): Promise<void> {
  await env.TEAM.get(env.TEAM.idFromName(team)).fetch(new Request("https://room/control", { method: "POST", headers: { "x-room": what } }));
}

/** Calls the WorkOS API with the secret key; null when it fails (callers decide whether that matters). */
async function workos(env: Env, path: string, init: { method: string; body?: unknown }): Promise<unknown> {
  try {
    const r = await fetch(`https://api.workos.com${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}
/** On localhost with DEV_LOGIN (wrangler dev, tests of the dev flow): no WorkOS. */
const devOnly = (env: Env, url: URL) => env.DEV_LOGIN === "1" && ["localhost", "127.0.0.1"].includes(url.hostname);

/** Mirrors a membership in the WorkOS organisation (for SSO later); D1 stays the authority, so a failure only logs. */
async function mirrorMembership(env: Env, url: URL, team: string, user: string, on: boolean): Promise<void> {
  if (devOnly(env, url)) return;
  if (on) {
    if (
      !(await workos(env, "/user_management/organization_memberships", { method: "POST", body: { user_id: user, organization_id: team } }))
    )
      console.error(`workos: couldn't add ${user} to ${team}`);
    return;
  }
  const list = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(
    await workos(env, `/user_management/organization_memberships?${new URLSearchParams({ user_id: user, organization_id: team })}`, {
      method: "GET",
    }),
  );
  for (const m of list.success ? list.data.data : [])
    await workos(env, `/user_management/organization_memberships/${encodeURIComponent(m.id)}`, { method: "DELETE" });
}

const Body = {
  create: z.object({ name: z.string().trim().min(1).max(60) }),
  invite: z.object({ email: z.email().max(200), role: z.enum(["admin", "member"]).default("member") }),
  revoke: z.object({ id: z.string().max(80) }),
  role: z.object({ user: z.string().max(80), role: z.enum(["admin", "member"]) }),
  remove: z.object({ user: z.string().max(80) }),
  project: z.object({
    project: z.string().trim().min(1).max(60),
    owner: z.string().max(80).nullable(),
    backup: z.string().max(80).nullable(),
  }),
};

/** Who is asking: a daemon by its key, or a signed-in browser (same origin for anything but a read). */
async function actorOf(req: Request, env: Env, url: URL, now: number): Promise<Actor | null> {
  const d = await daemonOf(req, env, now);
  if (d) return { user: d.ws, email: d.email, via: "daemon" };
  const s = await sessionOf(req, env, now);
  if (!s || (req.method !== "GET" && !sameOrigin(req, url))) return null;
  return { user: s.ws, email: s.email, via: "browser" };
}

/** The /relay/team* and /relay/join routes; null for any other path. */
export async function teamRoute(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/relay/join") return join(req, env, url, now);
  if (p !== "/relay/team" && !p.startsWith("/relay/team/")) return null;
  const actor = await actorOf(req, env, url, now);
  if (!actor) return json({ error: "sign in" }, 401);
  const db = env.DB;
  const body: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : null;

  if (req.method === "POST" && p === "/relay/team/create") {
    const b = Body.create.safeParse(body);
    if (!b.success) return json({ error: "name the team (1 to 60 characters)" }, 400);
    if (await membershipOf(db, actor.user)) return json({ error: "You're in a team already." }, 409);
    const plan = await activeEntitlement(db, actor.user);
    if (plan?.plan !== "team") return json({ error: "A team needs the Team plan: open Billing to start it." }, 402);
    // the team is a WorkOS organisation (SSO and directory sync attach to it later)
    let id = `team_${crypto.randomUUID()}`;
    if (!devOnly(env, url)) {
      const org = z
        .object({ id: z.string() })
        .safeParse(await workos(env, "/organizations", { method: "POST", body: { name: b.data.name } }));
      if (!org.success) return json({ error: "Couldn't create the organisation at WorkOS; try again." }, 502);
      id = org.data.id;
    }
    // one team per workspace when two creates race: the later rows are ignored (billing_ws and the member are unique),
    // its organisation is deleted again, and it answers as a second create does
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO teams (id, name, billing_ws, created_at, over_since) VALUES (?, ?, ?, ?, NULL)")
        .bind(id, b.data.name, actor.user, now),
      db
        .prepare("INSERT OR IGNORE INTO team_members (user, team, email, role, joined_at) VALUES (?, ?, ?, 'owner', ?)")
        .bind(actor.user, id, actor.email, now),
    ]);
    const m = await membershipOf(db, actor.user);
    if (m?.team.id !== id) {
      await db.prepare("DELETE FROM teams WHERE id = ?").bind(id).run();
      if (!devOnly(env, url) && !(await workos(env, `/organizations/${encodeURIComponent(id)}`, { method: "DELETE" })))
        console.error(`workos: couldn't delete the unused organisation ${id}`);
      return json({ error: "You're in a team already." }, 409);
    }
    await mirrorMembership(env, url, id, actor.user, true);
    return json(await roster(db, m.team, m.me, now));
  }

  const m = await membershipOf(db, actor.user);
  if (!m) return json({ error: "You're not in a team.", team: null }, 404);
  const { team, me } = m;

  if (req.method === "GET" && p === "/relay/team") return json(await roster(db, team, me, now));

  if (req.method === "GET" && p === "/relay/team/ws") {
    // only a member's daemon holds a room socket; their browsers read the team from their own daemon
    if (actor.via !== "daemon") return json({ error: "daemons only" }, 403);
    const refused = (await roomRule(db, team.id, now))(actor.user);
    if (refused) return json({ error: refused }, 402);
    if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected a websocket" }, 426);
    // the room trusts only these headers; nothing the client sent is forwarded
    const h = new Headers({
      upgrade: "websocket",
      "x-user": actor.user,
      "x-team": team.id,
      "x-since": String(Number(url.searchParams.get("since")) || 0),
    });
    return env.TEAM.get(env.TEAM.idFromName(team.id)).fetch(new Request(req.url, { method: "GET", headers: h }));
  }

  if (req.method !== "POST") return json({ error: "not found" }, 404);

  if (p === "/relay/team/remove") {
    const b = Body.remove.safeParse(body);
    if (!b.success) return json({ error: "who?" }, 400);
    const target = MemberRowSchema.safeParse(
      await db
        .prepare("SELECT user, email, role, joined_at FROM team_members WHERE user = ? AND team = ?")
        .bind(b.data.user, team.id)
        .first(),
    );
    if (!target.success) return json({ error: "not a member" }, 404);
    const self = target.data.user === me.user;
    if (target.data.role === "owner") return json({ error: "The owner can't leave or be removed; the team goes with the plan." }, 403);
    if (!self && !(canAdmin(me.role) && (target.data.role === "member" || me.role === "owner")))
      return json({ error: "Only admins remove members, and only the owner removes an admin." }, 403);
    // their membership, and their ownership of projects, go at once; their socket closes now
    await db.batch([
      db.prepare("DELETE FROM team_members WHERE user = ? AND team = ?").bind(target.data.user, team.id),
      db.prepare("UPDATE team_projects SET owner = NULL WHERE team = ? AND owner = ?").bind(team.id, target.data.user),
      db.prepare("UPDATE team_projects SET backup = NULL WHERE team = ? AND backup = ?").bind(team.id, target.data.user),
    ]);
    await tellRoom(env, team.id, `kick:${target.data.user}`);
    await tellRoom(env, team.id, "roster");
    await mirrorMembership(env, url, team.id, target.data.user, false);
    return json({ ok: true });
  }

  if (!canAdmin(me.role)) return json({ error: "Only the team's admins can do that." }, 403);

  if (p === "/relay/team/invite") {
    const b = Body.invite.safeParse(body);
    if (!b.success) return json({ error: "an email address, and member or admin" }, 400);
    const email = b.data.email.toLowerCase();
    await db.prepare("DELETE FROM team_invites WHERE team = ? AND expires_at <= ?").bind(team.id, now).run();
    const s = await seating(db, team, now);
    if (s.members.some((x) => x.email.toLowerCase() === email)) return json({ error: `${email} is in the team already.` }, 409);
    const pending = await rows(db, z.object({ email: z.string() }), "SELECT email FROM team_invites WHERE team = ?", team.id);
    // a pending invite holds a seat, so accepting can't overflow the plan
    if (!pending.some((x) => x.email === email) && s.members.length + pending.length >= s.seats)
      return json({ error: `All ${s.seats} seats are taken or invited: add seats in Billing first.` }, 402);
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
    const id = await sha256(secret);
    await db.batch([
      db.prepare("DELETE FROM team_invites WHERE team = ? AND email = ?").bind(team.id, email),
      db
        .prepare("INSERT INTO team_invites (id, team, email, role, by_user, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, team.id, email, b.data.role, me.user, now + INVITE_MS),
    ]);
    await tellRoom(env, team.id, "roster");
    // the link carries the secret; only its hash is stored. Shared by the admin (email, chat): we send no mail.
    return json({ id, link: `${url.origin}/relay/join?t=${secret}`, expiresAt: now + INVITE_MS });
  }
  if (p === "/relay/team/invite/revoke") {
    const b = Body.revoke.safeParse(body);
    if (!b.success) return json({ error: "which invite?" }, 400);
    await db.prepare("DELETE FROM team_invites WHERE id = ? AND team = ?").bind(b.data.id, team.id).run();
    await tellRoom(env, team.id, "roster");
    return json({ ok: true });
  }
  if (p === "/relay/team/role") {
    const b = Body.role.safeParse(body);
    if (!b.success) return json({ error: "who, and admin or member" }, 400);
    const target = MemberRowSchema.safeParse(
      await db
        .prepare("SELECT user, email, role, joined_at FROM team_members WHERE user = ? AND team = ?")
        .bind(b.data.user, team.id)
        .first(),
    );
    if (!target.success) return json({ error: "not a member" }, 404);
    if (target.data.role === "owner") return json({ error: "The owner's role doesn't change." }, 403);
    if (target.data.role === "admin" && me.role !== "owner") return json({ error: "Only the owner changes an admin's role." }, 403);
    await db.prepare("UPDATE team_members SET role = ? WHERE user = ? AND team = ?").bind(b.data.role, b.data.user, team.id).run();
    await tellRoom(env, team.id, "roster");
    return json({ ok: true });
  }
  if (p === "/relay/team/project") {
    const b = Body.project.safeParse(body);
    if (!b.success) return json({ error: "a project, its owner and its backup" }, 400);
    const ids = new Set(
      (await rows(db, z.object({ user: z.string() }), "SELECT user FROM team_members WHERE team = ?", team.id)).map((x) => x.user),
    );
    const { project, owner, backup } = b.data;
    if ((owner && !ids.has(owner)) || (backup && !ids.has(backup))) return json({ error: "Owners and backups must be members." }, 400);
    if (owner && owner === backup) return json({ error: "The backup is someone other than the owner." }, 400);
    await db
      .prepare(
        "INSERT INTO team_projects (team, project, owner, backup) VALUES (?, ?, ?, ?) ON CONFLICT (team, project) DO UPDATE SET owner = excluded.owner, backup = excluded.backup",
      )
      .bind(team.id, project, owner, backup)
      .run();
    await tellRoom(env, team.id, "roster");
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/**
 * Joining from an invite link: a signed-in browser whose email is the invited one confirms, then becomes a member if
 * a seat is free. GET shows the confirmation; POST (same origin) joins.
 */
async function join(req: Request, env: Env, url: URL, now: number): Promise<Response> {
  const s = await sessionOf(req, env, now);
  const secret =
    req.method === "POST" ? String((await req.formData().catch(() => new FormData())).get("t") ?? "") : (url.searchParams.get("t") ?? "");
  if (!/^[0-9a-f]{48}$/.test(secret)) return html("Invite", "<p>That invite link is malformed. Ask for a new one.</p>", 400);
  if (!s)
    return new Response(null, { status: 302, headers: { location: `/relay/login?next=${encodeURIComponent(`/relay/join?t=${secret}`)}` } });
  const invite = z
    .object({
      id: z.string(),
      team: z.string(),
      email: z.string(),
      role: z.enum(["admin", "member"]),
      expires_at: z.number(),
      name: z.string(),
    })
    .safeParse(
      await env.DB.prepare(
        "SELECT i.id, i.team, i.email, i.role, i.expires_at, t.name FROM team_invites i JOIN teams t ON t.id = i.team WHERE i.id = ?",
      )
        .bind(await sha256(secret))
        .first(),
    );
  if (!invite.success || invite.data.expires_at <= now)
    return html("Invite", "<p>That invite expired or was withdrawn. Ask for a new one.</p>", 410);
  const inv = invite.data;
  if (inv.email !== s.email.toLowerCase())
    return html(
      "Invite",
      `<p>This invite is for ${esc(inv.email)}, and you're signed in as ${esc(s.email)}. Sign in with the invited address.</p>`,
      403,
    );
  const already = await membershipOf(env.DB, s.ws);
  if (already)
    return html(
      "Invite",
      `<p>You're in ${esc(already.team.name)} already. Leave it in Overhand (Settings → Team) before joining another team.</p>`,
      409,
    );
  if (req.method === "GET")
    return html(
      "Join the team",
      `<h1>Join ${esc(inv.name)} as ${inv.role === "admin" ? "an admin" : "a member"}?</h1>
<p>Your teammates will see your projects' status, the questions your agents ask on projects they own, your results and your presence. Never your code, keys, tokens or agent transcripts.</p>
<form method="post" action="/relay/join"><input type="hidden" name="t" value="${secret}"><button class="primary">Join</button></form>`,
    );
  if (!sameOrigin(req, url)) return html("Invite", "<p>Join from the invite page itself.</p>", 403);
  const teamRow = await teamById(env.DB, inv.team);
  if (!teamRow) return html("Invite", "<p>That team no longer exists.</p>", 410);
  const seat = await seating(env.DB, teamRow, now);
  // the invite held its seat; a plan shrunk since may still leave none
  if (seat.members.length >= seat.seats) return html("Invite", "<p>The team has no free seat. Ask its owner to add one.</p>", 402);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO team_members (user, team, email, role, joined_at) VALUES (?, ?, ?, ?, ?)").bind(
      s.ws,
      inv.team,
      s.email,
      inv.role,
      now,
    ),
    env.DB.prepare("DELETE FROM team_invites WHERE id = ?").bind(inv.id),
  ]);
  await mirrorMembership(env, url, inv.team, s.ws, true);
  await tellRoom(env, inv.team, "roster");
  return html(
    "Joined",
    `<h1>You're in ${esc(inv.name)}.</h1><p>In Overhand on your computer, open Settings → Team: it links this account if it isn't yet, then your team appears on Now.</p>`,
  );
}
