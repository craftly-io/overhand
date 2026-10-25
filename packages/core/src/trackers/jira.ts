/** Jira Cloud tracker. */
import type { Client } from "../config";
import { basic, http, secret } from "../env";
import type { Query, Ticket } from "./types";

export type Jira = Extract<Client["tracker"], { kind: "jira" }>;

// ---------- Atlassian Document Format ----------

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

const ADF_BLOCKS = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"]);

/** Flattens a Jira ADF document to plain text, one line per block. */
export function adfToText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  const inner = (node.content ?? []).map(adfToText).join("");
  return node.type && ADF_BLOCKS.has(node.type) ? `${inner}\n` : inner;
}

function adf(text: string): AdfNode & { version: number } {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  };
}

/** A Jira issue as the REST API (and the Atlassian MCP server, which may send markdown text instead of ADF) returns it. */
export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: AdfNode | string | null;
    status: { name: string; statusCategory: { key: string } };
    priority: { name: string } | null;
    labels: string[];
    comment?: { comments: { author: { displayName: string }; body: AdfNode | string }[] };
  };
}

const text = (x: AdfNode | string | null | undefined): string => (typeof x === "string" ? x : adfToText(x)).trim();

async function jira<T>(t: Jira, method: string, path: string, body?: unknown): Promise<T> {
  if (!t.secret) throw new Error("Jira isn't connected: connect it in Settings → Connections, or add a token");
  return http<T>(`https://${t.site}${path}`, {
    method,
    headers: { Authorization: basic(t.email, secret(t.secret)), "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A Jira issue as a Ticket. */
export function fromJira(c: Client, t: Jira, i: JiraIssue): Ticket {
  return {
    client: c,
    key: i.key,
    id: i.key,
    title: i.fields.summary,
    url: `https://${t.site}/browse/${i.key}`,
    status: i.fields.status.name,
    statusType: i.fields.status.statusCategory.key === "done" ? "completed" : "open",
    priority: i.fields.priority?.name ?? "",
    labels: i.fields.labels,
    description: text(i.fields.description),
    comments: (i.fields.comment?.comments ?? []).slice(-10).map((k) => `${k.author.displayName}: ${text(k.body)}`),
  };
}

/** The JQL for open issues in the project: one by key, the ones assigned to you, or the ones with a label. */
export function jiraJql(t: Jira, q: Query): string {
  const where = "key" in q ? `key = ${q.key}` : "mine" in q ? "assignee = currentUser()" : `labels = "${q.label}"`;
  return `project = ${t.project} AND ${where} AND statusCategory != Done ORDER BY priority DESC, created ASC`;
}

/** The issue fields a Ticket is built from. */
export const JIRA_FIELDS = ["summary", "description", "status", "priority", "labels", "comment"];

/** Open Jira issues in the project: one by key, the ones assigned to you, or the ones with a label. */
export async function jiraTickets(c: Client, t: Jira, q: Query): Promise<Ticket[]> {
  const d = await jira<{ issues: JiraIssue[] }>(t, "POST", "/rest/api/3/search/jql", {
    jql: jiraJql(t, q),
    fields: JIRA_FIELDS,
    maxResults: 100,
  });
  return d.issues.map((i) => fromJira(c, t, i));
}

/** Adds and removes labels on a Jira issue in one update. */
export async function jiraSetLabels(t: Jira, tk: Ticket, add: string[], remove: string[]): Promise<void> {
  const ops = [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))];
  await jira(t, "PUT", `/rest/api/3/issue/${tk.key}`, { update: { labels: ops } });
}

/** Posts a comment on a Jira issue. */
export async function jiraComment(t: Jira, tk: Ticket, text: string): Promise<void> {
  await jira(t, "POST", `/rest/api/3/issue/${tk.key}/comment`, { body: adf(text) });
}

/** Files a Task (or the first non-subtask type) assigned to you and returns its key. */
export async function jiraCreateTicket(t: Jira, title: string, body: string, label: string): Promise<string> {
  const me = await jira<{ accountId: string }>(t, "GET", "/rest/api/3/myself");
  type IssueType = { id: string; name: string; subtask: boolean };
  const meta = await jira<{ issueTypes?: IssueType[]; values?: IssueType[] }>(
    t,
    "GET",
    `/rest/api/3/issue/createmeta/${t.project}/issuetypes`,
  );
  const types = (meta.issueTypes ?? meta.values ?? []).filter((x) => !x.subtask);
  const type = types.find((x) => x.name === "Task") ?? types[0];
  if (!type) throw new Error(`no issue type available in ${t.project}`);
  const r = await jira<{ key: string }>(t, "POST", "/rest/api/3/issue", {
    fields: {
      project: { key: t.project },
      summary: title,
      description: adf(body),
      issuetype: { id: type.id },
      assignee: { accountId: me.accountId },
      labels: [label],
    },
  });
  return r.key;
}
