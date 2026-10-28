/**
 * Adding an agent account: which CLI, how it signs in (its own login, an API key, or the login already on this computer),
 * and the label it gets. Each CLI keeps its own credential: Overhand stores a pasted key in the secret store and opens
 * the CLI's own sign-in otherwise; it never reads, copies or moves a login.
 */
import { z } from "zod";
import { LOGIN_HOME_VAR } from "./agent-home";
import { type Config, FIRST_DAY_BUDGET_USD, RUNTIME_IDS, type RuntimeId } from "./config";
import { RUNTIMES } from "./runtimes";

/** What the Add an agent account flow submits. */
export const AddAccountSchema = z.object({
  agent: z.enum(RUNTIME_IDS),
  /** Empty: one is picked (`accountLabel`). */
  label: z.string().trim().default(""),
  /**
   * `login`: the CLI's own sign-in, in a folder of the account's own where the CLI can keep one there (LOGIN_HOME_VAR),
   * else this computer's login. `key`: an API key (`key`). `existing`: the login already on this computer, as is.
   */
  how: z.enum(["login", "key", "existing"]),
  key: z.string().trim().default(""),
});
export type AddAccount = z.infer<typeof AddAccountSchema>;

/**
 * The daily budget once an account is added: when it's the first billed one (an API key) and no cap is set, the budget a
 * new install with a billed account starts with; otherwise the cap as it was (a person who already runs billed accounts
 * without a cap chose that).
 */
export const budgetAfterAdd = (cap: number, billedBefore: boolean, addedBilled: boolean): number =>
  cap || billedBefore || !addedBilled ? cap : FIRST_DAY_BUDGET_USD;

/** The secret store item prefix of each CLI's API key (the runtime reads <prefix>-<account>); none for the others. */
export const KEY_ITEM: Partial<Record<RuntimeId, string>> = {
  "claude-code": "anthropic-key",
  codex: "codex-key",
  gemini: "gemini-key",
  cursor: "cursor-key",
};

/** The CLIs with a sign-in of their own; Gemini CLI runs on a key here, Aider on a key per model or a gateway. */
export const LOGIN_CLIS: readonly RuntimeId[] = ["claude-code", "codex", "cursor", "opencode"];

const SHORT: Record<RuntimeId, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
  opencode: "opencode",
  aider: "aider",
};

/** A free label for a new account of `agent`: its short name, then name-2, name-3 and on. */
export function accountLabel(agent: RuntimeId, taken: readonly string[]): string {
  const base = SHORT[agent];
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** What "Keep a client's work on this account" submits: the projects that run only on it, and the MCP servers it may use. */
export const ScopeAccountSchema = z.object({
  account: z.string().min(1),
  projects: z.array(z.string()).default([]),
  servers: z.array(z.string()).default([]),
});
export type ScopeAccount = z.infer<typeof ScopeAccountSchema>;

/**
 * The config with `account` set up for a client: each listed project runs on it alone (never on another account, even
 * when it's busy: that is the point of one account per client), and the account reaches only the listed MCP servers
 * (none listed = all of yours). Or why it can't be.
 */
export function scopeAccount(
  c: Pick<Config, "accounts" | "runtimes" | "clients">,
  s: ScopeAccount,
): Pick<Config, "runtimes" | "clients"> | { error: string } {
  if (!c.accounts.includes(s.account)) return { error: `no agent account named ${s.account}` };
  const unknown = s.projects.filter((p) => !c.clients.some((x) => x.name === p));
  if (unknown.length) return { error: `no project named ${unknown.join(", ")}` };
  const rt = c.runtimes[s.account] ?? { kind: "claude-code" as const, model: "" };
  return {
    runtimes: { ...c.runtimes, [s.account]: { ...rt, mcpServers: s.servers.length ? s.servers : undefined } },
    clients: c.clients.map((x) => (s.projects.includes(x.name) ? { ...x, accounts: [s.account], fallbackToAll: false } : x)),
  };
}

type Accounts = Pick<Config, "accounts" | "providers" | "runtimes"> & Partial<Pick<Config, "billing">>;

/**
 * The account already on this computer's own login of `agent` (no folder of its own, no key, not a gateway or cloud), or
 * "". A CLI's login there is one per computer, so a second account of it signs in in its own folder or with a key.
 */
export function onSharedLogin(c: Accounts, agent: RuntimeId, hasKey: (item: string) => boolean): string {
  return (
    c.accounts.find((a) => {
      const kind = c.runtimes[a]?.kind ?? "claude-code";
      if (kind !== agent) return false;
      const p = c.providers[a];
      if (agent === "claude-code") return p?.kind === "claude" && p.auth === "login" && p.existing !== undefined;
      const item = KEY_ITEM[agent];
      return !c.runtimes[a]?.ownLogin && (p === undefined || p.kind === "claude") && !(item && hasKey(`${item}-${a}`));
    }) ?? ""
  );
}

/**
 * The config with one more account, last in the order (so it takes work only once the ones before it are busy), or why it
 * can't be added. `existing`: the folder of the Claude Code sign-in on this computer ("" for the default), null for none.
 * `hasKey` says whether the secret store holds an item. Two accounts of one CLI are for keeping work apart (work and
 * personal, one per client); routing never spreads one project's work across them to get round a plan's limits.
 */
export function addAccount(
  c: Accounts,
  a: AddAccount,
  opts: { existing: string | null; hasKey: (item: string) => boolean },
): { accounts: Accounts; label: string } | { error: string } {
  const label = a.label || accountLabel(a.agent, c.accounts);
  if (c.accounts.includes(label)) return { error: `there's already an account ${label}` };
  const claude = a.agent === "claude-code";
  const name = RUNTIMES[a.agent].label;
  const runtimes = claude ? c.runtimes : { ...c.runtimes, [label]: { kind: a.agent, model: "" } };
  const shared = onSharedLogin(c, a.agent, opts.hasKey);
  const own = a.agent in LOGIN_HOME_VAR;
  const add = (providers: Accounts["providers"], rt: Accounts["runtimes"] = runtimes) => ({
    accounts: { accounts: [...c.accounts, label], providers, runtimes: rt },
    label,
  });
  if (a.how === "key") {
    if (!KEY_ITEM[a.agent]) return { error: `${name} doesn't take an API key here` };
    if (!a.key) return { error: "paste the API key" };
    if (claude) return add({ ...c.providers, [label]: { kind: "claude", auth: "key" } });
    // another CLI's config can't tell its key from its sign-in: the key is paid per use, so it's written down
    const added = add(c.providers);
    return { ...added, accounts: { ...added.accounts, billing: { ...c.billing, [label]: "pay-per-use" } } };
  }
  if (!LOGIN_CLIS.includes(a.agent)) return { error: `${name} has no sign-in of its own: add it with an API key` };
  if (a.how === "existing") {
    if (shared) return { error: `${shared} already uses the ${name} sign-in on this computer` };
    if (!claude) return add(c.providers);
    if (opts.existing === null) return { error: "Claude Code isn't signed in on this computer" };
    return add({ ...c.providers, [label]: { kind: "claude", auth: "login", existing: opts.existing } });
  }
  // its own sign-in: in a folder of its own where the CLI's login can live there, else this computer's (one per computer)
  if (claude) return add({ ...c.providers, [label]: { kind: "claude", auth: "login" } });
  if (own) return add(c.providers, { ...runtimes, [label]: { kind: a.agent, model: "", ownLogin: true } });
  if (shared) return { error: `${name} keeps one sign-in per computer, and ${shared} uses it: add this account with an API key` };
  return add(c.providers);
}
