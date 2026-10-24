/** The dashboard's HTTP server (http://127.0.0.1:4317): the page, /api/state and the actions it posts. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  askGate,
  CleanupCategorySchema,
  type CleanupStatus,
  CleanupStatusSchema,
  CleanupSwitchesSchema,
  FeedbackDraftSchema,
  FeedbackRequestSchema,
  FRESH_MIN,
  isBilled,
  LEAD_TEMPLATES,
  LEAD_WORK,
  localDay,
  NameSchema,
  type PreviewReview,
  PreviewViewportSchema,
  QuickSettingSchema,
  QuietSchema,
  reportCsv,
  reportMarkdown,
  SpanSchema,
  SplitPartSchema,
  templateKey,
  updateSecret,
  type WorkReport,
} from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { z } from "zod";
import { AddAccountSchema, accountLabel, addAccount, budgetAfterAdd, KEY_ITEM, LOGIN_CLIS, onSharedLogin } from "./accounts";
import { activeRepos } from "./agent";
import {
  AGENT_HOMES,
  accountLogin,
  accountLoginCommand,
  claudeLoginCommand,
  configHome,
  LOGIN_HOME_VAR,
  signInHome,
  writeAgentHome,
} from "./agent-home";
import { assign, dropFinding, loadFindings, unassign } from "./assign";
import { billingOf, forgetBilling } from "./billing";
import { noteCalls } from "./calls";
import { type Checked, cachedCheckup } from "./checkup";
import { refreshUsage, testAccount } from "./claude";
import { type Config, parseConfig, RUNTIME_IDS, type RuntimeId, saveConfig, withQuick } from "./config";
import { beatOf, loadRequests, RUN_KEY_HEADER, type RunWho, runByKey } from "./control";
import { controlRoute } from "./control-api";
import { dashboardState, migrateLabels, roomChanged, startStateRefresh } from "./dashboard";
import { briefFor, moreFacts, snoozeItem } from "./decide";
import { deviceOf, devices, hasLocalKey, isLocal, localCookie, newPairing, redeem, revoke, sessionCookie, useOpenLink } from "./devices";
import {
  applyConfig,
  BUNDLED,
  CFG,
  CLIENTS,
  CODE,
  clientOf,
  LABEL,
  MIN,
  needsSetup,
  OPS,
  OWNER,
  PROJECTS,
  SLACK_MCP,
  SRC,
  UI_PORT,
  WEB_DIST,
} from "./env";
import { previewFeedback, sendFeedback } from "./feedback";
import { pickTask, startFirstWin } from "./firstwin";
import { setQuiet } from "./governor";
import { effectiveClients } from "./groups";
import { requestGuide } from "./guide";
import { inboxReadAt } from "./inbox";
import {
  appendAnswer,
  blankLead,
  DISMISS_TEXT,
  defaultText,
  ELSEWHERE_TEXT,
  type LeadState,
  leadAsk,
  leadInbox,
  leadName,
  leadOf,
  leadPid,
  loadLeads,
  lockHolder,
  saveLeads,
  superviseLeads,
} from "./leads";
import { addRule, dismissRule, learnFromAnswer } from "./learn";
import { CALLBACK, disconnect, finishConnect, isMcpService, SERVICES, startConnect } from "./mcp";
import { diskFree, notify, push, report } from "./notify";
import {
  AGENT_DOCS,
  agentLogins,
  configFromSetup,
  connectCommand,
  connections,
  FIRST_ACCOUNT,
  type FoundRepo,
  geminiGoogleLogin,
  geminiKeyItem,
  githubLogin,
  gitUserName,
  homePath,
  type InstallHost,
  installCommand,
  isFolder,
  ollamaModels,
  parseRemote,
  pickAgent,
  pickBackend,
  proposeProjects,
  SetupSchema,
  scanRepos,
  signInCommand,
} from "./onboard";
import { canFrame, checkFix, reviewImage, reviewOf, sendPins, takeStill } from "./onpreview";
import { organiseBrief, organiseGet, organisePost } from "./organise-api";
import { releaseLeak } from "./outward-release";
import { serveOnTailnet, tailscale } from "./phone";
import { armAll, editPlan, planFile, upsertPlanItem } from "./plan";
import { openTerminal, readSecret, SECRET_STORE, writeSecret } from "./platform";
import { additions, addRepos, copyRoots, destOf, listGithubRepos, parseRepoInput, tilde } from "./projects";
import {
  finishLink,
  hostedActive,
  linkUrl,
  refreshEntitlement,
  relayOrigins,
  relayPairUrl,
  relayStatus,
  relayUrl,
  setEnabled,
  startRelay,
  unlink,
} from "./relay";
import { takeReply } from "./replies";
import { closePr, markReady, readPr } from "./review";
import { RUNTIMES } from "./runtimes";
import { claudeSignedIn, existingClaudeSignIn } from "./runtimes/claude-code";
import { codexSignedIn } from "./runtimes/codex";
import { hostTool, sandboxState } from "./sandbox";
import { liveDeps, runSelfCheck, writeDiagnostic } from "./selfcheck";
import { requestStop, restartIfRequested, START_AGAIN, updateOps } from "./selfupdate";
import { leadLog, liveSessions } from "./sessions";
import { checks, secretsOf } from "./setup";
import { shipCheck, shipRefusal, shipSweep, undoShip } from "./ship";
import { shotsDir } from "./shots";
import { SIGNIN_GONE, sendSignInCode, signInState, startSignIn } from "./signin";
import { loadPrReview, loadSplits, loadState, saveName, savePrReview, saveSplits, type TrackedPr, ticketCache } from "./state";
import { refreshStatus } from "./status/index";
import { summarize } from "./summary";
import { startTeam, teamAction, tick as teamTick, touchTeam } from "./team";
import { answerTicket, comment, createTicket, setLabels, tickets } from "./trackers/index";
import { channelMarkdown, channelSummary, sendUpdate, webhookOk } from "./updates";
import { addSubscription, subscriptions, vapidPublicKey, webPushAll } from "./webpush";
import { dayStart, projectReport, reportHtml, sendReport } from "./workreport";
import { listWorktrees } from "./worktrees";

// the hosted page joins them while Access from anywhere is on: its requests arrive over WebRTC, as a remote device's
const uiOrigins = (): Set<string> =>
  new Set([`http://127.0.0.1:${UI_PORT}`, `http://localhost:${UI_PORT}`, ...CFG.dashboardOrigins, ...relayOrigins()]);

/** The cleanup worker's last state (.cleanup.json), or idle when it never ran or wrote an older shape. */
function cleanupStatus(): CleanupStatus {
  const f = join(OPS, ".cleanup.json");
  try {
    const st = CleanupStatusSchema.safeParse(existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});
    return st.success ? st.data : { status: "idle", at: 0 };
  } catch {
    return { status: "idle", at: 0 }; // caught mid-write; the next poll reads it whole
  }
}

/** True while a scan or cleanup runs (one stuck for 30 minutes is assumed dead). */
export const cleanupActive = (st = cleanupStatus()): boolean =>
  (st.status === "planning" || st.status === "running") && Date.now() - st.at < 30 * MIN;

/** Starts the cleanup worker out of process: a scan runs git fetch and du across every repo and would block the dashboard. */
export function spawnCleanup(mode: "plan" | "run" | "auto"): void {
  const self = BUNDLED ? [process.execPath] : [process.execPath, join(SRC, "run.ts")];
  Bun.spawn([...self, "cleanup", mode], { cwd: OPS, stdout: "ignore", stderr: "ignore" });
}

/**
 * The file for a page request: the built dashboard's index for `/`, its assets by path; null for API paths, unknown
 * files, and everything while the dashboard isn't built (`bun run --filter web build`).
 */
export function webFile(pathname: string, dist = WEB_DIST): string | null {
  if (!existsSync(join(dist, "index.html")) || pathname.startsWith("/api/")) return null;
  if (pathname === "/") return join(dist, "index.html");
  // only files inside dist: a path like /../overhand.config.json resolves outside it and is refused
  let file: string;
  try {
    file = resolve(dist, `.${decodeURIComponent(pathname)}`);
  } catch {
    return null; // malformed %-encoding
  }
  return file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile() ? file : null;
}

const encoder = new TextEncoder();
/** Each open stream, with the paired device it serves ("" on this machine) so revoking a device ends its stream. */
const listeners = new Map<(chunk: Uint8Array) => void, { device: string; close: () => void }>();
let lastState = "";
let lastSent = 0;
let hub: ReturnType<typeof setInterval> | null = null;

/** Readings that drift on their own: they ride along with the next real change or the 25 s refresh. */
const DRIFTING = new Set(["now", "upSec", "freeGb"]);

/**
 * What counts as the state changing. The clock, session uptimes and free disk space move on every read (free space by
 * a few KB as anything writes), and each change re-sends the whole state, the day's log with it, to every open tab:
 * with free space in the key that was every 2 s, all day (release/soak.ts found it).
 */
export const stateKey = (state: unknown): string => JSON.stringify(state, (k, v: unknown) => (DRIFTING.has(k) ? undefined : v));

/**
 * Live updates for every open dashboard: one timer builds the state while anyone listens and sends it when it changed,
 * or every 25 s regardless (it carries the time, and keeps the connection open).
 */
export async function pushState(): Promise<void> {
  if (!listeners.size) return; // nobody is watching: don't build the state for no one
  const state = await dashboardState();
  // the team hears about real changes as they happen, from the state built anyway
  void teamTick(state).catch(() => {});
  const key = stateKey(state);
  if (key === lastState && Date.now() - lastSent < 25_000) return;
  lastState = key;
  lastSent = Date.now();
  const chunk = encoder.encode(`data: ${JSON.stringify(state)}\n\n`);
  for (const send of listeners.keys()) send(chunk);
}

/** Stops listening for `send`, and the timer with the last listener. */
function unlisten(send: (chunk: Uint8Array) => void): void {
  listeners.delete(send);
  if (!listeners.size && hub) {
    clearInterval(hub);
    hub = null;
  }
}

/** `GET /api/events`: Server-Sent Events carrying the whole dashboard state, the moment it changes. */
function events(device: string): Response {
  let send: ((chunk: Uint8Array) => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const own = (chunk: Uint8Array) => controller.enqueue(chunk);
      send = own;
      listeners.set(own, {
        device,
        close: () => {
          unlisten(own);
          controller.close();
        },
      });
      lastState = ""; // the newcomer needs a full state now
      void pushState().catch(() => {});
      hub ??= setInterval(() => void pushState().catch(() => {}), 2000);
    },
    cancel() {
      if (send) unlisten(send);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

/**
 * How the first account already reaches Claude, so the wizard can skip asking: signed in to Claude Code in its own folder,
 * else the Claude Code you're already signed in to (`existing`: its config folder, "" for the default), else an Anthropic
 * API key stored; auth "" for none. Claude Code says whether it's signed in; its credential is never read.
 */
async function claudeReady(): Promise<{ auth: "login" | "key" | ""; existing?: string }> {
  if (await claudeSignedIn(signInHome(FIRST_ACCOUNT))) return { auth: "login" };
  const existing = await existingClaudeSignIn(process.env, AGENT_HOMES);
  if (existing !== null) return { auth: "login", existing };
  return { auth: readSecret(`anthropic-key-${FIRST_ACCOUNT}`) !== null ? "key" : "" };
}

/** How long the agent CLIs' sign-in facts are kept: long enough that reopening Settings is instant. */
const LOGINS_MS = 60_000;
let loginsCache: { at: number; facts: Promise<{ existing: string | null; logins: ReturnType<typeof agentLogins> }> } | null = null;

/**
 * The slow part of the Add an agent account flow: which agent CLIs are installed and signed in, and the Claude Code
 * sign-in your terminal uses (a few child processes, about 4 s). Kept for `LOGINS_MS`, one lookup however many ask at
 * once; adding an account or opening a sign-in clears it (`forgetLogins`), so a new login shows on the next look.
 */
function loginFacts(now = Date.now()) {
  if (!loginsCache || now - loginsCache.at > LOGINS_MS) {
    const facts = existingClaudeSignIn(process.env, AGENT_HOMES).then((existing) => ({ existing, logins: agentLogins(existing !== null) }));
    const entry = { at: now, facts };
    loginsCache = entry;
    // a failed lookup isn't kept: the next one tries again
    facts.catch(() => {
      if (loginsCache === entry) loginsCache = null;
    });
  }
  return loginsCache.facts;
}
const forgetLogins = () => {
  loginsCache = null;
};

/**
 * What the setup wizard needs to know about this machine: logins it can reuse, the projects it found, the agent CLIs and
 * local models there are, and what it proposes from them (the wizard shows that as one screen to confirm).
 */
async function accountOptions() {
  const hasKey = (item: string) => readSecret(item) !== null;
  const { logins } = await loginFacts();
  return {
    agents: logins.map((a) => ({
      ...a,
      // here: signed in on this computer as you (Claude Code: the one in your terminal, not Overhand's folders)
      label: RUNTIMES[a.id].label,
      suggested: accountLabel(a.id, CFG.accounts),
      login: LOGIN_CLIS.includes(a.id),
      ownFolder: a.id in LOGIN_HOME_VAR,
      key: Boolean(KEY_ITEM[a.id]),
      // the account already on this computer's login of this CLI: a second one needs its own folder or a key
      shared: onSharedLogin(CFG, a.id, hasKey),
    })),
  };
}

/**
 * Readies an account's own folder for its sign-in (Claude Code: the guard's settings; Codex: a config that keeps the
 * login in that folder's auth.json, never the OS keyring this computer's login may use).
 */
function readyLoginHome(account: string, home: string): void {
  const kind = CFG.runtimes[account]?.kind ?? "claude-code";
  if (home && kind === "claude-code") writeAgentHome(home, undefined, false);
  if (home && kind === "codex") {
    mkdirSync(home, { recursive: true });
    const toml = join(home, "config.toml");
    if (!existsSync(toml)) writeFileSync(toml, 'cli_auth_credentials_store = "file"\n');
  }
}

/**
 * The CLIs whose sign-in the daemon runs itself (signin.ts), each with its own check that it's signed in there. OpenCode
 * isn't one: its sign-in starts with a menu of providers to pick in the terminal, so it still opens in one.
 */
const DRIVEN_LOGIN: Partial<Record<RuntimeId, (home: string) => Promise<boolean>>> = {
  "claude-code": (home) => claudeSignedIn(home),
  codex: (home) => codexSignedIn(home),
  cursor: async () => true, // its sign-in exits 0 only once signed in
};

async function setupFacts(codeRoot: string, scan: boolean) {
  // a folder is scanned only when you chose "use projects already on this computer"; otherwise nothing is read
  const repos = scan && isFolder(codeRoot) ? scanRepos(codeRoot, [SRC, OPS]) : [];
  const ready = await claudeReady();
  const claude = ready.auth !== "";
  const agents = agentLogins(claude);
  const models = await ollamaModels();
  const host = installHost();
  return {
    needed: needsSetup(),
    owner: gitUserName() || CFG.owner.name,
    codeRoot,
    scanned: scan,
    projectsDir: PROJECTS,
    folder: isFolder(codeRoot),
    tools: { claude: Bun.which("claude") !== null, git: Bun.which("git") !== null, gh: Bun.which("gh") !== null },
    github: githubLogin(),
    claude,
    // the Claude Code you're already signed in to is what the first account will use (no second sign-in)
    claudeExisting: ready.existing !== undefined,
    // a cached Gemini CLI Google sign-in, which no longer works for free accounts: setup says so and asks for a key
    geminiGoogle: geminiGoogleLogin(),
    projects: proposeProjects([...repos, ...addedRepos(codeRoot)]),
    elsewhere: repos.filter((r) => r.host !== "github").map((r) => r.path),
    agents: agents.map((a) => ({
      ...a,
      label: RUNTIMES[a.id].label,
      // what "Install and sign in" runs in a terminal (shown first, word for word); "" when setup can't do it from here
      connect: connectFor(a.id, a.installed, host),
      docs: AGENT_DOCS[a.id] ?? "",
    })),
    ollama: models.map((m) => m.name),
    agent: pickAgent(agents),
    backend: pickBackend(
      agents.some((a) => a.id === "claude-code" && a.signedIn),
      models,
      totalmem(),
    ),
  };
}

/**
 * The repo folder a check-up may read: a git repo under the code root or the projects folder, or, during setup on
 * this computer, under the folder you chose to scan. Null for anything else (the check-up runs the repo's own scripts).
 */
function checkable(path: string, local: boolean, scanned = ""): string | null {
  const p = resolve(path);
  const roots = [CODE, PROJECTS, ...(local && needsSetup() && scanned ? [resolve(scanned)] : [])].filter(Boolean);
  return roots.some((r) => p.startsWith(`${r}/`)) && existsSync(join(p, ".git")) ? p : null;
}

/** A check-up as the page sees it: without the briefs the agent would be given. */
const shown = ({ tasks: _, ...r }: Checked) => r;

/** What an agent install can use on this machine. */
const installHost = (): InstallHost => ({ os: process.platform, brew: Bun.which("brew") !== null, npm: Bun.which("npm") !== null });

/**
 * The terminal command that gets an agent going: its official install when it's missing, then its own sign-in (Claude
 * Code's in the first account's folder). "" when it can't be installed from here or has no sign-in to open.
 */
function connectFor(agent: RuntimeId, installed: boolean, host: InstallHost): string {
  const install = installed ? null : installCommand(agent, host);
  const signIn = agent === "claude-code" ? claudeLoginCommand(signInHome(FIRST_ACCOUNT)) : signInCommand(agent);
  // Gemini CLI has no sign-in to open (it runs on an API key), so for it this is the install alone
  return installed || install ? connectCommand(install, signIn) : "";
}

/** Repos added from GitHub that are ready in the projects folder, as paths under `codeRoot` (projects group them). */
const addedRepos = (codeRoot: string): FoundRepo[] =>
  additions().flatMap((a) => {
    const r = parseRemote(a.url);
    return a.state === "ready" && r ? [{ ...r, owner: a.owner, name: a.name, path: relative(codeRoot, destOf(PROJECTS, a)) }] : [];
  });

/** The repos being added and the projects the ready ones make (prefixes of projects you have aren't reused). */
function addedFacts(codeRoot: string) {
  return {
    projectsDir: PROJECTS,
    additions: additions().map((a) => ({
      ...a,
      copy: a.copy ? { ...a.copy, path: tilde(a.copy.path) } : null,
      others: a.others.map((p) => tilde(p)),
    })),
    projects: proposeProjects(addedRepos(codeRoot), new Set(CFG.clients.map((c) => c.prefix))),
  };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** A work report from `project`, `from` and `to` (local days, `to` included; default the last 7 days), or why not. */
function reportFor(q: URLSearchParams): WorkReport | { error: string } {
  const project = q.get("project") ?? "";
  if (!CLIENTS.some((c) => c.name === project)) return { error: `no project ${project}` };
  const today0 = new Date(new Date().toDateString()).getTime();
  const to = q.get("to") ? dayStart(q.get("to") ?? "") + 864e5 : today0 + 864e5;
  const from = q.get("from") ? dayStart(q.get("from") ?? "") : to - 7 * 864e5;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { error: "from and to are days (YYYY-MM-DD), from first" };
  return projectReport(project, from, to);
}

let briefStateCache: { at: number; s: ReturnType<typeof dashboardState> } | null = null;
/** The dashboard's state for briefs, reused for 5 s: a Needs you list asks for several at once, and asks again while pending. */
function briefState(): ReturnType<typeof dashboardState> {
  if (!briefStateCache || Date.now() - briefStateCache.at > 5000) briefStateCache = { at: Date.now(), s: dashboardState() };
  return briefStateCache.s;
}

/** A PR's preview review as the dashboard reads it: images as URLs on this daemon, framing checked against its origin. */
async function previewReview(key: string, pr: TrackedPr, origin: string): Promise<PreviewReview> {
  const frame = pr.preview ? await canFrame(pr.preview, origin) : false;
  return reviewOf(key, pr, frame, (f) => `/api/preview/img?key=${encodeURIComponent(key)}&f=${f}&t=${Date.now()}`);
}

/** A review note joins the PR's next fix round (the work pass takes the queue), and that pass starts now, not in minutes. */
function queueReviewNote(key: string, text: string): void {
  const q = loadPrReview();
  q.notes[key] = [q.notes[key], `${OWNER} (review): ${text}`].filter(Boolean).join("\n");
  savePrReview(q);
  writeFileSync(join(OPS, ".request-work"), "");
}

/**
 * Why a config change can't be saved because it newly turns Ship on where green would mean nothing (ship.ts), or "".
 */
const refuseShip = (next: Config): Promise<string> => shipRefusal(CLIENTS, effectiveClients(next));

/**
 * Right after a config save: auto-merge off on every armed PR whose project left Ship or the config, without waiting for
 * a work pass. GitHub is the record: state.json isn't written here (the work pass owns it) and its next pass sees it off.
 */
const disarmLeaving = (): Promise<void> => shipSweep(loadState().prs).catch(() => undefined);

/** The agent PR a review request names: only PRs Overhand opened and tracks, and only on GitHub (where `gh` reaches). */
function agentPr(raw: unknown): { key: string; pr: TrackedPr } | { error: string; status: number } {
  const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) return { error: "give a ticket key, like HONEY-12", status: 400 };
  const pr = loadState().prs[key];
  if (!pr) return { error: `no agent PR for ${key}`, status: 404 };
  if (pr.host !== "github") return { error: "review Bitbucket pull requests in Bitbucket", status: 400 };
  return { key, pr };
}

/** Appends your answer to a lead's questions file and resumes a lead held on it. `note` goes beside the heading's stamp. */
function answerLead(g: (typeof CFG.godmode)[number], text: string, note = ""): void {
  const at = appendAnswer(g, OWNER, text, note);
  // your own answer changes the file: mark it seen so it doesn't notify you that the lead needs you
  const leads = loadLeads();
  leadOf(leads, g.key).inboxAt = at;
  saveLeads(leads);
  report(`💬 answered ${leadName(g)}${note ? ` (${note})` : ""}`);
  superviseLeads(); // a held lead resumes right away
  void pushState().catch(() => {});
}

/** A lead by its key or its label, any case (the dashboard sends keys; `overhand answer` takes either). */
const leadNamed = (name: unknown) => {
  const n = String(name ?? "")
    .trim()
    .toLowerCase();
  return CFG.godmode.find((x) => x.key === n || x.label.toLowerCase() === n);
};

/**
 * `POST /api/lead/answer`: your answer (`kind` "answer", the default), "I answered elsewhere" with an optional note,
 * "dismiss" for a question that no longer applies, or "default" to go with the lead's stated default now.
 */
function leadAnswerRoute(body: { key?: unknown; text?: unknown; kind?: unknown }): Response {
  const g = leadNamed(body.key);
  const text = String(body.text ?? "").trim();
  const kind = String(body.kind ?? "answer");
  if (!g)
    return json({ error: `no lead named ${String(body.key ?? "")}; leads: ${CFG.godmode.map((x) => x.key).join(", ") || "none"}` }, 400);
  if (kind === "answer") {
    if (!text) return json({ error: "empty answer" }, 400);
    answerLead(g, text);
    // "from now on, …" is a rule, not one decision: offered for the project's instruction file so it isn't asked again
    learnFromAnswer(g.project, g.dir, `lead-${g.key}-${Date.now()}`, text);
    return json({ ok: true });
  }
  const box = leadInbox(g);
  if (!box?.open) return json({ error: `${leadName(g)} has no open question` }, 409);
  if (kind === "elsewhere") answerLead(g, text || ELSEWHERE_TEXT, "given outside Overhand");
  else if (kind === "dismiss") answerLead(g, DISMISS_TEXT);
  else if (kind === "default") {
    const ask = leadAsk(g, loadLeads()[g.key] ?? blankLead(), box, null);
    if (!ask?.default)
      return json({ error: `${leadName(g)}'s question gives no default ("If there's no answer: …"); answer it instead` }, 409);
    answerLead(g, defaultText(ask.default));
  } else return json({ error: "kind is answer, elsewhere, dismiss or default" }, 400);
  return json({ ok: true });
}

/**
 * Where a service's consent page sends the browser back. Only this machine gets here (isLocal), the nonce in the
 * path picks the sign-in and the state must match it (finishConnect); the page says what happened, never a token.
 */
async function oauthCallback(url: URL): Promise<Response> {
  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:15px system-ui;background:#070b16;color:#edf1fa;display:grid;place-content:center;min-height:90vh;text-align:center"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body>`,
      { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  try {
    const service = await finishConnect(url.pathname.slice(CALLBACK.length), url.searchParams);
    report(`🔌 ${SERVICES[service].label} connected over MCP`);
    void pushState();
    return page(`${SERVICES[service].label} is connected`, "You can close this tab and go back to Overhand.");
  } catch (e) {
    return page("Not connected", esc(e instanceof Error ? e.message : String(e)), 400);
  }
}

/**
 * What a run may call with its own key, never the install's: `overhand ask` (as itself), `overhand ack` (only a request
 * sent to one of its own sessions) and `overhand answer` (a lead's open question, as anyone at a terminal may).
 */
const RUN_ROUTES = new Set(["/api/requests", "/api/requests/ack", "/api/lead/answer"]);

async function runRoute(path: string, raw: unknown, who: RunWho): Promise<Response> {
  const body = z.record(z.string(), z.unknown()).catch({}).parse(raw);
  if (path === "/api/lead/answer") {
    // only its own lead's question: a lead run answers itself (a subagent of it, say), no other run answers any lead
    const g = leadNamed(body.key);
    if (!g || who.run !== `lead-${g.key}`) return json({ error: "a run answers only its own lead's question" }, 403);
    return leadAnswerRoute(body);
  }
  if (path === "/api/requests/ack") {
    const r = loadRequests(OPS).find((x) => x.id === body.id);
    if (!r || beatOf(OPS, r.to)?.run !== who.run) return json({ error: `no request ${String(body.id)}` }, 404);
  }
  const res = await controlRoute(path, path === "/api/requests" ? { ...body, from: who.run } : body, who.run);
  roomChanged();
  return res ?? json({ error: "not found" }, 404);
}

/** Hosts the dashboard answers to; anything else is a page elsewhere reaching it by DNS rebinding. */
const uiHosts = (): Set<string> => new Set([...uiOrigins()].map((o) => URL.parse(o)?.host ?? "").filter(Boolean));

/**
 * A request from another device that isn't paired. The page's scripts and styles load (they're the open-source bundle,
 * no data), the page itself answers 401 and shows "Pair this device", and every API answers 401.
 */
function unpaired(req: Request, url: URL): Response {
  const file = req.method === "GET" ? webFile(url.pathname) : null;
  if (file && url.pathname !== "/") return new Response(Bun.file(file));
  const index = req.method === "GET" && url.pathname === "/" ? webFile("/") : null;
  if (index) return new Response(Bun.file(index), { status: 401, headers: { "cache-control": "no-store" } });
  return json({ error: "pair this device" }, 401);
}

/** What Settings → Phone shows: Tailscale, the addresses the dashboard answers on, and whether ntfy is set up. */
async function phoneFacts(local: boolean) {
  return {
    local,
    port: UI_PORT,
    tailscale: await tailscale(UI_PORT),
    origins: CFG.dashboardOrigins,
    ntfy: Boolean(CFG.ntfySecret) && readSecret(CFG.ntfySecret, CFG.owner.keychainAccount) !== null,
  };
}

/** Adds an address to dashboardOrigins (saved and live) unless it's there. */
function allowOrigin(origin: string): void {
  if (!CFG.dashboardOrigins.includes(origin)) applyConfig(saveConfig(OPS, { ...CFG, dashboardOrigins: [...CFG.dashboardOrigins, origin] }));
}

/** The daemon's side of the automatic asks: many tabs and devices coming back at once still cost one pass. */
const autoInbox = askGate();
const autoUsage = askGate();

/** One dashboard or API request. Exported so tests can exercise routes without a server. */
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!uiHosts().has(req.headers.get("host") ?? url.host)) return json({ error: "forbidden" }, 403);
  // Another device needs a session from pairing; this machine's own callers need the local key (devices.ts localKey):
  // its file for the CLI, a cookie for a browser that opened an open link, which this trades for it
  const here = isLocal(req);
  if (here && req.method === "GET" && useOpenLink(url.searchParams.get("open") ?? "")) {
    // the page it named, with the rest of its query (a drawer to open), minus the spent link
    const rest = new URLSearchParams(url.search);
    rest.delete("open");
    return new Response(null, {
      status: 303,
      headers: { location: `${url.pathname}${rest.size ? `?${rest}` : ""}`, "set-cookie": localCookie(), "cache-control": "no-store" },
    });
  }
  const local = here && hasLocalKey(req);
  // a run's own key (control.ts runKey) reaches only the routes a run calls, as that run (runRoute)
  const asRun =
    here && !local && req.method === "POST" && RUN_ROUTES.has(url.pathname) ? runByKey(OPS, req.headers.get(RUN_KEY_HEADER) ?? "") : null;
  // the consent page sends back only a browser on this machine (its redirect is 127.0.0.1)
  if (url.pathname.startsWith(CALLBACK) && !local) return json({ error: "forbidden" }, 403);
  const device = local ? null : deviceOf(req);
  // two ways in without one: a notification's quick reply (its own single-use token) and redeeming a pairing code
  const open = req.method === "POST" && (url.pathname === "/api/lead/reply" || url.pathname === "/api/pair");
  if (!local && !device && !open && !asRun) return unpaired(req, url);
  if (req.method === "GET") {
    const page = webFile(url.pathname);
    if (page) return new Response(Bun.file(page));
  }
  if (req.method === "GET" && url.pathname === "/api/state") return json(await dashboardState());
  if (req.method === "GET" && url.pathname === "/api/brief") {
    // a decision card: the facts at once, the agent's phrasing when cached for them (`pending` while one runs)
    const id = url.searchParams.get("id") ?? "";
    if (id.startsWith("organise:")) {
      const o = organiseBrief(id);
      return o ? json(o) : json({ error: "that item is gone" }, 404);
    }
    const b = briefFor(await briefState(), id, await moreFacts(id));
    return b ? json(b.brief) : json({ error: "that item is gone" }, 404);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/organise")) {
    const r = organiseGet(url.pathname);
    if (r) return r;
  }
  if (req.method === "GET" && url.pathname === "/api/events") return events(device?.id ?? "");
  if (req.method === "GET" && url.pathname === "/api/accounts/options") return json(await accountOptions());
  if (req.method === "GET" && url.pathname === "/api/accounts/login")
    return json(signInState(url.searchParams.get("id") ?? "", device?.id ?? "local") ?? { state: "failed", why: SIGNIN_GONE });
  if (req.method === "GET" && url.pathname === "/api/devices")
    return json({ local, devices: devices().map((d) => ({ ...d, current: d.id === device?.id })) });
  if (req.method === "GET" && url.pathname === "/api/phone") return json(await phoneFacts(local));
  if (req.method === "GET" && url.pathname === "/api/cleanup")
    return json({ ...cleanupStatus(), config: CFG.cleanup, freeGb: Math.min(diskFree(), 1e6) });
  if (req.method === "GET" && url.pathname === "/api/worktrees") return json(await listWorktrees(await liveSessions()));
  if (req.method === "GET" && url.pathname === "/api/lead/log") {
    // the last part of the lead's current log, so you can watch it from the dashboard instead of a terminal
    const g = CFG.godmode.find((x) => x.key === (url.searchParams.get("key") ?? ""));
    const st = g ? loadLeads()[g.key] : undefined;
    const f = st?.log && existsSync(st.log) ? st.log : "";
    const text = f ? leadLog(readFileSync(f, "utf8").slice(-200_000), st?.account ?? "") : "";
    return json({ text, at: f ? statSync(f).mtimeMs : 0 });
  }
  if (req.method === "GET" && url.pathname === "/api/pr/review") {
    const pr = agentPr(url.searchParams.get("key"));
    if ("error" in pr) return json({ error: pr.error }, pr.status);
    try {
      return json(readPr(pr.key, pr.pr));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/preview/review") {
    const pr = agentPr(url.searchParams.get("key"));
    if ("error" in pr) return json({ error: pr.error }, pr.status);
    return json(await previewReview(pr.key, pr.pr, url.origin));
  }
  if (req.method === "GET" && url.pathname === "/api/preview/img") {
    const f = reviewImage(url.searchParams.get("key") ?? "", url.searchParams.get("f") ?? "");
    if (!f) return json({ error: "no image" }, 404);
    return new Response(Bun.file(f), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  if (req.method === "GET" && url.pathname === "/api/report") {
    const r = reportFor(url.searchParams);
    if ("error" in r) return json({ error: r.error }, 400);
    const format = url.searchParams.get("format") ?? "json";
    const name = `work-report-${r.project.replace(/[^A-Za-z0-9-]/g, "_")}-${new Date(r.from).toLocaleDateString("sv-SE")}`;
    const file = (body: string, type: string, ext: string) =>
      new Response(body, { headers: { "content-type": type, "content-disposition": `attachment; filename="${name}.${ext}"` } });
    // the reader's own date format, as the dashboard shows it (`lang`); the CSV keeps YYYY-MM-DD for spreadsheets
    const day = localDay(url.searchParams.get("lang") ?? "");
    if (format === "md") return file(reportMarkdown(r, { cost: plainWords, day }), "text/markdown; charset=utf-8", "md");
    if (format === "csv") return file(reportCsv(r), "text/csv; charset=utf-8", "csv");
    if (format === "html") return new Response(reportHtml(r, day), { headers: { "content-type": "text/html; charset=utf-8" } });
    return json(r);
  }
  if (req.method === "GET" && url.pathname === "/api/proof/shot") {
    const which = url.searchParams.get("which");
    const f = join(shotsDir(url.searchParams.get("key") ?? ""), `${which === "before" ? "before" : "after"}.png`);
    return existsSync(f) ? new Response(Bun.file(f), { headers: { "content-type": "image/png" } }) : json({ error: "no screenshot" }, 404);
  }
  if (req.method === "GET" && url.pathname === "/api/updates/preview") {
    const ch = CFG.updates.find((u) => u.id === url.searchParams.get("id"));
    if (!ch) return json({ error: "no such channel; save it first" }, 404);
    return json({ markdown: channelMarkdown(ch, await channelSummary(ch)) });
  }
  if (req.method === "GET" && url.pathname === "/api/summary") {
    const span = SpanSchema.safeParse(url.searchParams.get("span") ?? "night");
    if (!span.success) return json({ error: "span is night, day, today or week" }, 400);
    return json(await summarize(span.data));
  }
  if (req.method === "GET" && url.pathname === "/api/setup") {
    const asked = url.searchParams.get("codeRoot") ?? "";
    return json(await setupFacts(asked ? homePath(asked) : PROJECTS, asked !== ""));
  }
  if (req.method === "GET" && url.pathname === "/api/checkup") {
    // one repo (setup names it relative to its folder), else every project's active repos, three at most
    const rel = url.searchParams.get("repo");
    const root = homePath(url.searchParams.get("codeRoot") || PROJECTS);
    if (rel !== null) {
      const p = checkable(isAbsolute(rel) ? rel : join(root, rel), local, root);
      return p ? json({ reports: [shown(await cachedCheckup(p))] }) : json({ error: "not a repo Overhand can check" }, 400);
    }
    const repos = CLIENTS.flatMap((c) => activeRepos(c)).slice(0, 3);
    return json({ reports: (await Promise.all(repos.map(cachedCheckup))).map(shown) });
  }
  if (req.method === "GET" && url.pathname === "/api/projects/github") return json(await listGithubRepos());
  if (req.method === "GET" && url.pathname === "/api/projects/added") return json(addedFacts(url.searchParams.get("codeRoot") || CODE));
  if (req.method === "GET" && url.pathname === "/api/connections") return json({ services: await connections() });
  if (req.method === "GET" && url.pathname.startsWith(CALLBACK)) return oauthCallback(url);
  if (req.method === "GET" && url.pathname === "/api/settings") {
    const folders = !existsSync(CODE)
      ? []
      : readdirSync(CODE, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name);
    const homes = Object.fromEntries(CFG.accounts.map((a) => [a, configHome(a)]));
    return json({
      config: CFG,
      checks: await checks(CFG, CODE),
      codeRoot: CODE,
      folders,
      secretStore: SECRET_STORE,
      slackMcp: SLACK_MCP,
      homes,
      sandbox: {
        ...sandboxState(CFG.sandbox),
        platform: process.platform,
        // on enforce, the projects holding a tool that can't run inside it: Settings suggests, never switches
        suggest:
          CFG.sandbox.mode === "enforce"
            ? Object.fromEntries(
                CFG.clients.flatMap((c) => (c.sandbox === "off" ? [] : [[c.name, hostTool(join(CODE, c.dir))]])).filter(([, t]) => t),
              )
            : {},
      },
    });
  }
  if (req.method === "GET" && url.pathname === "/api/relay") return json(await relayStatus());
  if (req.method === "GET" && url.pathname === "/api/push/key")
    return json({ key: vapidPublicKey(), active: hostedActive(), subscribed: subscriptions() });
  if (req.method === "GET" && url.pathname === "/api/relay/linked") {
    // the relay sends this computer's browser back here after you confirm the link; the nonce is single-use
    if (!local) return json({ error: "forbidden" }, 403);
    const r = await finishLink(url.searchParams.get("nonce") ?? "", url.searchParams.get("cert") ?? "");
    if ("error" in r) return new Response(r.error, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    report("🌐 linked to your Overhand account for access from anywhere");
    return new Response(null, { status: 303, headers: { location: "/" } });
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (url.pathname === "/api/lead/reply") {
    // a quick reply from a phone notification: no Origin, so the single-use token in the URL is the only way in
    const r = takeReply(url.searchParams.get("t") ?? "", Number(url.searchParams.get("c")), (key) => {
      const g = CFG.godmode.find((x) => x.key === key);
      return (g && leadInbox(g)?.at) || 0;
    });
    if ("error" in r) return json({ error: r.error }, r.status);
    const g = CFG.godmode.find((x) => x.key === r.key);
    if (!g) return json({ error: "no such lead" }, 404);
    answerLead(g, r.text);
    return json({ ok: true });
  }
  // Only this page may trigger actions: locally, or through `tailscale serve` on your tailnet (never Funnel).
  const origin = req.headers.get("origin") ?? "";
  if (!uiOrigins().has(origin)) return json({ error: "forbidden" }, 403);
  if (asRun) return runRoute(url.pathname, await req.json().catch(() => ({})), asRun);
  const body = (await req.json().catch(() => ({}))) as {
    ids?: unknown[];
    key?: string;
    line?: number;
    text?: string;
    voice?: string;
    config?: unknown;
    service?: string;
    value?: string;
    parts?: unknown;
    setup?: unknown;
    template?: string;
    name?: unknown;
    project?: string;
    code?: string;
    id?: string;
    account?: unknown;
    how?: string;
    kind?: string;
    repos?: unknown;
    fresh?: unknown;
    codeRoot?: unknown;
    path?: unknown;
    agent?: unknown;
    confirm?: unknown;
    on?: unknown;
    hours?: unknown;
    subscription?: unknown;
    title?: unknown;
    brief?: unknown;
    plan?: unknown;
    force?: unknown;
    channel?: unknown;
    from?: unknown;
    to?: unknown;
    viewport?: unknown;
    pins?: unknown;
    url?: unknown;
    auto?: unknown;
  };
  touchTeam();
  if (url.pathname.startsWith("/api/team/")) {
    // Teams (docs/teams.md): roster actions go to the relay, which checks the role; feed actions go to the team's room
    try {
      return json(await teamAction(url.pathname.slice("/api/team/".length), body));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  // the control room: card buttons, connecting a session's project, typed requests between sessions
  const control = await controlRoute(url.pathname, body);
  if (control) {
    roomChanged();
    return control;
  }
  // organising: groups, their rules and lead scope, and the suggestions (organise-api.ts)
  const organise = organisePost(url.pathname, body);
  if (organise) {
    void pushState().catch(() => {});
    return organise;
  }
  switch (url.pathname) {
    case "/api/pair": {
      // a phone trades the code the Mac showed for its own session; the token is new, never one the browser offered
      if (local) return json({ error: "This browser is on the Mac itself; it needs no pairing." }, 400);
      const r = redeem(String(body.code ?? ""), req.headers.get("user-agent") ?? "");
      if ("error" in r) return json({ error: r.error }, 400);
      report(`📱 ${r.device.name} paired`);
      return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(r.token, origin.startsWith("https:")) } });
    }
    case "/api/devices/pair": {
      // only from the Mac: a paired phone can't mint more devices
      if (!local) return json({ error: "Add a device from the Mac itself." }, 403);
      const p = newPairing();
      const base = CFG.dashboardOrigins.find((o) => o.startsWith("https:")) ?? CFG.dashboardOrigins[0] ?? "";
      // over the relay when it's on: the hosted page, which also pins this daemon's key from the link
      return json({ ...p, url: relayPairUrl(p.code) || (base ? `${base}/?pair=${p.code}` : "") });
    }
    case "/api/relay/link":
    case "/api/relay/enable":
    case "/api/relay/unlink":
    case "/api/relay/refresh": {
      // Access from anywhere is set up from the computer itself, never from a paired or hosted device
      if (!local) return json({ error: "Set this up from the computer itself." }, 403);
      const action = url.pathname.split("/").pop();
      if (action === "link") return json({ url: await linkUrl(UI_PORT) });
      if (action === "enable") setEnabled(body.on === true);
      if (action === "unlink") await unlink();
      if (action === "refresh") await refreshEntitlement();
      return json(await relayStatus());
    }
    case "/api/push/subscribe": {
      // a browser on the hosted page subscribing to the daemon's own Web Push (a paired device, over the data channel)
      if (!addSubscription(body.subscription)) return json({ error: "That isn't a push subscription." }, 400);
      return json({ ok: true });
    }
    case "/api/push/test": {
      if (!hostedActive()) return json({ error: "Push through the hosted page needs Overhand Pro or Team." }, 402);
      const n = await webPushAll("Overhand", "Test notification: this is where Overhand's alerts arrive.", relayUrl());
      return n ? json({ ok: true }) : json({ error: "No browser took it; turn on notifications on the hosted page first." }, 502);
    }
    case "/api/devices/revoke": {
      const id = String(body.id ?? "");
      if (!revoke(id)) return json({ error: "no such device" }, 404);
      for (const l of [...listeners.values()]) if (l.device === id) l.close();
      report("📱 a device was removed");
      return json({ ok: true });
    }
    case "/api/phone/serve": {
      // runs `tailscale serve` on a free port (never Funnel) and lets its address in; only from the Mac
      if (!local) return json({ error: "Set this up from the Mac itself." }, 403);
      const r = await serveOnTailnet(UI_PORT);
      if (!r.ok) return json({ error: r.error }, 409);
      try {
        allowOrigin(r.ts.served);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      report(`📱 Overhand served on the tailnet at ${r.ts.served}`);
      return json(await phoneFacts(local));
    }
    case "/api/phone/test": {
      if (!CFG.ntfySecret) return json({ error: "Name your ntfy topic's secret first (Settings, Integrations)." }, 400);
      const ok = await push("Overhand", "Test notification: this is where Overhand's alerts arrive.");
      return ok ? json({ ok: true }) : json({ error: "ntfy didn't take it; check the topic URL in the secret store." }, 502);
    }
    case "/api/pause":
      writeFileSync(join(OPS, "PAUSE"), "");
      return json({ ok: true });
    case "/api/quiet": {
      // "I need my laptop": no heavy agent jobs until it ends; edits and targeted tests carry on
      const parsed = QuietSchema.safeParse(body);
      if (!parsed.success) return json({ error: "hours must be 0 to 72" }, 400);
      const quietUntil = setQuiet(OPS, parsed.data.hours);
      report(quietUntil ? `🤫 quiet mode until ${new Date(quietUntil).toTimeString().slice(0, 5)}` : "🤫 quiet mode off");
      return json({ ok: true, quietUntil });
    }
    case "/api/settings": {
      const labelsBefore = { ...LABEL };
      try {
        const refused = await refuseShip(parseConfig(body.config));
        if (refused) return json({ error: refused }, 400);
        applyConfig(saveConfig(OPS, body.config));
        await disarmLeaving();
        void migrateLabels(labelsBefore, LABEL); // in the background: trackers can be slow
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      ticketCache.at = 0;
      report("⚙ settings saved from Overhand");
      return json({ ok: true, config: CFG, checks: await checks(CFG, CODE) });
    }
    case "/api/connect": {
      // the consent page URL for the browser to open; the tokens arrive at /oauth/callback, never through this page
      const service = String(body.service ?? "");
      if (!isMcpService(service)) return json({ error: `can't connect ${service}` }, 400);
      try {
        return json({ url: await startConnect(service, UI_PORT) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    case "/api/disconnect": {
      const service = String(body.service ?? "");
      if (!isMcpService(service)) return json({ error: `can't disconnect ${service}` }, 400);
      if (!disconnect(service)) return json({ error: `couldn't remove the ${SERVICES[service].label} sign-in from ${SECRET_STORE}` }, 500);
      report(`🔌 ${SERVICES[service].label} disconnected`);
      return json({ ok: true });
    }
    case "/api/secret": {
      // Only secrets the config names; the value goes straight to the secret store and is never logged or returned.
      const service = String(body.service ?? "");
      const value = String(body.value ?? "").trim();
      if (!secretsOf(CFG).includes(service)) return json({ error: `${service} isn't used by the config` }, 400);
      if (!value) return json({ error: "empty value" }, 400);
      if (service.startsWith(updateSecret("")) && !webhookOk(value)) return json({ error: "That isn't an https webhook URL." }, 400);
      const r = writeSecret(service, CFG.owner.keychainAccount, value);
      if (!r.ok) return json({ error: `${SECRET_STORE} refused it: ${r.err}` }, 500);
      return json({ ok: true, checks: await checks(CFG, CODE) });
    }
    case "/api/report/send": {
      // opt-in, one channel at a time, through the outward firewall; the error comes back without the URL
      const ch = CFG.updates.find((u) => u.id === String(body.channel ?? ""));
      if (!ch) return json({ error: "no such channel; save it first" }, 404);
      const r = reportFor(
        new URLSearchParams({ project: String(body.project ?? ""), from: String(body.from ?? ""), to: String(body.to ?? "") }),
      );
      if ("error" in r) return json({ error: r.error }, 400);
      const error = await sendReport(ch, r);
      return error ? json({ error }, 502) : json({ ok: true });
    }
    case "/api/updates/test": {
      // sends now, quiet or not; the error comes back without the URL
      const ch = CFG.updates.find((u) => u.id === String(body.id ?? ""));
      if (!ch) return json({ error: "no such channel; save it first" }, 404);
      const error = await sendUpdate(ch, await channelSummary(ch), Date.now());
      return error ? json({ error }, 502) : json({ ok: true });
    }
    case "/api/cleanup/plan":
    case "/api/cleanup/run": {
      const st = cleanupStatus();
      if (cleanupActive(st)) return json({ error: `cleanup is already ${st.status}` }, 409);
      const go = url.pathname.endsWith("/run");
      if (go) {
        if (st.status !== "ready" || !st.items || Date.now() - st.at > 60 * MIN)
          return json({ error: "scan again first: the plan is missing or over an hour old" }, 409);
        // only what you ticked; the worker re-checks each one before it goes
        const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
        // an item in your own checkout goes only with the confirmation that named its path
        const confirmed = new Set(Array.isArray(body.confirm) ? body.confirm.map(String) : []);
        const items = st.items.map((i) => ({ ...i, checked: ids.has(i.id), confirmed: i.personal && confirmed.has(i.path) ? i.path : "" }));
        if (!items.some((i) => i.checked)) return json({ error: "nothing ticked" }, 400);
        const unconfirmed = items.filter((i) => i.checked && i.personal && !i.confirmed).map((i) => i.path);
        if (unconfirmed.length) return json({ error: `confirm removing from your own checkout: ${unconfirmed.join(", ")}` }, 400);
        writeFileSync(join(OPS, ".cleanup.json"), JSON.stringify({ ...st, items }), { mode: 0o600 });
        report(`🧹 cleanup started: ${ids.size} items`);
      }
      spawnCleanup(go ? "run" : "plan");
      return json({ ok: true });
    }
    case "/api/settings/quick": {
      // one switch from Quick settings: the daily budget, weekly pacing, or a project's autonomy
      const parsed = QuickSettingSchema.safeParse(body);
      if (!parsed.success) return json({ error: "bad quick setting" }, 400);
      try {
        const next = withQuick(CFG, parsed.data);
        const refused = await refuseShip(next);
        if (refused) return json({ error: refused }, 400);
        applyConfig(saveConfig(OPS, next));
        await disarmLeaving();
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      report("⚙ quick setting changed from Overhand");
      return json({ ok: true });
    }
    case "/api/cleanup/config": {
      // the drawer's switches: categories on or off, and the unattended schedule
      const parsed = CleanupSwitchesSchema.safeParse(body);
      if (!parsed.success) return json({ error: "bad cleanup settings" }, 400);
      const { categories = {}, schedule } = parsed.data;
      const c = structuredClone(CFG.cleanup);
      for (const [k, on] of Object.entries(categories)) {
        const cat = CleanupCategorySchema.safeParse(k);
        if (cat.success && on !== undefined) c.categories[cat.data].enabled = on;
      }
      if (schedule) c.auto.schedule = schedule;
      try {
        applyConfig(saveConfig(OPS, { ...CFG, cleanup: c }));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      return json({ ok: true });
    }
    case "/api/setup": {
      // first run only: afterwards the config changes through Settings, which validates every field
      if (!needsSetup()) return json({ error: "already set up; use Settings" }, 409);
      const parsed = SetupSchema.safeParse(body.setup);
      if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      const s = parsed.data;
      // Overhand's own projects folder may not exist yet when nothing was picked
      if (s.codeRoot === PROJECTS) mkdirSync(PROJECTS, { recursive: true });
      if (!isFolder(s.codeRoot)) return json({ error: `${s.codeRoot} isn't a folder` }, 400);
      // a pasted API key is stored; otherwise the account runs on whatever already reaches Claude (its own sign-in first)
      if (s.credential.kind === "key" && s.credential.value) {
        const r = writeSecret(`anthropic-key-${FIRST_ACCOUNT}`, CFG.owner.keychainAccount, s.credential.value);
        if (!r.ok) return json({ error: `${SECRET_STORE} refused the API key: ${r.err}` }, 500);
      }
      // Gemini CLI's key (free from Google AI Studio): the Gemini runtime passes it as GEMINI_API_KEY
      if (s.agent === "gemini" && s.geminiKey) {
        const r = writeSecret(geminiKeyItem(FIRST_ACCOUNT), CFG.owner.keychainAccount, s.geminiKey);
        if (!r.ok) return json({ error: `${SECRET_STORE} refused the Gemini API key: ${r.err}` }, 500);
      }
      const ready = s.credential.kind === "key" && s.credential.value ? { auth: "key" as const } : await claudeReady();
      // other agent CLIs use their own login, and a local or gateway model needs no Claude account
      if (s.agent === "claude-code" && s.backend.kind === "claude" && !ready.auth)
        return json({ error: "sign in to Claude Code (Sign in opens it in a terminal) or add an Anthropic API key" }, 400);
      try {
        const setup = { ...s, credential: { kind: ready.auth || "login", value: "" } };
        applyConfig(saveConfig(OPS, configFromSetup(setup, CFG, "existing" in ready ? ready.existing : undefined)));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      report(`⚙ set up with ${s.projects.length} project${s.projects.length === 1 ? "" : "s"}`);
      // a first win without asking: look for one small safe task now (read-only, local, under 30 s); a work pass runs it
      if (s.projects.length) void startFirstWin();
      return json({ ok: true, checks: await checks(CFG, CODE) });
    }
    case "/api/projects/add": {
      // picked or pasted repos: a copy you already have is linked, else Overhand clones its own (in the background)
      const inputs = Array.isArray(body.repos) ? body.repos.filter((x): x is string => typeof x === "string") : [];
      const refs = inputs.map((x) => ({ x, r: parseRepoInput(x) }));
      const bad = refs.filter((p) => !p.r).map((p) => p.x);
      if (!inputs.length || bad.length)
        return json({ error: bad.length ? `Not a repository URL: ${bad.join(", ")}` : "pick a repository" }, 400);
      const roots = copyRoots(typeof body.codeRoot === "string" && body.codeRoot ? body.codeRoot : CODE);
      void addRepos(
        refs.flatMap((p) => (p.r ? [p.r] : [])),
        PROJECTS,
        roots,
        body.fresh === true,
      );
      return json({ ok: true });
    }
    case "/api/github/signin": {
      // GitHub's own browser sign-in in a terminal you can watch, so setup needs no typing; the page then sees it by itself
      const command = "gh auth login --web --git-protocol https --hostname github.com";
      if (!Bun.which("gh")) return json({ error: "GitHub's command tool (gh) isn't installed yet" }, 400);
      if (!openTerminal(command)) return json({ error: NO_TERMINAL, command: withoutBrowser(command) }, 500);
      return json({ ok: true, command });
    }
    case "/api/agent/connect": {
      // installs the agent you pay for when it's missing, then opens its own sign-in, in a terminal you can watch
      const agent = RUNTIME_IDS.find((id) => id === body.agent);
      if (!agent) return json({ error: "pick an agent" }, 400);
      const installed = Bun.which(RUNTIMES[agent].bin, { PATH: process.env.PATH }) !== null;
      const command = connectFor(agent, installed, installHost());
      if (!command) return json({ error: `${RUNTIMES[agent].label} can't be set up from here`, docs: AGENT_DOCS[agent] ?? "" }, 400);
      if (agent === "claude-code") writeAgentHome(signInHome(FIRST_ACCOUNT), undefined, false);
      if (!openTerminal(command)) return json({ error: NO_TERMINAL, command: withoutBrowser(command) }, 500);
      report(`🔑 ${installed ? "signing in to" : "installing and signing in to"} ${RUNTIMES[agent].label}`);
      return json({ ok: true, command });
    }
    case "/api/accounts/add": {
      // Add an agent account: a pasted key goes to the secret store, a sign-in opens the CLI's own flow in a terminal
      const parsed = AddAccountSchema.safeParse(body);
      if (!parsed.success) return json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
      const a = parsed.data;
      const existing = a.how === "existing" && a.agent === "claude-code" ? (await loginFacts()).existing : null;
      const added = addAccount(CFG, a, { existing, hasKey: (item) => readSecret(item) !== null });
      if ("error" in added) return json({ error: added.error }, 400);
      const item = KEY_ITEM[a.agent];
      if (a.how === "key" && item) {
        const r = writeSecret(`${item}-${added.label}`, CFG.owner.keychainAccount, a.key);
        if (!r.ok) return json({ error: `${SECRET_STORE} refused the API key: ${r.err}` }, 500);
      }
      // the first billed account (a key) on an install with no cap gets the first-day budget
      const billedBefore = CFG.accounts.some((x) => isBilled(billingOf(x)));
      const limits = { ...CFG.limits, dailyBudgetUsd: budgetAfterAdd(CFG.limits.dailyBudgetUsd, billedBefore, a.how === "key") };
      try {
        applyConfig(saveConfig(OPS, { ...CFG, ...added.accounts, limits }));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      forgetLogins();
      forgetBilling();
      report(`➕ agent account ${added.label} added (${RUNTIMES[a.agent].label})`);
      // a sign-in comes next, from the app (/api/accounts/login)
      return json({ ok: true, label: added.label });
    }
    case "/api/accounts/login": {
      // the account's CLI's own sign-in, in its own folder where it has one: the credential stays with the CLI
      const account = typeof body.account === "string" ? body.account : "";
      if (!CFG.accounts.includes(account)) return json({ error: `no account ${account}` }, 400);
      const login = accountLogin(account);
      if (!login) return json({ error: `${account} doesn't sign in with a login` }, 400);
      readyLoginHome(account, login.home);
      forgetLogins();
      forgetBilling(); // the new sign-in may say plan or per use: ask it again
      const kind = CFG.runtimes[account]?.kind ?? "claude-code";
      const verify = DRIVEN_LOGIN[kind];
      if (!verify) {
        const command = accountLoginCommand(account);
        if (!openTerminal(command)) return json({ error: NO_TERMINAL, command: withoutBrowser(command) }, 500);
        return json({ ok: true, command });
      }
      // from another device (a phone, over the relay) Codex's local-port sign-in can't call back: its device code can
      const argv = kind === "codex" && !local ? [...login.argv, "--device-auth"] : login.argv;
      const started = await startSignIn({
        key: account,
        by: device?.id ?? "local",
        argv,
        env: login.env,
        verify: async () => {
          const ok = await verify(login.home);
          forgetLogins();
          forgetBilling();
          return ok;
        },
      });
      if ("error" in started) return json({ error: started.error }, 502);
      report(`🔑 signing in ${account}`);
      return json({ ok: true, ...started });
    }
    case "/api/accounts/login/code": {
      // the code the browser showed, to the waiting sign-in this device started, and nowhere else
      const id = typeof body.id === "string" ? body.id : "";
      const r = sendSignInCode(id, device?.id ?? "local", typeof body.code === "string" ? body.code : "");
      return "error" in r ? json(r, 409) : json(r);
    }
    case "/api/accounts/test": {
      const account = typeof body.account === "string" ? body.account : "";
      if (!CFG.accounts.includes(account)) return json({ error: `no account ${account}` }, 400);
      return json(await testAccount(account));
    }
    case "/api/claude-login": {
      // Claude Code's own sign-in, in the account's own config folder: the credential stays with Claude Code
      const account = typeof body.account === "string" ? body.account : FIRST_ACCOUNT;
      if (!(needsSetup() ? [FIRST_ACCOUNT] : CFG.accounts).includes(account)) return json({ error: `no account ${account}` }, 400);
      const home = signInHome(account);
      writeAgentHome(home, undefined, false);
      if (!openTerminal(claudeLoginCommand(home))) return json({ error: NO_TERMINAL, command: claudeLoginCommand(home) }, 500);
      return json({ ok: true, command: claudeLoginCommand(home) });
    }
    case "/api/restart":
    case "/api/shutdown": {
      const off = url.pathname.endsWith("shutdown");
      requestStop(off);
      const busy = existsSync(join(OPS, ".lock"));
      report(`${off ? "⏻ turning off" : "↻ restarting"}${busy ? " after the running agent finishes" : ""}`);
      restartIfRequested();
      return json({ ok: true, busy, startAgain: START_AGAIN });
    }
    case "/api/self-update": {
      const r = updateOps();
      if (!r.ok) return json({ error: r.message }, 409);
      restartIfRequested();
      return json(r);
    }
    case "/api/usage/refresh": {
      // the app came back into view: readings older than FRESH_MIN, at most once per FRESH_MIN for every tab and device
      if (!autoUsage(0, Date.now())) return json({ ok: true, skipped: true });
      await refreshUsage(FRESH_MIN);
      return json({ ok: true });
    }
    case "/api/lead/answer":
      return leadAnswerRoute(body);
    case "/api/name": {
      // a person's own name for a lead or a piece of work: it wins over every name Overhand makes
      const parsed = NameSchema.safeParse(body);
      if (!parsed.success || !/^(lead|work):/.test(parsed.data.id)) return json({ error: "name a lead or a piece of work" }, 400);
      saveName(parsed.data.id, parsed.data.name);
      return json({ ok: true });
    }
    case "/api/lead/template": {
      // the second click on a suggestion's preview: a ready-made lead for a project, switched on; it sleeps until
      // Overhand finds its kind of work there, and goes as far as the project's mode allows
      const id = LEAD_WORK.find((x) => x === body.template);
      const c = CFG.clients.find((x) => x.name === body.project);
      const label = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
      if (!id || !c || !label) return json({ error: "pick a template, a project and a name" }, 400);
      const key = templateKey(c.name, id);
      if (CFG.godmode.some((g) => g.key === key)) return json({ error: `${c.name} already has that lead` }, 409);
      const lead = {
        key,
        label,
        dir: c.dir,
        project: c.name,
        goal: LEAD_TEMPLATES[id].goal,
        supervised: true,
        onDemand: true,
        watch: [id],
      };
      try {
        applyConfig(saveConfig(OPS, { ...CFG, godmode: [...CFG.godmode, lead] }));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      report(`⚡ ${lead.label} added from a template`);
      superviseLeads();
      return json({ ok: true });
    }
    case "/api/lead/start":
    case "/api/lead/stop": {
      const g = CFG.godmode.find((x) => x.key === String(body.key ?? "").toLowerCase());
      if (!g?.supervised) return json({ error: "that godmode session isn't supervised; turn it on in Settings" }, 400);
      const leads = loadLeads();
      const st = leadOf(leads, g.key);
      if (url.pathname.endsWith("/start")) {
        const running = !!lockHolder(g) || !!leadPid(g, st); // before superviseLeads, which may start it now
        Object.assign(st, { stopped: false, reason: "", crashes: [], lastExit: 0, waiting: false, startNow: true });
        saveLeads(leads);
        superviseLeads();
        return json({ ok: true, running });
      }
      Object.assign(st, { stopped: true, reason: "stopped from Overhand" });
      saveLeads(leads);
      const pid = leadPid(g, st);
      const holder = lockHolder(g);
      if (pid) process.kill(pid, "SIGTERM");
      report(`⏹ ${leadName(g)} stopped from Overhand`);
      // a lock held by another pid is a session you opened by hand; ops leaves that one alone
      return json({ ok: true, other: holder && holder !== pid ? holder : 0 });
    }
    case "/api/allout": {
      let armed = 0;
      editPlan((md) => {
        const r = armAll(md);
        armed = r.armed;
        return r.md;
      });
      if (existsSync(join(OPS, "PAUSE"))) unlinkSync(join(OPS, "PAUSE"));
      writeFileSync(join(OPS, ".request-work"), "");
      // every lead that's switched on and was stopped gets started again
      const leads = loadLeads();
      const started = CFG.godmode.filter((g) => g.supervised && leads[g.key]?.stopped).map((g) => leadName(g));
      for (const g of CFG.godmode)
        if (g.supervised && leads[g.key]) Object.assign(leads[g.key] as LeadState, { stopped: false, reason: "", crashes: [] });
      saveLeads(leads);
      superviseLeads();
      report(`⚡ all-out: armed ${armed}${started.length ? `, started ${started.join(", ")}` : ""}`);
      return json({ ok: true, armed, started });
    }
    case "/api/resume":
      if (existsSync(join(OPS, "PAUSE"))) unlinkSync(join(OPS, "PAUSE"));
      writeFileSync(join(OPS, ".request-work"), "");
      return json({ ok: true });
    case "/api/ticket/split": {
      // Files each part as a ticket for the agent, listed unarmed in today's plan; the big ticket steps aside.
      const key = (body.key ?? "").toUpperCase();
      const parts = SplitPartSchema.array().min(1).max(10).safeParse(body.parts);
      if (!parts.success) return json({ error: "Give each part a title (1 to 10 parts)." }, 400);
      const c = clientOf(key);
      const tk = c ? (await tickets(c, { key }))[0] : undefined;
      if (!c || !tk) return json({ error: `ticket ${key} not found` }, 404);
      const created: string[] = [];
      let failed = "";
      for (const p of parts.data) {
        const text = [p.scope, "", `Split from ${tk.key}: ${tk.url}`].join("\n");
        try {
          const k = await createTicket(c, p.title, text, LABEL.queue, "owner");
          created.push(k);
          editPlan((md) => upsertPlanItem(md, c.name, k, p.title, null));
        } catch (e) {
          failed = String(e);
          break;
        }
      }
      ticketCache.at = 0;
      // keep only the parts not filed yet, so a retry never files one twice
      const splits = loadSplits();
      const left = parts.data.slice(created.length);
      if (left.length) splits[key] = left;
      else delete splits[key];
      saveSplits(splits);
      if (created.length) report(`✂ ${key} split into ${created.join(", ")}`);
      if (failed) return json({ error: `Filed ${created.join(", ") || "none"}, then the tracker refused: ${failed.slice(0, 200)}` }, 502);
      await comment(tk, `Split into ${created.join(", ")}, one PR each.`, "owner");
      await setLabels(tk, [], [LABEL.blocked, LABEL.queue], "owner");
      return json({ ok: true, created });
    }
    case "/api/request/inbox":
      // asked by the app coming back into view: only when Slack is set up and its last read is old, once per FRESH_MIN
      // for every tab and device together (the palette's own ask, `auto` unset, always goes through)
      if (body.auto === true && !(existsSync(SLACK_MCP) && autoInbox(inboxReadAt(), Date.now()))) return json({ ok: true, skipped: true });
      writeFileSync(join(OPS, ".request-inbox"), "");
      return json({ ok: true });
    case "/api/request/plan":
    case "/api/request/work":
      writeFileSync(join(OPS, `.request-${url.pathname.split("/").pop() ?? "work"}`), "");
      return json({ ok: true });
    case "/api/plan/toggle": {
      const file = planFile();
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
      const i = body.line ?? -1;
      if (lines[i] === undefined || lines[i] !== body.text) return json({ error: "plan changed, reload" }, 409);
      lines[i] = /\[[xX]\]/.test(lines[i] ?? "") ? (lines[i] ?? "").replace(/\[[xX]\]/, "[ ]") : (lines[i] ?? "").replace("[ ]", "[x]");
      writeFileSync(file, lines.join("\n"));
      return json({ ok: true, line: lines[i] });
    }
    case "/api/preview/still":
    case "/api/preview/send":
    case "/api/preview/check": {
      // review on the preview: a still to pin on, pinned notes sent as the PR's next fix round, the spots checked after a push
      const pr = agentPr(body.key);
      if ("error" in pr) return json({ error: pr.error }, pr.status);
      const action = url.pathname.split("/").pop();
      if (action === "still") {
        const v = PreviewViewportSchema.safeParse(body.viewport ?? "wide");
        if (!v.success) return json({ error: "wide or phone" }, 400);
        const why = await takeStill(pr.key, pr.pr, v.data);
        if (why) return json({ error: why }, 502);
      } else if (action === "send") {
        const r = await sendPins(pr.key, pr.pr, body.pins);
        if ("error" in r) return json({ error: r.error }, 400);
        queueReviewNote(pr.key, r.text);
        report(`📌 ${pr.key}: notes pinned on its preview, sent as its next fix round`);
      } else {
        const why = await checkFix(pr.key, pr.pr);
        if (why) return json({ error: why }, 409);
      }
      return json(await previewReview(pr.key, pr.pr, url.origin));
    }
    case "/api/ship/undo": {
      // Undo on a Ship merge: a revert PR for you to review, never a push to the base branch
      try {
        return json({ ok: true, url: await undoShip(String(body.url ?? "")) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/pr/ready":
    case "/api/pr/changes":
    case "/api/pr/close": {
      // Review drawer actions on an agent PR: ready, request changes and close. None merges (only Ship, through GitHub's auto-merge).
      const pr = agentPr(body.key);
      if ("error" in pr) return json({ error: pr.error }, pr.status);
      const action = url.pathname.split("/").pop();
      if (action === "changes") {
        const text = String(body.text ?? "").trim();
        if (!text) return json({ error: "write what should change" }, 400);
        if (text.length > 4000) return json({ error: "keep the note under 4000 characters" }, 400);
        queueReviewNote(pr.key, text);
        // Ship: changes asked stop its auto-merge now, not at the next pass
        if (pr.pr.ship?.on)
          await shipCheck(pr.key, { ...pr.pr, extra: text }, clientOf(pr.key)).catch((e: unknown) =>
            report(`⚠ ${pr.key}: couldn't stop its auto-merge: ${String(e)}; the next pass tries again`),
          );
        report(`✍ ${pr.key}: changes requested from Overhand`);
        return json({ ok: true });
      }
      try {
        if (action === "close") {
          closePr(pr.pr);
          report(`🗑 ${pr.key}: PR closed from Overhand`);
          return json({ ok: true });
        }
        const r = markReady(pr.pr);
        const q = loadPrReview();
        if (!q.ready.includes(pr.key)) savePrReview({ ...q, ready: [...q.ready, pr.key] });
        report(`👍 ${pr.key}: marked ready${r.approved ? " and approved" : ""} from Overhand`);
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    case "/api/rules/add":
    case "/api/rules/dismiss": {
      // a rule learned from review: Add proposes it in a draft PR (or hands back the text on watch); never commits to a base branch
      const id = String(body.id ?? "");
      const how = body.how === "never" ? "never" : "later";
      try {
        if (url.pathname.endsWith("/add")) return json({ ok: true, ...(await addRule(id)) });
        dismissRule(id, how);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/checkup/pick": {
      // a check-up finding, handed to an agent: the first win (picked during setup, or now), else a ticket
      const p = checkable(String(body.path ?? ""), local, typeof body.codeRoot === "string" ? body.codeRoot : "");
      const task = p ? (await cachedCheckup(p)).tasks[String(body.id ?? "")] : undefined;
      if (!p || !task) return json({ error: "That finding is gone; check the repo again." }, 404);
      try {
        return json({ ok: true, ...(await pickTask(p, task)) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/guide/run": {
      // an onboarding guide, written by the project's agent on the next work pass: one at a time, within budget and autonomy
      try {
        await requestGuide(String(body.project ?? ""));
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/ticket/queue": {
      const key = (body.key ?? "").toUpperCase();
      const c = clientOf(key);
      const tk = c ? (await tickets(c, { key }))[0] : undefined;
      if (!tk) return json({ error: `ticket ${key} not found` }, 404);
      await setLabels(tk, [LABEL.queue], [LABEL.blocked], "owner");
      editPlan((md) => upsertPlanItem(md, c?.name ?? "", tk.key, tk.title, true));
      ticketCache.at = 0;
      writeFileSync(join(OPS, ".request-work"), "");
      return json({ ok: true });
    }
    case "/api/ticket/answer": {
      // a choice from a ticket's decision card: posted and re-queued, or on watch held for you to post
      const key = (body.key ?? "").toUpperCase();
      const text = (body.text ?? "").trim();
      const c = clientOf(key);
      const tk = c && text ? (await tickets(c, { key }))[0] : undefined;
      if (!tk) return json({ error: text ? `ticket ${key} not found` : "say what to answer" }, text ? 404 : 400);
      const done = await answerTicket(tk, text);
      if (done === "posted") {
        editPlan((md) => upsertPlanItem(md, c?.name ?? "", tk.key, tk.title, true));
        writeFileSync(join(OPS, ".request-work"), "");
      }
      ticketCache.at = 0;
      report(`💬 ${tk.key}: you answered (${done})`);
      return json({ ok: true, done });
    }
    case "/api/assign": {
      // Assign an agent: on a watch or propose project, build this one ticket (or a finding's task) at assignedAutonomy
      try {
        const finding = body.id ? loadFindings().find((f) => f.id === body.id) : undefined;
        if (body.id && !finding) return json({ error: "that finding is gone; reload" }, 404);
        // a plan you go ahead with builds its own task, told the plan you approved; `plan` starts one from a sentence
        const a = finding?.task
          ? assign({
              project: finding.project,
              key: finding.task,
              title: finding.title,
              brief: `The plan the owner approved:\n${finding.text}`,
              by: "dashboard",
              allowAct: true,
            })
          : assign({
              project: finding?.project ?? String(body.project ?? ""),
              key: finding ? finding.key : String(body.key ?? ""),
              title: finding?.title ?? String(body.title ?? ""),
              brief: finding?.text ?? String(body.brief ?? ""),
              by: "dashboard",
              // a teammate's hand-off lands held even where agents act on their own; assigning it runs it there
              allowAct: finding?.from === "team",
              plan: !finding && body.plan === true,
            });
        if (finding) dropFinding(finding.id, false);
        writeFileSync(join(OPS, ".request-work"), "");
        report(a.plan ? `📝 ${a.key}: you started an agent; it plans first` : `🙋 ${a.key}: you assigned an agent to build it`);
        return json({ ok: true, key: a.key });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/calls": {
      // what Needs you shows now, from any screen: counted once each (calls.ts)
      const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : null;
      if (!ids) return json({ error: "ids is a list of strings" }, 400);
      return json({ fresh: noteCalls(ids) });
    }
    case "/api/brief/snooze": {
      const hours = Number(body.hours);
      if (typeof body.id !== "string" || !body.id || !(hours > 0 && hours <= 24 * 14)) return json({ error: "bad snooze" }, 400);
      return json({ until: snoozeItem(body.id, hours) });
    }
    case "/api/finding/post":
    case "/api/finding/dismiss": {
      // Post it sends the comment Overhand held on a watch project, as you; Dismiss drops it for good
      const f = loadFindings().find((x) => x.id === body.id);
      if (!f) return json({ error: "that finding is gone; reload" }, 404);
      if (url.pathname.endsWith("/post")) {
        const c = clientOf(f.key);
        const tk = c && f.post ? (await tickets(c, { key: f.key }).catch(() => []))[0] : undefined;
        if (!tk) return json({ error: "nothing to post: no ticket goes with it" }, 400);
        const sent = await comment(tk, f.post, "owner");
        report(`📮 ${f.key}: ${sent ? "you posted a held comment" : "the outward firewall held a comment you posted"}`);
      }
      dropFinding(f.id, url.pathname.endsWith("/dismiss"));
      // dropping a plan drops the task it was for
      if (f.task && url.pathname.endsWith("/dismiss")) unassign(f.task);
      return json({ ok: true });
    }
    case "/api/selfcheck/report":
      // Report: what the self-check saw, with nothing private in it, in a local file
      return json({ path: writeDiagnostic(await dashboardState()) });
    case "/api/feedback/preview": {
      // Suggest or report: the exact issue, what the firewall marks in it, and how Send posts. Sends nothing.
      const parsed = FeedbackRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: "say what it's about in one line" }, 400);
      return json(await previewFeedback(parsed.data, parsed.data.diagnostics ? await dashboardState() : null));
    }
    case "/api/feedback/send": {
      // only your Send: the text you saw, read again; posted with your gh login, else the link for your browser
      const parsed = FeedbackDraftSchema.safeParse(body);
      if (!parsed.success) return json({ error: "the issue needs a title" }, 400);
      const r = await sendFeedback(parsed.data);
      if ("via" in r && r.via === "gh") report(`💡 you posted feedback: ${r.url}`);
      return json(r);
    }
    case "/api/selfcheck/run":
      // Reload asks for a fresh look first, so the card goes once the dashboard renders again
      return json(await runSelfCheck(liveDeps(dashboardState)));
    case "/api/finding/release": {
      // what the outward firewall held: Edit and post (`text`, checked again) or Post anyway (`force`, confirmed)
      const f = loadFindings().find((x) => x.id === body.id);
      if (!f?.leak) return json({ error: "that finding is gone; reload" }, 404);
      try {
        const r = await releaseLeak(f, typeof body.text === "string" ? body.text : null, body.force === true);
        if ("hits" in r) return json({ hits: r.hits });
        report(`📮 ${f.project || "Overhand"}: you sent what the outward firewall held (${f.leak.dest})`);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    default:
      return json({ error: "not found" }, 404);
  }
}

/** A sign-in's answer when no terminal window can open here (a server without a desktop): the page shows the command. */
export const NO_TERMINAL = "No terminal window opens on this machine. Run the command shown in a terminal on it, over SSH on a server.";

/**
 * A sign-in command as it has to run with no browser on this machine: Codex's own `codex login` waits for one on a
 * local port, so it takes its device code instead (`--device-auth`).
 */
export const withoutBrowser = (command: string): string =>
  command.replace(/\bcodex login\b(?! (?:status|--))/, "codex login --device-auth");

export const PORT_BUSY = `Port ${UI_PORT} is in use; is Overhand already running? (overhand status)`;

/**
 * Whether something already listens on the dashboard's port. Checked before serving: on macOS Bun.serve can bind a port
 * another process holds instead of failing with EADDRINUSE, and two daemons would then split the requests.
 */
export async function portInUse(port = UI_PORT): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

/** Serves the dashboard and its API, and starts the status timer. */
export function serveDashboard(): void {
  try {
    Bun.serve({
      hostname: "127.0.0.1",
      port: UI_PORT,
      idleTimeout: 60,
      development: false,
      fetch: handle,
      // never Bun's developer error page: it shows source and paths
      error: () => json({ error: "Something went wrong in Overhand; see the daemon log." }, 500),
    });
  } catch (e) {
    if ((e as { code?: unknown }).code !== "EADDRINUSE") throw e;
    console.error(PORT_BUSY);
    process.exit(1);
  }
  console.log(`Overhand: http://127.0.0.1:${UI_PORT}`);
  void refreshStatus();
  setInterval(() => void refreshStatus(), 3 * 60_000);
  startStateRefresh(); // what the state shows that costs a process to read, kept fresh off the request path
  // Access from anywhere, only when switched on and paid for; a failure here never touches local use
  void startRelay(handle).catch((e) => console.error(`relay: ${e instanceof Error ? e.message : String(e)}`));
  // Teams, only for a linked computer in a team; nothing local waits on it
  startTeam({
    state: dashboardState,
    answer: (key, text, from) => {
      const g = CFG.godmode.find((x) => x.key === key);
      if (g && leadInbox(g)?.open) answerLead(g, text, `from ${from}, on the team`);
    },
    notify,
    changed: () => void pushState().catch(() => {}),
  });
}
