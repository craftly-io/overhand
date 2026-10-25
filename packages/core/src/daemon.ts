/** The daemon's main loop and the CLI (see USAGE). */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewerVersion } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { KEY_ITEM } from "./accounts";
import { work } from "./agent";
import { finishMove, pendingMoves, signInHome, writeAgentHome } from "./agent-home";
import { morningBrief } from "./brief";
import { loadLocalCode } from "./claude";
import { autoDue, cleanupJob, dropVoiceModel } from "./cleanup";
import { saveConfig } from "./config";
import { extended, ingestOutboxes, insideRun, pruneRuns, ruleHold } from "./control";
import { ackCli, askCli, autoAct, connectCli, sampleStrain } from "./control-api";
import { dashboardState } from "./dashboard";
import { keyFile, localHeaders, openLink, resetLocalKey } from "./devices";
import {
  ACCOUNTS,
  applyConfig,
  BUNDLED,
  CFG,
  CLIENTS,
  CODE,
  DASHBOARD,
  HOME,
  INSTALL,
  MIN,
  needsSetup,
  OPS,
  runtimeOf,
  SELF_EXEC,
  SLACK_MCP,
  SRC,
  secret,
  sh,
  today,
  UI_PORT,
} from "./env";
import {
  HEAVY,
  holders,
  isHeavy,
  killTree,
  logEvent,
  orphanBrowsers,
  parseHours,
  processTable,
  readMachine,
  runHeavy,
  setQuiet,
} from "./governor";
import { windowsFor } from "./groups";
import { GUARD_LOG, guardHook, guardLogAt, guardWriteRoot, projectAt, trustIdentity } from "./guard";
import { inbox, inboxReadAt } from "./inbox";
import { blankLead, leadPid, loadLeads, lockHolder, superviseLeads, watchQuestions } from "./leads";
import { serveMcp } from "./mcp-server";
import { syncMenubar } from "./menubar";
import { diskFree, notify, problems, report, stampConsole } from "./notify";
import { refreshSuggestions } from "./organise";
import { plan } from "./plan";
import { daemonLog, installService, isLoginService, openBrowser, readSecret, SERVICE, uninstallService } from "./platform";
import { tickPlugins } from "./plugins";
import { claudeSignedIn } from "./runtimes/claude-code";
import { codexSignedIn } from "./runtimes/codex";
import { liveDeps, runSelfCheck, SELF_CHECK_EVERY } from "./selfcheck";
import { latestRelease, restartIfRequested, updateRoute, VERSION } from "./selfupdate";
import { cleanupActive, PORT_BUSY, portInUse, pushState, serveDashboard, spawnCleanup } from "./server";
import { checks } from "./setup";
import { currentRuns, loadState, readJson, saveState } from "./state";
import { uninstallCli } from "./uninstall";
import { tickUpdates } from "./updates";
import { tickReports } from "./workreport";

const REQUESTS = [".request-plan", ".request-inbox", ".request-work"];

function takeRequest(name: string): boolean {
  const p = join(OPS, name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/**
 * Sleeps up to `ms`, waking early when the dashboard asks for something. It always sleeps a moment first: with a
 * request already pending, returning at once would spin the loop and starve the server.
 */
async function nap(ms: number): Promise<void> {
  const end = Date.now() + ms;
  do await Bun.sleep(Math.min(5000, ms));
  while (Date.now() < end && !REQUESTS.some((r) => existsSync(join(OPS, r))));
}

/** Starts the unattended cleanup when `cleanup.auto` says it's due and no agent or lead is running. */
function autoCleanup(): void {
  if (needsSetup() || CFG.cleanup.auto.schedule === "off" || cleanupActive()) return;
  const stamp = join(OPS, ".cleanup-auto");
  const lastAt = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) || 0 : 0;
  const leads = loadLeads();
  const idle = !currentRuns().length && !CFG.godmode.some((g) => lockHolder(g) || leadPid(g, leads[g.key] ?? blankLead()));
  const why = autoDue(CFG.cleanup.auto, { freeGb: diskFree(), lastAt, now: Date.now(), idle });
  if (!why) return;
  writeFileSync(stamp, String(Date.now()));
  report(`🧹 automatic cleanup: ${why}`);
  spawnCleanup("auto");
}

/**
 * Moves each account still on your own config (agent-home.ts pendingMove) to its own folder once that folder has a
 * valid sign-in there (Claude Code says so; Codex: `codex login status` there, or a key), saved; never before, so
 * nothing breaks. `signedIn` is for tests. Returns the accounts it moved.
 */
export async function finishMoves(
  signedIn: (account: string) => Promise<boolean> = async (a) =>
    runtimeOf(a).kind === "codex"
      ? readSecret(`${KEY_ITEM.codex}-${a}`) !== null || (await codexSignedIn(signInHome(a)))
      : claudeSignedIn(signInHome(a)),
): Promise<string[]> {
  const moved: string[] = [];
  for (const a of pendingMoves(CFG)) if (await signedIn(a).catch(() => false)) moved.push(a);
  if (!moved.length) return [];
  applyConfig(
    saveConfig(
      OPS,
      moved.reduce((c, a) => finishMove(c, a), CFG),
    ),
  );
  report(`🔐 ${moved.join(", ")} now run in a config folder of Overhand's, not your own`);
  return moved;
}

/** Says which accounts still wait for their one-time sign-in in a folder of their own (Settings shows each one's row). */
function noticeMoves(): void {
  const waiting = pendingMoves(CFG);
  if (!waiting.length) return;
  const title = plainWords.movedOffOwnTitle.replace("{accounts}", waiting.join(", "));
  report(`🔐 ${title}`);
  notify(title, plainWords.movedOffOwnBody);
}

/** Runs forever: serves the dashboard, plans daily, reads Slack on config.schedule, works the queue. */
export async function daemon(): Promise<void> {
  const local = await loadLocalCode();
  if (local) report(`🔌 account order from local code ${local}`);
  writeAgentHome();
  noticeMoves();
  void finishMoves();
  pruneRuns(OPS); // runs whose process is gone, or whose pid another process now has
  if (dropVoiceModel(OPS)) report("🧹 removed the old in-page voice model (no longer used)");
  serveDashboard();
  // the menu bar item: only under the installed login service, so a test's or a script's daemon never puts one up
  if (isLoginService()) {
    syncMenubar();
    setInterval(() => syncMenubar(), 10_000);
  }
  // an answer written to a questions file by any route (dashboard, phone, terminal, an editor) resumes its lead in
  // seconds; the minute tick stays as the fallback and re-arms the watch when leads change
  const onQuestions = () => {
    superviseLeads();
    void pushState().catch(() => {});
  };
  const leadTick = () => {
    superviseLeads();
    watchQuestions(onQuestions);
  };
  leadTick();
  setInterval(leadTick, MIN);
  setInterval(() => needsSetup() || morningBrief(), MIN);
  setInterval(() => needsSetup() || void tickUpdates(), MIN);
  setInterval(() => needsSetup() || void tickReports(), MIN);
  setInterval(autoCleanup, 10 * MIN);
  setInterval(governorTick, MIN);
  // plugins whose turn has come, each in its own sandbox, one at a time (plugins.ts)
  let plugging = false;
  setInterval(() => {
    if (plugging || needsSetup()) return;
    plugging = true;
    void tickPlugins(CFG, secret)
      .then(() => pushState())
      .catch(() => {})
      .finally(() => {
        plugging = false;
      });
  }, MIN);
  // the dashboard looks at itself every 15 min, the first time once it has warmed up; a failure shows in Needs you
  const selfCheck = () => void runSelfCheck(liveDeps(dashboardState)).then(() => pushState().catch(() => {}));
  setTimeout(selfCheck, 2 * MIN);
  setInterval(selfCheck, SELF_CHECK_EVERY);
  // organising suggestions: cheap git reads, every half hour (ponytail: in-process; move out like cleanup if it lags)
  setInterval(() => needsSetup() || refreshSuggestions(CFG, CODE, OPS, SRC), 30 * MIN);
  setInterval(() => writeFileSync(join(OPS, ".heartbeat"), String(Date.now())), 10_000);
  writeFileSync(join(OPS, ".heartbeat"), String(Date.now()));
  let lastPlanTry = 0;
  let lastInbox = inboxReadAt();
  for (;;) {
    try {
      // first run: the dashboard is up for the setup wizard, but there's nothing to plan or work on yet
      if (needsSetup() || !CLIENTS.length || !ACCOUNTS.length) {
        // nothing can act on a request yet; drop it so it can't keep waking the loop
        for (const r of REQUESTS) takeRequest(r);
        await nap(30_000);
        continue;
      }
      const paused = existsSync(join(OPS, "PAUSE"));
      const hour = new Date().getHours();
      const planned = existsSync(join(OPS, "plans", `${today()}.md`));
      const planAsked = takeRequest(".request-plan");
      if (planAsked || (!planned && hour >= CFG.schedule.planFromHour && !paused && Date.now() - lastPlanTry > 60 * MIN)) {
        lastPlanTry = Date.now();
        await plan();
      }
      const inboxAsked = takeRequest(".request-inbox");
      const inboxDue =
        planned &&
        hour >= CFG.schedule.inboxFromHour &&
        hour < CFG.schedule.inboxToHour &&
        Date.now() - lastInbox > CFG.schedule.inboxEveryMin * MIN &&
        !paused;
      if ((inboxAsked || inboxDue) && existsSync(SLACK_MCP)) {
        lastInbox = Date.now();
        const state = loadState();
        await inbox(state);
        saveState(state);
      }
      takeRequest(".request-work");
      const didWork = await work();
      restartIfRequested();
      await nap((didWork ? CFG.schedule.busyPollMin : CFG.schedule.idlePollMin) * MIN);
    } catch (e) {
      report(`⚠ loop error: ${String(e)}`);
      await nap(300_000);
    }
  }
}

const USAGE = `Overhand ${VERSION}: mission control for your AI coding agents.

  overhand start     run Overhand in the background (at every login) and open it in your browser
  overhand stop      stop it and don't start it at login
  overhand open      open it in your browser, signed in (a browser on this computer needs this once);
                     --reset makes a new local key first, which signs every browser out
  overhand status    whether it's running: port, version, last heartbeat, agents at work, free disk
  overhand logs      the daemon's log (-f keeps following it)
  overhand update    update to the latest release
  overhand uninstall  stop it and remove the program; --remove-data also deletes ~/.overhand (asks first),
                      --dry-run only lists what it would remove and keep
  overhand doctor    check what Overhand needs on this machine
  overhand version   print the version
  overhand answer <lead> "<text>"   answer a lead's open question (--default: go with the default it gave)

  overhand daemon    run in the foreground (what the login service runs)
  overhand plan | work | inbox | ui   one step by hand
  overhand cleanup plan | run | auto  one disk cleanup pass (Overhand's own cleanup runs these)
  overhand quiet 3h | 90m | off       "I need my laptop": agents start no browsers, suites, builds, simulators or dev servers

  overhand connect [<folder>]         your own Claude Code sessions in that project join the control room and follow the
                                      house rules (writes .claude/settings.local.json; --global: every project, asks first)
  overhand disconnect [<folder>]      undo it
  overhand ask <session> "<request>" [--by HH:MM]   a typed request, handed to that session at its next tool call
  overhand ack <id> [done | refuse "why"]           answer a request handed to this session
  overhand mcp                        Overhand's MCP server over stdio, for an agent: status, answer, ask and ack as tools`;

/** `overhand quiet 3h | 90m | off`: holds every heavy job off until then; edits and targeted tests carry on. */
function quiet(arg: string): void {
  const hours = parseHours(arg);
  if (hours === null || hours > 72) {
    console.error(`usage: overhand quiet 3h | 90m | off (up to 72h)\n\n${USAGE}`);
    process.exit(2);
  }
  const until = setQuiet(OPS, hours);
  console.log(
    until
      ? `Quiet until ${new Date(until).toTimeString().slice(0, 5)}: Overhand's agents start no screenshot sweeps, full test suites, builds, simulators or dev servers. Edits and targeted tests carry on. End it early: overhand quiet off`
      : "Quiet mode is off; held heavy jobs can start again.",
  );
}

/** `overhand heavy <kind> -- <command>`: what the guard runs a heavy agent command in (a slot, a watchdog). */
async function heavy(args: string[]): Promise<void> {
  const [kind = "", ...more] = args;
  const session = more[0] === "--session" ? (more[1] ?? "") : "";
  const [sep, ...rest] = session ? more.slice(2) : more;
  if (!isHeavy(kind) || sep !== "--" || !rest.length) {
    console.error(`usage: overhand heavy ${HEAVY.join("|")} [--session <id>] -- <command>`);
    process.exit(2);
  }
  const project = process.env.OVERHAND_PROJECT || projectAt(process.cwd());
  // inside a sandboxed run its log lines go to the run's outbox, like its guard's (trustIdentity sets where)
  trustIdentity();
  process.exitCode = await runHeavy(kind, rest.join(" "), {
    ops: OPS,
    gov: CFG.governor,
    machine: () => readMachine(diskFree()),
    run: process.env.OVERHAND_RUN ?? "",
    project,
    log: guardLogAt(guardWriteRoot()),
    session,
    hold: () => ruleHold(kind, { ...CFG.control, windows: windowsFor(CFG, project) }, { ops: OPS, project, session }),
    extended: (pgid) => extended(OPS, pgid),
  });
}

/** When the minute tick last looked for accounts whose sign-in in their own folder is done (finishMoves). */
let lastMoveCheck = 0;

/**
 * The governor's minute tick: expires slots whose holder died (killing what its job left running), kills headless
 * browsers orphaned by an agent run (only ones with OVERHAND_RUN in their environment, never yours), and acts on the
 * action cards a standing approval covers.
 */
function governorTick(): void {
  holders(OPS);
  // an account whose one-time sign-in in its own folder is done moves there within five minutes
  if (pendingMoves(CFG).length && Date.now() - lastMoveCheck > 5 * MIN) {
    lastMoveCheck = Date.now();
    void finishMoves().catch(() => {});
  }
  // what sandboxed runs' guards wrote this minute: heartbeats, blocks, handed-over requests
  try {
    ingestOutboxes(OPS, GUARD_LOG);
  } catch (e) {
    report(`⚠ couldn't take in the runs' outboxes: ${String(e)}`);
  }
  for (const p of orphanBrowsers(processTable())) {
    void killTree(p.pid);
    logEvent(GUARD_LOG, "", "", p.cmd, "reaped: a headless browser left running after its agent's command ended");
    report(`🧹 stopped an orphaned headless browser from an agent run (pid ${p.pid})`);
  }
  // how hard the machine works, then what standing approvals let Overhand do about it
  void sampleStrain()
    .then(() => (CFG.control.approvals.length ? autoAct() : undefined))
    .catch((e: unknown) => report(`⚠ control room: ${String(e)}`));
}

const LOG = daemonLog(join(OPS, "logs"));

/** True when a Overhand (or ops) dashboard already answers on this machine's port. */
async function running(): Promise<boolean> {
  try {
    // the page itself, which answers at once; /api/setup checks every agent CLI and can take seconds
    return (await fetch(`${DASHBOARD}/`, { headers: localHeaders(DASHBOARD), signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** `overhand start`: installs the login service unless something already serves the dashboard, then opens it. */
async function start(): Promise<void> {
  if (!(await running())) {
    // the binary runs itself, by the path that follows its updates (Homebrew's opt link, the launcher's npm/current); a
    // checkout runs run.ts with the bun that runs this
    const cmd = BUNDLED ? [SELF_EXEC, "daemon"] : [process.execPath, join(SRC, "run.ts"), "daemon"];
    const r = installService(cmd, HOME, join(OPS, "logs"));
    if (!r.ok) {
      console.error(`Couldn't start the ${SERVICE} service: ${r.err}\nRun it in the foreground instead: overhand daemon`);
      process.exit(1);
    }
    if (r.note) console.log(`Note: ${r.note}`); // the installer shows Note: lines
    // a first start (fresh build, many projects to scan) can take well over 10s; give up only after a minute
    for (let i = 0; i < 240 && !(await running()); i++) await Bun.sleep(250);
    if (!(await running())) {
      console.error(`Overhand didn't come up on port ${UI_PORT}. Its log says why: ${LOG}  (overhand logs)`);
      process.exit(1);
    }
  }
  // the link would sign in whoever reads it, so a run that starts Overhand gets none
  if (insideRun(OPS)) console.error(RUN_REFUSED);
  else openDashboard();
}

/** Why `overhand open` and `start` give no open link inside an agent's run. */
const RUN_REFUSED =
  "Overhand doesn't open its dashboard from inside an agent's run: the link would sign that agent in. Run it in your own terminal.";

/** Signs this computer's browser in once the dashboard answers, by an open link; nothing when no browser opens. */
async function signInBrowserOnce(): Promise<void> {
  for (let i = 0; i < 120 && !(await running()); i++) await Bun.sleep(250);
  // no browser (a server over SSH): nothing opens, and the link isn't logged; `overhand open` prints one
  if (await running()) openBrowser(openLink(DASHBOARD));
}

/**
 * Opens the dashboard by a one-time open link, which signs this browser in with the local key (`overhand open`, and the
 * end of `overhand start`); prints the link when no browser opens, as on a server over SSH.
 */
function openDashboard(): void {
  const link = openLink(DASHBOARD);
  const opened = openBrowser(link);
  console.log(
    `Overhand is running. ${opened ? `Opened ${DASHBOARD}` : `Open this link within two minutes: ${link}`}${needsSetup() ? " to set it up." : "."}`,
  );
}

/**
 * `overhand open [--reset]`: the dashboard, signed in. `--reset` first makes a new local key, so every browser signed in
 * here is signed out and every open link given out stops working. Refused inside a run Overhand started. The exit code.
 */
export async function openCli(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (insideRun(OPS, env)) {
    console.error(RUN_REFUSED);
    return 1;
  }
  if (args.includes("--reset")) {
    resetLocalKey();
    console.log("Made a new local key: every browser on this computer is signed out, and open links given out stop working.");
  }
  if (!(await running())) {
    console.error(`Overhand isn't running (nothing answers on port ${UI_PORT}). Start it: overhand start`);
    return 1;
  }
  openDashboard();
  return 0;
}

/** How long ago an epoch-ms time was, in words. */
const ago = (at: number): string => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** `overhand status`: whether the daemon answers, and what it's doing; exits 1 when it isn't running. */
async function showStatus(): Promise<void> {
  const up = await running();
  const beat = Number(existsSync(join(OPS, ".heartbeat")) ? readFileSync(join(OPS, ".heartbeat"), "utf8") : 0) || 0;
  const free = diskFree();
  const runs = currentRuns();
  console.log(
    [
      up ? `Overhand is running on ${DASHBOARD}` : `Overhand isn't running (nothing answers on port ${UI_PORT}). Start it: overhand start`,
      `  version         ${VERSION}${BUNDLED && isNewerVersion(latestRelease(), VERSION) ? ` (${latestRelease()} is out: ${updateRoute(INSTALL).say})` : ""}`,
      `  last heartbeat  ${beat ? ago(beat) : "never"}`,
      `  agents running  ${runs.length}${runs.length ? ` (${runs.map((r) => r.name).join(", ")})` : ""}`,
      `  free disk       ${Number.isFinite(free) ? `${free.toFixed(1)} GB` : "unknown"}`,
      `  state           ${OPS}`,
      `  log             ${LOG}`,
    ].join("\n"),
  );
  process.exitCode = up ? 0 : 1;
}

/**
 * `overhand answer <lead> "<text>"` or `overhand answer <lead> --default`: answers a lead's open question through the
 * running daemon, exactly as the dashboard does, so a terminal session (yours or an agent's) can unblock a lead.
 * `<lead>` is its key or label. Returns the line to print and whether it worked; `base` is for tests.
 */
export async function answerFromTerminal(args: string[], base = DASHBOARD): Promise<{ ok: boolean; message: string }> {
  const [lead = "", ...rest] = args;
  const byDefault = rest.includes("--default");
  const text = rest
    .filter((a) => a !== "--default")
    .join(" ")
    .trim();
  if (!lead || (!byDefault && !text) || (byDefault && text))
    return { ok: false, message: 'usage: overhand answer <lead> "<your answer>"  |  overhand answer <lead> --default' };
  const res = await fetch(`${base}/api/lead/answer`, {
    method: "POST",
    headers: { ...localHeaders(DASHBOARD), "content-type": "application/json" },
    body: JSON.stringify({ key: lead, text, kind: byDefault ? "default" : "answer" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return { ok: false, message: `Overhand isn't running (nothing answers on port ${UI_PORT}). Start it: overhand start` };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) return { ok: false, message: `Not answered: ${String(body.error ?? res.status)}` };
  return { ok: true, message: `Answered ${lead}${byDefault ? " with its default" : ""}; it picks up from here.` };
}

/** `overhand logs [-f]`: the daemon log's tail, or follows it. */
function logs(follow: boolean): void {
  if (!existsSync(LOG)) {
    console.error(`No daemon log yet at ${LOG}. The login service writes it (overhand start); overhand daemon prints to the terminal.`);
    process.exit(1);
  }
  const r = Bun.spawnSync(["tail", "-n", "200", ...(follow ? ["-f"] : []), LOG], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = r.exitCode ?? 1;
}

/**
 * `overhand update`: updates the way this copy was installed (the installer, `brew upgrade`, the npx launcher; see
 * updateRoute), never as a second copy beside it, then restarts the daemon once no agent runs. The service runs the
 * binary by a path that follows updates, so it comes back on the new version.
 */
async function update(): Promise<void> {
  if (INSTALL === "checkout") {
    console.log(`This is a checkout (${SRC}): update it with git pull, then bun install.`);
    return;
  }
  const { run, say } = updateRoute(INSTALL);
  let code: number | null = 1;
  try {
    code = Bun.spawnSync(run, { env: { ...process.env, OVERHAND_NO_START: "1" }, stdout: "inherit", stderr: "inherit" }).exitCode;
  } catch {} // brew or npx isn't on PATH
  if (code !== 0) {
    console.error(`The update didn't install; Overhand is unchanged. To update by hand: ${say}`);
    process.exit(1);
  }
  // the path the service runs now leads to the new binary, so its version is what runs after the restart
  const now = sh([SELF_EXEC, "version"]).out || "?";
  if (now === VERSION) {
    console.log(`Overhand ${VERSION} is the latest version.`);
    return;
  }
  console.log(`Updated Overhand ${VERSION} to ${now}.`);
  if (!(await running())) return;
  // the running daemon still runs the old binary: it restarts itself between work passes, and its service brings it back
  const res = await fetch(`${DASHBOARD}/api/restart`, { method: "POST", headers: localHeaders(DASHBOARD) }).catch(() => null);
  console.log(
    res?.ok
      ? "Overhand restarts on the new version as soon as no agent is running."
      : "Restart Overhand to use the new version: overhand stop && overhand start",
  );
}

/** `overhand doctor`: every check with its fix; exits non-zero while something required is missing. */
async function doctor(): Promise<void> {
  // before setup there's no config yet, but the tools it needs (an agent CLI, git, a signed-in gh) can be checked already
  await loadLocalCode(); // local code can change which Claude credentials the checks look for
  const list = await checks(CFG, CODE);
  for (const x of list)
    console.log(`${x.ok ? "✓" : x.optional ? "–" : "✗"} ${x.what}${x.ok ? "" : x.optional ? " (optional)" : `\n    ${x.fix}`}`);
  const missing = list.filter((x) => !x.ok && !x.optional).length;
  if (needsSetup()) console.log(`\nNot set up yet: run overhand start and finish the setup in the browser (${DASHBOARD}).`);
  if (missing) console.log(`\n${missing} thing(s) to fix.`);
  else if (!needsSetup()) console.log("\nAll set.");
  process.exitCode = missing ? 1 : 0;
}

/** `overhand cleanup plan|run|auto`: one cleanup pass; exits 1 when it failed, 2 on a bad mode. */
async function cleanup(mode: string): Promise<void> {
  if (!["plan", "run", "auto"].includes(mode)) {
    console.error(`usage: overhand cleanup plan | run | auto\n\n${USAGE}`);
    process.exit(2);
  }
  const r = await cleanupJob(mode, CFG, CODE, OPS, SRC);
  const st = readJson<{ status?: string; error?: string }>(join(OPS, ".cleanup.json"), {});
  if (st.status === "error") {
    console.error(`Cleanup failed: ${st.error ?? "unknown error"}`);
    process.exit(1);
  }
  if (mode === "auto" && r) {
    const line = `freed about ${(r.freedKb / 1024 ** 2).toFixed(1)} GB (${r.removed} items${r.skipped.length ? `, ${r.skipped.length} left alone` : ""})`;
    report(`🧹 automatic cleanup ${line}`);
    notify("Cleaned up", `Automatic cleanup ${line}.`);
  }
}

/**
 * A one-shot step that fails loudly: exit code 1 when it threw or reported a warning or failure (⚠, ✗) on the way, so
 * scripts and cron notice. The steps catch most errors themselves and report them, hence the count.
 */
async function step(name: string, f: () => Promise<unknown>): Promise<void> {
  const before = problems;
  try {
    await loadLocalCode();
    await f();
  } catch (e) {
    console.error(`overhand ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (problems > before) {
    console.error(`overhand ${name} hit ${problems - before} problem(s); see the lines above and today's report.`);
    process.exitCode = 1;
  }
}

/** The CLI: `overhand <command>` (or `bun run.ts <command>` from a checkout); an unknown command prints usage and exits 2. */
export async function main(mode: string | undefined): Promise<void> {
  if (mode === "guard")
    await guardHook(process.argv[3]); // the agent hook (`guard hand`: yours; `guard codex` and the like: another CLI's): first, it runs on every tool call
  else if (mode === "connect" || mode === "disconnect") process.exitCode = await connectCli(mode === "connect", process.argv.slice(3));
  else if (mode === "ask") process.exitCode = await askCli(process.argv.slice(3));
  else if (mode === "ack") process.exitCode = await ackCli(process.argv.slice(3));
  else if (mode === "mcp") await serveMcp();
  else if (mode === "start") await start();
  else if (mode === "open") process.exitCode = await openCli(process.argv.slice(3));
  else if (mode === "stop") {
    const r = uninstallService(HOME, join(OPS, "logs"));
    console.log(r.ok ? "Overhand stopped; it won't start at login. Start it again with: overhand start" : `Couldn't stop it: ${r.err}`);
    if (!r.ok) process.exitCode = 1;
  } else if (mode === "status") await showStatus();
  else if (mode === "answer") {
    const r = await answerFromTerminal(process.argv.slice(3));
    (r.ok ? console.log : console.error)(r.message);
    if (!r.ok) process.exitCode = 1;
  } else if (mode === "logs") logs(process.argv.slice(3).some((a) => a === "-f" || a === "--follow"));
  else if (mode === "update") await update();
  else if (mode === "uninstall") process.exitCode = await uninstallCli(process.argv.slice(3));
  else if (mode === "doctor") await doctor();
  else if (mode === "version" || mode === "--version") console.log(VERSION);
  else if (mode === "cleanup") await cleanup(process.argv[3] ?? "");
  else if (mode === "heavy") await heavy(process.argv.slice(3));
  else if (mode === "quiet") quiet(process.argv[3] ?? "");
  else if (mode === "plan") await step("plan", plan);
  else if (mode === "work") await step("work", work);
  else if (mode === "daemon" || mode === "ui") {
    stampConsole(); // the service's log: every line says when
    if (await portInUse()) {
      console.error(PORT_BUSY);
      process.exit(1);
    }
    if (mode === "daemon") {
      // the first start with a local key (a new install, or the update that brought the key): this computer's browser is
      // signed in once, as `overhand start` would, so the open dashboard isn't left on the pair screen
      // only the installed login service: a copy started by a test, the release's checks or a script never opens a browser
      if (isLoginService() && !existsSync(keyFile(OPS))) void signInBrowserOnce();
      await daemon();
    } else serveDashboard();
  } else if (mode === "inbox")
    await step("inbox", async () => {
      const state = loadState();
      await inbox(state);
      saveState(state);
    });
  else if (mode === undefined || mode === "help" || mode === "--help" || mode === "-h") console.log(USAGE);
  else {
    console.error(`Unknown command: ${mode}\n\n${USAGE}`);
    process.exit(2);
  }
}
