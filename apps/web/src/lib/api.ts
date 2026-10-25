import { type DashboardState, DashboardStateSchema } from "@overhand/contract";
import type { z } from "zod";
import { DEMO, DEMO_REFUSAL, demoPost } from "@/demo/demo";
import { demoGet } from "@/demo/fixtures";

/** The daemon answered, but with data the contract rejects; `path` names the field that drifted. */
export class ContractError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** A live event stream: an EventSource, or its stand-in over the WebRTC data channel on the hosted page. */
export type EventStream = {
  onmessage: ((e: MessageEvent<string>) => void) | null;
  onerror: ((e: Event) => void) | null;
  readonly readyState: number;
  close(): void;
};
/** EventSource.CLOSED, for either kind of stream. */
export const STREAM_CLOSED = 2;

type Channel = { fetch(url: string, init?: RequestInit): Promise<Response>; events(url: string): EventStream };
/** How the hosted page reaches its daemon: set once the data channel is open (lib/rtc.ts), null everywhere else. */
let channel: Channel | null = null;
/** Routes the dashboard's API through `c` (the data channel), or back to plain HTTP with null. */
export function setChannel(c: Channel | null): void {
  channel = c;
}
/** fetch for the daemon's API: over the data channel when the hosted page has one, else HTTP. */
export const apiFetch = (url: string, init?: RequestInit): Promise<Response> => (channel ? channel.fetch(url, init) : fetch(url, init));
/** The daemon's event stream, over the same transport. */
export const openEvents = (url: string): EventStream => (channel ? channel.events(url) : new EventSource(url));

/** The daemon wants this device paired first: it's another device, not a browser on the computer itself. */
export class Unpaired extends Error {}

/** A POST the daemon refused, with the command to run by hand when it gave one (no terminal window opens on a server). */
export class Refused extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
  }
}

/** Reads a GET endpoint and validates it against its schema. */
export async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  if (DEMO) {
    const sample = demoGet(url);
    if (sample === undefined) throw new Error(DEMO_REFUSAL);
    return schema.parse(sample);
  }
  const r = await apiFetch(url);
  if (r.status === 401) throw new Unpaired(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  const parsed = schema.safeParse(await r.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ContractError(issue?.path.join(".") || "(root)", issue?.message ?? "invalid");
  }
  return parsed.data;
}

/** `GET /api/state`, validated. */
export function fetchState(): Promise<DashboardState> {
  return get("/api/state", DashboardStateSchema);
}

/**
 * Sends an action. The daemon only accepts POSTs from the dashboard's own origin, which a page it serves always has.
 * Throws the daemon's error message when it refuses.
 */
export async function post<S extends z.ZodType>(url: string, body: object, schema: S): Promise<z.infer<S>> {
  if (DEMO) {
    const done = demoPost(url, { ...body });
    if (done === undefined) throw new Error(DEMO_REFUSAL);
    return schema.parse(done);
  }
  const r = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j: unknown = await r.json().catch(() => ({}));
  if (!r.ok) {
    const o = typeof j === "object" && j !== null ? j : {};
    const msg = "error" in o && typeof o.error === "string" ? o.error : r.statusText;
    throw new Refused(msg, "command" in o && typeof o.command === "string" ? o.command : "");
  }
  return schema.parse(j);
}
