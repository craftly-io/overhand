/**
 * `overhand hosted-run`: what runs inside a hosted run's container (relay/runner/Dockerfile). It serves one run on
 * HOSTED_PORT: the relay POSTs the job, the API key and the repository token, and this does what this computer's work
 * pass does with a ticket (agent.ts handleTicket): the same guard on every tool call, the same project mode, and
 * Overhand, not the agent, pushes the branch and opens the PR. The answer is one plain line and the PR.
 *
 * Nothing is kept: Overhand's folder and its secrets file live in memory (/dev/shm, OVERHAND_HOME), the code on the
 * container's own disk, and the relay destroys the container when the run ends. The token is only ever in this
 * process's environment, set when the run arrives (so not in /proc's start-up copy of it), which agent runs never get
 * (sandbox.ts SIGN_IN_ENV); git and gh read it through gh's credential helper.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_PORT, type HostedJob, type HostedRunAnswer, HostedRunRequestSchema } from "@overhand/contract";
import { type AgentResult, handleTicket } from "./agent";
import { type Client, type Config, saveConfig } from "./config";
import { applyConfig, CFG, CLIENTS, OPS, sh } from "./env";
import { writeSecret } from "./platform";
import { loadState } from "./state";
import type { Ticket } from "./trackers/types";

/** The one account a hosted run has. */
const ACCOUNT = "hosted";

/** The config a hosted run works under: one project, one API-key account, nothing else of yours. */
export function hostedConfig(job: HostedJob, code: string, owner = CFG.owner): Config {
  const prefix = job.key.split("-")[0] ?? "HOSTED";
  const name = job.repo.split("/")[1] ?? "repo";
  return {
    ...CFG,
    owner,
    accounts: [ACCOUNT],
    providers: job.runtime === "claude-code" ? { [ACCOUNT]: { kind: "claude", auth: "key" } } : {},
    runtimes: { [ACCOUNT]: { kind: job.runtime, model: job.model } },
    clients: [
      {
        name: job.project,
        dir: name,
        prefix,
        host: "github",
        aliases: [],
        autonomy: job.autonomy,
        status: { vercelSecrets: [], sentrySecrets: [] },
      },
    ],
    groups: [],
    codeRoot: code,
    // a fresh clone counts as active whatever its last commit's date; one run, one try
    limits: { ...CFG.limits, dormantDays: 36_500, maxAttempts: 1, maxTasksPerRun: 1, dailyBudgetUsd: 0 },
    sandbox: { mode: "enforce", required: false },
  };
}

/** The handed-over ticket as the work pass's own: a task with no tracker behind it (the container has no tracker access). */
export const hostedTicket = (job: HostedJob, client: Client): Ticket => ({
  client,
  key: job.key,
  id: "",
  title: job.title,
  url: "",
  status: "assigned",
  statusType: "unstarted",
  priority: "",
  labels: [],
  description: job.brief,
  comments: [],
  local: true,
});

/** One run, start to end: clone, set up, work the ticket, and say what came of it. Never throws. */
export async function hostedRun(job: HostedJob, token: string, code = "/work"): Promise<HostedRunAnswer> {
  const fail = (summary: string): HostedRunAnswer => ({ status: "failed", pr: "", branch: "", draft: false, summary });
  process.env.GH_TOKEN = token;
  mkdirSync(OPS, { recursive: true, mode: 0o700 });
  const name = job.repo.split("/")[1] ?? "repo";
  const dir = join(code, name, name);
  mkdirSync(join(code, name), { recursive: true });
  const clone = sh(["git", "clone", "--quiet", `https://github.com/${job.repo}.git`, dir], code);
  if (!clone.ok) return fail(`Couldn't get ${job.repo}: ${clone.err.trim().split("\n").at(-1) ?? ""}`);
  const secret = job.runtime === "claude-code" ? `anthropic-key-${ACCOUNT}` : `codex-key-${ACCOUNT}`;
  const saved = writeSecret(secret, ACCOUNT, job.apiKey);
  if (!saved.ok) return fail(`Couldn't hand the run its API key: ${saved.err}`);
  applyConfig(saveConfig(OPS, hostedConfig(job, code)));
  const c = CLIENTS[0];
  if (!c) return fail("The run's project couldn't be set up.");
  const state = loadState();
  let said: AgentResult | null = null;
  try {
    const r = await handleTicket(state, hostedTicket(job, c), (x) => {
      said = x;
    });
    if (r === "no-capacity") return fail("The API key was refused or is out of credit.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return answerOf(state.prs[job.key], said);
}

/** What the relay is told: the PR when one opened, else the run's own one line. */
export function answerOf(
  pr: { url: string; branch: string; draft?: boolean } | undefined,
  said: Pick<AgentResult, "status" | "message"> | null,
): HostedRunAnswer {
  const line = (said?.message ?? "").split("\n").find((l) => l.trim()) ?? "";
  if (pr) return { status: "done", pr: pr.url, branch: pr.branch, draft: Boolean(pr.draft), summary: line || "Opened a PR." };
  if (said?.status === "done") return { status: "report", pr: "", branch: "", draft: false, summary: line || "Filed a report." };
  return { status: "failed", pr: "", branch: "", draft: false, summary: line || "The run ended without a result." };
}

/** Serves one hosted run on HOSTED_PORT: `/health`, then a single POST `/run`; a second run is refused. */
export function serveHostedRun(port = HOSTED_PORT): void {
  let busy = false;
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 0, // a run takes as long as it takes, up to the relay's limit
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/health") return new Response("ok");
      if (p !== "/run" || req.method !== "POST") return new Response("not found", { status: 404 });
      if (busy) return Response.json({ error: "one run per container" }, { status: 409 });
      const body = HostedRunRequestSchema.safeParse(await req.json().catch(() => null));
      if (!body.success) return Response.json({ error: "bad run" }, { status: 400 });
      busy = true;
      return Response.json(await hostedRun(body.data.job, body.data.token));
    },
  });
  console.log(`hosted run waiting on port ${port}`);
}
