/** Headless agent runs on accounts (each on its account's runtime, Claude Code by default): account order, cooldowns and usage probes. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Autonomy, RunKind } from "@overhand/contract";
import { z } from "zod";
import { AGENT_HOME, AGENT_HOMES, guardHooks, INSTRUCTIONS_FILE, inboxHome, runHome, runMcpServers, writeAgentHome } from "./agent-home";
import { budgetUntil, recordedBilling } from "./billing";
import type { Client } from "./config";
import { ingestOutboxes, recordSpawn } from "./control";
import { ACCOUNTS, CFG, claudeEnv, MIN, OPS, providerOf, runtimeOf, today } from "./env";
import { GUARD_LOG } from "./guard";
import { comboOfAccount, identityOf, nameParts, projectOf, projectRows } from "./history";
import { allowSubscriptionTokens } from "./legacy-token";
import { backAt, bench, benchedUntil, outOfUsage } from "./limits";
import { report } from "./notify";
import { readSecret } from "./platform";
import { routeOrder } from "./routing";
import { RUNTIMES } from "./runtimes";
import { writeRunFiles } from "./runtimes/claude-code";
import { repoRefusal } from "./runtimes/repo-config";
import { type AgentRuntime, dropNulls, extractJson, gitCommonDir, type RunInput, type RunOutput, readOnly } from "./runtimes/runtime";
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
 * account instead of moving work onto another subscription. Local code may supply another order.
 */
export function accountsFor(
  all: string[],
  preferred: string[],
  fallbackToAll: boolean,
  start: number,
  order: AccountOrder | null = localOrder,
): string[] {
  if (order) return order(all, preferred, fallbackToAll, start);
  const one = preferred[0] ?? all[0];
  return one ? [one] : [];
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
 * are cooling down. The account's runtime decides the CLI; one that can't enforce `schema` is asked for JSON in the prompt,
 * validated, and retried once.
 */
export async function claude<T>(
  state: State,
  prompt: string,
  cwd: string,
  schema: string,
  logName: string,
  opts: { model?: string; args?: string[]; client?: Client; autonomy?: Autonomy; inbox?: boolean } = {},
): Promise<{ out: T; account: string; cost: number; transcript: string } | null> {
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
  for (const account of pool) {
    if (
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
    let run = await runOnce(rt, input, cwd, logName, meta);
    let cost = run.out.cost;
    let transcript = run.stdout;
    const until = run.out.ok ? 0 : outOfUsage(runOutput(run), run.out.usage);
    if (until) {
      bench(account, until); // for every run, lead and test, not just this pass
      report(`⏸ account ${account} hit its limit, back at ${backAt(until)}`);
      continue;
    }
    state.nextAccount = (state.nextAccount + 1) % Math.max(ACCOUNTS.length, 1); // spread load across runs
    let answer = run.out.ok ? checked(rt, schema, run.out) : { value: undefined, problem: "" };
    // an answer that doesn't match the schema gets one more try, told what was wrong with it
    if (run.out.ok && answer.value === undefined) {
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
      };
    return { out: answer.value as T, account, cost, transcript };
  }
  return null;
}

/** A finished run's whole output, as its log has it: its answer, stdout's tail (where a CLI's last error lands) and stderr. */
const runOutput = (run: { out: RunOutput; stdout: string; stderr: string }): string =>
  [run.out.text, run.stdout.slice(-4000), run.stderr].join("\n");

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
): Promise<{ out: RunOutput; stderr: string; stdout: string }> {
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
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  recordSpawn(OPS, proc, env, boxed.sandboxed, cwd, boxed.guardOnly);
  const startedAt = Date.now();
  const { account } = input;
  const pm = argv.indexOf("--permission-mode");
  const mode = pm >= 0 ? (argv[pm + 1] ?? "") : rt.caps.autoMode ? "auto" : "";
  saveCurrentRuns([...currentRuns(), { name: logName, account, cwd, startedAt, pid: proc.pid, model: input.alias || input.model, mode }]);
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.kill();
    },
    (input.tune?.timeoutMin || CFG.limits.taskTimeoutMin) * MIN,
  );
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const code = await proc.exited;
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
    `${JSON.stringify({ name: logName, account, start: startedAt, end: Date.now(), cost: out.cost, ok: out.ok, ...meta, ...identityOf(account), billing: recordedBilling(account), ...(timedOut ? { timedOut } : {}), ...(boxed.guardOnly ? { guardOnly: true } : {}) })}\n`,
  );
  return { out, stderr, stdout };
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
    if (out.ok && checked(rt, schema, out).value !== undefined) return { ok: true, message: "" };
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
  const { usage } = parseStream(await new Response(proc.stdout).text());
  if (usage) recordUsage(OPS, account, usage);
  return usage;
}

/**
 * Probes accounts with no reading in the last `olderThanMin` minutes (30 on the schedule, FRESH_MIN when you come back
 * to the app), one after another. Only Claude accounts on Claude Code: Bedrock, Vertex, gateways and other CLIs have
 * no 5-hour or weekly windows to read.
 */
export async function refreshUsage(olderThanMin = 30): Promise<void> {
  const known = loadUsage(OPS);
  const windows = (a: string) => providerOf(a).kind === "claude" && runtimeOf(a).kind === "claude-code";
  for (const a of ACCOUNTS) if (windows(a) && Date.now() - (known[a]?.at ?? 0) > olderThanMin * MIN) await probeUsage(a).catch(() => null);
}
