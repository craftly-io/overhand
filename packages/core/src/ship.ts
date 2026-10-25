/**
 * Ship (a project at autonomy `ship`): Overhand's daemon, never the agent and never through any agent's settings, hands
 * an agent PR to GitHub's own auto-merge, so GitHub merges it only once every required check and branch rule passes.
 * Overhand never presses merge itself and never bypasses a rule. The guardrails, each here and each pinned by a test:
 * the base branch must have a required status check (`repoGate`, checked when Ship is turned on and before every
 * request); the PR's proof must be on it; a protected path in its diff, or the day's cap reached, leaves it waiting for
 * your merge (`shipVerdict`); every merge is reported with an Undo that opens a revert PR (`undoShip`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Proof, SHIP_DEFAULTS, withMark } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { gitReposAsync } from "./cleanup";
import type { Client } from "./config";
import { CFG, CODE, clientOf, OPS, sh, shAsync, today } from "./env";
import { notify, report } from "./notify";
import { readJson, type TrackedPr, writeJsonAtomic } from "./state";

/** A shell runner (`shAsync`); tests pass a fake gh. */
export type Run = (cmd: string[], cwd?: string) => Promise<{ ok: boolean; out: string; err: string }>;

export { SHIP_DEFAULTS };

const say = (word: string, vars: Record<string, string | number>): string =>
  word.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
const firstLine = (t: string): string => t.trim().split("\n")[0] ?? "";

// ---------- the gate: a required status check on the base branch ----------

type Protection = { protection?: { required_status_checks?: { enforcement_level?: string; contexts?: string[]; checks?: unknown[] } } };
type Rule = { type?: string; parameters?: { required_status_checks?: unknown[] } };

/**
 * Why green would mean nothing on `repo`'s `base`, or "" when it has at least one required status check, from classic
 * branch protection or a ruleset. A repo it can't read counts as no gate.
 */
export async function repoGate(repo: string, base: string, run: Run = shAsync): Promise<string> {
  if (!repo || !base) return say(plainWords.shipUnread, { repo: repo || "?", error: "no repository or branch" });
  const branch = await run(["gh", "api", `repos/${repo}/branches/${encodeURIComponent(base)}`]);
  if (!branch.ok) return say(plainWords.shipUnread, { repo, error: firstLine(branch.err) });
  const rsc = (JSON.parse(branch.out || "{}") as Protection).protection?.required_status_checks;
  if (rsc && rsc.enforcement_level !== "off" && (rsc.contexts?.length ?? 0) + (rsc.checks?.length ?? 0) > 0) return "";
  const rules = await run(["gh", "api", `repos/${repo}/rules/branches/${encodeURIComponent(base)}`]);
  const parsed: unknown = rules.ok ? JSON.parse(rules.out || "[]") : [];
  const list: Rule[] = Array.isArray(parsed) ? parsed : [];
  if (list.some((r) => r.type === "required_status_checks" && (r.parameters?.required_status_checks?.length ?? 0) > 0)) return "";
  // a private repo on GitHub's free plan can't have either (rulesets, protection and auto-merge all need a paid plan):
  // say that, rather than suggest adding a check GitHub would refuse
  const meta = await run(["gh", "api", `repos/${repo}`, "--jq", "{private, allow_auto_merge}"]);
  const m = meta.ok ? (JSON.parse(meta.out || "{}") as { private?: boolean; allow_auto_merge?: boolean }) : {};
  if (m.private && !m.allow_auto_merge) return say(plainWords.shipPrivatePlan, { level: plainWords.autonomyActName });
  return say(plainWords.shipNoGate, { branch: base });
}

// ponytail: in memory, so a restart reads each gate once more; ten minutes keeps a removed rule from going unseen for long
const gates = new Map<string, { at: number; why: string }>();
const GATE_TTL_MS = 10 * 60_000;

/** `repoGate`, read at most every ten minutes per repo and branch. */
export async function cachedGate(repo: string, base: string, run: Run = shAsync, now = Date.now()): Promise<string> {
  const id = `${repo}@${base}`;
  const hit = gates.get(id);
  if (hit && now - hit.at < GATE_TTL_MS) return hit.why;
  const why = await repoGate(repo, base, run);
  gates.set(id, { at: now, why });
  return why;
}

/** The branch an agent PR from this checkout targets: develop when the remote has it, else its default branch. */
export function baseOf(mainRepo: string): string {
  const has = (ref: string) => sh(["git", "rev-parse", "-q", "--verify", ref], mainRepo).ok;
  return pickBase(has("origin/develop"), sh(HEAD_REF, mainRepo).out, () => has("origin/main"));
}
const HEAD_REF = ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"];
const pickBase = (develop: boolean, head: string, main: () => boolean): string =>
  develop ? "develop" : head.replace(/^origin\//, "") || (main() ? "main" : "master");

/** "owner/repo" from a GitHub remote URL (https or ssh); "" for any other host. */
export const githubSlug = (remote: string): string => remote.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? "";

/** Each repository of a project as the gate reads it: its GitHub slug and the branch agent PRs target. */
export async function shipTargets(c: Pick<Client, "dir">): Promise<{ repo: string; base: string }[]> {
  const out: { repo: string; base: string }[] = [];
  for (const dir of await gitReposAsync(join(CODE, c.dir))) {
    const has = (ref: string) => shAsync(["git", "rev-parse", "-q", "--verify", ref], dir);
    const [remote, develop, head, main] = await Promise.all([
      shAsync(["git", "remote", "get-url", "origin"], dir),
      has("origin/develop"),
      shAsync(HEAD_REF, dir),
      has("origin/main"),
    ]);
    out.push({ repo: githubSlug(remote.out), base: pickBase(develop.ok, head.out, () => main.ok) });
  }
  return out;
}

/** Why Ship can't be on for this project, or "" when every repository's base branch has a required status check. */
export async function projectGate(
  c: Pick<Client, "name" | "host">,
  targets: readonly { repo: string; base: string }[],
  run: Run = shAsync,
): Promise<string> {
  if (c.host !== "github") return plainWords.shipNotGithub;
  if (!targets.length) return say(plainWords.shipUnread, { repo: c.name, error: "no git repository found" });
  for (const t of targets) {
    const why = await cachedGate(t.repo, t.base, run);
    if (why) return targets.length > 1 && t.repo ? `${t.repo}: ${why}` : why;
  }
  return "";
}

/**
 * Why Ship can't be turned on, for each project a config change newly puts on it ("" = every one may): Settings and
 * Quick settings save only when this is empty.
 */
export async function shipRefusal(
  before: readonly Pick<Client, "name" | "autonomy">[],
  after: readonly Pick<Client, "name" | "host" | "dir" | "autonomy">[],
  run: Run = shAsync,
  targets: (c: Pick<Client, "dir">) => Promise<{ repo: string; base: string }[]> | { repo: string; base: string }[] = shipTargets,
): Promise<string> {
  for (const c of after) {
    if (c.autonomy !== "ship" || before.find((b) => b.name === c.name)?.autonomy === "ship") continue;
    const why = await projectGate(c, await targets(c), run);
    if (why) return `${c.name}: ${why} ${plainWords.shipStays}`;
  }
  return "";
}

// ponytail: the dashboard's per-project answer, refreshed in the background at most every half hour per project
const blocks = new Map<string, { at: number; why: string }>();
const BLOCK_TTL_MS = 30 * 60_000;

/**
 * Why Ship can't be on for a GitHub project, as last read (Settings and Quick settings show it); "" when it can or it
 * hasn't been read yet (`refreshShipBlocks` reads it).
 */
export function shipBlock(c: Pick<Client, "name" | "host">): string {
  return c.host === "github" ? (blocks.get(c.name)?.why ?? "") : plainWords.shipNotGithub;
}

/** Reads each GitHub project's stale or missing Ship answer again, in the background (the dashboard's state timer). */
export function refreshShipBlocks(clients: readonly Pick<Client, "name" | "host" | "dir">[], now = Date.now()): void {
  for (const c of clients) {
    const hit = blocks.get(c.name);
    if (c.host !== "github" || (hit && now - hit.at <= BLOCK_TTL_MS)) continue;
    blocks.set(c.name, { at: now, why: hit?.why ?? "" }); // one read at a time
    void shipTargets(c)
      .then((t) => projectGate(c, t))
      .then((why) => blocks.set(c.name, { at: Date.now(), why }))
      .catch(() => undefined);
  }
}

// ---------- one PR: hand it to auto-merge, or say why it waits ----------

/** What decides one Ship PR, read fresh each time. */
export interface ShipFacts {
  /** `repoGate`'s answer for its base: "" = a required check guards it. */
  gate: string;
  /** Its proof (checks run, screenshots for screen changes) is in its body (`proofOn`). */
  proof: boolean;
  /** You asked for changes on it (Review drawer, Slack): it waits for your merge from then on. */
  asked: boolean;
  /** Files its diff touches. */
  files: readonly string[];
  protect: readonly string[];
  /** Ship requests already made on this project today. */
  today: number;
  perDay: number;
}

/** The PR carries its proof: the checks the agent ran, and before/after screenshots when it changes a screen. */
export const proofOn = (p: Proof | undefined): boolean => Boolean(p?.checks.length && (!p.ui || p.shots.after));

/** The first protected path a file list touches: "dir/" covers everything under it, anything else is a glob. */
export function protectedFile(files: readonly string[], protect: readonly string[]): string {
  for (const p of protect) for (const f of files) if (p.endsWith("/") ? f.startsWith(p) : f === p || new Bun.Glob(p).match(f)) return f;
  return "";
}

/**
 * What Ship does with one open PR: `merge` hands it to GitHub's auto-merge; otherwise `why` it waits for your merge
 * and `final` when that PR stays waiting for you (otherwise it's asked again next pass: a proof, a gate may come).
 */
export function shipVerdict(f: ShipFacts): { merge: true } | { merge: false; why: string; final: boolean } {
  if (f.asked) return { merge: false, why: plainWords.shipAsked, final: true };
  if (f.gate) return { merge: false, why: f.gate, final: false };
  if (!f.proof) return { merge: false, why: plainWords.shipNoProof, final: false };
  const hit = protectedFile(f.files, f.protect);
  if (hit) return { merge: false, why: say(plainWords.shipProtected, { path: hit }), final: true };
  if (f.today >= f.perDay) return { merge: false, why: say(plainWords.shipCapped, { n: f.perDay }), final: true };
  return { merge: true };
}

/** One auto-merge Overhand asked for, kept for the day's cap, the report and Undo. */
export interface ShipRecord {
  key: string;
  project: string;
  url: string;
  repo: string;
  number: number;
  base: string;
  mainRepo: string;
  /** When auto-merge was turned on, and on which local day (the cap counts per day). */
  at: number;
  day: string;
  /** When GitHub merged it; absent while it waits for its checks. */
  merged?: number;
  /** The revert PR Undo opened. */
  revert?: string;
  /** When Overhand turned this request's auto-merge off again (a push, a start, a reason to wait); absent while on. */
  off?: number;
}

const LOG = () => join(OPS, "ship.json");
/** Every Ship request, newest last. */
export const loadShips = (): ShipRecord[] => readJson<ShipRecord[]>(LOG(), []);
const saveShips = (xs: ShipRecord[]) => writeJsonAtomic(LOG(), xs.slice(-500));
const editShips = (f: (xs: ShipRecord[]) => void) => {
  const xs = loadShips();
  f(xs);
  saveShips(xs);
};

/** The PR as GitHub has it now: what arming and disarming are checked against. */
interface LivePr {
  id: string;
  state: string;
  baseRefName: string;
  headRefOid: string;
  reviewDecision: string;
  autoMergeRequest: unknown;
}

async function livePr(pr: TrackedPr, run: Run): Promise<LivePr | null> {
  const fields = "id,state,baseRefName,headRefOid,reviewDecision,autoMergeRequest";
  const r = await run(["gh", "pr", "view", String(pr.number), "-R", pr.repo, "--json", fields]);
  if (!r.ok || !r.out.trim()) return null;
  const v = JSON.parse(r.out) as Partial<LivePr>;
  return {
    id: v.id ?? "",
    state: v.state ?? "",
    baseRefName: v.baseRefName ?? "",
    headRefOid: v.headRefOid ?? "",
    reviewDecision: v.reviewDecision ?? "",
    autoMergeRequest: v.autoMergeRequest ?? null,
  };
}

// GitHub's own auto-merge, the GraphQL mutations themselves: they wait for every required check, and unlike `gh pr merge
// --auto` never fall back to merging on the spot. Arming names the head commit whose files were checked.
const ARM =
  "mutation($id:ID!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$head}){clientMutationId}}";
const DISARM = "mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}";
const graphql = (query: string, vars: Record<string, string>, run: Run) =>
  run(["gh", "api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-F", `${k}=${v}`])]);

/** Files a PR touches, renames counted under both names; null when unreadable or too many to check (fail closed). */
async function changedFiles(pr: TrackedPr, run: Run): Promise<string[] | null> {
  const jq = ".[] | .filename, (.previous_filename // empty)";
  const r = await run(["gh", "api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/files`, "--jq", jq]);
  if (!r.ok) return null;
  const files = r.out.split("\n").filter(Boolean);
  return files.length >= MAX_FILES ? null : files;
}
/** GitHub lists at most 3000 files of a PR: past that, what it touches can't be known. */
const MAX_FILES = 3000;

/**
 * Turns auto-merge off on an armed PR (already off on GitHub counts as off). `why` is said on the PR item; `final` keeps it
 * waiting for you. A failure leaves it marked armed, so the next pass tries again.
 */
async function disarm(key: string, pr: TrackedPr, why: string, final: boolean, run: Run, live?: LivePr | null): Promise<void> {
  if (!pr.ship?.on) return;
  const l = live === undefined ? await livePr(pr, run) : live;
  const off = l && !l.autoMergeRequest ? { ok: true, err: "" } : l ? await graphql(DISARM, { id: l.id }, run) : null;
  if (!off?.ok) return report(`⚠ ${key}: couldn't turn auto-merge off for ${pr.url}: ${firstLine(off?.err ?? "can't read it")}`);
  pr.ship = { on: false, why, head: pr.ship.head, final };
  editShips((xs) => {
    const s = xs.findLast((x) => x.url === pr.url);
    if (s && !s.merged && !s.off) s.off = Date.now();
  });
  report(`✋ ${key}: auto-merge off for ${pr.url}${why ? `: ${why}` : ""}`);
}

/** Turns auto-merge off before an agent pushes to the PR: armed again only after a pass re-reads the new diff. */
export async function disarmForPush(key: string, pr: TrackedPr, run: Run = shAsync): Promise<void> {
  const was = pr.ship;
  if (!was?.on) return; // a PR waiting for you keeps its reason: a push doesn't clear it
  await disarm(key, pr, "", false, run);
  if (pr.ship?.on) return;
  // changes you asked for keep it waiting for your merge after the push too; otherwise re-checked before arming again
  pr.ship = pr.extra ? { on: false, why: plainWords.shipAsked, head: was.head, final: true } : undefined;
}

/**
 * The disarm-only check of an armed PR, needing no run budget: off when its project left Ship or the config, a new commit
 * landed (re-checked before arming again), its base changed, someone asked for changes, or the gate is gone. True when
 * it stays armed.
 */
export async function shipCheck(
  key: string,
  pr: TrackedPr,
  c: Pick<Client, "name" | "autonomy"> | undefined,
  run: Run = shAsync,
  now = Date.now(),
): Promise<boolean> {
  if (!pr.ship?.on) return false;
  if (c?.autonomy !== "ship" || pr.draft) {
    await disarm(key, pr, "", false, run);
    return Boolean(pr.ship?.on);
  }
  const l = await livePr(pr, run);
  if (!l) {
    report(`⚠ ${key}: couldn't read ${pr.url} to check its auto-merge`);
    return true;
  }
  if (l.state === "MERGED") return true; // the work pass reports it
  const why =
    l.headRefOid !== pr.ship.head
      ? { text: "", final: false }
      : l.baseRefName !== pr.base
        ? { text: plainWords.shipBaseMoved, final: true }
        : l.reviewDecision === "CHANGES_REQUESTED" || pr.extra
          ? { text: plainWords.shipAsked, final: true }
          : { text: await cachedGate(pr.repo, pr.base ?? "", run, now), final: false };
  if (why.text === "" && l.headRefOid === pr.ship.head) return true;
  await disarm(key, pr, why.text, why.final, run, l);
  return Boolean(pr.ship?.on);
}

/** Every armed PR checked at once (a Settings save, the start of a work pass), whatever the run budget. */
export async function shipSweep(
  prs: Record<string, TrackedPr>,
  clientFor: (key: string) => Pick<Client, "name" | "autonomy"> | undefined = clientOf,
  run: Run = shAsync,
): Promise<void> {
  for (const [key, pr] of Object.entries(prs))
    if (pr.ship?.on)
      await shipCheck(key, pr, clientFor(key), run).catch((e: unknown) => report(`⚠ ${key}: Ship couldn't check ${pr.url}: ${String(e)}`));
}

/**
 * One pass of Ship over an open agent PR at head commit `head`: on a Ship project, once its proof is on it, the gate
 * holds, its base and head are the ones checked, nobody asked for changes, it touches nothing protected and today's cap
 * allows, turns on GitHub's auto-merge for that commit (and records it). An armed PR goes through `shipCheck`.
 * `canArm` is asked right before the request and again right after it (a lead's PR: no lead of its project may run
 * then); a no after arming turns it straight off again.
 */
export async function shipStep(
  key: string,
  pr: TrackedPr,
  c: Pick<Client, "name" | "autonomy" | "ship">,
  head: string,
  run: Run = shAsync,
  now = Date.now(),
  canArm: () => boolean = () => true,
): Promise<void> {
  if (pr.ship?.on && (await shipCheck(key, pr, c, run, now))) return;
  if (c.autonomy !== "ship" || pr.host !== "github" || pr.draft) return;
  const l = await livePr(pr, run);
  if (!l) return report(`⚠ ${key}: couldn't read ${pr.url}, so Ship waits`);
  if (l.state !== "OPEN") return;
  // auto-merge someone else turned on (an agent through the API, say) while Ship says wait: off, and told
  const foreign = async () => {
    if (!l.autoMergeRequest || pr.ship?.on) return;
    const off = await graphql(DISARM, { id: l.id }, run);
    report(
      off.ok
        ? `✋ ${key}: auto-merge on ${pr.url} wasn't turned on by Ship, so it's off again; the merge is yours`
        : `⚠ ${key}: auto-merge on ${pr.url} wasn't turned on by Ship and couldn't be turned off: ${firstLine(off.err)}`,
    );
  };
  const waits = async (why: string, final: boolean) => {
    pr.ship = { on: false, why, head, final };
    await foreign();
  };
  if (pr.ship?.final) return foreign();
  if (l.headRefOid !== head) return foreign(); // a newer commit: the next pass checks that one
  if (l.baseRefName !== pr.base) return waits(plainWords.shipBaseMoved, true);
  const files = await changedFiles(pr, run);
  if (!files) return waits(plainWords.shipTooBig, true);
  const day = today();
  const v = shipVerdict({
    gate: await cachedGate(pr.repo, pr.base ?? "", run, now),
    asked: Boolean(pr.extra) || l.reviewDecision === "CHANGES_REQUESTED",
    proof: proofOn(pr.proof),
    files,
    protect: c.ship?.protect ?? SHIP_DEFAULTS.protect,
    // distinct PRs: one armed again after a push doesn't take a second slot
    today: new Set(loadShips().flatMap((s) => (s.project === c.name && s.day === day && s.url !== pr.url ? [s.url] : []))).size,
    perDay: c.ship?.perDay ?? SHIP_DEFAULTS.perDay,
  });
  if (!v.merge) return waits(v.why, v.final);
  // a Settings save during this pass may have taken the project off Ship: the live config decides, right before arming
  if (clientOf(key)?.autonomy !== "ship" || !canArm()) return foreign();
  const r = await graphql(ARM, { id: l.id, head }, run);
  if (!r.ok) {
    // never retried every pass, and never merged by Overhand instead: a person takes it from here
    if (/auto.?merge is not allowed|not allowed for this repository/i.test(r.err)) return waits(plainWords.shipNotAllowed, true);
    if (/clean status/i.test(r.err)) return waits(plainWords.shipClean, true);
    return report(`⚠ ${key}: couldn't turn on auto-merge for ${pr.url}: ${firstLine(r.err)}`);
  }
  const { url, repo, number, mainRepo } = pr;
  editShips((xs) => xs.push({ key, project: c.name, url, repo, number, base: pr.base ?? "", mainRepo, at: now, day }));
  pr.ship = { on: true, why: "", head, final: false };
  report(`🚢 ${key}: auto-merge on for ${pr.url}; GitHub merges it once every required check passes`);
  if (!canArm()) await disarm(key, pr, "", false, run);
}

/** A Ship PR merged (the work pass saw it): kept for Undo, told in the day's log, the brief and a push. */
export function shipMerged(key: string, pr: TrackedPr, now = Date.now()): void {
  editShips((xs) => {
    const s = xs.findLast((x) => x.url === pr.url);
    if (s) s.merged = now;
  });
  report(`🎉 ${key} PR merged on Ship ${pr.url}`);
  notify(`Merged by itself: ${key}`, `${say(plainWords.shipMerged, { key })} ${plainWords.shipUndoHint}: ${plainWords.shipUndo}.`);
}

/** Ship merges of the last two days, newest first, for the dashboard's Undo. */
export const recentShips = (now = Date.now()): ShipRecord[] =>
  loadShips()
    .filter((s) => s.merged && now - s.merged < 48 * 3600_000)
    .reverse();

/**
 * Undo for a Ship merge: a new branch off the base with the merge reverted, pushed, and a PR from it for you to review.
 * It never pushes to the base branch and never force-pushes. Returns the revert PR's URL (the same one when asked again).
 */
export async function undoShip(url: string, run: Run = shAsync): Promise<string> {
  const s = loadShips().findLast((x) => x.url === url && x.merged);
  if (!s) throw new Error("no Ship merge to undo there");
  if (s.revert) return s.revert;
  const view = await run(["gh", "pr", "view", url, "--json", "mergeCommit", "-q", ".mergeCommit.oid"]);
  const sha = view.out.trim();
  if (!view.ok || !sha) throw new Error(`couldn't read the merge commit of ${url}: ${firstLine(view.err)}`);
  const branch = `${CFG.outward.branchPrefix}revert-${s.number}`;
  if (branch === s.base) throw new Error("the revert branch can't be the base branch");
  const path = join(s.mainRepo, ".claude", "worktrees", `revert-${s.number}`);
  const git = async (args: string[], cwd = s.mainRepo) => {
    const r = await run(["git", ...args], cwd);
    if (!r.ok) throw new Error(`git ${args[0]}: ${firstLine(r.err)}`);
    return r;
  };
  await git(["fetch", "origin", s.base]);
  // a retry after the push went through and the PR didn't: open the PR from the branch already there
  const pushed = (await run(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], s.mainRepo)).ok;
  if (!pushed) {
    if (!existsSync(path)) await git(["worktree", "add", "-B", branch, path, `origin/${s.base}`]);
    try {
      await git(["revert", "--no-edit", sha], path);
      await git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], path);
    } finally {
      await run(["git", "worktree", "remove", "--force", path], s.mainRepo);
    }
  }
  const body = withMark(`Reverts #${s.number} (${s.key}), which merged on Ship. Opened from Undo in Overhand for you to review.`);
  const pr = await run([
    "gh",
    "pr",
    "create",
    "-R",
    s.repo,
    "--head",
    branch,
    "--base",
    s.base,
    "--title",
    `Revert #${s.number} (${s.key})`,
    "--body",
    body,
  ]);
  const revert = pr.out.trim().split("\n").pop() ?? "";
  if (!pr.ok || !revert) throw new Error(`gh pr create: ${firstLine(pr.err)}`);
  editShips((xs) => {
    const x = xs.findLast((y) => y.url === url);
    if (x) x.revert = revert;
  });
  report(`↩ ${s.key}: revert PR opened for the Ship merge ${revert}`);
  return revert;
}
