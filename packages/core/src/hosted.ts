/**
 * Hosted runs (issue #15), the daemon's side: "Run here when my computer is off", per project. While this computer is
 * on, each work pass hands the queued tickets of those projects to the relay over one socket, each with the API key of
 * yours its run uses (never a sign-in); the relay never stores a key, and runs them only once this computer has gone
 * away (relay/src/hosted.ts, Runner). Back on, the daemon takes the finished runs in: a PR is tracked like its own (Review,
 * fix rounds), the ticket hears about it, and a run that stopped or never started shows as a card with its fix.
 *
 * Off unless this build switches hosted runs on (`hostedRunsOn`), this computer is linked, and a plan is active.
 */
import { join } from "node:path";
import {
  APP,
  HOSTED_MAX_JOBS,
  type HostedJob,
  type HostedResult,
  HostedRunsSchema,
  HostedTakenSchema,
  hostedRunsOn,
} from "@overhand/contract";
import { activeRepos } from "./agent";
import type { Client } from "./config";
import { ACCOUNTS, CFG, LABEL, OPS, providerOf, runtimeOf, sh } from "./env";
import { recordOutcome } from "./history";
import { notify, report } from "./notify";
import { readSecret } from "./platform";
import { hostedActive, relayLinked, relayRequest, relaySocketUrl, relayTiming } from "./relay";
import { baseOf } from "./ship";
import { readJson, type State, writeJsonAtomic } from "./state";
import { comment, setLabels, tickets } from "./trackers/index";
import type { Ticket } from "./trackers/types";

/** Whether hosted runs can work from this computer now: the build's switch, a link to an account, a paid plan. */
export const hostedReady = (): boolean => hostedRunsOn() && relayLinked() && hostedActive();

/** owner/name from a GitHub remote (https or ssh), else null. */
export function githubSlug(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The account a project's hosted run uses: the first of its accounts that runs on an API key of yours (Claude Code on
 * an Anthropic key, or Codex on its key), with that key. Null when none does: a hosted run never uses a sign-in.
 */
export function hostedAccount(
  c: Pick<Client, "accounts">,
  read: (service: string) => string | null = readSecret,
): { runtime: HostedJob["runtime"]; model: string; apiKey: string } | null {
  for (const a of c.accounts.length ? c.accounts : ACCOUNTS) {
    const rt = runtimeOf(a);
    const p = providerOf(a);
    const key =
      rt.kind === "claude-code" && p.kind === "claude" && p.auth === "key"
        ? read(`anthropic-key-${a}`)
        : rt.kind === "codex"
          ? read(`codex-key-${a}`)
          : null;
    if (key && (rt.kind === "claude-code" || rt.kind === "codex"))
      return { runtime: rt.kind, model: rt.kind === "codex" ? rt.model : p.kind === "claude" ? "" : p.model, apiKey: key };
  }
  return null;
}

/** A ticket as a hosted job, or null when it can't run hosted: not GitHub, more than one repo, no API key. */
export function jobFor(tk: Ticket, read: (service: string) => string | null = readSecret): HostedJob | null {
  const c = tk.client;
  if (!c.hosted || c.host !== "github") return null;
  const repos = activeRepos(c);
  const repo = repos.length === 1 && repos[0] ? repos[0] : null; // ponytail: one-repo projects; routing needs an agent run
  const slug = repo ? githubSlug(sh(["git", "remote", "get-url", "origin"], repo).out) : null;
  const acct = hostedAccount(c, read);
  if (!repo || !slug || !acct) return null;
  const brief = [tk.description, tk.comments.length ? ["Comments, oldest first:", ...tk.comments].join("\n") : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);
  return { key: tk.key, project: c.name, repo: slug, base: baseOf(repo), title: tk.title, brief, autonomy: c.autonomy, ...acct };
}

// ── the hand-off socket ──

let sock: WebSocket | null = null;
let handed: HostedJob[] = [];
/** Tickets a hosted run has taken: this computer must not start them, even if they're still in its queue. */
const taken = new Set<string>();

/** Whether a hosted run has this ticket (running or done): the work pass skips it. */
export const hostedTaken = (key: string): boolean => taken.has(key);

const send = () => {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "hand", jobs: handed }));
};

/**
 * Hands these tickets to the relay, replacing what it held (an empty list closes the socket, so nothing is held at
 * all). Called with each work pass's queue, and again as each ticket starts here, so a ticket running on this computer
 * is never also run hosted.
 */
export async function handOff(jobs: HostedJob[]): Promise<void> {
  handed = jobs.slice(0, HOSTED_MAX_JOBS);
  if (!handed.length || !hostedReady()) {
    sock?.close(1000, "nothing to hand over");
    sock = null;
    return;
  }
  if (sock && sock.readyState <= WebSocket.OPEN) return void send();
  const url = await relaySocketUrl("/relay/hosted/ws");
  if (!url) return;
  const ws = new WebSocket(url);
  sock = ws;
  // the relay's object hibernates between messages; its runtime answers these without waking it (relay.ts's timing)
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), relayTiming.ping);
  ws.onopen = send;
  ws.onmessage = (ev) => {
    try {
      const m = HostedTakenSchema.safeParse(JSON.parse(String(ev.data)));
      if (m.success) for (const k of m.data.keys) taken.add(k);
    } catch {
      // not JSON: ignored
    }
  };
  ws.onclose = () => {
    clearInterval(ping);
    if (sock === ws) sock = null; // the next work pass opens it again while there's anything to hand over
  };
}

/** Takes one ticket back from the hand-off list as it starts on this computer. */
export const takeBack = (key: string): Promise<void> => handOff(handed.filter((j) => j.key !== key));

// ── results ──

const STOPPED_FILE = () => join(OPS, "hosted.json");
/** How long a stopped run's card stays: a day, then the ticket has had its turn here again. */
const STOPPED_MS = 24 * 60 * 60_000;

/** The hosted runs that stopped or never started in the last day, newest first (the app's cards). */
export const stoppedRuns = (now = Date.now()): HostedResult[] =>
  readJson<HostedResult[]>(STOPPED_FILE(), []).filter((r) => now - r.at < STOPPED_MS);

/** What /api/state says about hosted runs; null where they can't be used. */
export const hostedState = (): { billing: string; stopped: HostedResult[] } | null =>
  hostedReady() ? { billing: `${APP}/relay/billing`, stopped: stoppedRuns() } : null;

/** A PR a hosted run opened, as the work pass tracks its own: Review shows it, fix rounds run here. */
function trackedPr(r: HostedResult, mainRepo: string): State["prs"][string] | null {
  const m = r.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m?.[1] || !r.branch) return null;
  return {
    url: r.pr,
    host: "github",
    repo: m[1],
    number: Number(m[2]),
    branch: r.branch,
    mainRepo,
    repoPath: "", // no worktree here yet: a fix round makes one from the branch
    base: baseOf(mainRepo),
    seen: "",
    fixes: 0,
    draft: r.draft,
    openedAt: r.at,
  };
}

/**
 * Takes in the hosted runs that finished while this computer was away: each PR into `state.prs`, the ticket told and
 * labelled as a local run's would be, a stop or a run that never started kept for its card. Then tells the relay
 * they're in. Network failures wait for the next pass.
 */
export async function takeInHosted(state: State, clients: Client[]): Promise<void> {
  if (!hostedRunsOn() || !relayLinked()) return;
  const res = await relayRequest("/relay/hosted/runs").catch(() => null);
  if (!res?.ok) return;
  const parsed = HostedRunsSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || !parsed.data.runs.length) return;
  const stopped = readJson<HostedResult[]>(STOPPED_FILE(), []);
  for (const r of parsed.data.runs) {
    taken.delete(r.key);
    const c = clients.find((x) => x.name === r.project);
    const tk = c && (await tickets(c, { key: r.key }).catch(() => []))[0];
    const mainRepo = c ? (activeRepos(c)[0] ?? "") : "";
    const pr = r.status === "done" && mainRepo ? trackedPr(r, mainRepo) : null;
    if (pr) {
      state.prs[r.key] = pr;
      if (tk)
        await comment(tk, `${pr.draft ? "Draft PR for review" : "PR ready for review"}: ${pr.url}\n\n${r.summary}`).catch(() => false);
      if (tk) await setLabels(tk, [LABEL.review], [LABEL.queue, LABEL.working]).catch(() => undefined);
      recordOutcome(OPS, { key: r.key, event: "pr", url: pr.url });
      report(`✅ ${r.key} (hosted, ${r.minutes} min) → ${pr.url}${pr.draft ? " (draft)" : ""}`);
      notify(pr.draft ? `Draft to review: ${r.key}` : `PR ready: ${r.key}`, r.summary.slice(0, 120));
    } else if (r.status === "report") {
      if (tk) await comment(tk, `Investigation, nothing changed yet:\n\n${r.summary}`).catch(() => false);
      if (tk) await setLabels(tk, [LABEL.blocked], [LABEL.working]).catch(() => undefined);
      recordOutcome(OPS, { key: r.key, event: "no-pr" });
      report(`👁 ${r.key} (hosted, ${r.minutes} min): report filed`);
    } else {
      // it stays in this computer's queue: the card says why and how to fix it
      stopped.unshift(r);
      report(`⚠ ${r.key}: hosted run ${r.status === "failed" ? "stopped" : "didn't start"}: ${r.summary}`);
    }
  }
  writeJsonAtomic(STOPPED_FILE(), stopped.slice(0, 50));
  const upTo = Math.max(...parsed.data.runs.map((r) => r.at));
  await relayRequest("/relay/hosted/seen", { body: { upTo } }).catch(() => null);
}

/** The work pass's queue as hosted jobs: what this computer would run, on projects switched to run hosted. */
export function hostedJobs(queue: Ticket[], state: State, busy: string[]): HostedJob[] {
  if (!hostedReady()) return [];
  return queue
    .filter(
      (tk) =>
        tk.client.hosted &&
        !state.prs[tk.key] &&
        tk.statusType !== "completed" &&
        !tk.labels.some((l) => busy.includes(l)) &&
        (state.attempts[tk.key] ?? 0) < CFG.limits.maxAttempts,
    )
    .flatMap((tk) => jobFor(tk) ?? []);
}
