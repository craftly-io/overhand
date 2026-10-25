/**
 * Teams, the daemon's side (docs/teams.md): the roster from the relay, one hibernating WebSocket to the team's room,
 * and the metadata feed both ways. Out: presence (agents running, quiet, project statuses, what your dashboard has open,
 * your claims), questions your agents ask on projects a teammate owns, results, hand-offs, comments, answers. In: the
 * same from teammates; an answer to one of your agents' questions goes into its inbox, a hand-off to you is held as an
 * "Assign an agent" item, a mention of you notifies you. Everything sent is built here from structured state and checked
 * against the contract's allowlist; nothing from a file, a diff or an agent's log is ever read into it.
 *
 * Nothing local depends on this: no link, no team or no relay just means the Team view is empty.
 */
import { join } from "node:path";
import {
  CATCHUP_MAX,
  CLAIM_IDLE_MS,
  clip as clipWords,
  type DashboardState,
  memberName,
  type Presence,
  plainSentences,
  type TeamEvent,
  TeamIncomingSchema,
  type TeamRoster,
  TeamRosterSchema,
  type TeamSend,
  TeamSendSchema,
  type TeamState,
  unsafeText,
} from "@overhand/contract";
import { holdFinding } from "./assign";
import { OPS } from "./env";
import { leadName } from "./leads";
import { cleared } from "./outward";
import { hostedActive, relayLinked, relayRequest, relaySocketUrl } from "./relay";
import { readJson, writeJsonAtomic } from "./state";

/** What the daemon keeps across restarts (team.json, 0600): where the feed resumes, and what it already handled. */
type Saved = {
  /** The last sequence number seen: the room sends only what came after it. */
  seq: number;
  log: TeamEvent[];
  sharePrs: boolean;
  /** Questions this daemon published, by id: which lead asked, and whether it's closed. */
  asked: Record<string, { lead: string; closed: boolean }>;
  /** Report lines already published as results (hashes), and events already acted on (hand-offs, mentions). */
  results: string[];
  handled: string[];
  claims: { item: string; label: string }[];
};
const FILE = () => join(OPS, "team.json");
const blank = (): Saved => ({ seq: 0, log: [], sharePrs: false, asked: {}, results: [], handled: [], claims: [] });
let saved: Saved = { ...blank(), ...readJson<Partial<Saved>>(FILE(), {}) };
const persist = () => writeJsonAtomic(FILE(), saved);

/** The hooks the server gives: building the state, answering a lead, notifying you. */
export type TeamHooks = {
  state: () => Promise<DashboardState>;
  answer: (lead: string, text: string, from: string) => void;
  notify: (title: string, body: string) => void;
  /** The state changed in a way the dashboard should show now. */
  changed: () => void;
};
let hooks: TeamHooks | null = null;

let roster: TeamRoster | null = null;
let problem = "";
const online = new Map<string, { at: number; presence: Presence | null }>();
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let backoff = 5_000;
let viewing: Presence["viewing"] = null;
let lastActivity = Date.now();
let lastPresence = "";
let lastSeen = 0;

/** The team as the dashboard shows it (DashboardState.team), or null with no team. */
export function teamState(): TeamState | null {
  if (!roster) return null;
  return {
    roster,
    connected: socket?.readyState === WebSocket.OPEN,
    online: Object.fromEntries(online),
    log: saved.log,
    problem,
    sharePrs: saved.sharePrs,
  };
}

/** Reads the roster from the relay, then opens or closes the room socket to match. */
async function refreshTeam(): Promise<void> {
  if (!relayLinked()) {
    roster = null;
    problem = "";
    return syncSocket();
  }
  try {
    const r = await relayRequest("/relay/team");
    if (r?.ok) {
      roster = TeamRosterSchema.parse(await r.json());
      const me = roster.members.find((m) => m.user === roster?.me);
      problem = roster.seats === 0 ? "The team's plan isn't active." : me?.seated === false ? "The team has more members than seats." : "";
    } else if (r?.status === 404) {
      roster = null;
      problem = "";
    } else problem = `The relay answered ${r?.status ?? "nothing"}.`;
  } catch (e) {
    problem = `Couldn't reach the relay: ${e instanceof Error ? e.message : String(e)}`;
  }
  syncSocket();
  hooks?.changed();
}

const shouldConnect = () => Boolean(roster && relayLinked() && hostedActive() && !problem);

function syncSocket(): void {
  if (!shouldConnect()) {
    if (retry) clearTimeout(retry);
    retry = null;
    socket?.close(1000, "off");
    socket = null;
    online.clear();
    return;
  }
  if (socket || retry) return;
  void connect();
}

async function connect(): Promise<void> {
  retry = null;
  const url = await relaySocketUrl("/relay/team/ws", { since: String(saved.seq) }).catch(() => null);
  if (!url) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return scheduleRetry();
  }
  socket = ws;
  ws.onopen = () => {
    backoff = 5_000;
    lastPresence = "";
    if (ping) clearInterval(ping);
    // answered by the room's auto-response, never waking it
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 50_000);
    void tick();
  };
  ws.onmessage = (e: MessageEvent) => receive(String(e.data));
  ws.onclose = (e: CloseEvent) => {
    if (socket === ws) socket = null;
    if (ping) clearInterval(ping);
    online.clear();
    // removed from the team: read the roster again rather than knocking on the door
    if (e.code === 4001) return void refreshTeam();
    scheduleRetry();
    hooks?.changed();
  };
}

function scheduleRetry(): void {
  if (retry || !shouldConnect()) return;
  retry = setTimeout(() => syncSocket(), backoff);
  backoff = Math.min(backoff * 2, 5 * 60_000);
}

/** The words in a team message that people read: what the outward firewall checks. */
function teamText(m: TeamSend): string {
  const r: Record<string, unknown> = m;
  return ["title", "text", "note", "fallback"]
    .map((k) => r[k])
    .filter((v): v is string => typeof v === "string" && v !== "")
    .join("\n");
}

/** Whether a team message may go: the outward firewall holds one carrying a secret, a private word or another project's. */
export function teamCleared(m: TeamSend): boolean {
  const text = teamText(m);
  const project = "project" in m ? m.project : "";
  const title = `Message to your team${project ? ` about ${project}` : ""}`;
  return !text || cleared({ kind: "team", project, dest: "your team's feed", title, text, payload: { msg: JSON.stringify(m) } });
}

/**
 * Sends one message, checked against the allowlist and the outward firewall first (`checked`: you released it); false
 * when it isn't allowed, it's held, or there's no socket.
 */
export function send(m: TeamSend, checked = false): boolean {
  const ok = TeamSendSchema.safeParse(m);
  if (!ok.success || socket?.readyState !== WebSocket.OPEN) return false;
  if (!checked && !teamCleared(ok.data)) return false;
  socket.send(JSON.stringify(ok.data));
  return true;
}

const keep = (list: string[], add: string, max = 500) => [...list.filter((x) => x !== add), add].slice(-max);
const nameOf = (user: string) => memberName(roster?.members.find((m) => m.user === user)?.email ?? user);

/** One message from the room. */
export function receive(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const m = TeamIncomingSchema.safeParse(parsed);
  if (!m.success) return;
  const e = m.data;
  if (e.k === "hello") {
    online.clear();
    for (const o of e.online) online.set(o.by, { at: o.at, presence: o.presence });
    for (const x of e.log) if (x.k !== "presence") take(x);
  } else if (e.k === "join") online.set(e.by, { at: e.at, presence: online.get(e.by)?.presence ?? null });
  else if (e.k === "leave") online.delete(e.by);
  else if (e.k === "roster") void refreshTeam();
  else if (e.k === "presence") online.set(e.by, { at: e.at, presence: e });
  else if (e.k === "question" || e.k === "answer" || e.k === "result" || e.k === "handoff" || e.k === "comment") take(e);
  persist();
  hooks?.changed();
}

/** A durable event: into the log (once, by sequence number), then acted on if it's for you. */
function take(e: Exclude<TeamEvent, { k: "presence" }>): void {
  if (e.seq && saved.log.some((x) => x.seq === e.seq)) return;
  saved.log = [...saved.log, e].slice(-CATCHUP_MAX);
  saved.seq = Math.max(saved.seq, e.seq);
  const me = roster?.me ?? "";
  const once = (id: string) => {
    if (saved.handled.includes(id)) return false;
    saved.handled = keep(saved.handled, id);
    return true;
  };
  if (e.k === "answer" && e.by !== me && e.text) {
    const q = saved.asked[e.id];
    if (q && !q.closed && once(`a:${e.id}`)) {
      q.closed = true;
      hooks?.answer(q.lead, e.text, nameOf(e.by));
    }
  }
  if (e.k === "handoff" && e.to === me && once(`h:${e.id}`)) {
    // held for you, like a finding: nothing runs until you press Assign an agent (at the project's assignedAutonomy)
    holdFinding({
      project: e.project,
      key: e.key ?? "",
      title: e.title,
      text: [`${nameOf(e.by)} handed this to your crew.`, e.note].filter(Boolean).join(" "),
      post: "",
      from: "team",
    });
    hooks?.notify(`${nameOf(e.by)} handed you ${e.title}`, `${e.project}: assign an agent when you're ready.`);
  }
  if (e.k === "comment" && e.by !== me && e.mentions.includes(me) && once(`c:${e.id}`))
    hooks?.notify(`${nameOf(e.by)} mentioned you`, e.text);
}

// ── what this daemon publishes ──

/** The last question in a lead's inbox, as plain text safe for the team: code blocks and diff lines left out. */
export function questionText(inbox: string): string {
  const sections = inbox.split(/^## /m);
  const last = (sections.at(-1) ?? "").replace(/^[^\n]*\n/, "");
  // its sentences only: code, diff lines and tables stay on the asker's machine
  const prose = plainSentences(
    last
      .split("\n")
      .filter((l) => !/^(diff --git |@@ |\+\+\+ |--- |[+-]\s)/.test(l))
      .join("\n"),
  ).join(" ");
  const cut = clipWords(prose, 400);
  return cut && !unsafeText(cut) ? cut : "";
}

/** Presence from the dashboard's state: counts and statuses only. */
export function presenceOf(s: DashboardState, view: Presence["viewing"], claims: Saved["claims"]): Presence {
  const leadsOf = (p: string) => s.godmode.filter((g) => g.project === p);
  // a ticket run's name starts with its key, so its project's prefix
  const runsOf = (prefix: string) => s.running.filter((r) => r.name.startsWith(`${prefix}-`)).length;
  const projects = s.clients.slice(0, 24).map((c) => {
    const leads = leadsOf(c.name);
    const agents = leads.filter((g) => g.running).length + runsOf(c.prefix);
    const state: Presence["projects"][number]["state"] = leads.some((g) => g.inbox?.open) ? "needs" : agents ? "working" : "idle";
    return { name: c.name.slice(0, 60), state, agents };
  });
  return {
    k: "presence",
    agents: s.running.length + s.godmode.filter((g) => g.running).length,
    quiet: s.governor.quietUntil > s.now,
    viewing: view,
    claims,
    projects: projects.filter((p) => !unsafeText(p.name)),
  };
}

const RESULT = /^- \d\d:\d\d (🎉|✅|🆕|✗) (.*)$/u;
const KEY = /\b[A-Z][A-Z0-9]*-\d{1,12}\b/;

/** A result from one activity line: the ticket key or PR title, its project and outcome, never the agent's words. */
export function resultOf(line: string, s: Pick<DashboardState, "clients">, sharePrs: boolean): Extract<TeamSend, { k: "result" }> | null {
  const m = RESULT.exec(line);
  if (!m) return null;
  const rest = m[2] ?? "";
  const key = KEY.exec(rest)?.[0] ?? "";
  const project = s.clients.find((c) => key.startsWith(`${c.prefix}-`))?.name ?? "";
  if (!project) return null;
  const outcome: "merged" | "failed" | "opened" = m[1] === "🎉" ? "merged" : m[1] === "✗" ? "failed" : "opened";
  // a merge line names the PR's title after "merged: "; everything else is the key alone
  const title = outcome === "merged" ? (rest.split(" merged: ")[1] ?? key).slice(0, 140) : key;
  const pr = sharePrs && outcome === "opened" ? (/https:\/\/\S+/.exec(rest)?.[0] ?? null) : null;
  const r = { k: "result" as const, project, title: unsafeText(title) ? key : title, outcome, pr };
  return TeamSendSchema.safeParse(r).success ? r : null;
}

/**
 * Publishes what changed since the last look: presence when it differs, each new question on a project a teammate owns
 * or backs up, each question closed here, each new result. Called with every state the dashboard builds, and on its
 * own timer when nobody is watching.
 */
export async function tick(given?: DashboardState): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN || !roster || !hooks) return;
  const s = given ?? (await hooks.state());
  lastSeen = Date.now();
  // claims lapse after a while without you
  if (saved.claims.length && Date.now() - lastActivity > CLAIM_IDLE_MS) {
    saved.claims = [];
    persist();
  }
  const p = presenceOf(s, viewing, saved.claims);
  const key = JSON.stringify(p);
  if (key !== lastPresence && send(p)) lastPresence = key;
  const me = roster.me;
  const teammate = (project: string) =>
    roster?.projects.some((x) => x.project === project && [x.owner, x.backup].some((u) => u && u !== me));
  for (const g of s.godmode) {
    if (!g.inbox?.open || !teammate(g.project)) continue;
    const id = `${g.key}-${Math.round(g.inbox.at)}`.replace(/[^\w-]/g, "-").slice(-64);
    if (saved.asked[id]) continue;
    const text = questionText(g.inbox.text) || "A question with code in it: open it on the asker's machine.";
    const fallback = g.ask?.default && !unsafeText(g.ask.default) ? g.ask.default.slice(0, 200) : "";
    if (send({ k: "question", id, project: g.project, lead: (leadName(g) || g.key).slice(0, 60), text, fallback }))
      saved.asked[id] = { lead: g.key, closed: false };
  }
  // answered here (or the lead moved on): close it for the team
  for (const [id, q] of Object.entries(saved.asked)) {
    if (q.closed) continue;
    const g = s.godmode.find((x) => x.key === q.lead);
    if (!g?.inbox?.open && send({ k: "answer", id, text: "" })) q.closed = true;
  }
  const fresh = s.reports.filter((l) => !saved.results.includes(String(Bun.hash(l))));
  // the first look after joining marks today's lines seen rather than flooding the team with them
  const first = saved.results.length === 0;
  for (const line of fresh) {
    saved.results = keep(saved.results, String(Bun.hash(line)));
    const r = first ? null : resultOf(line, s, saved.sharePrs);
    if (r) send(r);
  }
  saved.asked = Object.fromEntries(Object.entries(saved.asked).slice(-200));
  persist();
}

/** Something you did on the dashboard: keeps your claims alive. */
export function touchTeam(): void {
  lastActivity = Date.now();
}

/** Mentions in a comment: `@name` matching a member's name or the part of their email before the @. */
export function mentionsIn(text: string, members: TeamRoster["members"]): string[] {
  const named = new Set([...text.matchAll(/@([\w.-]+)/g)].map((m) => (m[1] ?? "").toLowerCase()));
  return members.filter((m) => named.has((m.email.split("@")[0] ?? "").toLowerCase())).map((m) => m.user);
}

const id = () => crypto.randomUUID();
const clip = (v: unknown, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

/**
 * The dashboard's team actions (POST /api/team/<action>). Feed actions go over the socket; roster actions go to the
 * relay, signed, and the relay checks the role. Returns the response body, or throws a message for the dashboard.
 */
export async function teamAction(action: string, body: Record<string, unknown>): Promise<unknown> {
  touchTeam();
  const relay = async (path: string, payload: unknown) => {
    const r = await relayRequest(path, { body: payload });
    if (!r) throw new Error("Link this computer to your account first: Settings → Connections → Access from anywhere.");
    const j: unknown = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j === "object" && j !== null && "error" in j ? String(j.error) : `The relay answered ${r.status}.`);
    await refreshTeam();
    return j;
  };
  switch (action) {
    case "refresh":
      await refreshTeam();
      return { ok: true };
    case "create":
      return relay("/relay/team/create", { name: clip(body.name, 60) });
    case "invite":
      return relay("/relay/team/invite", { email: clip(body.email, 200), role: body.role === "admin" ? "admin" : "member" });
    case "revoke":
      return relay("/relay/team/invite/revoke", { id: clip(body.id, 80) });
    case "role":
      return relay("/relay/team/role", { user: clip(body.user, 80), role: body.role === "admin" ? "admin" : "member" });
    case "remove":
      return relay("/relay/team/remove", { user: clip(body.user, 80) });
    case "leave":
      return relay("/relay/team/remove", { user: roster?.me ?? "" });
    case "project":
      return relay("/relay/team/project", {
        project: clip(body.project, 60),
        owner: clip(body.owner, 80) || null,
        backup: clip(body.backup, 80) || null,
      });
    case "share":
      saved.sharePrs = body.on === true;
      persist();
      hooks?.changed();
      return { ok: true };
  }
  if (!roster) throw new Error("You're not in a team.");
  const feed = (m: TeamSend) => {
    if (!TeamSendSchema.safeParse(m).success)
      throw new Error("That can't go to the team: it looks like code or a secret, or it's too long.");
    if (!teamCleared(m)) throw new Error("Held by the outward firewall: it's waiting in Needs you.");
    if (!send(m, true)) throw new Error("Not connected to the team right now.");
    return { ok: true };
  };
  switch (action) {
    case "answer":
      return feed({ k: "answer", id: clip(body.id, 64), text: clip(body.text, 400) });
    case "handoff":
      return feed({
        k: "handoff",
        id: id(),
        to: clip(body.to, 64),
        project: clip(body.project, 60),
        title: clip(body.title, 200),
        key: KEY.test(String(body.key ?? "")) ? clip(body.key, 30) : null,
        note: clip(body.note, 400),
      });
    case "comment": {
      const text = clip(body.text, 400);
      return feed({ k: "comment", id: id(), item: clip(body.item, 133), text, mentions: mentionsIn(text, roster.members) });
    }
    case "claim": {
      const item = clip(body.item, 133);
      saved.claims = saved.claims.filter((c) => c.item !== item);
      if (body.on === true) saved.claims = [...saved.claims, { item, label: clip(body.label, 80) || item }].slice(-20);
      persist();
      await tick();
      return { ok: true };
    }
    case "viewing": {
      // a dashboard tab that opens or closes an item, or goes hidden (null): one presence message, only on change
      viewing = body.item ? { item: clip(body.item, 133), label: clip(body.label, 80) || clip(body.item, 80) } : null;
      await tick();
      return { ok: true };
    }
  }
  throw new Error("not found");
}

/**
 * Starts Teams: reads the roster now and every six hours (and when the room says it changed), and publishes on a slow
 * timer when no dashboard is building the state anyway. Every call here is async; a failure never touches local use.
 */
export function startTeam(h: TeamHooks): void {
  hooks = h;
  void refreshTeam();
  setInterval(() => void refreshTeam(), 6 * 60 * 60_000).unref();
  setInterval(() => {
    // the entitlement may have arrived since the roster did (a new member's first start): connect once it has
    syncSocket();
    if (Date.now() - lastSeen > 25_000) void tick().catch(() => {});
  }, 30_000).unref();
}

/** For tests: forget everything held in memory and on disk; `asked` maps question ids this daemon published to leads. */
export function resetTeam(r: TeamRoster | null = null, asked: Record<string, string> = {}): void {
  saved = blank();
  saved.asked = Object.fromEntries(Object.entries(asked).map(([id, lead]) => [id, { lead, closed: false }]));
  roster = r;
  problem = "";
  online.clear();
  viewing = null;
  lastPresence = "";
}

/** For tests: the hooks to call, without starting timers or the socket. */
export function setTeamHooks(h: TeamHooks): void {
  hooks = h;
}
