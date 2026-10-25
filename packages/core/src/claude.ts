/** Headless agent runs on accounts (each on its account's runtime, Claude Code by default): account order, cooldowns and usage probes. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Autonomy, FailureReason, RunKind, WinStep } from "@overhand/contract";
import { z } from "zod";
import { AGENT_HOME, AGENT_HOMES, guardHooks, INSTRUCTIONS_FILE, inboxHome, runHome, runMcpServers, writeAgentHome } from "./agent-home";
import { budgetUntil, recordedBilling } from "./billing";
import type { Client } from "./config";
import { ingestOutboxes, recordSpawn } from "./control";
import { ACCOUNTS, CFG, claudeEnv, MIN, OPS, providerOf, runtimeOf, today, untilExit } from "./env";
import { killTree, leftBehind, processTable } from "./governor";
import { GUARD_LOG } from "./guard";
import { comboOfAccount, identityOf, nameParts, projectOf, projectRows } from "./history";
import { allowSubscriptionTokens } from "./legacy-token";
import { backAt, bench, benchedUntil, markSignedOut, outOfUsage, signedOut, signedOutAccounts } from "./limits";
import { report } from "./notify";
import { keepRunAwake, readSecret } from "./platform";
import { routeOrder } from "./routing";
import { RUNTIMES } from "./runtimes";
import { writeRunFiles } from "./runtimes/claude-code";
import { repoRefusal } from "./runtimes/repo-config";
import {
  type AgentRuntime,
  dropNulls,
  extractJson,
  gitCommonDir,
  type RunInput,
  type RunOutput,
  readOnly,
  stepReader,
} from "./runtimes/runtime";
import { projectSandbox, sandboxSpawn, waitsForSignIn } from "./sandbox";
import { answers } from "./setup";
import { currentRuns, type State, saveCurrentRuns } from "./state";
import { type AccountUsage, exhaustedUntil, loadUsage, parseStream, recordUsage } from "./usage";

/** Whether an account can run right now: its CLI is installed and, on a gateway, the gateway answers. */
async function reachable(account: string, bin: string): Promise<boolean> {
  if (Bun.which(bin) === null || keyless(account)) return false;
  const p = providerOf(account);
  return p.kind !== "gateway" || answers(p.baseUrl);
}

/**
 * A Gemini CLI account with no API key: its runs use Overhand's own Gemini home (runtimes/gemini.ts), where no browser
 * login of yours is, so it can't run at all.
 */
export const keyless = (
  account: string,
  kind: string = runtimeOf(account).kind,
  read: (item: string) => string | null = readSecret,
  env: Record<string, string | undefined> = process.env,
): boolean => kind === "gemini" && !env.GEMINI_API_KEY && read(`gemini-key-${account}`) === null;

/** The order a run tries accounts in, from every account, the preferred ones, `fallbackToAll` and a rotating start. */
export type AccountOrder = (all: string[], preferred: string[], fallbackToAll: boolean, start: number) => string[];

/** Set by local code (`loadLocalCode`); Overhand itself never moves a run onto another account. */
let localOrder: AccountOrder | null = null;

/**
 * The accounts a run may use, in order: one account (the preferred one, else the first), so a run waits for its own
 * account instead of moving work onto another subscription. Local code may supply another order, but never two accounts
 * of one pool (`poolOf`: CLI and backend, one person's subscriptions), the rule `routeOrder` keeps too: a provider's
 * limits are per person, and getting round them with a second account of the same kind is against every provider's terms.
 */
export function accountsFor(
  all: string[],
  preferred: string[],
  fallbackToAll: boolean,
  start: number,
  order: AccountOrder | null = localOrder,
  poolOf: (account: string) => string = (a) => comboOfAccount(a).pool,
): string[] {
  if (!order) {
    const one = preferred[0] ?? all[0];
    return one ? [one] : [];
  }
  const pools = new Set<string>();
  const out: string[] = [];
  for (const a of order(all, preferred, fallbackToAll, start)) {
    if (pools.has(poolOf(a))) continue;
    pools.add(poolOf(a));
    out.push(a);
  }
  return out;
}

/**
 * Loose `.ts` files left in `<config folder>/plugins`, where local code lived before: never loaded or moved (a file an
 * agent could drop there must never reach the daemon), only named so the person moves them to `local-code/` by hand.
 */
function oldLocalCode(ops = OPS): void {
  const from = join(ops, "plugins");
  if (!existsSync(from)) return;
  for (const f of readdirSync(from).filter((f) => f.endsWith(".ts") && lstatSync(join(from, f)).isFile()))
    report(`📦 ${join(from, f)} no longer runs: local code lives in ${join(ops, "local-code")} now; move it there yourself if it's yours`);
}

/**
 * Loads local code: `.ts` files in `<config folder>/local-code`, which is never part of the product and runs inside the
 * daemon with its rights. Nothing under `plugins/` is ever imported. The first file that exports `accountOrder` (an
 * `AccountOrder`) decides the order runs try accounts in; returns that file, else null. One that exports
 * `subscriptionTokens = true` turns on the legacy token opt-in (legacy-token.ts).
 */
export async function loadLocalCode(ops = OPS): Promise<string | null> {
  localOrder = null;
  allowSubscriptionTokens(false);
  oldLocalCode(ops);
  const dir = join(ops, "local-code");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  let from: string | null = null;
  for (const f of files) {
    const mod: Record<string, unknown> = await import(join(dir, f));
    if (mod.subscriptionTokens === true) allowSubscriptionTokens(true);
    if (from !== null || typeof mod.accountOrder !== "function") continue;
    localOrder = mod.accountOrder as AccountOrder; // the person's own code, trusted like their config
    from = f;
  }
  return from;
}

/**
 * Runs one headless session on the first account with capacity (the client's own accounts when it lists any); null when all
 * are cooling down or signed out. The account's runtime decides the CLI; one that can't enforce `schema` is asked for JSON
 * in the prompt, validated, and retried once. `onLimit` hears that a run started and its account hit its limit. A run
 * that failed says why in `failure` (its `out.message` keeps the CLI's own words). `onStep` hears each later step the run
 * reaches, read from its output as it arrives (stepReader).
 */
export async function claude<T>(
  state: State,
  prompt: string,
  cwd: string,
  schema: string,
  logName: string,
  opts: {
    model?: string;
    args?: string[];
    client?: Client;
    autonomy?: Autonomy;
    inbox?: boolean;
    onLimit?: () => void;
    onStep?: (step: WinStep) => void;
  } = {},
): Promise<{ out: T; account: string; cost: number; transcript: string; failure?: FailureReason } | null> {
  const busy = new Set(currentRuns().map((r) => r.account));
  const { kind, key } = nameParts(logName);
  const c = opts.client;
  const today = accountsFor(ACCOUNTS, c?.accounts ?? [], c?.fallbackToAll ?? true, state.nextAccount);
  // a new ticket may be routed by the scorecard (routing.mode auto); everything else keeps today's order
  const routed =
    c && kind === "ticket"
      ? routeOrder({
          mode: CFG.routing.mode,
          autonomy: c.autonomy,
          today,
          allowed: c.accounts.length ? c.accounts : ACCOUNTS,
          identity: comboOfAccount,
          rows: projectRows(c.name),
        })
      : today;
  // accounts another run is using go last, so parallel runs spread across accounts (sort is stable)
  const pool = routed === today ? today.sort((a, b) => Number(busy.has(a)) - Number(busy.has(b))) : routed;
  // a new ticket's run reads its accounts' usage first when the last reading is old, so a used-up week is skipped
  if (kind === "ticket") await refreshUsage(BEFORE_RUN_MIN, pool);
  const signedOutNow = signedOutAccounts();
  for (const account of pool) {
    if (
      account in signedOutNow ||
      benchedUntil(account) > Date.now() ||
      exhaustedUntil(loadUsage(OPS)[account], Date.now(), CFG.limits.paceWeekly) > Date.now() ||
      budgetUntil(account) > Date.now() || // a billed account past today's budget; plan accounts never are
      waitsForSignIn(account, c?.name ?? "")
    )
      continue;
    const rt = RUNTIMES[runtimeOf(account).kind];
    // routed runs move on when an account's CLI isn't installed or its gateway doesn't answer, instead of failing there
    if (routed !== today && pool.length > 1 && !(await reachable(account, rt.bin))) {
      report(`↷ ${logName}: ${account} isn't reachable, trying the next allowed account`);
      continue;
    }
    // an account that can't start at all is passed over, as a busy one is (a routed run checked it above): no key, or a
    // repo whose own config for its CLI could turn the guard off
    const refused = keyless(account) ? `${account} has no Gemini API key (gemini-key-${account})` : repoRefusal(rt.id, cwd);
    if (refused) {
      report(`↷ ${logName}: ${refused}; trying the next account`);
      continue;
    }
    // Claude Code flags (the inbox's Slack MCP) have no equivalent in other CLIs: those runs skip such accounts
    if (opts.args?.length && rt.id !== "claude-code") continue;
    // the project's autonomy level decides whether the CLI may write at all (runtimes map watch onto read-only flags)
    const meta = { kind, key, project: c?.name ?? projectOf(key, logName) };
    const input = {
      ...runInput(account, cwd, prompt, schema, opts.model ?? "", opts.args ?? [], opts.inbox),
      autonomy: opts.autonomy ?? opts.client?.autonomy,
      run: logName,
      project: meta.project,
    };
    let run = await runOnce(rt, input, cwd, logName, meta, opts.onStep && stepReader(opts.onStep));
    let cost = run.out.cost;
    let transcript = run.stdout;
    // an expired sign-in isn't the task's failure: the account waits for you to sign it in again (Needs you: Sign in)
    if (!run.out.ok && !run.stopped && signedOut(runOutput(run))) {
      markSignedOut(account, true);
      report(`🔑 account ${account} is signed out: sign it in again`);
      continue;
    }
    const until = run.out.ok || run.stopped ? 0 : outOfUsage(runOutput(run), run.out.usage);
    if (until) {
      bench(account, until); // for every run, lead and test, not just this pass
      report(`⏸ account ${account} hit its limit, back at ${backAt(until)}`);
      opts.onLimit?.();
      continue;
    }
    state.nextAccount = (state.nextAccount + 1) % Math.max(ACCOUNTS.length, 1); // spread load across runs
    let answer = run.out.ok ? checked(rt, schema, run.out) : { value: undefined, problem: "" };
    // an answer that doesn't match the schema gets one more try, told what was wrong with it
    if (run.out.ok && !run.stopped && answer.value === undefined) {
      const again = `Your reply wasn't a JSON object matching the schema (${answer.problem}). Reply with only that JSON object.`;
      run = await runOnce(rt, { ...input, prompt: [prompt, again].join("\n\n") }, cwd, `${logName}-retry`, meta);
      cost += run.out.cost;
      transcript = [transcript, run.stdout].join("\n");
      answer = run.out.ok ? checked(rt, schema, run.out) : answer;
    }
    if (!run.out.ok || answer.value === undefined)
      return {
        out: { status: "failed", message: (run.out.text || answer.problem || "no output").slice(-800) } as T,
        account,
        cost,
        transcript,
        failure: failureOf(run),
      };
    return { out: answer.value as T, account, cost, transcript };
  }
  return null;
}

/**
 * What a finished run's CLI itself said: its result or error (the runtime's parse) and stderr, never the transcript, where
 * a project's own output (a test printing "429") would read as the CLI's.
 */
const runOutput = (run: { out: RunOutput; stderr: string }): string => [run.out.text, run.stderr].join("\n");

/**
 * Why a run gave no answer: you stopped it, it ran past its time limit, its account is signed out, its CLI exited with an
 * error (crashed), or it exited cleanly with output Overhand can't read (the CLI changed how it reports).
 */
export function failureOf(run: { out: RunOutput; stderr: string; code: number; timedOut: boolean; stopped?: boolean }): FailureReason {
  if (run.stopped) return "stopped";
  if (run.timedOut) return "timeout";
  if (signedOut(runOutput(run))) return "signed-out";
  return run.code !== 0 ? "crashed" : "unreadable";
}

/**
 * Readies a run's config folder before it starts, every time, so an update's instructions and guard reach the next
 * agent (an account's own folder: the guard only). Only into folders Overhand owns: never your own Claude Code config.
 */
export function readyHome(runtime: string, configDir: string): void {
  writeAgentHome();
  if (runtime === "claude-code" && configDir.startsWith(`${AGENT_HOMES}/`) && configDir !== AGENT_HOME)
    writeAgentHome(configDir, undefined, false);
}

/** The main checkout a worktree belongs to (where Claude Code keyed its local-scope MCP servers); "" outside git. */
export function mainCheckout(cwd: string): string {
  const git = gitCommonDir(cwd);
  return git ? dirname(git) : "";
}

/** What a runtime needs for one of this account's runs, from the live config. */
function runInput(account: string, cwd: string, prompt: string, schema: string, alias: string, args: string[], inbox = false): RunInput {
  const configDir = inbox ? inboxHome(account) : runHome(account);
  // every run gets your MCP servers by flag, strictly (runtimes/claude-code.ts mcpConfig); a config folder of Overhand's
  // has the guard written in, your own config (an account waiting for its own sign-in) gets it by flag
  const ours = configDir.startsWith(`${AGENT_HOMES}/`);
  return {
    account,
    cwd,
    prompt,
    schema,
    schemaFile: join(AGENT_HOME, `schema-${process.pid}-${Date.now()}.json`),
    alias,
    provider: providerOf(account),
    model: runtimeOf(account).model,
    tune: runtimeOf(account),
    attribution: CFG.outward.aiAttribution,
    args,
    configDir,
    mcpServers: runMcpServers(mainCheckout(cwd)),
    ...(ours || runtimeOf(account).kind !== "claude-code" ? {} : { hooks: guardHooks() }),
    instructions: INSTRUCTIONS_FILE,
    read: readSecret,
  };
}

/**
 * The schema-shaped answer of a successful run: what the CLI enforced itself, else the JSON object in its reply, validated
 * against the schema (Zod from the JSON Schema) either way, since a local model behind a schema-enforcing CLI may not be
 * held to it. Nulls a strict schema put in optional fields are dropped first. `problem` says why there's none.
 */
export function checked(rt: AgentRuntime, schema: string, out: RunOutput): { value: unknown; problem: string } {
  const json = rt.caps.jsonSchema ? out.structured : extractJson(out.text);
  if (json === undefined) return { value: undefined, problem: rt.caps.jsonSchema ? "no structured output" : "no JSON object in the reply" };
  const r = z.fromJSONSchema(JSON.parse(schema)).safeParse(dropNulls(json, JSON.parse(schema)));
  return r.success ? { value: r.data, problem: "" } : { value: undefined, problem: z.prettifyError(r.error).slice(0, 400) };
}

/** Starts one headless run, waits for it (up to the task timeout), logs it and books its cost and usage. */
async function runOnce(
  rt: AgentRuntime,
  input: RunInput,
  cwd: string,
  logName: string,
  meta: { kind: RunKind; key: string; project: string },
  onText?: (chunk: string) => void,
): Promise<{ out: RunOutput; stderr: string; stdout: string; code: number; timedOut: boolean; stopped: boolean }> {
  readyHome(rt.id, input.configDir);
  // the OS sandbox (sandbox.ts): one sandbox, ours, so the CLI's own is off under it
  const sb = projectSandbox(meta.project);
  const task = rt.task({ ...input, osSandbox: sb.effective !== "off" });
  const removeFiles = writeRunFiles(task.files); // a run's MCP servers can carry their tokens
  const boxed = sandboxSpawn(
    { ...task, cwd, runtime: rt.id, configDir: input.configDir, run: input.run || logName, readOnly: readOnly(input) },
    sb,
    gitCommonDir,
  );
  const { argv, env } = boxed;
  // its own process group, so it ends with everything it started (endRun)
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", detached: true });
  recordSpawn(OPS, proc, env, boxed.sandboxed, cwd, boxed.guardOnly);
  keepRunAwake(proc.pid); // every run, as long as it lives: done, timed out or stopped (endRun)
  const startedAt = Date.now();
  const { account } = input;
  const pm = argv.indexOf("--permission-mode");
  const mode = pm >= 0 ? (argv[pm + 1] ?? "") : rt.caps.autoMode ? "auto" : "";
  saveCurrentRuns([...currentRuns(), { name: logName, account, cwd, startedAt, pid: proc.pid, model: input.alias || input.model, mode }]);
  let timedOut = false;
  // the time limit counts the time the run was awake: a laptop asleep past it doesn't stop the run the moment it wakes
  const limit = (input.tune?.timeoutMin || CFG.limits.taskTimeoutMin) * MIN;
  const tick = Math.min(15_000, limit / 4);
  let awake = 0;
  let last = startedAt;
  const timer = setInterval(() => {
    const now = Date.now();
    awake += awakeFor(now - last, tick);
    last = now;
    if (awake < limit || timedOut) return;
    timedOut = true;
    void endRun(proc.pid, cwd);
  }, tick);
  const {
    texts: [stdout = "", stderr = ""],
    code,
  } = await untilExit(proc.exited, [proc.stdout, proc.stderr], undefined, onText);
  clearInterval(timer);
  const stopped = stopping.delete(logName);
  await endRun(proc.pid, cwd); // nothing it started outlives it
  boxed.done(startedAt);
  if (boxed.sandboxed) ingestOutboxes(OPS, GUARD_LOG);
  saveCurrentRuns(currentRuns().filter((r) => r.pid !== proc.pid));
  removeFiles();
  const logDir = join(OPS, "logs", today());
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${logName}-${Date.now()}.json`), [stdout, stderr].join("\n--- stderr ---\n"));
  const out = rt.parse(stdout, stderr, code);
  if (out.usage) recordUsage(OPS, account, out.usage);
  mkdirSync(join(OPS, "runs"), { recursive: true });
  appendFileSync(
    join(OPS, "runs", `${today()}.jsonl`),
    `${JSON.stringify({ name: logName, account, start: startedAt, end: Date.now(), cost: out.cost, ok: out.ok, ...meta, ...identityOf(account), billing: recordedBilling(account), ...(timedOut ? { timedOut } : {}), ...(stopped ? { stopped } : {}), ...(boxed.guardOnly ? { guardOnly: true } : {}) })}\n`,
  );
  return { out, stderr, stdout, code, timedOut, stopped };
}

/**
 * How much of the `elapsed` ms since a run's clock last ticked counts toward its time limit: all of it, except a gap far
 * longer than a tick, which is the computer asleep (and the run with it), counted as one tick.
 */
export const awakeFor = (elapsed: number, tick: number): number => (elapsed > tick * 3 ? tick : elapsed);

/**
 * Ends a run and what it started: its process group and children, then anything it detached from them and left working
 * in its worktree (governor.ts leftBehind). Once its CLI exits, is stopped, or runs past its time limit.
 */
async function endRun(pid: number, cwd: string): Promise<void> {
  await killTree(pid, 1000);
  for (const p of leftBehind(cwd, processTable())) await killTree(p, 1000);
}

/** Runs stopped from the dashboard, by name: their end reads as stopped, not as a crash. */
const stopping = new Set<string>();

/** Stop on a running agent: ends its run and everything it started; false when no run has that name. */
export async function stopRun(name: string): Promise<boolean> {
  const r = currentRuns().find((x) => x.name === name);
  if (!r) return false;
  stopping.add(name);
  await killTree(r.pid);
  return true;
}

/**
 * A quick test call on one account: a tiny read-only run of its own CLI, model and sign-in, in an empty folder (it costs a
 * few tokens). ok when the CLI answered with the JSON asked for; `message` says what it said otherwise.
 */
export async function testAccount(account: string): Promise<{ ok: boolean; message: string }> {
  if (!ACCOUNTS.includes(account)) return { ok: false, message: `no account ${account}` };
  const rt = RUNTIMES[runtimeOf(account).kind];
  const cwd = mkdtempSync(join(tmpdir(), "overhand-test-"));
  const schema = JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
  const prompt = 'This is a connection test. Reply with {"ok": true} and nothing else; use no tools.';
  try {
    const alias = rt.id === "claude-code" ? "haiku" : "";
    const input = { ...runInput(account, cwd, prompt, schema, alias, []), autonomy: "watch" as const, run: `test-${account}` };
    const run = await runOnce(rt, input, cwd, `test-${account}`, { kind: "other", key: "", project: "" });
    const { out, stderr } = run;
    if (out.ok && checked(rt, schema, out).value !== undefined) {
      markSignedOut(account, false); // a test that answers is signed in: its runs go on
      return { ok: true, message: "" };
    }
    if (!out.ok && signedOut(runOutput(run))) markSignedOut(account, true);
    const until = outOfUsage(runOutput(run), out.usage);
    if (until) bench(account, until); // a test that finds it out of usage benches it like a run would
    return { ok: false, message: (out.text || stderr).trim().slice(-300) || "no answer" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The usage probe's command: one Haiku turn with no tools and no MCP servers at all (it runs outside the sandbox, in a
 * config folder runs also use, so nothing a run left there may start).
 */
export const PROBE_ARGV = [
  ...["claude", "-p", "Reply OK.", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1"],
  ...["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""],
];

/** Reads one account's usage with a tiny Haiku call (Claude Code only reports usage on a real request). */
async function probeUsage(account: string): Promise<AccountUsage | null> {
  const home = runHome(account);
  const env = claudeEnv(account);
  // your own default config is Claude Code's with the variable unset (it keys its login to whether it's set)
  if (home) env.CLAUDE_CONFIG_DIR = home;
  else delete env.CLAUDE_CONFIG_DIR;
  const proc = Bun.spawn(PROBE_ARGV, {
    cwd: OPS,
    env,
    timeout: 90_000, // a hung probe would otherwise hold /api/usage/refresh open forever
    stdout: "pipe",
    stderr: "ignore",
  });
  const { usage } = parseStream((await untilExit(proc.exited, [proc.stdout])).texts[0] ?? "");
  if (usage) recordUsage(OPS, account, usage);
  return usage;
}

/** How old a reading may be when a new ticket's run starts before its accounts are read again. */
export const BEFORE_RUN_MIN = 30;

/**
 * Probes `accounts` with no reading in the last `olderThanMin` minutes (BEFORE_RUN_MIN right before a new ticket's
 * run, FRESH_MIN when you come back to the app), one after another; never on a timer, as each probe is a model call.
 * Only Claude accounts on Claude Code: Bedrock, Vertex, gateways and other CLIs have no 5-hour or weekly windows to
 * read. `probe` is for tests.
 */
export async function refreshUsage(
  olderThanMin: number,
  accounts: readonly string[] = ACCOUNTS,
  probe: (account: string) => Promise<unknown> = probeUsage,
): Promise<void> {
  const known = loadUsage(OPS);
  const windows = (a: string) => providerOf(a).kind === "claude" && runtimeOf(a).kind === "claude-code";
  for (const a of accounts) if (windows(a) && Date.now() - (known[a]?.at ?? 0) > olderThanMin * MIN) await probe(a).catch(() => null);
}
