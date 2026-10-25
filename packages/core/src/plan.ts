/** The daily plan: the planner run and the plan file's armed "### Agent" items. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claude } from "./claude";
import { CLIENTS, http, LABEL, OPS, OWNER, sh, today } from "./env";
import { notify, report } from "./notify";
import { openBrowser } from "./platform";
import { loadState, saveState } from "./state";
import { projectScope } from "./status/github";
import { bitbucket, bitbucketAuth } from "./trackers/bitbucket";
import { myAndQueued } from "./trackers/index";

// ---------- plan ----------

interface PlanItem {
  ref: string;
  title: string;
  reason: string;
  minutes: number;
}
interface Plan {
  clients: { name: string; agent: PlanItem[]; you: PlanItem[] }[];
  top3: string[];
  notes: string;
}

const PLAN_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    clients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          agent: { type: "array", items: { $ref: "#/$defs/item" } },
          you: { type: "array", items: { $ref: "#/$defs/item" } },
        },
        required: ["name", "agent", "you"],
      },
    },
    top3: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["clients", "top3", "notes"],
  $defs: {
    item: {
      type: "object",
      properties: { ref: { type: "string" }, title: { type: "string" }, reason: { type: "string" }, minutes: { type: "number" } },
      required: ["ref", "title", "reason", "minutes"],
    },
  },
});

/** A ticket line in a plan: `- [x] KEY …`; group 1 is the box, group 2 the ticket key. */
const PLAN_ITEM = /^\s*-\s*\[([ xX])\]\s*([A-Z][A-Z0-9]+-\d+)/;

/** Calls fn for every line, saying whether it sits under a "### Agent" heading. */
function agentLines(md: string, fn: (line: string, inAgent: boolean) => string | undefined): string[] {
  let inAgent = false;
  return md.split("\n").map((line) => {
    if (line.startsWith("#")) inAgent = /^###\s+Agent/i.test(line);
    return fn(line, inAgent) ?? line;
  });
}

/** Returns ticket keys checked under "### Agent" headings in a plan file. */
export function parsePlan(md: string): string[] {
  const keys: string[] = [];
  agentLines(md, (line, inAgent) => {
    const m = inAgent ? line.match(PLAN_ITEM) : null;
    if (m?.[2] && m[1] !== " ") keys.push(m[2]);
  });
  return keys;
}

/**
 * Adds a ticket to a client's "### Agent" list in a plan, or re-arms it when already listed.
 * armed=null leaves an existing line untouched (used for tickets labelled in the tracker, which wait for you to arm them).
 */
export function upsertPlanItem(md: string, client: string, key: string, title: string, armed: boolean | null): string {
  const lines = md ? md.split("\n") : [`# Plan ${today()}`, ""];
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s*\\[[ xX]\\]\\s*${key}\\b`).test(l));
  if (at >= 0) {
    if (armed !== null) lines[at] = (lines[at] ?? "").replace(/\[[ xX]\]/, armed ? "[x]" : "[ ]");
    return lines.join("\n");
  }
  const item = `- [${armed ? "x" : " "}] ${key} ${title}`;
  const section = lines.findIndex((l) => l.trim() === `## ${client}`);
  const agent = section >= 0 ? lines.findIndex((l, i) => i > section && /^###\s+Agent/i.test(l)) : -1;
  const nextSection = lines.findIndex((l, i) => i > section && /^##\s/.test(l));
  if (agent >= 0 && (nextSection < 0 || agent < nextSection)) {
    if (/^- nothing/.test(lines[agent + 1] ?? "")) lines.splice(agent + 1, 1);
    lines.splice(agent + 1, 0, item);
  } else if (section >= 0) {
    lines.splice(section + 1, 0, "### Agent", item);
  } else {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(`## ${client}`, "### Agent", item, "");
  }
  return lines.join("\n");
}

/** Today's plan file. */
export const planFile = (): string => join(OPS, "plans", `${today()}.md`);

/**
 * Rewrites today's plan with `edit`, reading and writing in one synchronous step. Never hold plan text across an
 * await and write it back later: the dashboard or the Slack inbox may have changed the file in between.
 */
export function editPlan(edit: (md: string) => string): void {
  const file = planFile();
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const md = edit(old);
  if (md === old) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md, { mode: 0o600 });
}

/** Arms every unchecked ticket under "### Agent" in a plan; returns the new text and how many it armed. */
export function armAll(md: string): { md: string; armed: number } {
  let armed = 0;
  const lines = agentLines(md, (l, inAgent) => {
    if (!inAgent || l.match(PLAN_ITEM)?.[1] !== " ") return;
    armed++;
    return l.replace("[ ]", "[x]");
  });
  return { md: lines.join("\n"), armed };
}

/** Builds today's plan from your tickets and PRs with one planner run, keeping armed items and inbox sections. */
export async function plan(): Promise<void> {
  const state = loadState();
  const data: Record<string, unknown> = {};
  for (const c of CLIENTS) {
    try {
      data[c.name] = (await myAndQueued(c)).map((t) => ({
        key: t.key,
        title: t.title,
        status: t.status,
        priority: t.priority,
        labels: t.labels,
        description: t.description.slice(0, 600),
        lastComment: t.comments.at(-1)?.slice(0, 300) ?? "",
      }));
    } catch (e) {
      data[c.name] = `ERROR fetching tickets: ${String(e)}`;
    }
  }
  // your projects' PRs only, as Needs you has them (gh searches your whole account)
  const inProjects = projectScope();
  const prs = (who: string): string => {
    const out = sh(["gh", "search", "prs", `--${who}=@me`, "--state=open", "--json", "repository,number,title,url", "--limit", "50"]).out;
    try {
      const all = JSON.parse(out) as { repository: { nameWithOwner: string } }[];
      return JSON.stringify(all.filter((p) => inProjects(p.repository.nameWithOwner) !== null));
    } catch {
      return out;
    }
  };
  const myPrs = prs("author");
  const reviews = prs("review-requested");
  let bbPrs = "[]";
  try {
    const me = await http<{ uuid: string }>("https://api.bitbucket.org/2.0/user", { headers: { Authorization: bitbucketAuth() } });
    const r = await http<{ values: { title: string; links: { html: { href: string } } }[] }>(
      `https://api.bitbucket.org/2.0/workspaces/${bitbucket().workspace}/pullrequests/${encodeURIComponent(me.uuid)}?state=OPEN&pagelen=50`,
      { headers: { Authorization: bitbucketAuth() } },
    );
    bbPrs = JSON.stringify(r.values.map((v) => ({ title: v.title, url: v.links.html.href })));
  } catch (e) {
    bbPrs = `ERROR: ${String(e)}`;
  }

  const prompt = [
    `Build today's (${today()}) work plan for ${OWNER}, a developer working for several clients.`,
    `Below: open tickets assigned to ${OWNER} (plus tickets labelled \`${LABEL.queue}\`), per client, and open PRs.`,
    "For each client split today's realistic work into:",
    "- agent: tickets an autonomous coding agent can finish alone and hand back as a PR. Only clear, self-contained,",
    `  code-only tickets (bug fixes, small features, tests, copy, refactors) with enough detail. Always include tickets labelled \`${LABEL.queue}\``,
    `  unless labelled ${LABEL.blocked}/${LABEL.review}/${LABEL.working}. Never: In Review / In Progress by a human, design or product`,
    "  decisions, client communication, infra/prod/credentials, vague epics. At most 3 per client.",
    `- you: what ${OWNER} should do personally today, most important first: unblock reviews, in-progress work, decisions,`,
    "  replies. Include open PRs needing attention. Realistic: about 6 focus hours in total across clients.",
    "Use ticket keys (e.g. HONEY-123) as ref for tickets, the URL for PRs. minutes = honest estimate (for agent items: the",
    "agent's expected run time). reason = one short line.",
    `top3 = the three things that matter most for ${OWNER} today across all clients. notes = risks or conflicts, else empty.`,
    `${OWNER} doesn't keep trackers up to date, so in notes also flag tracker drift: open PRs whose ticket isn't In Review,`,
    "tickets In Progress or In Review with no open PR, and tickets that look already done. Name the ticket and the fix.",
    "Skip clients with errors but mention them in notes. Do not use tools, answer only from this data.",
    "",
    `TICKETS: ${JSON.stringify(data)}`,
    `MY OPEN GITHUB PRS: ${myPrs}`,
    `GITHUB PRS WAITING FOR MY REVIEW: ${reviews}`,
    `MY OPEN BITBUCKET PRS: ${bbPrs}`,
  ].join("\n");

  const run = await claude<Plan>(state, prompt, OPS, PLAN_SCHEMA, "plan");
  saveState(state);
  if (!run || !("clients" in run.out)) {
    notify(
      "Planning failed",
      run ? "The planner returned no plan. Its log says why." : "Every account is cooling down. It tries again later.",
    );
    report(`✗ plan failed${run ? `, see logs/${today()}/plan-*.json` : " (no capacity)"}`);
    return;
  }
  const p = run.out;
  // Re-planning keeps what you already armed and today's Slack inbox sections; everything new waits for you.
  editPlan((old) => {
    const armed = new Set(parsePlan(old));
    const inboxes = old.split(/^(?=## )/m).filter((sec) => sec.startsWith("## Inbox"));
    return [
      `# Plan ${today()}`,
      "",
      "> Ready to deploy: nothing runs until you check it. Checked items start on the next pass (about 2 min), or press Deploy.",
      `> Pause everything: \`touch ${join(OPS, "PAUSE")}\``,
      "",
      "## Top 3 for you",
      ...p.top3.map((t, n) => `${n + 1}. ${t}`),
      "",
      ...p.clients.flatMap((c) => [
        `## ${c.name}`,
        "### Agent",
        ...(c.agent.length
          ? c.agent.map((i) => `- [${armed.has(i.ref) ? "x" : " "}] ${i.ref} ${i.title} — ${i.reason} (~${i.minutes}m)`)
          : ["- nothing suitable today"]),
        "### You",
        ...(c.you.length ? c.you.map((i, n) => `${n + 1}. ${i.ref} ${i.title} — ${i.reason} (~${i.minutes}m)`) : ["- nothing"]),
        "",
      ]),
      ...(p.notes ? ["## Notes", p.notes, ""] : []),
      ...inboxes.map((sec) => sec.trimEnd()),
    ].join("\n");
  });
  const agentCount = p.clients.reduce((n, c) => n + c.agent.length, 0);
  notify("Today's plan is ready", `${agentCount} tickets planned for agents. Top: ${p.top3[0] ?? ""}`);
  report(`📋 plan written: ${agentCount} agent tasks ready to deploy (planner on ${run.account}, $${run.cost.toFixed(2)})`);
  openBrowser(planFile()); // the plan file, in the default Markdown app
}
