/** Test doubles for the relay: D1 over bun:sqlite with the real schema, and the hibernation API's socket bookkeeping. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1, D1Stmt } from "../src/paddle";
import type { HibernatingSocket, SignalState } from "../src/signal";

/** D1 over bun:sqlite with the relay's real schema. */
export function fakeD1(): D1 {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
  const stmt = (sql: string, args: (string | number | null)[] = []): D1Stmt & { exec(): { changes: number } } => ({
    bind: (...v) => stmt(sql, v),
    first: async () => (db.query(sql).get(...args) as Record<string, unknown> | null) ?? null,
    run: async () => ({ meta: { changes: db.query(sql).run(...args).changes } }),
    all: async () => ({ results: db.query(sql).all(...args) as Record<string, unknown>[] }),
    exec: () => db.query(sql).run(...args),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) =>
      db.transaction(() => list.map((s) => ({ meta: { changes: "exec" in s && typeof s.exec === "function" ? s.exec().changes : 0 } })))(),
  };
}

/** A socket that records what it was sent (parsed), its close code and its attachment. */
export type FakeSocket<M = unknown> = HibernatingSocket & { sent: M[]; closed: number | null; attachment: unknown };
export const socket = <M = unknown>(): FakeSocket<M> => {
  const s: FakeSocket<M> = {
    sent: [],
    closed: null,
    attachment: null,
    send: (m) => s.sent.push(JSON.parse(m)),
    close: (code) => {
      s.closed = code ?? 1000;
    },
    serializeAttachment: (v) => {
      s.attachment = structuredClone(v);
    },
    deserializeAttachment: () => s.attachment,
  };
  return s;
};

/** The hibernation API's socket bookkeeping: what the runtime keeps across hibernation. */
export function fakeState<M = unknown>(): SignalState & { sockets: { ws: FakeSocket<M>; tags: string[] }[] } {
  const sockets: { ws: FakeSocket<M>; tags: string[] }[] = [];
  return {
    sockets,
    acceptWebSocket: (ws, tags = []) => {
      const found = sockets.find((x) => x.ws === ws);
      if (!found) sockets.push({ ws: ws as FakeSocket<M>, tags });
    },
    getWebSockets: (tag) => sockets.filter((x) => x.ws.closed === null && (!tag || x.tags.includes(tag))).map((x) => x.ws),
    setWebSocketAutoResponse: () => {},
  };
}

/** A team room's state: the sockets, and the one alarm the runtime keeps. */
export function fakeRoomState<M = unknown>() {
  const st = { ...fakeState<M>(), alarm: null as number | null };
  return Object.assign(st, {
    storage: {
      getAlarm: async () => st.alarm,
      setAlarm: async (at: number) => {
        st.alarm = at;
      },
    },
  });
}
