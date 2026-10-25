import type { Client } from "../config";
import { CFG, CLIENTS, shAsync } from "../env";
import { type ProjectRepos, projectRepos } from "../lead-prs";
import type { UiPr } from "./types";

/**
 * Which of your projects a PR's repo (owner/name) is in, by name: a project whose alias is its owner, then an owner in
 * config.otherOrgs, then a project whose tracker repo it is or that has it in its folder. Null for everything else on
 * your GitHub account, which stays off the dashboard. Each repo's origin is read once, when the scope is made.
 */
export function projectScope(
  clients: readonly Pick<Client, "name" | "aliases" | "tracker" | "dir">[] = CLIENTS,
  otherOrgs: Readonly<Record<string, string>> = CFG.otherOrgs,
  repos: ProjectRepos = projectRepos,
): (repo: string) => string | null {
  const slugs = new Map<string, string>();
  for (const c of clients)
    for (const s of [...(c.tracker?.kind === "github" ? [c.tracker.repo] : []), ...repos(c).map((r) => r.slug)])
      if (!slugs.has(s.toLowerCase())) slugs.set(s.toLowerCase(), c.name);
  return (repo) => {
    const owner = (repo.split("/")[0] ?? "").toLowerCase();
    return clients.find((c) => c.aliases.includes(owner))?.name ?? otherOrgs[owner] ?? slugs.get(repo.toLowerCase()) ?? null;
  };
}

/**
 * GitHub PRs matching a search query in your projects (`scope`, which also names the project), with review and CI
 * state; ones untouched for 90 days are left out.
 */
export async function githubPrs(query: string, scope: (repo: string) => string | null): Promise<UiPr[]> {
  const q = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
    number title url isDraft updatedAt reviewDecision repository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
  const r = await shAsync(["gh", "api", "graphql", "-f", `query=${q}`, "-f", `q=${query}`]);
  if (!r.ok) throw new Error(`GitHub: ${r.err.slice(0, 200)}`);
  type Node = {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    updatedAt: string;
    reviewDecision: string | null;
    repository: { nameWithOwner: string };
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  };
  // PRs untouched for 90 days are abandoned, not work, and ones outside your projects aren't yours here: both stay off
  const nodes = (JSON.parse(r.out) as { data: { search: { nodes: Node[] } } }).data.search.nodes.flatMap((n) => {
    const client = n.url && Date.now() - Date.parse(n.updatedAt) < 90 * 864e5 ? scope(n.repository.nameWithOwner) : null;
    return client ? [{ ...n, client }] : [];
  });
  return nodes.map((n) => ({
    client: n.client,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    draft: n.isDraft,
    review: n.reviewDecision ?? "",
    checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "",
    updated: n.updatedAt,
  }));
}
