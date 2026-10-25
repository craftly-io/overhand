/** The ticket agent: routing to a repo, worktrees, PRs and their fix rounds, and the work pass. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildsItself,
  fromOverhand,
  type Proof,
  planPoints,
  proofMarkdown,
  type SplitPart,
  SplitPartSchema,
  withMark,
} from "@overhand/contract";
import {
  assign,
  editAssignments,
  holdFinding,
  isTaskKey,
  loadAssignments,
  PLAN_FIRST,
  runClient,
  type StoredAssignment,
  unassign,
} from "./assign";
import { policyOf, prCreateFlags, ticketRules } from "./autonomy";
import { claude } from "./claude";
import { gitRepos } from "./cleanup";
import type { Client } from "./config";
import { inspectCorners } from "./corners";
import { CFG, CLIENTS, CODE, clientOf, http, LABEL, MIN, OPS, sh, shAsync } from "./env";
import { loadWin, type StoredWin, saveWin } from "./firstwin";
import { protectedBranch } from "./guard";
import { capReport, guideMerged, guideNext, guidePrompt, isGuideKey, loadGuides, type StoredGuide, saveGuide } from "./guide";
import { recordOutcome } from "./history";
import { handOff, hostedJobs, hostedTaken, takeBack, takeInHosted } from "./hosted";
import { createPendingTickets } from "./inbox";
import { adoptLeadPrs, leadShipStep } from "./lead-prs";
import { learnFrom } from "./learn";
import { diskLow, enforceBudget, errorText, notify, report } from "./notify";
import { cleared, HeldError, holdLeak, scanOutward } from "./outward";
import { editPlan, parsePlan, planFile, upsertPlanItem } from "./plan";
import { previewOf } from "./preview";
import { assembleProof } from "./proof";
import { baseOf, disarmForPush, shipMerged, shipStep, shipSweep } from "./ship";
import { takeShots } from "./shots";
import { loadSplits, loadState, type State, saveSplits, saveState, type TrackedPr, takePrReview } from "./state";
import { bitbucket, bitbucketAuth } from "./trackers/bitbucket";
import { comment, labelledByOwner, mayPost, setLabels, tickets } from "./trackers/index";
import type { Ticket } from "./trackers/types";

interface Worktree {
  mainRepo: string;
  path: string;
  branch: string;
  base: string;
}

export interface AgentResult {
  status: "done" | "question" | "failed";
  pr_title: string;
  pr_body: string;
  message: string;
  parts?: SplitPart[];
  verified?: string;
}

const RESULT_SHAPE = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "question", "failed"] },
    pr_title: { type: "string" },
    pr_body: { type: "string", description: "markdown: what changed, why, how it was verified, which review agents ran" },
    message: { type: "string", description: "done: one-paragraph summary; question: the exact question; failed: what blocked you" },
    verified: {
      type: "string",
      description: "done: what you checked yourself and how (tests, pages opened, cases tried), in one or two sentences; empty if nothing",
    },
    parts: {
      type: "array",
      description: "question only, when the ticket is too big for one PR: the split you propose, one PR per part",
      items: { type: "object", properties: { title: { type: "string" }, scope: { type: "string" } }, required: ["title", "scope"] },
    },
  },
  required: ["status", "pr_title", "pr_body", "message"],
};
export const RESULT_SCHEMA = JSON.stringify(RESULT_SHAPE);
/** A guide run's result: a ticket's, plus the guide's text, which a watch run returns instead of writing it. */
const GUIDE_SCHEMA = JSON.stringify({
  ...RESULT_SHAPE,
  properties: { ...RESULT_SHAPE.properties, guide: { type: "string", description: "watch only: the whole ONBOARDING.md as Markdown" } },
});

/** A pull request to open: on which host, from which repository folder, branch onto base. */
export interface PrRequest {
  host: Client["host"];
  dir: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** `gh pr create` flags from the autonomy level (`--draft` on propose). */
  flags: string[];
}

/**
 * Pushes a run's work with your sign-in, so the run itself needs none (sandbox.ts SIGN_INS): only the branch its worktree
 * was made on, from that worktree, never forced and never a protected branch or the base. Throws with why.
 */
export async function pushBranch(wt: Pick<Worktree, "path" | "branch" | "base">): Promise<void> {
  if (wt.branch === wt.base || protectedBranch(wt.branch)) throw new Error(`${wt.branch} is a protected branch: Overhand doesn't push it`);
  const head = await shAsync(["git", "symbolic-ref", "--short", "HEAD"], wt.path);
  if (head.out !== wt.branch) throw new Error(`the run left its worktree on ${head.out || "no branch"}, not ${wt.branch}: nothing pushed`);
  const res = await shAsync(["git", "push", "-u", "origin", `HEAD:refs/heads/${wt.branch}`], wt.path);
  if (!res.ok) throw new Error(`git push: ${res.err.trim().split("\n").at(-1) ?? ""}`);
}

/** Opens a pull request (marked as Overhand's) and returns where it is. */
export async function createPr(p: PrRequest): Promise<{ url: string; host: Client["host"]; repo: string; number: number }> {
  if (p.host === "github") {
    const res = sh(
      ["gh", "pr", "create", "--head", p.branch, "--base", p.base, "--title", p.title, "--body", withMark(p.body), ...p.flags],
      p.dir,
    );
    if (!res.ok) throw new Error(`gh pr create: ${res.err}`);
    const url = res.out.split("\n").pop() ?? res.out;
    const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return { url, host: "github", repo: m?.[1] ?? "", number: Number(m?.[2] ?? 0) };
  }
  const remote = sh(["git", "remote", "get-url", "origin"], p.dir).out;
  const slug =
    remote
      .replace(/\.git$/, "")
      .split("/")
      .pop() ?? "";
  const pr = await http<{ id: number; links: { html: { href: string } } }>(
    `https://api.bitbucket.org/2.0/repositories/${bitbucket().workspace}/${slug}/pullrequests`,
    {
      method: "POST",
      headers: { Authorization: bitbucketAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: p.title,
        description: withMark(p.body),
        source: { branch: { name: p.branch } },
        destination: { branch: { name: p.base } },
        draft: p.flags.includes("--draft"),
      }),
    },
  );
  return { url: pr.links.html.href, host: "bitbucket", repo: slug, number: pr.id };
}

/**
 * The proof for a worktree's work: the checks in the run's transcript, the diff against its base, the agent's own
 * "verified", and (UI changes, a project with a preview) before/after screenshots. Never throws.
 */
async function proveWork(c: Client, key: string, wt: Worktree, transcript: string, verified: string): Promise<Proof> {
  const numstat = await shAsync(["git", "diff", "--numstat", `origin/${wt.base}...HEAD`], wt.path);
  const proof = assembleProof({ transcript, numstat: numstat.out, verified });
  if (!proof.ui) return proof;
  const shots = await takeShots(c, key, wt).catch((e: unknown) => ({ before: false, after: false, note: String(e) }));
  return assembleProof({ transcript, numstat: numstat.out, verified, shots });
}

/** A Ship step that threw: reported, and the PR simply waits for your merge (nothing turned on). */
const shipFailed = (key: string) => (e: unknown) => report(`⚠ ${key}: Ship: ${errorText(e)}`);

/** A PR's diff size for outcomes.jsonl, which the work report's time-saved estimate reads. */
const sizeOf = (pr: TrackedPr) => (pr.proof ? { added: pr.proof.added, removed: pr.proof.removed, docsOnly: pr.proof.docsOnly } : {});

/**
 * Pushes a finished ticket's branch (pushBranch) and opens its PR, as the project's autonomy level allows: ready for review on `act` and `ship` (whose
 * auto-merge the work pass turns on once this proof is in its body, ship.ts), a draft on `propose`, and never on `watch` (it throws, so nothing reaches the repo even if a watch run said done). Its body gets
 * the proof section (proof.ts); title and body go through the outward firewall first: a leak is held for you
 * (HeldError), the branch already pushed.
 */
export async function openPr(
  tk: Pick<Ticket, "client"> & { key?: string },
  wt: Worktree,
  r: AgentResult,
  transcript = "",
): Promise<TrackedPr> {
  const flags = prCreateFlags(tk.client.autonomy);
  if (!flags) throw new Error(`${tk.client.name} is on Plan and warn only: Overhand doesn't open PRs there`);
  const c = tk.client;
  await pushBranch(wt);
  const proof = await proveWork(c, tk.key ?? wt.branch, wt, transcript, r.verified ?? "");
  const body = [r.pr_body.trimEnd(), proofMarkdown(proof, CFG.outward.aiAttribution)].join("\n\n");
  const text = `${r.pr_title}\n\n${body}`;
  const hits = scanOutward(text, [c.name]);
  if (hits.length) {
    const payload = { host: c.host, dir: wt.mainRepo, branch: wt.branch, base: wt.base, flags: flags.join(" ") };
    const dest = `${c.name} repository, a pull request from ${wt.branch}`;
    throw new HeldError(holdLeak({ kind: "pr", project: c.name, dest, title: `PR: ${r.pr_title}`, text, payload }, hits));
  }
  const pr = await createPr({ host: c.host, dir: wt.path, branch: wt.branch, base: wt.base, title: r.pr_title, body, flags });
  return {
    proof,
    branch: wt.branch,
    mainRepo: wt.mainRepo,
    repoPath: wt.path,
    base: wt.base,
    seen: "",
    fixes: 0,
    draft: flags.includes("--draft"),
    openedAt: Date.now(),
    ...pr,
  };
}

// ---------- repos and worktrees ----------

/** Git repos under a client folder with a commit within limits.dormantDays (worktrees and node_modules skipped). */
export function activeRepos(c: Client): string[] {
  return gitRepos(join(CODE, c.dir)).filter(
    (repo) => Date.now() - Number(sh(["git", "log", "-1", "--format=%ct"], repo).out) * 1000 < CFG.limits.dormantDays * 24 * 60 * MIN,
  );
}

/** Picks the repo a ticket belongs to: the only active one, or a quick Haiku call over each repo's recent history. */
async function route(state: State, tk: Ticket): Promise<string | null> {
  const repos = activeRepos(tk.client);
  if (repos.length <= 1) return repos[0] ?? null;
  const profiles = repos.map((repo) => {
    const pkg = existsSync(join(repo, "package.json"))
      ? ((JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { description?: string }).description ?? "")
      : "";
    const log = sh(["git", "log", "-12", "--format=%s"], repo).out.replaceAll("\n", " | ");
    return `- ${repo}\n  ${pkg}\n  recent commits: ${log.slice(0, 700)}`;
  });
  const schema = JSON.stringify({
    type: "object",
    properties: { repo: { type: "string", enum: repos }, confident: { type: "boolean" } },
    required: ["repo", "confident"],
  });
  const prompt = [
    `Which repo does ticket ${tk.key} belong to? Answer from this data only, no tools.`,
    `Title: ${tk.title}`,
    `Description: ${tk.description.slice(0, 1500)}`,
    "",
    "Repos:",
    ...profiles,
  ].join("\n");
  const r = await claude<{ repo: string; confident: boolean; status?: string }>(state, prompt, OPS, schema, `${tk.key}-route`, {
    model: "haiku",
  });
  return r?.out.confident && repos.includes(r.out.repo) ? r.out.repo : null;
}

const LOCAL_FILE = /(^|\/)(\.env(\.local|\.development(\.local)?|\.test(\.local)?)?|\.claude\/settings\.local\.json)$/;

/**
 * Creates (or reuses) the worktree for a ticket so the session starts inside the repo and loads its own
 * CLAUDE.md, .claude/agents, skills, hooks and .mcp.json. Dev env files are copied in because git doesn't carry them.
 */
export async function prepareWorktree(mainRepo: string, key: string, existingBranch?: string): Promise<Worktree> {
  await shAsync(["git", "fetch", "origin", "--prune"], mainRepo); // the network: never on the event loop
  const has = (ref: string) => sh(["git", "rev-parse", "-q", "--verify", ref], mainRepo).ok;
  const base = baseOf(mainRepo);
  const branch = existingBranch ?? `${CFG.outward.branchPrefix}${key}`;
  const path = join(mainRepo, ".claude", "worktrees", key.toLowerCase());

  const exclude = join(mainRepo, ".git", "info", "exclude");
  if (!sh(["git", "check-ignore", "-q", ".claude/worktrees/x"], mainRepo).ok) appendFileSync(exclude, "\n.claude/worktrees/\n");

  if (!existsSync(path)) {
    const add = has(`origin/${branch}`)
      ? sh(["git", "worktree", "add", "-B", branch, path, `origin/${branch}`], mainRepo)
      : has(branch)
        ? sh(["git", "worktree", "add", path, branch], mainRepo)
        : sh(["git", "worktree", "add", "-b", branch, path, `origin/${base}`], mainRepo);
    if (!add.ok) throw new Error(`git worktree add failed in ${mainRepo}: ${add.err}`);
  }
  const ignored = sh(["git", "ls-files", "-o", "-i", "--exclude-standard", "--directory"], mainRepo).out.split("\n");
  for (const rel of ignored.filter((f) => LOCAL_FILE.test(f) && !f.includes("node_modules"))) {
    const dest = join(path, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(mainRepo, rel)));
  }
  return { mainRepo, path, branch, base };
}

interface PrStatus {
  state: "open" | "merged" | "closed";
  pending: boolean;
  needsFix: boolean;
  /** A reviewer asked for changes. */
  changes: boolean;
  /** The PR's head commit. */
  head: string;
  fingerprint: string;
  feedback: string;
  /** What people said, without authors: reviews, inline and PR comments; bots, CI and Overhand's own comments left out. */
  remarks: string[];
}

/**
 * A bot's login on GitHub or Bitbucket, or text Overhand or one of its agents posted (they post as you): it carries the
 * `<!-- overhand -->` marker. Ticket agents can't comment at all (the guard blocks it); a lead's comment is left out
 * only when it carries the marker, which its prompt tells it to add.
 */
export const notPerson = (login: string, body: string): boolean => /\[bot\]$|-bot$|^bot$/i.test(login) || fromOverhand(body);

async function prStatus(pr: TrackedPr): Promise<PrStatus> {
  if (pr.host === "github") {
    const v = JSON.parse(
      (await shAsync(["gh", "pr", "view", pr.url, "--json", "state,reviewDecision,statusCheckRollup,reviews,comments,headRefOid"])).out ||
        "{}",
    ) as {
      state?: string;
      reviewDecision?: string;
      headRefOid?: string;
      statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string; status?: string }[];
      reviews?: { author: { login: string }; state: string; body: string }[];
      comments?: { author: { login: string }; body: string }[];
    };
    // REST, not `gh pr view`: GraphQL drops a bot's "[bot]" suffix ("coderabbitai"), so only `user.type` tells a bot
    type Said = { body: string | null; user: { login: string; type?: string } };
    const rest = async <T>(path: string): Promise<T[]> => JSON.parse((await shAsync(["gh", "api", path])).out || "[]") as T[];
    const inline = await rest<Said & { path: string; line: number | null }>(`repos/${pr.repo}/pulls/${pr.number}/comments`);
    const said = [
      ...(await rest<Said>(`repos/${pr.repo}/pulls/${pr.number}/reviews`)),
      ...inline,
      ...(await rest<Said>(`repos/${pr.repo}/issues/${pr.number}/comments`)),
    ];
    const checks = v.statusCheckRollup ?? [];
    const failing = checks
      .filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.conclusion ?? c.state ?? ""))
      .map((c) => c.name ?? c.context ?? "check");
    const pending = checks.some((c) => c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.state === "PENDING");
    const feedback = [
      ...failing.map((f) => `CI failing: ${f}`),
      ...(v.reviews ?? []).filter((r) => r.body).map((r) => `Review (${r.state}) by ${r.author.login}: ${r.body}`),
      ...inline.map((c) => `${c.user.login} on ${c.path}:${c.line ?? "?"}: ${c.body}`),
      ...(v.comments ?? []).map((c) => `${c.author.login}: ${c.body}`),
    ].join("\n");
    return {
      state: v.state === "MERGED" ? "merged" : v.state === "CLOSED" ? "closed" : "open",
      pending,
      needsFix: v.reviewDecision === "CHANGES_REQUESTED" || failing.length > 0,
      changes: v.reviewDecision === "CHANGES_REQUESTED",
      head: v.headRefOid ?? "",
      fingerprint: [v.headRefOid, v.reviewDecision, failing.join(","), inline.length, v.reviews?.length].join("|"),
      feedback,
      remarks: said.flatMap((r) => (r.body && r.user.type !== "Bot" && !notPerson(r.user.login, r.body) ? [r.body] : [])),
    };
  }
  const base = `https://api.bitbucket.org/2.0/repositories/${bitbucket().workspace}/${pr.repo}/pullrequests/${pr.number}`;
  const h = { headers: { Authorization: bitbucketAuth() } };
  const p = await http<{ state: string; source: { commit: { hash: string } }; participants: { state: string | null }[] }>(base, h);
  const cs = await http<{
    values: { content: { raw: string }; inline?: { path: string; to: number | null }; user: { display_name: string } }[];
  }>(`${base}/comments?pagelen=50`, h);
  const st = await http<{ values: { state: string; name: string }[] }>(`${base}/statuses`, h);
  const failing = st.values.filter((s) => s.state === "FAILED").map((s) => s.name);
  const changes = p.participants.some((x) => x.state === "changes_requested");
  return {
    state: p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed",
    pending: st.values.some((s) => s.state === "INPROGRESS"),
    needsFix: changes || failing.length > 0,
    changes,
    head: p.source.commit.hash,
    fingerprint: [p.source.commit.hash, changes, failing.join(","), cs.values.length].join("|"),
    feedback: [
      ...failing.map((f) => `CI failing: ${f}`),
      ...cs.values.map((c) => `${c.user.display_name}${c.inline ? ` on ${c.inline.path}:${c.inline.to ?? "?"}` : ""}: ${c.content.raw}`),
    ].join("\n"),
    remarks: cs.values.filter((c) => c.content.raw && !notPerson(c.user.display_name, c.content.raw)).map((c) => c.content.raw),
  };
}

/**
 * Reads the PR's diff against its base for corners the agent may have cut, keeps them on the PR for the dashboard and
 * the brief, and (outward.cornerComment, GitHub) lists new ones in one PR comment. Never throws: it's a second look,
 * not a step the PR depends on.
 */
async function checkCorners(key: string, pr: TrackedPr): Promise<void> {
  try {
    const d =
      pr.host === "github"
        ? await shAsync(["gh", "pr", "diff", String(pr.number), "-R", pr.repo])
        : pr.base && existsSync(pr.repoPath)
          ? await shAsync(["git", "diff", "--no-color", `origin/${pr.base}...HEAD`], pr.repoPath)
          : null;
    if (!d?.ok) return;
    const post =
      CFG.outward.cornerComment && pr.host === "github"
        ? async (body: string) => {
            const project = clientOf(key)?.name ?? "";
            const payload = { repo: pr.repo, number: String(pr.number) };
            if (
              !cleared({
                kind: "pr-comment",
                project,
                dest: `pull request ${pr.url}`,
                key,
                title: `Comment on ${pr.url}`,
                text: body,
                payload,
              })
            )
              return false;
            return (await shAsync(["gh", "pr", "comment", String(pr.number), "-R", pr.repo, "--body", withMark(body)])).ok;
          }
        : undefined;
    const before = pr.corners?.length ?? 0;
    await inspectCorners(pr, d.out, post);
    const n = pr.corners?.length ?? 0;
    if (n && n !== before) report(`🚩 ${key}: ${n} thing${n === 1 ? "" : "s"} to check before merging ${pr.url}`);
  } catch (e) {
    report(`⚠ ${key}: couldn't check the diff for cut corners: ${errorText(e)}`);
  }
}

// ---------- work ----------

function taskPrompt(tk: Ticket, wt: Worktree): string {
  return [
    `Ticket ${tk.key} for client ${tk.client.name}: ${tk.title}`,
    tk.local ? "There is no ticket in a tracker: the owner assigned you this from Overhand." : `URL: ${tk.url}`,
    `Status: ${tk.status}   Priority: ${tk.priority}`,
    "",
    "Description:",
    tk.description || "(none)",
    "",
    "Comments, oldest first (answers to earlier questions are here):",
    ...(tk.comments.length ? tk.comments : ["(none)"]),
    "",
    `You are in a prepared worktree of ${wt.mainRepo}: ${wt.path}`,
    `Branch ${wt.branch}, based on origin/${wt.base} (the PR will target ${wt.base}). Work only inside this worktree.`,
    "Follow the workflow in your agent instructions and finish with the structured result.",
    ticketRules(tk.client.autonomy),
  ]
    .join("\n")
    .trimEnd();
}

function fixPrompt(key: string, pr: TrackedPr, feedback: string, c: Client): string {
  return [
    `Your PR for ${key} needs another round: ${pr.url}`,
    `You are in its worktree on branch ${pr.branch}. Overhand brought it up to date with what others pushed.`,
    "",
    "Feedback and failing checks:",
    feedback || "(CI failing, see the PR checks)",
    "",
    "Address every point that is right, explain in pr_body any you disagree with, rerun the checks and commit: Overhand pushes the same branch when you return done.",
    "Do not open a new PR. Return status done with pr_body summarizing what you changed in this round.",
    ticketRules(c.autonomy),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Works one ticket end to end: repo, worktree, the agent's run, then its PR, report, question or another attempt, as
 * the project's autonomy allows. `told` hears the run's own one-line outcome (a hosted run's container reports it).
 */
export async function handleTicket(state: State, tk: Ticket, told?: (r: AgentResult) => void): Promise<"ok" | "no-capacity"> {
  // where Overhand may not post (watch, a task with no ticket) no label marks the ticket as waiting on you: one that
  // stops for you counts as tried out, so it isn't rerun every pass; assigning an agent to it starts it afresh
  const held = !mayPost(tk);
  await setLabels(tk, [LABEL.queue, LABEL.working], [LABEL.blocked]);
  const splits = loadSplits();
  if (splits[tk.key]) {
    delete splits[tk.key]; // handed back to the agent whole: the old proposal no longer applies
    saveSplits(splits);
  }
  const repo = await route(state, tk);
  if (!repo) {
    const repos = activeRepos(tk.client).map((r) => r.split("/").pop() ?? r); // repo names, never local paths
    await comment(
      tk,
      `Which repo is this in? I couldn't tell from the ticket. Candidates: ${repos.join(", ")}\n\n(Reply here and remove the ${LABEL.blocked} label.)`,
    );
    await setLabels(tk, [LABEL.blocked], [LABEL.working]);
    if (held) state.attempts[tk.key] = CFG.limits.maxAttempts;
    report(`❓ ${tk.key}: couldn't pick a repo`);
    return "ok";
  }
  const wt = await prepareWorktree(repo, tk.key);
  const run = await claude<AgentResult>(state, taskPrompt(tk, wt), wt.path, RESULT_SCHEMA, tk.key, { client: tk.client });
  if (!run) {
    await setLabels(tk, [], [LABEL.working]);
    return "no-capacity";
  }
  const r = run.out;
  told?.(r);
  const tag = `${tk.key} (${run.account}, $${run.cost.toFixed(2)})`;
  if (r.status === "done" && policyOf(tk.client.autonomy).pr === "none") {
    // watch: the run was read-only; its report is held for you (dashboard: Post it, Assign an agent), never posted. A
    // task started from a sentence comes back as its plan: Go ahead builds that same task (dashboard plan card).
    if (tk.local && tk.status === "planning")
      holdFinding({
        project: tk.client.name,
        key: "",
        title: tk.title,
        text: r.message,
        post: "",
        from: "agent",
        task: tk.key,
        plan: planPoints(r.message),
      });
    else await comment(tk, `Investigation, nothing changed yet:\n\n${r.message}`);
    await setLabels(tk, [LABEL.blocked], [LABEL.working]);
    if (held) state.attempts[tk.key] = CFG.limits.maxAttempts;
    recordOutcome(OPS, { key: tk.key, event: "no-pr" });
    report(`👁 ${tag}: report filed`);
    notify(`Report on ${tk.key}`, r.message.slice(0, 120));
    return "ok";
  }
  if (r.status === "done") {
    try {
      const pr = await openPr(tk, wt, r, run.transcript);
      state.prs[tk.key] = pr;
      await checkCorners(tk.key, pr);
      // Ship: the proof is in its body now, so auto-merge may go on before its checks finish
      if (pr.host === "github")
        await shipStep(tk.key, pr, tk.client, sh(["git", "rev-parse", "HEAD"], wt.path).out).catch(shipFailed(tk.key));
      // a task with no ticket has nowhere to say so: its PR shows in Review like any other
      if (!tk.local) await comment(tk, `${pr.draft ? "Draft PR for review" : "PR ready for review"}: ${pr.url}\n\n${r.message}`);
      await setLabels(tk, [LABEL.review], [LABEL.working]);
      recordOutcome(OPS, { key: tk.key, event: "pr", url: pr.url, ...sizeOf(pr) });
      report(`✅ ${tag} → ${pr.url}${pr.draft ? " (draft)" : ""}`);
      notify(pr.draft ? `Draft to review: ${tk.key}` : `PR ready: ${tk.key}`, tk.title);
      return "ok";
    } catch (e) {
      r.status = "failed";
      r.message = `The work on ${wt.branch} is done, but pushing it or opening its PR failed: ${String(e)}`;
    }
  }
  if (r.status === "question") {
    const parts = (r.parts ?? []).filter((p) => SplitPartSchema.safeParse(p).success);
    if (parts.length) {
      saveSplits({ ...loadSplits(), [tk.key]: parts });
      r.message = [r.message, "", "Proposed split, one PR each:", ...parts.map((p, i) => `${i + 1}. ${p.title}: ${p.scope}`)].join("\n");
    }
    await comment(tk, `Question before I continue:\n\n${r.message}\n\n(Answer here and remove the ${LABEL.blocked} label.)`);
    await setLabels(tk, [LABEL.blocked], [LABEL.working]);
    if (held) state.attempts[tk.key] = CFG.limits.maxAttempts;
    recordOutcome(OPS, { key: tk.key, event: "no-pr" });
    report(`❓ ${tag}: ${r.message.slice(0, 160)}`);
    notify(`Question on ${tk.key}`, r.message.slice(0, 120));
    return "ok";
  }
  const attempts = (state.attempts[tk.key] ?? 0) + 1;
  state.attempts[tk.key] = attempts;
  if (attempts >= CFG.limits.maxAttempts) {
    await comment(tk, `I couldn't finish this after ${CFG.limits.maxAttempts} attempts:\n\n${r.message}`);
    await setLabels(tk, [LABEL.blocked], [LABEL.working]);
    notify(`Stuck on ${tk.key}`, r.message.slice(0, 120));
  } else {
    await setLabels(tk, [], [LABEL.working]);
  }
  recordOutcome(OPS, { key: tk.key, event: "failed" });
  report(`✗ ${tag} attempt ${attempts}: ${r.message.slice(0, 160)}`);
  return "ok";
}

/**
 * The first win, when setup queued one: the agent runs on it at once, like a ticket but local (key PREFIX-0, nothing in
 * the tracker), within the project's autonomy: a draft PR on propose, a PR on act, a report on watch. Its PR is then
 * tracked like any other, so Review and fix rounds work. Returns whether it ran, or false when no account had capacity.
 */
async function runFirstWin(state: State): Promise<boolean> {
  const w = loadWin();
  const c = w?.state === "queued" ? CLIENTS.find((x) => x.name === w.project) : undefined;
  if (!w || !c) return false;
  const save = (patch: Partial<StoredWin>) => saveWin({ ...w, ...patch, at: Date.now() });
  save({ state: "running" });
  try {
    const wt = await prepareWorktree(w.repoPath, w.key);
    const prompt = [
      `First task ${w.key} for ${c.name}: ${w.title}`,
      "Overhand found this small, safe task in the repo on its own; there is no ticket in a tracker. Do exactly this and nothing more.",
      "",
      w.brief,
      "",
      `You are in a prepared worktree of ${w.repo}: ${wt.path}`,
      `Branch ${wt.branch}, based on origin/${wt.base} (the PR will target ${wt.base}). Work only inside this worktree.`,
      "Follow the workflow in your agent instructions and finish with the structured result.",
      ticketRules(c.autonomy),
    ]
      .join("\n")
      .trimEnd();
    const run = await claude<AgentResult>(state, prompt, wt.path, RESULT_SCHEMA, w.key, { client: c });
    if (!run) {
      save({ state: "queued" });
      return false;
    }
    const r = run.out;
    const tag = `${w.key} (${run.account}, $${run.cost.toFixed(2)})`;
    if (r.status === "done" && policyOf(c.autonomy).pr === "none") {
      save({ state: "report", message: r.message });
      report(`👁 ${tag}: first task reported`);
      return true;
    }
    if (r.status !== "done") {
      save({ state: "failed", message: r.message });
      report(`✗ ${tag} first task: ${r.message.slice(0, 160)}`);
      return true;
    }
    const pr = await openPr({ client: c, key: w.key }, wt, r, run.transcript);
    state.prs[w.key] = pr;
    await checkCorners(w.key, pr);
    recordOutcome(OPS, { key: w.key, event: "pr", url: pr.url, ...sizeOf(pr) });
    save({ state: "pr", url: pr.url, message: r.message });
    report(`✅ ${tag} → ${pr.url}${pr.draft ? " (draft)" : ""}`);
    notify(pr.draft ? `Your first draft to review: ${w.key}` : `Your first PR: ${w.key}`, w.title);
    return true;
  } catch (e) {
    save({ state: "failed", message: e instanceof Error ? e.message : String(e) });
    report(`⚠ ${w.key} first task: ${errorText(e)}`);
    return true;
  }
}

/**
 * Queued onboarding guides, one run per project and at most `budget` of them: like the first win, local (no tracker
 * ticket) and within the project's autonomy, a PR adding ONBOARDING.md (a draft on propose) or, on watch, a report with
 * its text. The PR is then tracked like any other, so Review and fix rounds work. Returns how many ran; stops at the
 * first run no account had capacity for.
 */
async function runGuides(state: State, budget: number): Promise<number> {
  let ran = 0;
  for (const [project, g] of Object.entries(loadGuides())) {
    const c = g.run === "queued" ? CLIENTS.find((x) => x.name === project) : undefined;
    if (!c || ran >= budget) continue;
    const save = (patch: Partial<StoredGuide>) => saveGuide(project, { ...g, ...patch, at: Date.now() });
    save({ run: "running" });
    try {
      const wt = await prepareWorktree(g.repoPath, g.key);
      const run = await claude<AgentResult & { guide?: string }>(
        state,
        guidePrompt(c, g.key, basename(g.repoPath), wt),
        wt.path,
        GUIDE_SCHEMA,
        g.key,
        { client: c },
      );
      if (!run) {
        save({ run: "queued" });
        return ran;
      }
      ran++;
      const r = run.out;
      const tag = `${g.key} (${run.account}, $${run.cost.toFixed(2)})`;
      const next = guideNext(c.autonomy, r);
      if (next === "report") {
        save({ run: "idle", report: capReport(r.guide ?? ""), message: r.message });
        report(`👁 ${tag}: onboarding guide reported`);
        continue;
      }
      if (next === "failed") {
        save({ run: "failed", message: r.message });
        report(`✗ ${tag} onboarding guide: ${r.message.slice(0, 160)}`);
        continue;
      }
      const pr = await openPr({ client: c, key: g.key }, wt, r, run.transcript);
      state.prs[g.key] = pr;
      recordOutcome(OPS, { key: g.key, event: "pr", url: pr.url, ...sizeOf(pr) });
      save({ run: "idle", message: r.message });
      report(`📘 ${tag} → ${pr.url}${pr.draft ? " (draft)" : ""}`);
      notify(pr.draft ? `Onboarding guide to review: ${project}` : `Onboarding guide PR: ${project}`, r.pr_title);
    } catch (e) {
      save({ run: "failed", message: e instanceof Error ? e.message : String(e) });
      report(`⚠ ${g.key} onboarding guide: ${errorText(e)}`);
    }
  }
  return ran;
}

/**
 * Runs `run` over items, one group at a time per worker and up to `limit` groups at once, so items in the same group
 * never overlap. `run` returns false to stop the pass: runs already started finish, nothing new starts. A throw also
 * stops it, and is rethrown once every started run has finished.
 */
export async function runGrouped<T>(
  items: T[],
  group: (item: T) => string,
  limit: number,
  run: (item: T) => Promise<boolean>,
): Promise<void> {
  const groups = [...Map.groupBy(items, group).values()];
  let stop = false;
  const worker = async () => {
    for (let g = groups.shift(); g && !stop; g = groups.shift()) {
      for (const item of g) {
        if (stop) return;
        try {
          if (!(await run(item))) stop = true;
        } catch (e) {
          stop = true;
          throw e;
        }
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: limit }, worker));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * A task you assigned with no ticket behind it, as a ticket the agent works like any other (nothing reaches a tracker).
 * One started from a sentence is `planning` until you go ahead: the agent is told to plan it, not build it.
 */
const taskTicket = (c: Client, a: StoredAssignment): Ticket => ({
  client: c,
  key: a.key,
  id: "",
  title: a.title,
  url: "",
  status: a.plan ? "planning" : "assigned",
  statusType: "unstarted",
  priority: "",
  labels: [],
  description: a.plan ? `${a.brief}\n\n${PLAN_FIRST}` : a.brief,
  comments: [],
  local: true,
});

// ponytail: in memory, so a restart rechecks every labelled ticket once; a label someone else added is rechecked every 30 min
const labelChecked = new Map<string, number>();

/**
 * On a watch or propose project, the queue label counts as you assigning an agent only when you added it yourself
 * (labelledByOwner). Anyone else adding it (a client's teammate) assigns nothing; on watch you get a heads-up instead.
 */
async function assignIfOwnerLabelled(c: Client, tk: Ticket, assigned: Record<string, StoredAssignment>): Promise<void> {
  if ((labelChecked.get(tk.key) ?? 0) > Date.now()) return;
  if (await labelledByOwner(tk, LABEL.queue)) {
    assigned[tk.key] = assign({ project: c.name, key: tk.key, title: tk.title, by: "tracker" });
    report(`🙋 ${tk.key}: you labelled it ${LABEL.queue}, so an agent builds it`);
    return;
  }
  labelChecked.set(tk.key, Date.now() + 30 * MIN);
  if (c.autonomy === "watch")
    holdFinding({
      project: c.name,
      key: tk.key,
      title: `${tk.key}: ${tk.title}`,
      text: `Someone other than you added the ${LABEL.queue} label. On a watch project that starts no agent; assign one if this should be built.`,
      post: "",
      from: "tracker",
    });
}

/** One pass over PR feedback and the ticket queue, one agent per client at a time. Returns true if it started any agent work. */
export async function work(): Promise<boolean> {
  enforceBudget();
  if (existsSync(join(OPS, "PAUSE")) || diskLow()) return false; // a full disk fails runs with ENOSPC
  const lock = join(OPS, ".lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
      console.log(`already running (pid ${pid})`);
      return false;
    } catch {
      // stale lock from a crashed run
    }
  }
  writeFileSync(lock, String(process.pid));
  const state = loadState();
  // what you did in the Review drawer: notes join the PR's next fix round (like feedback from Slack), ready drafts stop waiting
  const reviewed = takePrReview();
  for (const [key, note] of Object.entries(reviewed.notes)) {
    const pr = state.prs[key];
    if (pr) pr.extra = [pr.extra, note].filter(Boolean).join("\n");
  }
  for (const key of reviewed.ready) {
    const pr = state.prs[key];
    if (pr) pr.draft = false;
  }
  let budget = CFG.limits.maxTasksPerRun;
  try {
    // A crashed run leaves claude-working behind; only one run exists at a time, so any we find are stale.
    for (const c of CLIENTS) {
      for (const tk of await tickets(c, { label: LABEL.working }).catch(() => [])) {
        // on watch only a ticket you assigned carries Overhand's label; anyone else's label there isn't Overhand's to remove
        await setLabels({ ...tk, client: runClient(c, tk.key) }, [], [LABEL.working]);
        report(`↺ ${tk.key} reset from an interrupted run`);
      }
    }
    await createPendingTickets(state);
    // what hosted runs did while this computer was away: their PRs are tracked from here like its own
    await takeInHosted(state, CLIENTS).catch((e: unknown) => report(`⚠ hosted runs: ${errorText(e)}`));
    // the first win, right after setup: before anything else, and inside the daily budget like any run
    if (await runFirstWin(state)) budget--;
    // onboarding guides asked for from the dashboard: also inside the budget, and before the queue like the first win
    budget -= await runGuides(state, budget);
    saveState(state);

    const fixRound = async ([key, pr]: [string, TrackedPr]): Promise<boolean> => {
      if (budget <= 0) return false;
      const s = await prStatus(pr).catch((e: unknown) => {
        report(`⚠ ${key}: couldn't read ${pr.url}: ${String(e)}`);
        return null;
      });
      if (!s) return true;
      if (s.state !== "open") {
        const c = clientOf(key);
        const tk = c && !isTaskKey(key) ? (await tickets(runClient(c, key), { key }).catch(() => []))[0] : undefined;
        if (tk) await setLabels(tk, [], [LABEL.review, LABEL.queue]);
        unassign(key); // its PR is done: the ticket is back at the project's own level
        recordOutcome(OPS, { key, event: s.state, url: pr.url, fixes: pr.fixes, changes: pr.changes ?? 0 });
        if (s.state === "merged" && isGuideKey(key))
          guideMerged(key, (await shAsync(["git", "remote", "get-url", "origin"], pr.mainRepo)).out);
        delete state.prs[key];
        if (s.state === "merged" && pr.ship?.on) shipMerged(key, pr);
        else report(`${s.state === "merged" ? "🎉" : "🗑"} ${key} PR ${s.state}`);
        return true;
      }
      // where to see it running, once its head commit has a preview deploy; looked up again after every push
      if (pr.host === "github" && s.head && pr.previewSha !== s.head) {
        const url = await previewOf(pr.repo, s.head).catch(() => "");
        if (url) Object.assign(pr, { preview: url, previewSha: s.head });
      }
      const fromSlack = pr.extra ?? "";
      const own = clientOf(key);
      // a PR for a ticket you assigned runs its fix rounds at the assigned level, like the run that opened it
      const c = own && runClient(own, key);
      // a lead's PR: the same Ship step, only for the commit its proof covers and while none of its project's leads
      // runs (one may push to it); saved at once, so a lead about to start sees it armed and turns it off first
      if (c && pr.host === "github" && pr.lead) {
        await leadShipStep(key, pr, c, s.head).catch(shipFailed(key));
        saveState(state);
      } else if (c && pr.host === "github") await shipStep(key, pr, c, s.head).catch(shipFailed(key));
      // what people asked for on this PR, kept to spot guidance that keeps coming back (learn.ts); once per new round
      if (c && (s.fingerprint !== pr.seen || fromSlack))
        learnFrom(c.name, basename(pr.mainRepo), key, [...s.remarks, ...fromSlack.split("\n").filter(Boolean)]);
      if (pr.lead) return true; // its lead answers its reviews and red checks itself: no second agent on it
      if (s.pending || ((!s.needsFix || s.fingerprint === pr.seen) && !fromSlack)) return true;
      if (!c || !policyOf(c.autonomy).fix) return true; // watch: no pushes, not even to an earlier PR's branch
      if (pr.fixes >= CFG.limits.maxFixes) {
        pr.seen = s.fingerprint;
        const tk = isTaskKey(key) ? undefined : (await tickets(c, { key }).catch(() => []))[0];
        if (tk) await setLabels(tk, [LABEL.blocked], []);
        report(`🛑 ${key} needs you: ${CFG.limits.maxFixes} fix rounds done on ${pr.url}`);
        return true;
      }
      if (budget <= 0) return false; // another client's run took the last slot while this one read its PR
      // Ship: never let a push land on an armed PR; the next pass re-reads its diff before arming it again
      await disarmForPush(key, pr).catch(shipFailed(key));
      if (pr.ship?.on) return true;
      budget--;
      const wt = existsSync(pr.repoPath) ? pr.repoPath : (await prepareWorktree(pr.mainRepo, key, pr.branch)).path;
      // what others pushed, brought in before the run: it has no sign-in to fetch with (sandbox.ts SIGN_INS)
      await shAsync(["git", "fetch", "origin", "--prune"], wt);
      await shAsync(["git", "merge", "--ff-only", `origin/${pr.branch}`], wt);
      const feedback = [s.feedback, fromSlack && `From the owner and Slack:\n${fromSlack}`].filter(Boolean).join("\n");
      if (s.changes) pr.changes = (pr.changes ?? 0) + 1;
      const run = await claude<AgentResult>(state, fixPrompt(key, pr, feedback, c), wt, RESULT_SCHEMA, `${key}-fix`, { client: c });
      if (!run) return false;
      pr.fixes++;
      pr.extra = undefined;
      if (run.out.status === "done")
        await pushBranch({ path: wt, branch: pr.branch, base: pr.base ?? "" }).catch((e: unknown) => {
          run.out.status = "failed";
          run.out.message = `nothing pushed to ${pr.branch}: ${errorText(e)}`;
        });
      if (run.out.status === "done" && pr.base) {
        // the proof as of this push; screenshots aren't retaken every round, the last ones stand
        const numstat = await shAsync(["git", "diff", "--numstat", `origin/${pr.base}...HEAD`], wt);
        const shots = pr.proof?.shots;
        pr.proof = assembleProof({
          transcript: run.transcript,
          numstat: numstat.out,
          verified: run.out.verified ?? "",
          ...(shots ? { shots } : {}),
        });
      }
      pr.seen = (await prStatus(pr).catch(() => s)).fingerprint;
      await checkCorners(key, pr);
      report(`${run.out.status === "done" ? "🔧" : "✗"} ${key} fix round ${pr.fixes} (${run.account}): ${run.out.message.slice(0, 160)}`);
      saveState(state);
      return true;
    };
    // the PRs leads opened since the last pass, taken in for Ship with their proof
    await adoptLeadPrs(state).catch((e: unknown) => report(`⚠ leads' PRs: ${String(e)}`));
    // Ship's disarm-only check of every armed PR first: it needs no run budget, so a full pass never delays it
    await shipSweep(state.prs).catch(shipFailed("Ship"));
    saveState(state);
    await runGrouped(Object.entries(state.prs), ([key]) => clientOf(key)?.name ?? key, CFG.limits.maxParallel, fixRound);

    // Gate: only items armed (checked) in today's plan run. Tickets labelled in the tracker are listed there unarmed.
    const plan = planFile();
    const planKeys = parsePlan(existsSync(plan) ? readFileSync(plan, "utf8") : "");
    const assigned = loadAssignments();
    const queue: Ticket[] = [];
    for (const c of CLIENTS) {
      const labelled = await tickets(c, { label: LABEL.queue }).catch((e: unknown) => {
        report(`⚠ ${c.name}: ${errorText(e)}`);
        return [];
      });
      for (const tk of labelled) {
        if (!buildsItself(c.autonomy) && !assigned[tk.key]) await assignIfOwnerLabelled(c, tk, assigned);
        if (planKeys.includes(tk.key) || assigned[tk.key]) queue.push(tk);
        else editPlan((md) => upsertPlanItem(md, c.name, tk.key, tk.title, null));
      }
      for (const key of planKeys.filter((k) => k.startsWith(`${c.prefix}-`) && !labelled.some((t) => t.key === k))) {
        queue.push(...(await tickets(c, { key }).catch(() => [])));
      }
      // what you assigned an agent to, armed or not; a task with no ticket runs from its brief
      for (const a of Object.values(assigned).filter((x) => x.project === c.name && !queue.some((t) => t.key === x.key))) {
        queue.push(...(a.local ? [taskTicket(c, a)] : await tickets(c, { key: a.key }).catch(() => [])));
      }
    }
    // one you assigned (again) since the last pass starts afresh; each runs at the project's assigned level, the rest at its own
    const fresh = Object.values(assigned).filter((a) => a.queued);
    for (const a of fresh) delete state.attempts[a.key];
    if (fresh.length)
      editAssignments((all) => {
        for (const a of fresh) {
          const x = all[a.key];
          if (x) x.queued = false;
        }
      });
    for (const tk of queue) tk.client = runClient(tk.client, tk.key, assigned);
    const busy: string[] = [LABEL.working, LABEL.review, LABEL.blocked];
    // projects that run hosted while this computer is away: the relay holds their queue until it is, or this pass runs it
    await handOff(hostedJobs(queue, state, busy)).catch((e: unknown) => report(`⚠ hosted runs: ${errorText(e)}`));
    await runGrouped(
      queue,
      (tk) => tk.client.name,
      CFG.limits.maxParallel,
      async (tk) => {
        if (budget <= 0) return false;
        if (tk.statusType === "completed" || tk.labels.some((l) => busy.includes(l)) || state.prs[tk.key]) return true;
        if ((state.attempts[tk.key] ?? 0) >= CFG.limits.maxAttempts || hostedTaken(tk.key)) return true;
        budget--;
        await takeBack(tk.key).catch(() => undefined); // running here now: never hosted as well
        const r = await handleTicket(state, tk).catch(async (e: unknown) => {
          report(`⚠ ${tk.key}: ${errorText(e)}`);
          await setLabels(tk, [], [LABEL.working]).catch(() => undefined);
          return "ok" as const;
        });
        saveState(state);
        if (r === "no-capacity") {
          report("⏸ all accounts cooling down, stopping this run");
          return false;
        }
        return true;
      },
    );
  } finally {
    saveState(state);
    unlinkSync(lock);
  }
  return budget < CFG.limits.maxTasksPerRun;
}
