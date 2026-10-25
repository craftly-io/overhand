/** Linear tracker. */
import type { Client } from "../config";
import { http, secret } from "../env";
import type { Query, Ticket } from "./types";

export type Linear = Extract<Client["tracker"], { kind: "linear" }>;

const LINEAR_FIELDS = `id identifier title url description priorityLabel state { name type } labels { nodes { id name } }
  comments(last: 10) { nodes { body createdAt user { name } } }`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  priorityLabel: string;
  state: { name: string; type: string };
  labels: { nodes: { id: string; name: string }[] };
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
}

async function linear<T>(t: Linear, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!t.secret) throw new Error("Linear isn't connected: connect it in Settings → Connections, or add a token");
  const r = await http<{ data?: T; errors?: { message: string }[] }>("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: secret(t.secret), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (r.errors?.length || !r.data) throw new Error(`Linear: ${r.errors?.[0]?.message ?? "no data"}`);
  return r.data;
}

function fromLinear(c: Client, i: LinearIssue): Ticket {
  return {
    client: c,
    key: i.identifier,
    id: i.id,
    title: i.title,
    url: i.url,
    status: i.state.name,
    statusType: i.state.type,
    priority: i.priorityLabel,
    labels: i.labels.nodes.map((l) => l.name),
    description: i.description ?? "",
    comments: [...i.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((n) => `${n.user?.name ?? "?"}: ${n.body}`),
  };
}

/** Open Linear issues: one by key, the ones assigned to you, or the ones with a label. */
export async function linearTickets(c: Client, t: Linear, q: Query): Promise<Ticket[]> {
  const open = `state: { type: { nin: ["completed", "canceled"] } }`;
  if ("key" in q) {
    const d = await linear<{ issue: LinearIssue | null }>(t, `query($id: String!) { issue(id: $id) { ${LINEAR_FIELDS} } }`, {
      id: q.key,
    });
    return d.issue ? [fromLinear(c, d.issue)] : [];
  }
  if ("mine" in q) {
    const d = await linear<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>(
      t,
      `{ viewer { assignedIssues(first: 100, filter: { ${open} }) { nodes { ${LINEAR_FIELDS} } } } }`,
    );
    return d.viewer.assignedIssues.nodes.map((i) => fromLinear(c, i));
  }
  const d = await linear<{ issues: { nodes: LinearIssue[] } }>(
    t,
    `query($l: String!) { issues(first: 50, filter: { labels: { some: { name: { eq: $l } } }, ${open} }) { nodes { ${LINEAR_FIELDS} } } }`,
    { l: q.label },
  );
  return d.issues.nodes.map((i) => fromLinear(c, i));
}

const linearLabelIds = new Map<string, Map<string, string>>();

/** A workspace label's id by name: cached, looked up on first use, created only if Linear has no such label. */
async function linearLabelId(t: Linear, name: string): Promise<string> {
  const ids = linearLabelIds.get(t.secret) ?? new Map<string, string>();
  linearLabelIds.set(t.secret, ids);
  const known = ids.get(name);
  if (known) return known;
  // look up before creating: renamed labels and labels made by hand already exist, and Linear rejects duplicates
  const d = await linear<{ issueLabels: { nodes: { id: string; team: { id: string } | null }[] } }>(
    t,
    `query($n: String!) { issueLabels(first: 20, filter: { name: { eqIgnoreCase: $n } }) { nodes { id team { id } } } }`,
    { n: name },
  );
  const found = d.issueLabels.nodes.find((l) => !l.team)?.id;
  if (found) {
    ids.set(name, found);
    return found;
  }
  const c = await linear<{ issueLabelCreate: { issueLabel: { id: string } } }>(
    t,
    `mutation($n: String!) { issueLabelCreate(input: { name: $n, color: "#D97757" }) { issueLabel { id } } }`,
    { n: name },
  );
  ids.set(name, c.issueLabelCreate.issueLabel.id);
  return c.issueLabelCreate.issueLabel.id;
}

/** Adds and removes labels on a Linear issue, one mutation each, skipping ones already in place. */
export async function linearSetLabels(t: Linear, tk: Ticket, add: string[], remove: string[]): Promise<void> {
  for (const l of add.filter((x) => !tk.labels.includes(x))) {
    await linear(t, `mutation($i: String!, $l: String!) { issueAddLabel(id: $i, labelId: $l) { success } }`, {
      i: tk.id,
      l: await linearLabelId(t, l),
    });
  }
  for (const l of remove.filter((x) => tk.labels.includes(x))) {
    await linear(t, `mutation($i: String!, $l: String!) { issueRemoveLabel(id: $i, labelId: $l) { success } }`, {
      i: tk.id,
      l: await linearLabelId(t, l),
    });
  }
}

/** Posts a comment on a Linear issue. */
export async function linearComment(t: Linear, tk: Ticket, text: string): Promise<void> {
  await linear(t, `mutation($i: String!, $b: String!) { commentCreate(input: { issueId: $i, body: $b }) { success } }`, {
    i: tk.id,
    b: text,
  });
}

/** Files an issue in the team whose key is the client's prefix, assigned to you, and returns its identifier. */
export async function linearCreateTicket(c: Client, t: Linear, title: string, body: string, label: string): Promise<string> {
  const d = await linear<{ teams: { nodes: { id: string }[] }; viewer: { id: string } }>(
    t,
    `query($k: String!) { teams(filter: { key: { eq: $k } }) { nodes { id } } viewer { id } }`,
    { k: c.prefix },
  );
  const team = d.teams.nodes[0]?.id;
  if (!team) throw new Error(`Linear team ${c.prefix} not found`);
  const r = await linear<{ issueCreate: { issue: { identifier: string } } }>(
    t,
    `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { identifier } } }`,
    {
      i: {
        teamId: team,
        title,
        description: body,
        assigneeId: d.viewer.id,
        labelIds: [await linearLabelId(t, label)],
      },
    },
  );
  return r.issueCreate.issue.identifier;
}

/** One entry of a Linear issue's history: who changed it, when, and the labels it added. */
export interface LinearHistoryEntry {
  createdAt: string;
  actor: { id: string } | null;
  addedLabelIds: string[] | null;
}

/** Whether the newest time the label `labelId` went onto an issue, the user `viewerId` (you) added it. */
export function viewerAddedLabel(history: readonly LinearHistoryEntry[], labelId: string, viewerId: string): boolean {
  const last = [...history]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((h) => h.addedLabelIds?.includes(labelId))
    .at(-1);
  return Boolean(viewerId) && last?.actor?.id === viewerId;
}

/** Whether you (the token's user) added `label` to a Linear issue, from its history. */
export async function linearOwnerLabelled(t: Linear, tk: Ticket, label: string): Promise<boolean> {
  const d = await linear<{
    viewer: { id: string };
    issue: { labels: { nodes: { id: string; name: string }[] }; history: { nodes: LinearHistoryEntry[] } } | null;
  }>(
    t,
    `query($id: String!) { viewer { id } issue(id: $id) { labels { nodes { id name } }
      history(last: 100) { nodes { createdAt actor { id } addedLabelIds } } } }`,
    { id: tk.id },
  );
  const labelId = d.issue?.labels.nodes.find((l) => l.name === label)?.id ?? "";
  return Boolean(labelId) && viewerAddedLabel(d.issue?.history.nodes ?? [], labelId, d.viewer.id);
}
