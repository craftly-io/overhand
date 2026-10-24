/**
 * A team's room: one hibernating Durable Object per team that fans members' metadata feed out to the other members'
 * daemons (docs/teams.md). It holds one socket per member's daemon, never a browser. Presence lives only on each
 * member's socket (its attachment survives hibernation, so it costs no writes and vanishes with the socket); durable
 * events (questions, answers, results, hand-offs, comments) also go to a bounded D1 log, so a member who was offline
 * catches up on connect. Every message is checked against the contract's allowlist (parseTeamSend) before anything else
 * happens to it, and stamped with who sent it here, never by the client. Keep-alive pings are answered by the runtime.
 *
 * Only the Worker reaches the object: it authenticated the member, checked their seat and set x-user and x-team. The room
 * checks seats again while members stay connected (check), so access lost later closes the socket too.
 */
import {
  CATCHUP_MAX,
  DURABLE_KINDS,
  type Presence,
  PresenceSchema,
  parseTeamSend,
  type RoomSays,
  TEAM_LOG_KEEP,
  type TeamEvent,
  TeamEventSchema,
} from "@overhand/contract";
import type { D1 } from "./paddle";
import type { HibernatingSocket, SignalState } from "./signal";
import { roomRule } from "./team";

/** The parts of DurableObjectState the room uses: the sockets, and an alarm for checking them again. */
export type RoomState = SignalState & {
  storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
};

/** How often a room with members checks each one against roomRule again: grace endings land within this. */
export const ROOM_CHECK_MS = 5 * 60_000;

/** A member's socket attachment (≤ 16 KiB): who, which team, their presence, and a per-minute message budget. */
export type MemberTag = { user: string; team: string; at: number; presence: Presence | null; minute: number; sent: number };

/** Messages per member per minute; past it the rest of the minute is dropped (a real client sends a handful). */
export const RATE_PER_MINUTE = 60;

declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };
declare const WebSocketPair: { new (): { 0: unknown; 1: HibernatingSocket } };

const tagOf = (ws: HibernatingSocket): MemberTag | null => {
  const a = ws.deserializeAttachment();
  if (typeof a !== "object" || a === null || !("user" in a) || !("team" in a)) return null;
  const o: Record<string, unknown> = { ...a };
  return {
    user: String(o.user),
    team: String(o.team),
    at: Number(o.at) || 0,
    presence: PresenceSchema.nullable()
      .catch(null)
      .parse(o.presence ?? null),
    minute: Number(o.minute) || 0,
    sent: Number(o.sent) || 0,
  };
};

const send = (ws: HibernatingSocket, m: RoomSays | TeamEvent): void => {
  try {
    ws.send(JSON.stringify(m));
  } catch {
    // closing already
  }
};

/** The team's room. */
export class TeamRoom {
  constructor(
    private readonly ctx: RoomState,
    private readonly env: { DB: D1 },
    private readonly clock: () => number = Date.now,
  ) {
    if (typeof WebSocketRequestResponsePair !== "undefined") ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** A member's daemon joining (an upgrade from the Worker), or the Worker's control message (x-room). */
  async fetch(req: Request): Promise<Response> {
    const control = req.headers.get("x-room");
    if (control && req.headers.get("upgrade") !== "websocket") {
      if (control === "roster") this.broadcast({ k: "roster", at: this.clock() });
      else if (control === "check") await this.check();
      else if (control.startsWith("kick:")) this.kick(control.slice(5));
      return new Response(null, { status: 204 });
    }
    const user = req.headers.get("x-user") ?? "";
    const team = req.headers.get("x-team") ?? "";
    if (req.headers.get("upgrade") !== "websocket" || !user || !team) return new Response("expected a member's websocket", { status: 426 });
    const pair = new WebSocketPair();
    await this.accept(pair[1], user, team, Number(req.headers.get("x-since")) || 0);
    const init: ResponseInit & { webSocket: unknown } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  }

  /** Takes a member's socket (replacing their older one), greets it with who's online and what it missed. */
  async accept(ws: HibernatingSocket, user: string, team: string, since: number): Promise<void> {
    for (const old of this.ctx.getWebSockets(user)) old.close(4000, "replaced by a newer connection");
    const now = this.clock();
    this.ctx.acceptWebSocket(ws, ["member", user]);
    const tag: MemberTag = { user, team, at: now, presence: null, minute: 0, sent: 0 };
    ws.serializeAttachment(tag);
    const online = this.members()
      .filter((m) => m.tag.user !== user)
      .map((m) => ({ by: m.tag.user, at: m.tag.at, presence: m.tag.presence }));
    // the newest CATCHUP_MAX events after the member's last one, oldest first: one summary message, not a replay
    const got = await this.env.DB.prepare("SELECT seq, at, body FROM team_events WHERE team = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
      .bind(team, since, CATCHUP_MAX + 1)
      .all();
    const log = got.results
      .slice(0, CATCHUP_MAX)
      .flatMap((r) => {
        try {
          const e = TeamEventSchema.safeParse({ ...JSON.parse(String(r.body)), seq: Number(r.seq), at: Number(r.at) });
          return e.success ? [e.data] : [];
        } catch {
          return [];
        }
      })
      .reverse();
    send(ws, { k: "hello", online, log, truncated: got.results.length > CATCHUP_MAX });
    this.broadcast({ k: "join", by: user, at: now }, user);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + ROOM_CHECK_MS);
  }

  /**
   * Checks every socket against roomRule, the rule the Worker admitted it by, and closes the ones it no longer admits
   * (a lapsed plan, an ended seat grace, fewer seats): code 4001, like a removal, so the daemon reads its roster again
   * and shows why.
   */
  async check(): Promise<void> {
    const sockets = this.members();
    const team = sockets[0]?.tag.team;
    if (!team) return;
    const refused = await roomRule(this.env.DB, team, this.clock());
    for (const { tag } of sockets) {
      const why = refused(tag.user);
      if (why) this.kick(tag.user, why);
    }
  }

  /** The timer: checks again, and keeps checking while anyone is connected. */
  async alarm(): Promise<void> {
    // a failed check (a D1 blip) keeps everyone connected, and the next tick still comes while anyone is here
    try {
      await this.check();
    } finally {
      if (this.members().length) await this.ctx.storage.setAlarm(this.clock() + ROOM_CHECK_MS);
    }
  }

  /** Every member socket with its tag. */
  private members(): { ws: HibernatingSocket; tag: MemberTag }[] {
    return this.ctx.getWebSockets("member").flatMap((ws) => {
      const tag = tagOf(ws);
      return tag ? [{ ws, tag }] : [];
    });
  }

  private broadcast(m: RoomSays | TeamEvent, except = ""): void {
    for (const x of this.members()) if (x.tag.user !== except) send(x.ws, m);
  }

  /** Closes the socket of a member no longer let in (code 4001, and why), and tells the others they left. */
  kick(user: string, why = "removed from the team"): void {
    for (const ws of this.ctx.getWebSockets(user)) {
      ws.close(4001, why);
      this.webSocketClose(ws, 4001, "", true);
    }
  }

  /** One message from a member: checked, stamped, logged when durable, fanned out. Anything else is dropped. */
  async webSocketMessage(ws: HibernatingSocket, message: string | ArrayBuffer): Promise<void> {
    const tag = tagOf(ws);
    if (!tag || typeof message !== "string") return;
    const now = this.clock();
    const minute = Math.floor(now / 60_000);
    const sent = minute === tag.minute ? tag.sent + 1 : 1;
    ws.serializeAttachment({ ...tag, minute, sent });
    if (sent > RATE_PER_MINUTE) return;
    const m = parseTeamSend(message);
    if (!m) return;
    if (m.k === "presence") {
      ws.serializeAttachment({ ...tag, minute, sent, presence: m });
      return this.broadcast({ ...m, by: tag.user, at: now, seq: 0 }, tag.user);
    }
    if (!DURABLE_KINDS.includes(m.k)) return;
    const row = await this.env.DB.prepare(
      "INSERT INTO team_events (team, seq, at, body) SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM team_events WHERE team = ? RETURNING seq",
    )
      .bind(tag.team, now, JSON.stringify({ ...m, by: tag.user }), tag.team)
      .first();
    const seq = Number(row?.seq) || 0;
    // bounded: every 50th event trims the team's log to its newest TEAM_LOG_KEEP
    if (seq % 50 === 0)
      await this.env.DB.prepare("DELETE FROM team_events WHERE team = ? AND seq <= ?")
        .bind(tag.team, seq - TEAM_LOG_KEEP)
        .run();
    // to everyone, the sender too: its daemon learns the sequence number it resumes from
    this.broadcast({ ...m, by: tag.user, at: now, seq });
  }

  /** A member leaving tells the others (unless a newer socket of theirs is still here). */
  webSocketClose(ws: HibernatingSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const tag = tagOf(ws);
    if (!tag) return;
    if (this.ctx.getWebSockets(tag.user).some((x) => x !== ws)) return;
    this.broadcast({ k: "leave", by: tag.user, at: this.clock() }, tag.user);
  }

  webSocketError(ws: HibernatingSocket, _error: unknown): void {
    this.webSocketClose(ws, 1011, "error", false);
  }
}
