/**
 * Hosted runs (issue #15), the relay's side: a daemon with projects switched to "Run here when my computer is off" (and a
 * paid plan) keeps one hibernating socket to its workspace's `Runner` Durable Object while it has queued tickets for
 * them, and sends the list, each with the API key its run uses. When the socket closes and stays closed for
 * HOSTED_GRACE_MS (an alarm), the computer has gone away: the object runs the tickets one at a time, each in a fresh
 * container (`RUN_INSTANCE`), destroyed after. Where the keys are held, and why an idle socket costs nothing: `Runner`.
 *
 * Prepaid only: a run starts when the workspace's minutes (the plan's monthly allowance, then packs bought on the
 * billing page) cover its longest length; that much is reserved, and what it didn't use goes back when it ends. Code
 * access is a GitHub App installation token minted for that run and that repository, revoked after. The container's
 * own Overhand pushes the branch and opens the PR with it; the agent never sees it. D1 keeps minutes and one plain line
 * per run, never a key, a token or a log.
 *
 * Switched on only where `HOSTED_RUNS` is "1" (staging); production answers 404 until the owner's setup is done.
 */
import {
  HOSTED_ALLOWANCE,
  HOSTED_PORT,
  HOSTED_RUN_MAX_MIN,
  HOSTED_STATUSES,
  HostedHandSchema,
  type HostedJob,
  type HostedResult,
  type HostedRunAnswer,
  HostedRunAnswerSchema,
  type Plan,
  unb64url,
} from "@overhand/contract";
import { z } from "zod";
import { RUN_INSTANCE } from "./cost";
import type { D1 } from "./paddle";
import type { HibernatingSocket, SignalState } from "./signal";
import { access } from "./team";
import { daemonOf, type Env, json } from "./worker";

/** How long the hand-off socket stays closed before the computer counts as gone: a network change reconnects sooner. */
export const HOSTED_GRACE_MS = 2 * 60_000;

/** The month a minute is counted in, YYYY-MM (UTC). */
const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

/** The longest a run may take here, in minutes (the HOSTED_RUN_MAX_MIN var, else the contract's default). */
export const runMaxMin = (env: Pick<Env, "HOSTED_RUN_MAX_MIN">): number => {
  const n = Number(env.HOSTED_RUN_MAX_MIN);
  return Number.isInteger(n) && n > 0 ? n : HOSTED_RUN_MAX_MIN;
};

// ── minutes ──

/** A workspace's minutes: packs bought (`balance`) and what's left of this month's plan allowance. */
export type Minutes = { balance: number; allowanceLeft: number; allowance: number };

/** What a run's reservation took, so the unused part goes back where it came from. */
export type Reservation = { fromAllowance: number; fromBalance: number; month: string };

async function row(db: D1, ws: string, now: number): Promise<{ balance: number; used: number }> {
  const r = await db.prepare("SELECT balance, month, allowance_used FROM hosted_minutes WHERE workspace = ?").bind(ws).first();
  return { balance: Number(r?.balance ?? 0), used: r?.month === monthOf(now) ? Number(r?.allowance_used ?? 0) : 0 };
}

/** The workspace's minutes now; no plan means no allowance (packs bought stay, for when a plan is on again). */
export async function minutesOf(db: D1, ws: string, plan: Plan | null, now: number): Promise<Minutes> {
  const r = await row(db, ws, now);
  const allowance = plan ? HOSTED_ALLOWANCE[plan] : 0;
  return { balance: r.balance, allowanceLeft: Math.max(0, allowance - r.used), allowance };
}

/**
 * Reserves `want` minutes, the allowance first, or null when allowance and balance together can't cover it. Only the
 * workspace's own Runner object calls this, one run at a time, so a read then a write can't race another run.
 */
export async function reserve(db: D1, ws: string, plan: Plan, want: number, now: number): Promise<Reservation | null> {
  const m = await minutesOf(db, ws, plan, now);
  const fromAllowance = Math.min(want, m.allowanceLeft);
  const fromBalance = want - fromAllowance;
  if (fromBalance > m.balance) return null;
  const used = m.allowance - m.allowanceLeft + fromAllowance;
  await db
    .prepare(
      `INSERT INTO hosted_minutes (workspace, balance, month, allowance_used) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace) DO UPDATE SET balance = excluded.balance, month = excluded.month, allowance_used = excluded.allowance_used`,
    )
    .bind(ws, m.balance - fromBalance, monthOf(now), used)
    .run();
  return { fromAllowance, fromBalance, month: monthOf(now) };
}

/** Gives back what a run reserved and didn't use: to the balance first (bought minutes), then this month's allowance. */
export async function settle(db: D1, ws: string, r: Reservation, used: number, now: number): Promise<void> {
  const unused = Math.max(0, r.fromAllowance + r.fromBalance - used);
  const toBalance = Math.min(unused, r.fromBalance);
  // allowance reserved in a month that has ended was that month's: nothing to give back to the new one
  const toAllowance = r.month === monthOf(now) ? unused - toBalance : 0;
  await db
    .prepare("UPDATE hosted_minutes SET balance = balance + ?, allowance_used = MAX(0, allowance_used - ?) WHERE workspace = ?")
    .bind(toBalance, toAllowance, ws)
    .run();
}

/** A workspace's latest runs, newest first, for the billing page. */
export async function recentRuns(db: D1, ws: string, limit = 20): Promise<HostedResult[]> {
  const { results } = await db.prepare("SELECT * FROM hosted_runs WHERE workspace = ? ORDER BY at DESC LIMIT ?").bind(ws, limit).all();
  return results.map(resultOf).filter((r) => r !== null);
}

const RunRow = z.object({
  key: z.string(),
  project: z.string(),
  status: z.enum(HOSTED_STATUSES),
  pr: z.string(),
  branch: z.string(),
  draft: z.number(),
  summary: z.string(),
  minutes: z.number(),
  at: z.number(),
});
const resultOf = (r: unknown): HostedResult | null => {
  const p = RunRow.safeParse(r);
  return p.success ? { ...p.data, draft: p.data.draft === 1 } : null;
};

async function record(db: D1, ws: string, r: HostedResult): Promise<void> {
  await db
    .prepare(
      "INSERT INTO hosted_runs (id, workspace, key, project, status, pr, branch, draft, summary, minutes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), ws, r.key, r.project, r.status, r.pr, r.branch, r.draft ? 1 : 0, r.summary, r.minutes, r.at)
    .run();
}

// ── the GitHub App's per-run token ──

const GITHUB = "https://api.github.com";
const ghHeaders = (auth: string) => ({
  Authorization: auth,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "overhand-relay",
});

/** The App's own JWT (RS256, ten minutes at most, GitHub's limit), from its PKCS#8 private key. */
export async function appJwt(appId: string, pkcs8Pem: string, now: number): Promise<string> {
  const der = unb64url(pkcs8Pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const part = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sec = Math.floor(now / 1000);
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: sec - 60, exp: sec + 540, iss: appId })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)));
  return `${body}.${btoa(String.fromCharCode(...sig))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

/**
 * A token for one repository only (contents and pull requests), from the App's installation on it; GitHub expires it
 * within the hour, and the run revokes it when it ends. Throws a plain line when the App isn't installed there.
 */
export async function mintToken(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">, repo: string, now: number): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("Overhand's GitHub App isn't set up on this relay.");
  const jwt = `Bearer ${await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, now)}`;
  const inst = await fetch(`${GITHUB}/repos/${repo}/installation`, { headers: ghHeaders(jwt) });
  if (!inst.ok) throw new Error(`Overhand's GitHub App isn't installed on ${repo}.`);
  const { id } = z.object({ id: z.number() }).parse(await inst.json());
  const r = await fetch(`${GITHUB}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: ghHeaders(jwt),
    body: JSON.stringify({
      repositories: [repo.split("/")[1]],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    }),
  });
  if (!r.ok) throw new Error(`GitHub refused a token for ${repo} (${r.status}).`);
  return z.object({ token: z.string() }).parse(await r.json()).token;
}

/** Revokes a run's token as soon as the run ends; a failure only leaves it to expire within the hour. */
export const revokeToken = (token: string): Promise<unknown> =>
  fetch(`${GITHUB}/installation/token`, { method: "DELETE", headers: ghHeaders(`token ${token}`) }).catch(() => null);

// ── one run ──

/** What a run needs from the world, so tests stand in for the container and GitHub. */
export type RunDeps = {
  db: D1;
  /** The workspace's plan now (its own or a Team seat), or null. */
  plan: () => Promise<Plan | null>;
  mint: (repo: string) => Promise<string>;
  revoke: (token: string) => Promise<unknown>;
  /** Starts a fresh container, sends it the run, waits up to `maxMin`, and destroys it whatever happened. */
  box: (job: HostedJob, token: string, maxMin: number) => Promise<HostedRunAnswer>;
  maxMin: number;
  now: () => number;
};

/** A line with the run's own secrets taken out, in case a tool echoed one: D1 and the app only ever get this. */
const scrub = (s: string, secrets: string[]) => secrets.reduce((t, x) => (x ? t.replaceAll(x, "[hidden]") : t), s).slice(0, 600);

/**
 * Runs one handed-over ticket: checks the plan, reserves its longest length, mints the repository token, runs the
 * container, charges the minutes it ran (rounded up) and gives back the rest, and records the outcome. Never throws.
 */
export async function runJob(ws: string, job: HostedJob, d: RunDeps): Promise<HostedResult> {
  const start = d.now();
  const base = { key: job.key, project: job.project, pr: "", branch: "", draft: false, minutes: 0 };
  const done = async (r: HostedResult) => {
    await record(d.db, ws, r).catch((e) => console.error(`hosted run record: ${e instanceof Error ? e.message : String(e)}`));
    return r;
  };
  const plan = await d.plan();
  if (!plan) return done({ ...base, status: "not-started", summary: "Hosted runs need Overhand Pro or Team.", at: start });
  const held = await reserve(d.db, ws, plan, d.maxMin, start);
  if (!held)
    return done({
      ...base,
      status: "no-minutes",
      summary: `Not started: a hosted run needs ${d.maxMin} run minutes free, and this account has fewer.`,
      at: start,
    });
  let token = "";
  let answer: HostedRunAnswer;
  try {
    token = await d.mint(job.repo);
    answer = await d.box(job, token, d.maxMin);
  } catch (e) {
    answer = { status: "failed", pr: "", branch: "", draft: false, summary: e instanceof Error ? e.message : String(e) };
  } finally {
    if (token) await d.revoke(token);
  }
  const end = d.now();
  // a run that never reached a container (no token) costs nothing
  const minutes = token ? Math.min(d.maxMin, Math.max(1, Math.ceil((end - start) / 60_000))) : 0;
  await settle(d.db, ws, held, minutes, end);
  return done({ ...base, ...answer, summary: scrub(answer.summary, [job.apiKey, token]), minutes, at: end });
}

// ── the container ──

/** The Durable Object Container API, the parts used here (developers.cloudflare.com/containers/api/durable-object-container). */
export type ContainerApi = {
  running: boolean;
  images: { base: unknown };
  start(o: { image: unknown; instance: string; enableInternet: boolean }): void;
  getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> };
  destroy(): Promise<void>;
};

declare const scheduler: { wait(ms: number): Promise<void> };
const wait = (ms: number) => (typeof scheduler === "undefined" ? new Promise((r) => setTimeout(r, ms)) : scheduler.wait(ms));

/** One run in a fresh container: start, wait for its port, POST the run, and destroy it, whatever happened. */
export async function containerRun(c: ContainerApi, job: HostedJob, token: string, maxMin: number): Promise<HostedRunAnswer> {
  if (c.running) await c.destroy(); // never reuse one: each run starts clean
  c.start({ image: c.images.base, instance: RUN_INSTANCE.name, enableInternet: true });
  const port = c.getTcpPort(HOSTED_PORT);
  try {
    for (let i = 0; ; i++) {
      const ok = await port
        .fetch("http://container/health", { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      if (i > 150) throw new Error("The run's machine didn't start.");
      await wait(400);
    }
    const r = await port.fetch("http://container/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job, token, maxMin }),
      signal: AbortSignal.timeout(maxMin * 60_000),
    });
    return HostedRunAnswerSchema.parse(await r.json());
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new Error(timedOut ? `Stopped at the ${maxMin}-minute limit for one hosted run.` : e instanceof Error ? e.message : String(e));
  } finally {
    await c.destroy().catch(() => undefined);
  }
}

// ── the Durable Object ──

/** The DurableObjectState parts the Runner uses: hibernating sockets, storage and its one alarm. */
export type RunnerState = SignalState & {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  container?: ContainerApi;
};

/** A handed-over ticket as storage keeps it: everything but its API key. */
type StoredJob = Omit<HostedJob, "apiKey">;

/** What the daemon's socket carries through hibernation: its workspace, and each ticket's key, only while it's open. */
type Attachment = { ws: string; keys: Record<string, string> };
const AttachmentSchema = z.object({ ws: z.string(), keys: z.record(z.string(), z.string()) });
const attachmentOf = (sock: HibernatingSocket): Attachment =>
  AttachmentSchema.safeParse(sock.deserializeAttachment()).data ?? { ws: "", keys: {} };

declare const WebSocketPair: { new (): { 0: unknown; 1: HibernatingSocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

/** Tickets the computer is told a hosted run has taken; older ones are long done. */
const TAKEN_KEEP = 50;

/**
 * One per workspace. The daemon's socket hibernates: an idle one costs no Durable Object time, and its keep-alive pings
 * are answered by the runtime without waking the object. The ticket list (no keys) is in storage; each ticket's API key
 * rides on the socket's attachment, which the runtime keeps with the socket in memory and drops with it, never in
 * storage. On close, the object takes the keys into memory, sets an alarm for the grace's end, and stays awake through
 * the grace (one short wait per close) so they're still there when the alarm fires; a reconnect cancels it. Evicted
 * anyway, the keys are gone: those tickets are recorded as not started and the computer runs them when it's back.
 */
export class Runner {
  /** Each handed-over ticket's API key, from the closed socket's attachment, until its run; never written anywhere. */
  private keys: Record<string, string> = {};
  private readonly deps: (ws: string) => RunDeps;
  private readonly grace: number;
  /** How long a close keeps the object awake: past the grace, so the alarm finds the keys. */
  private readonly hold: number;

  constructor(
    private readonly ctx: RunnerState,
    env: Env,
    o: { deps?: (ws: string) => RunDeps; grace?: number; hold?: number } = {},
  ) {
    this.deps = o.deps ?? ((ws) => liveDeps(ctx, env, ws));
    this.grace = o.grace ?? HOSTED_GRACE_MS;
    this.hold = o.hold ?? this.grace + 5_000;
    if (typeof WebSocketRequestResponsePair !== "undefined") ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker forwards the daemon's authenticated upgrade here, naming the workspace in x-ws. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const pair = new WebSocketPair();
    await this.accept(pair[1], req.headers.get("x-ws") ?? "");
    const init: ResponseInit & { webSocket: unknown } = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  }

  /** A daemon's socket, hibernating: a reconnect cancels the grace; it hears what hosted runs have taken. */
  async accept(sock: HibernatingSocket, ws: string): Promise<void> {
    this.ctx.acceptWebSocket(sock, ["daemon"]);
    sock.serializeAttachment({ ws, keys: {} } satisfies Attachment);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("ws", ws);
    await this.tell(sock);
  }

  private async tell(sock: HibernatingSocket): Promise<void> {
    sock.send(JSON.stringify({ type: "taken", keys: (await this.ctx.storage.get<string[]>("taken")) ?? [] }));
  }

  /** The hand-off list, which replaces the last: tickets into storage without their keys, the keys onto the socket. */
  async webSocketMessage(sock: HibernatingSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let m: ReturnType<typeof HostedHandSchema.safeParse>;
    try {
      m = HostedHandSchema.safeParse(JSON.parse(message));
    } catch {
      return;
    }
    if (!m.success) return;
    const taken = new Set((await this.ctx.storage.get<string[]>("taken")) ?? []);
    const jobs = m.data.jobs.filter((j) => !taken.has(j.key));
    const stored: StoredJob[] = jobs.map(({ apiKey: _, ...j }) => j);
    await this.ctx.storage.put("jobs", stored);
    sock.serializeAttachment({ ...attachmentOf(sock), keys: Object.fromEntries(jobs.map((j) => [j.key, j.apiKey])) } satisfies Attachment);
    await this.tell(sock);
  }

  /** The computer's socket closed: the alarm at the grace's end decides, and the object stays awake until then. */
  async webSocketClose(sock: HibernatingSocket, _code?: number, _reason?: string, _clean?: boolean): Promise<void> {
    if (this.ctx.getWebSockets("daemon").some((s) => s !== sock)) return;
    const a = attachmentOf(sock);
    this.keys = { ...this.keys, ...a.keys };
    await this.ctx.storage.setAlarm(Date.now() + this.grace);
    // ponytail: one awake wait per close (about 15 GB-s, a fraction of a cent) so the keys outlive the grace; a
    // container that waits out the grace itself would cost container time instead
    await wait(this.hold);
  }

  /** Errors close the socket: treated as a close. */
  webSocketError(sock: HibernatingSocket, _e: unknown): Promise<void> {
    return this.webSocketClose(sock);
  }

  /** The grace is over with no computer back: runs the handed-over tickets one at a time; a ticket with no key held isn't run. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets("daemon").length) return;
    const jobs = (await this.ctx.storage.get<StoredJob[]>("jobs")) ?? [];
    const ws = (await this.ctx.storage.get<string>("ws")) ?? "";
    await this.ctx.storage.delete("jobs");
    if (!jobs.length || !ws) return;
    const taken = (await this.ctx.storage.get<string[]>("taken")) ?? [];
    await this.ctx.storage.put("taken", [...jobs.map((j) => j.key), ...taken].slice(0, TAKEN_KEEP));
    const d = this.deps(ws);
    for (const j of jobs) {
      const apiKey = this.keys[j.key];
      delete this.keys[j.key];
      if (apiKey) await runJob(ws, { ...j, apiKey }, d);
      else await notStarted(d.db, ws, j, d.now());
    }
  }
}

/** A ticket whose key wasn't held any more (the object was evicted during the grace): the computer runs it when it's back. */
const notStarted = (db: D1, ws: string, j: StoredJob, at: number): Promise<void> =>
  record(db, ws, {
    key: j.key,
    project: j.project,
    status: "not-started",
    pr: "",
    branch: "",
    draft: false,
    summary: "Not started: its API key wasn't held any more. It runs on your computer when it's back.",
    minutes: 0,
    at,
  }).catch(() => undefined);

/** The real world for a run: D1, the plan from `access`, the GitHub App, this object's container. */
function liveDeps(ctx: Pick<RunnerState, "container">, env: Env, ws: string): RunDeps {
  return {
    db: env.DB,
    plan: async () => (await access(env.DB, ws, Date.now()))?.plan ?? null,
    mint: (repo) => mintToken(env, repo, Date.now()),
    revoke: revokeToken,
    box: (job, token, maxMin) => {
      if (!ctx.container) throw new Error("This relay has no run container set up.");
      return containerRun(ctx.container, job, token, maxMin);
    },
    maxMin: runMaxMin(env),
    now: Date.now,
  };
}

// ── routes ──

/**
 * The daemon's hosted-run routes, only where HOSTED_RUNS is "1": the hand-off socket (`/relay/hosted/ws`), finished
 * runs it hasn't taken in (`GET /relay/hosted/runs`), and marking them taken in (`POST /relay/hosted/seen`). Null for
 * other paths.
 */
export async function hostedRoute(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/relay/hosted/")) return null;
  if (env.HOSTED_RUNS !== "1") return json({ error: "not found" }, 404);
  const d = await daemonOf(req, env, now);
  if (!d) return json({ error: "unknown daemon" }, 401);
  if (p === "/relay/hosted/ws") {
    if (!(await access(env.DB, d.ws, now))) return json({ error: "Hosted runs need Overhand Pro or Team." }, 402);
    if (!env.RUNNER) return json({ error: "not found" }, 404);
    if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected a websocket" }, 426);
    const h = new Headers(req.headers);
    h.set("x-ws", d.ws);
    return env.RUNNER.get(env.RUNNER.idFromName(d.ws)).fetch(new Request(req.url, { method: "GET", headers: h }));
  }
  if (req.method === "GET" && p === "/relay/hosted/runs") {
    const { results } = await env.DB.prepare("SELECT * FROM hosted_runs WHERE workspace = ? AND seen = 0 ORDER BY at LIMIT 50")
      .bind(d.ws)
      .all();
    return json({ runs: results.map(resultOf).filter((r) => r !== null) });
  }
  if (req.method === "POST" && p === "/relay/hosted/seen") {
    const b = z.object({ upTo: z.number() }).safeParse(await req.json().catch(() => null));
    if (!b.success) return json({ error: "upTo, a time" }, 400);
    await env.DB.prepare("UPDATE hosted_runs SET seen = 1 WHERE workspace = ? AND at <= ?").bind(d.ws, b.data.upTo).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
