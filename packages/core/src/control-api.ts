/**
 * The control room wired to this machine: its dashboard routes, its CLI (`overhand connect | disconnect | ask | ack`)
 * and the daemon's minute tick that acts under standing approvals.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CardButtonSchema, type SessionRequest } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { z } from "zod";
import { handHookCommand } from "./agent-home";
import { saveConfig } from "./config";
import { addRequest, applyHook, beatOf, moveRequest, nextAt, repoOf, setHold, settingsFile, withHook } from "./control";
import { localHeaders } from "./devices";
import { applyConfig, CFG, DASHBOARD, HOME, OPS, sh } from "./env";
import { readMachine } from "./governor";
import { projectAt, UNRECORDED_RUN } from "./guard";
import { leadNameByLabel } from "./leads";
import { diskFree, notify, report } from "./notify";
import { act, liveActEnv, resolveTarget, room } from "./room";
import { liveSessions } from "./sessions";
import { attribute, CORES, costs, gauges, memoryInUse, STRAIN, takeSample } from "./strain";

const save = (c: typeof CFG) => applyConfig(saveConfig(OPS, c));
const env = () => liveActEnv(OPS, CFG, save, sh);
const fresh = async () => room(OPS, CFG, await liveSessions(), HOME, Date.now(), leadNameByLabel);

const ActSchema = z.object({ card: z.string(), button: CardButtonSchema });
const ConnectSchema = z.object({ key: z.string(), on: z.boolean(), preview: z.boolean().default(false) });
const AskSchema = z.object({
  to: z.string(),
  text: z.string().trim().min(1).max(2000),
  by: z.string().default(""),
  from: z.string().default("owner"),
});
const AckSchema = z.object({
  id: z.string(),
  state: z.enum(["acknowledged", "done", "refused", "dropped", "sent"]),
  note: z.string().default(""),
});

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** A deadline as typed: "16:20" (the next 16:20), a ms timestamp, or nothing. Null when it can't be read. */
function deadline(by: string): number | null {
  if (!by) return 0;
  if (/^\d{10,}$/.test(by)) return Number(by);
  return nextAt(by);
}

/**
 * A request a run sent (`asRun`) to a session that's yours, not one of Overhand's runs (`targetRun`: "" or a hand
 * session, or one Overhand has no record of): it comes to you first, never straight to the session.
 */
export const heldForOwner = (asRun: string, targetRun: string): boolean =>
  asRun !== "" && (targetRun === "" || targetRun.startsWith("hand") || targetRun === UNRECORDED_RUN);

/** The notification for a request a sandboxed run sent one of your own sessions: which run, and what it said. */
export function runAskNotice(run: string, session: string, text: string): { title: string; body: string } {
  const fill = (s: string) => s.replaceAll("{run}", run).replaceAll("{session}", session).replaceAll("{text}", text.slice(0, 300));
  return { title: fill(plainWords.runAsksYouTitle), body: fill(plainWords.runAsksYouBody) };
}

/**
 * One control-room request from the dashboard or the CLI, or null when the path isn't one. `asRun`: the run that sent
 * it with its own key (server.ts runRoute), whose request to one of your own sessions comes to you instead.
 */
export async function controlRoute(path: string, body: unknown, asRun = ""): Promise<Response | null> {
  switch (path) {
    case "/api/control/act": {
      const p = ActSchema.safeParse(body);
      if (!p.success) return json({ error: "bad card action" }, 400);
      const { rows, cards } = await fresh();
      const card = cards.find((c) => c.id === p.data.card);
      if (!card) return json({ error: "That's already been dealt with." }, 409);
      const a = await act(card, p.data.button, rows, env());
      report(`🎛 ${a.result}`);
      return a.ok ? json(a) : json({ ...a, error: a.result }, 409);
    }
    case "/api/control/connect": {
      // only a session the registry sees: never an arbitrary path from the request
      const p = ConnectSchema.safeParse(body);
      if (!p.success) return json({ error: "bad connect request" }, 400);
      const row = (await fresh()).rows.find((r) => r.key === p.data.key);
      if (!row) return json({ error: "That session has ended." }, 404);
      const file = settingsFile(row.repo || row.cwd);
      try {
        if (p.data.preview) return json({ file, ...withHook(file, handHookCommand(), p.data.on) });
        const r = applyHook(file, handHookCommand(), p.data.on);
        if (r.changed) report(`🎛 ${p.data.on ? "connected" : "disconnected"} ${row.project} (${file})`);
        return json({ file, changed: r.changed, after: r.after });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    case "/api/control/resume": {
      const session = z.object({ session: z.string() }).safeParse(body);
      if (!session.success) return json({ error: "which session?" }, 400);
      setHold(OPS, session.data.session, "");
      report("🎛 resumed a paused session");
      return json({ ok: true });
    }
    case "/api/requests": {
      const p = AskSchema.safeParse(body);
      if (!p.success) return json({ error: "a request needs a session and some text" }, 400);
      const by = deadline(p.data.by);
      if (by === null) return json({ error: `can't read the deadline ${p.data.by}; use HH:MM` }, 400);
      const target = resolveTarget(p.data.to, (await fresh()).rows);
      if (typeof target === "string") return json({ error: target }, 404);
      // a run asking one of your own sessions: it goes to you first, never straight to the session
      if (heldForOwner(asRun, beatOf(OPS, target.id)?.run ?? "")) {
        const n = runAskNotice(asRun, target.label, p.data.text);
        notify(n.title, n.body);
        report(`📨 ${n.title}: held for you`);
        return json({ held: true, error: plainWords.runAsksYouHeld }, 202);
      }
      const r = addRequest(OPS, { from: p.data.from, to: target.id, toLabel: target.label, text: p.data.text, by });
      report(`📨 ${r.from} → ${r.toLabel}: ${r.text.slice(0, 80)}`);
      return json(r);
    }
    case "/api/requests/ack": {
      const p = AckSchema.safeParse(body);
      if (!p.success) return json({ error: "bad ack" }, 400);
      const r = moveRequest(OPS, p.data.id, p.data.state, p.data.note);
      if (!r) return json({ error: `no request ${p.data.id}` }, 404);
      if (r.state !== "acknowledged") report(`📨 ${r.toLabel} ${r.state} request ${r.id}${r.note ? `: ${r.note.slice(0, 80)}` : ""}`);
      return json(r);
    }
    default:
      return null;
  }
}

/** The daemon's minute: cards a standing approval covers are acted on and reported instead of asked. */
export async function autoAct(): Promise<void> {
  const { rows, cards } = await fresh();
  for (const card of cards.filter((c) => c.auto)) {
    const button = card.buttons.find((b) => ["stop", "one-at-a-time", "close-pr", "pause"].includes(b));
    if (!button) continue;
    const a = await act(card, button, rows, env(), true);
    report(`🎛 under your standing approval: ${a.result}`);
    notify("Overhand acted for you", a.result);
  }
}

/**
 * The daemon's minute sample of how hard the machine works; who's causing it (sessions and their process trees) is only
 * worked out while CPU or memory is amber or red.
 */
export async function sampleStrain(): Promise<void> {
  const r = { ...readMachine(diskFree()), at: Date.now(), mem: memoryInUse() };
  const strained = gauges(r, CFG.governor).some((g) => (g.what === "cpu" || g.what === "mem") && g.level !== "ok");
  const rows = strained ? (await fresh()).rows : [];
  takeSample(STRAIN, r, CFG.governor, () => attribute(rows, costs(), CORES));
}

// ---------- the CLI ----------

async function call(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${DASHBOARD}${path}`, {
      method: "POST",
      headers: { ...localHeaders(DASHBOARD), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = z
      .record(z.string(), z.unknown())
      .catch({})
      .parse(await res.json());
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Overhand isn't running: overhand start" } };
  }
}

/** Asks a yes/no question in the terminal; only "y" or "yes" is a yes. */
export async function confirm(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

const USAGE_CONNECT = `usage: overhand connect [<folder>] [--global [--yes]]   (disconnect: the same arguments)`;

/**
 * `overhand connect | disconnect [folder] [--global]`: writes (or removes) Overhand's hook in the project's
 * .claude/settings.local.json, so Claude Code sessions you open there report to the control room and follow the house
 * rules. `--global` writes ~/.claude/settings.json instead, only after you confirm (or pass --yes).
 */
export async function connectCli(on: boolean, args: string[]): Promise<number> {
  const global = args.includes("--global");
  const folder = args.find((a) => !a.startsWith("--"));
  if (global && folder) {
    console.error(USAGE_CONNECT);
    return 2;
  }
  const root = global ? HOME : repoOf(resolve(folder ?? process.cwd())) || resolve(folder ?? process.cwd());
  const file = settingsFile(root, global);
  const cmd = handHookCommand();
  const r = withHook(file, cmd, on);
  if (!r.changed) {
    console.log(on ? `Already connected: ${file}` : `Not connected: ${file} has no Overhand hook.`);
    return 0;
  }
  console.log(`${on ? "Writing" : "Removing"} Overhand's hook ${on ? "to" : "from"} ${file}:\n`);
  console.log(r.after || "(the file is removed: nothing else was in it)");
  if (global && !args.includes("--yes") && !(await confirm("This changes your Claude Code settings for every project. Go ahead?"))) {
    console.log("Left as it was.");
    return 1;
  }
  applyHook(file, cmd, on);
  console.log(
    on
      ? `\nConnected. Claude Code sessions ${global ? "anywhere" : `in ${root}`} now show in Overhand's Crew and follow the house rules (from their next tool call). Undo: overhand disconnect${global ? " --global" : folder ? ` ${folder}` : ""}`
      : "\nDisconnected.",
  );
  return 0;
}

/** `overhand ask <session> "<request>" [--by HH:MM]`: a typed request, handed to that session at its next tool call. */
export async function askCli(args: string[]): Promise<number> {
  const at = args.indexOf("--by");
  const by = at >= 0 ? (args[at + 1] ?? "") : "";
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  const [to = "", ...words] = rest;
  if (!to || !words.length) {
    console.error(`usage: overhand ask <session> "<request>" [--by HH:MM]`);
    return 2;
  }
  const from = process.env.OVERHAND_RUN || (process.env.CLAUDECODE ? projectAt(process.cwd()) : "owner");
  const r = await call("/api/requests", { to, text: words.join(" "), by, from });
  console.log(r.ok ? `Sent ${String(r.data.id)} to ${String(r.data.toLabel)}. It gets it at its next tool call.` : String(r.data.error));
  return r.ok ? 0 : 1;
}

/** `overhand ack <id> [done | refuse "why" | "note"]`: answers a request handed to this session. */
export async function ackCli(args: string[]): Promise<number> {
  const [id = "", what = "", ...note] = args;
  if (!id) {
    console.error(`usage: overhand ack <id> [done | refuse "why"]`);
    return 2;
  }
  const state: SessionRequest["state"] = what === "done" ? "done" : /^refuse/.test(what) ? "refused" : "acknowledged";
  const text = state === "acknowledged" ? [what, ...note].join(" ") : note.join(" ");
  const r = await call("/api/requests/ack", { id, state, note: text.trim() });
  console.log(r.ok ? `Request ${id}: ${state}.` : String(r.data.error));
  return r.ok ? 0 : 1;
}
