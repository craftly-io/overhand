/**
 * Slack triage: feedback onto tickets and new work into the plan (both after the veto window, and on watch held for you
 * instead), replies owed; and the comments and tickets it files later.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdFinding } from "./assign";
import { claude } from "./claude";
import { CFG, CLIENTS, LABEL, MIN, OPS, OWNER, SLACK, SLACK_MCP, today } from "./env";
import { notify, report } from "./notify";
import { HeldError } from "./outward";
import type { State } from "./state";
import { comment, createTicket, mayPost, tickets } from "./trackers/index";

// Slack workspaces the inbox reads are config.slack; their MCP servers live in slack-mcp.json.
const SLACK_READ_TOOLS = [
  "slack_search_public_and_private",
  "slack_read_thread",
  "slack_read_channel",
  "slack_read_user_profile",
  "slack_search_users",
];

// ---------- inbox (Slack) ----------

interface InboxItem {
  workspace: string;
  kind: "feedback" | "work" | "reply";
  from: string;
  permalink: string;
  summary: string;
  ticket: string;
  title: string;
  details: string;
}

const INBOX_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          workspace: { type: "string", enum: SLACK.map((s) => s.client) },
          kind: { type: "string", enum: ["feedback", "work", "reply"] },
          from: { type: "string" },
          permalink: { type: "string" },
          summary: { type: "string", description: "one line" },
          ticket: { type: "string", description: "matching ticket key for feedback, else empty" },
          title: { type: "string", description: "work: imperative ticket title, else empty" },
          details: { type: "string", description: "work: what needs doing; reply: suggested answer; else empty" },
        },
        required: ["workspace", "kind", "from", "permalink", "summary", "ticket", "title", "details"],
      },
    },
  },
  required: ["items"],
});

/** The Slack servers a run's stream-json init line reports as not signed in. */
export function needsSignIn(transcript: string): string[] {
  const init = transcript.split("\n").find((l) => l.includes('"subtype":"init"'));
  if (!init) return [];
  try {
    const servers: unknown = JSON.parse(init).mcp_servers;
    if (!Array.isArray(servers)) return [];
    return servers.filter((s) => s?.status === "needs-auth" && typeof s.name === "string").map((s) => s.name);
  } catch {
    return [];
  }
}

/** Returns ids of checked `new-xxxxxx` lines (Slack work waiting to become tickets) in a plan file. */
export function parseNewTickets(md: string): string[] {
  return [...md.matchAll(/^\s*-\s*\[[xX]\]\s*(new-[a-z0-9]+)\b/gm)].map((m) => m[1] ?? "").filter(Boolean);
}

const READ_AT = () => join(OPS, ".inbox-at");

/** When a Slack pass last started (epoch ms), 0 when none has: the dashboard's "Read … ago" and the throttle on asks. */
export function inboxReadAt(): number {
  return existsSync(READ_AT()) ? Number(readFileSync(READ_AT(), "utf8")) || 0 : 0;
}

/** Reads Slack DMs and mentions since the last run, files feedback on tickets, queues new work, lists replies owed. */
export async function inbox(state: State): Promise<void> {
  writeFileSync(READ_AT(), String(Date.now()));
  const since = state.slackCursor || Math.floor(Date.now() / 1000) - 24 * 3600;
  const startedAt = Math.floor(Date.now() / 1000);
  const open: Record<string, string[]> = {};
  for (const s of SLACK) {
    const c = CLIENTS.find((x) => x.name === s.client);
    if (c) open[s.client] = (await tickets(c, { mine: true }).catch(() => [])).map((t) => `${t.key} ${t.title}`);
  }
  const prompt = [
    `Triage ${OWNER}'s Slack since ${new Date(since * 1000).toISOString()} (unix ${since}).`,
    `Each MCP server is one workspace: ${SLACK.map((s) => `${s.server} = ${s.client}`).join(", ")}.`,
    `In each, find DMs, group DMs, and messages mentioning ${OWNER} newer than that time. Read threads when you need context.`,
    `Skip ${OWNER}'s own messages, bots, and anything already resolved in the thread.`,
    "Classify each message or thread once, and leave out everything that isn't one of these:",
    "- feedback: remarks on existing work (bug in something shipped, review comments, change requests). ticket = matching",
    "  key from OPEN TICKETS when clear, else empty.",
    "- work: a NEW thing to build, fix, design or write that no open ticket covers. title + details (what, acceptance hints,",
    "  links). Questions, opinions, scheduling and chit-chat are never work.",
    `- reply: someone is waiting for an answer from ${OWNER}. details = a short, direct suggested reply in their voice.`,
    "Always include the permalink. Never send, react to, or draft anything.",
    "",
    `OPEN TICKETS: ${JSON.stringify(open)}`,
    `AGENT PRS: ${JSON.stringify(Object.fromEntries(Object.entries(state.prs).map(([k, p]) => [k, p.url])))}`,
  ].join("\n");
  // Slack's MCP tools are deferred: the model must load them through ToolSearch before it can call one.
  const allowed = ["ToolSearch", ...SLACK.flatMap((s) => SLACK_READ_TOOLS.map((t) => `mcp__${s.server}__${t}`))];
  const run = await claude<{ items?: InboxItem[] }>(state, prompt, OPS, INBOX_SCHEMA, "inbox", {
    model: "sonnet",
    inbox: true,
    args: ["--mcp-config", SLACK_MCP, "--strict-mcp-config", "--permission-mode", "dontAsk", "--allowedTools", ...allowed],
  });
  if (!run) {
    report("⏸ Slack check waiting: no Claude Code account has capacity right now");
    return;
  }
  const signIn = needsSignIn(run.transcript);
  if (signIn.length) {
    const names = SLACK.filter((s) => signIn.includes(s.server)).map((s) => s.client);
    report(`⚠ Slack needs signing in again for ${names.join(", ")}: Needs you has its Sign in`);
    state.slackSignIn = { clients: names, account: run.account };
  } else delete state.slackSignIn;
  if (!Array.isArray(run.out.items)) {
    report("⚠ Slack inbox triage failed, see logs/<date>/inbox-*.json");
    return;
  }
  state.slackCursor = startedAt;
  const fresh = run.out.items.filter((i) => i.permalink && !state.seen.includes(i.permalink));
  state.seen = [...state.seen, ...fresh.map((i) => i.permalink)].slice(-500);

  const lines: string[] = [];
  for (const it of fresh) {
    const c = CLIENTS.find((x) => x.name === it.workspace);
    const tk = it.kind === "feedback" && it.ticket && c ? (await tickets(c, { key: it.ticket }).catch(() => []))[0] : undefined;
    if (tk && c) {
      const pr = state.prs[tk.key];
      if (pr) pr.extra = [pr.extra, `${it.from} (Slack): ${it.summary}`].filter(Boolean).join("\n");
      const text = `💬 Feedback from ${it.from} on Slack: ${it.summary}\n\n${it.permalink}`;
      if (!mayPost(tk)) {
        // watch: the summary is triage written for you, and the client reads the ticket (2026-10-19: "not sure
        // what's being asked" reached the sender). Held for you; Post it sends it.
        holdFinding({ project: c.name, key: tk.key, title: `${tk.key}: feedback from ${it.from}`, text, post: text, from: "inbox" });
        lines.push(`- 💬 ${tk.key}: feedback from ${it.from}: ${it.summary} (${it.permalink})`);
        continue;
      }
      // elsewhere it goes on the ticket after the veto window, like Slack work: uncheck the line to keep it off
      const id = `new-${Bun.hash(`${it.permalink}#comment`).toString(36).slice(0, 6)}`;
      state.pending[id] = {
        client: c.name,
        title: `comment on ${tk.key}`,
        details: text,
        permalink: it.permalink,
        from: it.from,
        createAfter: Date.now() + CFG.limits.slackVetoMin * MIN,
        ticket: tk.key,
      };
      lines.push(`- [x] ${id} ${tk.key}: comment feedback from ${it.from}: ${it.summary} (${it.permalink})`);
    } else if (it.kind === "feedback") {
      lines.push(`- 💬 ${it.workspace}: feedback from ${it.from}, no matching ticket: ${it.summary} (${it.permalink})`);
    } else if (it.kind === "work" && c?.autonomy === "watch") {
      // watch files no tickets on its own: the ask waits on the dashboard, where you can assign an agent to it
      const text = [it.details, `From ${it.from} on Slack: ${it.permalink}`].filter(Boolean).join("\n\n");
      holdFinding({ project: c.name, key: "", title: it.title, text, post: "", from: "inbox" });
      lines.push(`- 💬 ${c.name}: ask from ${it.from}: ${it.title} (${it.permalink})`);
    } else if (it.kind === "work" && c) {
      const id = `new-${Bun.hash(it.permalink).toString(36).slice(0, 6)}`;
      state.pending[id] = {
        client: c.name,
        title: it.title,
        details: it.details,
        permalink: it.permalink,
        from: it.from,
        createAfter: Date.now() + CFG.limits.slackVetoMin * MIN,
      };
      lines.push(`- [x] ${id} ${c.name}: ${it.title} (from ${it.from}, ${it.permalink})`);
    } else if (it.kind === "reply") {
      lines.push(`- ↩ ${it.from} (${it.workspace}): ${it.summary}`, `  Suggested: ${it.details}`, `  ${it.permalink}`);
    }
  }
  if (!lines.length) return;
  const at = new Date(Date.now() + CFG.limits.slackVetoMin * MIN).toTimeString().slice(0, 5);
  mkdirSync(join(OPS, "plans"), { recursive: true });
  appendFileSync(
    join(OPS, "plans", `${today()}.md`),
    `${["", `## Inbox ${new Date().toTimeString().slice(0, 5)}`, `> Checked new-… lines become tickets at ${at}. Uncheck to skip.`, ...lines].join("\n")}\n`,
    { mode: 0o600 },
  );
  notify(
    "Slack inbox",
    `${fresh.length} new: ${lines.filter((l) => l.startsWith("- [x]")).length} tickets, ${fresh.filter((i) => i.kind === "reply").length} replies owed`,
  );
  report(`📥 inbox: ${fresh.length} items (${run.account}, $${run.cost.toFixed(2)})`);
}

/** Creates tickets for Slack work items whose veto window passed and that are still checked in a plan file. */
export async function createPendingTickets(state: State): Promise<void> {
  const yesterday = new Date(Date.now() - 864e5).toLocaleDateString("sv-SE");
  const md = [today(), yesterday]
    .map((d) => join(OPS, "plans", `${d}.md`))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const checked = new Set(parseNewTickets(md));
  for (const [id, p] of Object.entries(state.pending)) {
    if (p.created || p.createAfter > Date.now()) continue;
    const c = CLIENTS.find((x) => x.name === p.client);
    if (!checked.has(id) || !c) {
      p.created = "skipped";
      continue;
    }
    try {
      if (p.ticket) {
        // Slack feedback for a ticket, its veto window passed (comment holds it instead if the project went on watch)
        const tk = (await tickets(c, { key: p.ticket }))[0];
        const sent = tk ? await comment(tk, p.details) : false;
        p.created = p.ticket;
        report(`💬 ${p.ticket}: Slack feedback from ${p.from} ${sent ? "commented" : "held for you"}`);
        continue;
      }
      p.created = await createTicket(c, p.title, `${p.details}\n\nFrom ${p.from} on Slack: ${p.permalink}`, LABEL.fromSlack);
      report(`🎫 ${p.created} created from Slack: ${p.title}`);
    } catch (e) {
      // held by the outward firewall: it waits in Needs you, so it isn't tried again every pass
      if (e instanceof HeldError) p.created = "held";
      report(`⚠ couldn't create ticket for ${id} (${p.title}): ${String(e)}`);
    }
  }
  for (const [id, p] of Object.entries(state.pending)) if (p.created && p.createAfter < Date.now() - 7 * 864e5) delete state.pending[id];
}
