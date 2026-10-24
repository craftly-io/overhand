/**
 * Groups of projects and the rules they hand down. A project's effective rule is its own when it sets one, else its
 * group's, else the default; private words add up instead. A project in no group is its own group, so a config written
 * before groups resolves exactly as it did. Pure: every reader (the guard, the governor, the firewall, routing, leads)
 * goes through these.
 */
import type { Autonomy } from "@overhand/contract";
import type { Client, Config, Group, GroupRules, StoredClient } from "./config";

/** The defaults a rule takes when neither the project nor its group sets it. */
const RULE_DEFAULTS = { autonomy: "act", assignedAutonomy: "act", accounts: [], fallbackToAll: true } as const;

/** The rules a project may override; the rest of a group's rules (lead push branches, windows) apply to the group. */
const PROJECT_RULES = ["autonomy", "assignedAutonomy", "accounts", "fallbackToAll"] as const;
export type ProjectRule = (typeof PROJECT_RULES)[number];

type Groups = Pick<Config, "groups">;

/** The group a project or group name belongs to: the group of that name, or the one listing the project. */
export function groupOf(cfg: Groups, name: string): Group | undefined {
  return cfg.groups.find((g) => g.name === name) ?? cfg.groups.find((g) => g.members.includes(name));
}

/** One project with its effective rules. */
function effectiveClient(c: StoredClient, rules: GroupRules = {}): Client {
  const priv = [...new Set([...(rules.private ?? []), ...(c.private ?? [])])];
  return {
    ...c,
    autonomy: c.autonomy ?? rules.autonomy ?? RULE_DEFAULTS.autonomy,
    assignedAutonomy: c.assignedAutonomy ?? rules.assignedAutonomy ?? RULE_DEFAULTS.assignedAutonomy,
    accounts: c.accounts ?? rules.accounts ?? [],
    fallbackToAll: c.fallbackToAll ?? rules.fallbackToAll ?? RULE_DEFAULTS.fallbackToAll,
    ...(priv.length || c.private ? { private: priv } : {}),
  };
}

/** Every project with its effective rules, in config order. */
export function effectiveClients(cfg: Pick<Config, "clients" | "groups">): Client[] {
  return cfg.clients.map((c) => effectiveClient(c, groupOf(cfg, c.name)?.rules));
}

/** Where a project's rule comes from: its own setting, its group's, or the default. For Settings. */
export function ruleSource(cfg: Pick<Config, "clients" | "groups">, project: string, rule: ProjectRule): "own" | "group" | "default" {
  const c = cfg.clients.find((x) => x.name === project);
  if (c && c[rule] !== undefined) return "own";
  return groupOf(cfg, project)?.rules[rule] !== undefined ? "group" : "default";
}

const CAUTION: Record<Autonomy, number> = { watch: 0, propose: 1, act: 2, ship: 3 };

/**
 * How far a lead may go: its project's effective level, or for a group lead the group's rule, else the most careful of
 * its members' levels (a lead over a watch project never edits there). Unknown names act, as before.
 */
export function autonomyFor(cfg: Pick<Config, "clients" | "groups">, name: string): Autonomy {
  const clients = effectiveClients(cfg);
  const c = clients.find((x) => x.name === name);
  if (c) return c.autonomy;
  const g = cfg.groups.find((x) => x.name === name);
  if (!g) return RULE_DEFAULTS.autonomy;
  if (g.rules.autonomy) return g.rules.autonomy;
  const levels = clients.filter((x) => g.members.includes(x.name)).map((x) => x.autonomy);
  return levels.sort((a, b) => CAUTION[a] - CAUTION[b])[0] ?? RULE_DEFAULTS.autonomy;
}

/** The protected branches a lead may push to: its own list, else its project's group's, else none. */
export function leadPushBranches(
  cfg: { groups: Groups["groups"]; godmode: readonly { key: string; project?: string; pushBranches?: string[] }[] },
  key: string,
): string[] {
  const g = cfg.godmode.find((x) => x.key === key);
  if (!g) return [];
  return g.pushBranches ?? (g.project ? groupOf(cfg, g.project)?.rules.pushBranches : undefined) ?? [];
}

/** The accounts a lead prefers: its own, else its group's rule (a project's own list never applied to leads). */
export function leadAccounts(cfg: Groups, lead: { account: string; accounts?: string[]; project: string }): string[] {
  if (lead.accounts?.length) return lead.accounts;
  if (lead.account) return [lead.account];
  return (lead.project ? groupOf(cfg, lead.project)?.rules.accounts : undefined) ?? [];
}

/** The hold windows for heavy jobs in a project: the house rules' own, and its group's. */
export function windowsFor(cfg: Pick<Config, "groups" | "control">, project: string): Config["control"]["windows"] {
  return [...cfg.control.windows, ...((project ? groupOf(cfg, project)?.rules.windows : undefined) ?? [])];
}

/**
 * The projects text bound for `dest` may name freely: the destinations and their group-mates (a group is one client,
 * one org or one person's side projects; its words aren't secret from itself).
 */
export function firewallDest(cfg: Groups, dest: readonly string[]): string[] {
  return [...new Set(dest.flatMap((d) => [d, ...(groupOf(cfg, d)?.members ?? [])]))];
}

// ---------- changing groups (each returns a new config; the caller saves it) ----------

/**
 * Puts the projects of each proposed group into a group of that name, lifting rules every member already shares into
 * the group and clearing them from the members, so each project's effective rules stay exactly what they were. Projects
 * not named keep their group; empty groups are dropped. Accepting the same grouping twice changes nothing.
 */
export function acceptGrouping(cfg: Config, proposal: readonly { name: string; members: readonly string[] }[]): Config {
  const known = new Set(cfg.clients.map((c) => c.name));
  const moving = new Set(proposal.flatMap((p) => p.members.filter((m) => known.has(m))));
  const before = new Map(effectiveClients(cfg).map((c) => [c.name, c]));
  // what each moving project must still resolve to: its effective rules now, minus private words (they only add up)
  const kept: Group[] = cfg.groups
    .map((g) => ({ ...g, members: g.members.filter((m) => !moving.has(m)) }))
    .filter((g) => g.members.length || proposal.some((p) => p.name === g.name));
  const groups: Group[] = [...kept];
  for (const p of proposal) {
    const members = [...new Set(p.members.filter((m) => known.has(m)))];
    const at = groups.findIndex((g) => g.name === p.name);
    if (at >= 0) {
      const g = groups[at];
      if (g) groups[at] = { ...g, members: [...new Set([...g.members, ...members])] };
    } else if (members.length) groups.push({ name: p.name, members, rules: {} });
  }
  const led = (g: Group) => cfg.godmode.some((l) => l.project === g.name);
  let next: Config = { ...cfg, groups: groups.filter((g) => g.members.length || led(g)) };
  next = pinRules(next, before, moving);
  return liftShared(next, [...new Set(proposal.map((p) => p.name))]);
}

/** Sets every rule on the moving projects that their new group would change, so nothing they do changes by moving. */
function pinRules(cfg: Config, before: ReadonlyMap<string, Client>, moving: ReadonlySet<string>): Config {
  const after = new Map(effectiveClients(cfg).map((c) => [c.name, c]));
  const clients = cfg.clients.map((c) => {
    const was = before.get(c.name);
    const now = after.get(c.name);
    if (!moving.has(c.name) || !was || !now) return c;
    const pinned: StoredClient = { ...c };
    for (const r of PROJECT_RULES) if (JSON.stringify(was[r]) !== JSON.stringify(now[r])) Object.assign(pinned, { [r]: was[r] });
    return pinned;
  });
  return { ...cfg, clients };
}

/**
 * For each named group, a rule its members all set to the same value (and the group doesn't set otherwise) moves up to
 * the group, cleared from the members. Effective rules don't change.
 */
function liftShared(cfg: Config, names: readonly string[]): Config {
  let next = cfg;
  for (const name of names) {
    const g = next.groups.find((x) => x.name === name);
    if (!g?.members.length) continue;
    const members = next.clients.filter((c) => g.members.includes(c.name));
    const rules: GroupRules = { ...g.rules };
    const lifted: ProjectRule[] = [];
    for (const r of PROJECT_RULES) {
      const values = members.map((c) => c[r]);
      const first = values[0];
      if (first === undefined || values.some((v) => JSON.stringify(v) !== JSON.stringify(first))) continue;
      if (g.rules[r] !== undefined && JSON.stringify(g.rules[r]) !== JSON.stringify(first)) continue;
      Object.assign(rules, { [r]: first });
      lifted.push(r);
    }
    if (!lifted.length) continue;
    next = {
      ...next,
      groups: next.groups.map((x) => (x.name === name ? { ...x, rules } : x)),
      clients: next.clients.map((c) => (g.members.includes(c.name) ? without(c, lifted) : c)),
    };
  }
  return next;
}

/** A stored project without some of its own rules (it follows its group for them). */
function without(c: StoredClient, rules: readonly ProjectRule[]): StoredClient {
  const out: StoredClient = { ...c };
  for (const r of rules) delete out[r];
  return out;
}

/**
 * Sets a group's rules (a rule given as undefined is cleared). With `reset`, members' own settings of the rules given
 * are cleared too, so the whole group follows; otherwise members that override keep their override.
 */
export function setGroupRules(cfg: Config, name: string, rules: GroupRules, reset = false): Config {
  const g = cfg.groups.find((x) => x.name === name);
  if (!g) throw new Error(`no group ${name}`);
  const merged: GroupRules = { ...g.rules, ...rules };
  for (const k of Object.keys(merged) as (keyof GroupRules)[]) if (merged[k] === undefined) delete merged[k];
  const given = PROJECT_RULES.filter((r) => r in rules);
  return {
    ...cfg,
    groups: cfg.groups.map((x) => (x.name === name ? { ...x, rules: merged } : x)),
    clients: reset ? cfg.clients.map((c) => (g.members.includes(c.name) ? without(c, given) : c)) : cfg.clients,
  };
}

/**
 * Moves one project into a group (made when it doesn't exist) or out of every group (`to` empty). It keeps the rules it
 * sets itself and follows its new group for the rest; with `pin`, every rule the move would change is set on it as its
 * own instead, so nothing it does changes.
 */
export function moveProject(cfg: Config, project: string, to: string, pin = false): Config {
  if (!cfg.clients.some((c) => c.name === project)) throw new Error(`no project ${project}`);
  const before = new Map(effectiveClients(cfg).map((c) => [c.name, c]));
  const groups = cfg.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== project) }));
  if (to) {
    const at = groups.findIndex((g) => g.name === to);
    const g = groups[at];
    if (g) groups[at] = { ...g, members: [...g.members, project] };
    else groups.push({ name: to, members: [project], rules: {} });
  }
  // a group left empty keeps its rules only if a lead still names it
  const kept = groups.filter((g) => g.members.length || cfg.godmode.some((l) => l.project === g.name));
  const next = { ...cfg, groups: kept };
  return pin ? pinRules(next, before, new Set([project])) : next;
}
