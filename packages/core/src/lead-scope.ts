/**
 * Lead scope: per group, one lead for the whole group, one per project, or none; a recommendation from how big and busy
 * the members are, and a plan that applies a choice to the config's leads (godmode) without losing what you set on them
 * and without stopping a running lead unless you confirm. Pure: the caller passes what runs and how busy things are.
 */
import type { Config, LeadScope } from "./config";

type Lead = Config["godmode"][number];

/** How busy one member project is. */
export interface MemberStats {
  name: string;
  /** Git repos under its folder. */
  repos: number;
  /** Its folder's size on disk, MB (0 = unknown). */
  sizeMb: number;
  /** Commits in the last 30 days across its repos. */
  commits30d: number;
  /** Open tickets in its tracker (0 = unknown or none). */
  openTickets: number;
}

export interface ScopeAdvice {
  scope: LeadScope;
  reason: string;
  confidence: "low" | "medium" | "high";
}

/** A project busy enough to keep a lead to itself: many commits, a long queue, or a big repo still moving. */
export const isBusy = (m: MemberStats): boolean => m.commits30d >= 40 || m.openTickets >= 20 || (m.sizeMb >= 1000 && m.commits30d >= 15);

/**
 * The lead scope for a group: none when nothing moved in 30 days; one per project for a lone active project or when two
 * or more are busy (or one busy project with at most two others: a busy monorepo keeps its own lead); else one lead for
 * the group (many small projects share one).
 */
export function recommendLeadScope(members: readonly MemberStats[]): ScopeAdvice {
  const active = members.filter((m) => m.commits30d > 0 || m.openTickets > 0);
  if (!active.length) return { scope: "none", reason: "Nothing moved here in 30 days: no lead until it wakes up", confidence: "high" };
  if (members.length === 1) return { scope: "repo", reason: "One project: it gets a lead of its own", confidence: "high" };
  const busy = members.filter(isBusy);
  if (busy.length >= 2)
    return { scope: "repo", reason: `${busy.length} busy projects: each gets its own lead so none waits on another`, confidence: "medium" };
  if (busy.length === 1 && members.length <= 3)
    return { scope: "repo", reason: `${busy[0]?.name ?? "One project"} is busy enough for a lead of its own`, confidence: "medium" };
  return {
    scope: "group",
    reason: `${members.length} projects, ${busy.length ? "mostly " : ""}small or quiet: one lead covers them all`,
    confidence: busy.length ? "low" : "high",
  };
}

/** What applying a lead scope does to the leads, before anything is saved. */
export interface ScopePlan {
  /** The config's leads after the change. */
  godmode: Lead[];
  added: string[];
  removed: string[];
  /** Running leads the change would stop; nothing is applied until you confirm. */
  blocked: string[];
}

/** A lead key from a name: lowercase letters, digits and dashes. */
const leadKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "lead";

/** The folder every member shares (relative to the Code root), or the first member's when they share none. */
export function commonDir(dirs: readonly string[]): string {
  const split = dirs.map((d) => d.split("/").filter(Boolean));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((s) => s[n] === first[n])) n++;
  return first.slice(0, n).join("/") || dirs[0] || "";
}

/** A new lead with the config's defaults, taking what you set on `from` (prompt, goal, name, account, push branches…). */
function newLead(key: string, label: string, dir: string, project: string, from?: Lead): Lead {
  const base: Lead = {
    key,
    label,
    name: "",
    dir,
    project,
    goal: "",
    prompt: "",
    supervised: true,
    onDemand: true,
    account: "",
    accounts: [],
    fallbackToAll: true,
    lockFile: "",
    lockStaleMin: 45,
    inboxFile: "",
    restartAfterMin: 5,
    maxCrashesPerHour: 3,
    answerWaitHours: 4,
  };
  if (!from) return base;
  // the lock and inbox files are the old lead's own; the new one keeps its own
  const { key: _k, label: _l, dir: _d, project: _p, lockFile: _lf, inboxFile: _if, ...custom } = from;
  return { ...base, ...custom };
}

/**
 * Applies a lead scope to one group's leads. `group`: one lead for the group (an existing group lead is kept; else one is
 * made from the first member lead's settings) and the member leads go. `repo`: each member keeps its lead or gets one
 * (made from the group lead's settings), and the group lead goes. `none`: every lead of the group goes. A running lead
 * that would go is listed in `blocked` and nothing changes, unless `confirm`. Leads of other groups are never touched.
 */
export function planLeadScope(
  cfg: Pick<Config, "clients" | "groups" | "godmode">,
  groupName: string,
  scope: LeadScope,
  o: { running: ReadonlySet<string>; confirm?: boolean; activeOnly?: ReadonlySet<string> },
): ScopePlan {
  const g = cfg.groups.find((x) => x.name === groupName);
  if (!g) throw new Error(`no group ${groupName}`);
  const members = cfg.clients.filter((c) => g.members.includes(c.name));
  const groupLeads = cfg.godmode.filter((l) => l.project === g.name);
  const memberLeads = cfg.godmode.filter((l) => g.members.includes(l.project));
  const keys = new Set(cfg.godmode.map((l) => l.key));
  const fresh = (name: string) => {
    let k = leadKey(name);
    for (let n = 2; keys.has(k); n++) k = `${leadKey(name)}-${n}`;
    keys.add(k);
    return k;
  };
  let drop: Lead[] = [];
  const add: Lead[] = [];
  if (scope === "none") drop = [...groupLeads, ...memberLeads];
  else if (scope === "group") {
    drop = memberLeads;
    if (!groupLeads.length) {
      const dir = commonDir(members.map((c) => c.dir));
      add.push(newLead(fresh(`${g.name}-lead`), `${g.name} lead`, dir, g.name, memberLeads[0]));
    }
  } else {
    drop = groupLeads;
    for (const c of members) {
      if (memberLeads.some((l) => l.project === c.name) || (o.activeOnly && !o.activeOnly.has(c.name))) continue;
      add.push(newLead(fresh(`${c.name}-lead`), `${c.name} lead`, c.dir, c.name, groupLeads[0]));
    }
  }
  const blocked = drop.filter((l) => o.running.has(l.key)).map((l) => l.key);
  if (blocked.length && !o.confirm) return { godmode: [...cfg.godmode], added: [], removed: [], blocked };
  const gone = new Set(drop.map((l) => l.key));
  return {
    godmode: [...cfg.godmode.filter((l) => !gone.has(l.key)), ...add],
    added: add.map((l) => l.key),
    removed: [...gone],
    blocked: o.confirm ? [] : blocked,
  };
}

/** The config with a lead scope applied (when nothing is blocked) and recorded on the group. */
export function withLeadScope(cfg: Config, groupName: string, scope: LeadScope, plan: ScopePlan): Config {
  if (plan.blocked.length) return cfg;
  return { ...cfg, godmode: plan.godmode, groups: cfg.groups.map((g) => (g.name === groupName ? { ...g, lead: scope } : g)) };
}
