/**
 * What `bun run setup` (setup-cli.ts) runs. First run: it asks a few questions and writes overhand.config.json, then checks everything ops needs.
 * With a config already present it only runs the checks (`bun run setup` again any time something breaks).
 */
import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { updateSecret } from "@overhand/contract";
import { accountLoginCommand, claudeLoginCommand, ownSignInHome } from "./agent-home";
import { type Config, ConfigError, FIRST_DAY_BUDGET_USD, loadConfig } from "./config";
import { OPS } from "./env";
import { subscriptionTokensAllowed } from "./legacy-token";
import { PLATFORM_TOOLS, readSecret, SECRET_STORE, secretCommand } from "./platform";
import { RUNTIMES, versionOf } from "./runtimes";
import { claudeSignedIn } from "./runtimes/claude-code";

const CODE = dirname(OPS);
const FILE = join(OPS, "overhand.config.json");

function ask(q: string, fallback = ""): string {
  const a = prompt(fallback ? `${q} [${fallback}]` : q)?.trim();
  return a || fallback;
}

function interview(): void {
  console.log("No overhand.config.json yet. A few questions; Enter takes the default in brackets.\n");
  const name = ask("Your first name (agents address you by it)", userInfo().username);
  const accounts = ask("Account labels, comma-separated (each is one agent sign-in or key)", "main")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const clients: Record<string, unknown>[] = [];
  do {
    const cname = ask("\nClient or project name (e.g. Honeycrust)");
    if (!cname) break;
    const dir = ask(`Folder under ${CODE}`, cname.toLowerCase());
    const prefix = ask("Ticket key prefix (e.g. HONEY for HONEY-123)").toUpperCase();
    const host = ask("Git host: github or bitbucket", "github");
    const kind = ask("Tracker: linear or jira", "linear");
    const tracker =
      kind === "jira"
        ? {
            kind,
            secret: `overhand-jira-${prefix.toLowerCase()}`,
            site: ask("Jira site (e.g. honeycrust.atlassian.net)"),
            email: ask("Your Jira email"),
            project: ask("Jira project key", prefix),
          }
        : { kind, secret: `overhand-linear-${prefix.toLowerCase()}` };
    // a new project starts careful: agents open draft PRs and a person marks them ready
    clients.push({ name: cname, dir, prefix, host, tracker, aliases: [cname.toLowerCase()], autonomy: "propose" });
  } while (ask("Add another client? y/n", "n").toLowerCase().startsWith("y"));
  // its accounts sign in to Claude Code, which may be a plan or a per-use Console login: until the sign-in says which,
  // they count as billed, so a new install starts with the first-day budget (it never holds an account known to be a plan)
  const config = {
    owner: { name, keychainAccount: userInfo().username },
    accounts,
    clients,
    limits: { dailyBudgetUsd: FIRST_DAY_BUDGET_USD },
  };
  writeFileSync(FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nWrote ${FILE}. Edit it for Slack, godmode sessions and per-client accounts.\n`);
}

interface Check {
  ok: boolean;
  what: string;
  fix: string;
  /** Keychain item the dashboard can store when this check fails. */
  secret?: string;
  /** Status sources only: missing means that source is skipped, nothing breaks. */
  optional?: boolean;
}

/** Every Keychain item the config refers to. */
export function secretsOf(c: Config): string[] {
  return [
    ...new Set([
      // a Linear or Jira project without a token reads through Overhand's MCP sign-in instead
      ...c.clients.flatMap((x) => (x.tracker && "secret" in x.tracker && x.tracker.secret ? [x.tracker.secret] : [])),
      ...(c.bitbucket ? [c.bitbucket.secret] : []),
      ...c.clients.flatMap((x) => [
        ...(x.status.jenkins ? [x.status.jenkins.secret] : []),
        ...x.status.vercelSecrets,
        ...x.status.sentrySecrets,
      ]),
      ...c.status.vercelSecrets,
      ...c.status.sentrySecrets,
      ...(c.status.icalSecret ? [c.status.icalSecret] : []),
      ...(c.ntfySecret ? [c.ntfySecret] : []),
      ...c.updates.map((u) => updateSecret(u.id)),
      // a Claude account on an API key needs it stored; on its own sign-in, nothing (Claude Code keeps that login). Bedrock
      // and Vertex use the cloud's own login, a gateway its token if it names one
      ...c.accounts.flatMap((a) => {
        const p = c.providers[a] ?? { kind: "claude", auth: "login" };
        const claudeCode = (c.runtimes[a]?.kind ?? "claude-code") === "claude-code";
        if (p.kind === "claude" && claudeCode && p.auth === "key") return [`anthropic-key-${a}`];
        // ponytail: the legacy token opt-in only (legacy-token.ts); goes with it
        if (p.kind === "claude" && claudeCode && subscriptionTokensAllowed()) return [`claude-token-${a}`];
        return p.kind === "gateway" && p.secret ? [p.secret] : [];
      }),
      ...keyedRuntimes(c),
    ]),
  ];
}

/** Optional API keys for CLIs that otherwise use their own login (codex-key-<account>, gemini-key-..., cursor-key-...). */
const keyedRuntimes = (c: Config): string[] =>
  Object.entries(c.runtimes).flatMap(([a, r]) => (["codex", "gemini", "cursor"].includes(r.kind) ? [`${r.kind}-key-${a}`] : []));

/** Whether a gateway answers at all: any HTTP response counts, only no answer within 5 s fails. */
export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/** The GitHub account `gh` is signed in as, from `gh auth status`; "" when it isn't signed in (or isn't installed). */
export function ghAccount(): string {
  try {
    const r = Bun.spawnSync(["gh", "auth", "status", "--hostname", "github.com"], { env: process.env, timeout: 15_000 });
    return r.exitCode === 0 ? ghAccountIn(`${r.stdout}\n${r.stderr}`) : "";
  } catch {
    return "";
  }
}

/** The account in `gh auth status` output: "Logged in to github.com account x" (or "as x" before gh 2.40). */
export const ghAccountIn = (out: string): string => out.match(/Logged in to \S+ (?:account|as) ([\w-]+)/)?.[1] ?? "";

/**
 * Whether a stored Anthropic API key has the shape of one (`sk-ant-api03-…`). A shape check, not a call: doctor runs
 * often and a model call costs time and tokens.
 */
export const looksLikeAnthropicKey = (v: string): boolean => /^sk-ant-api\d{2}-[\w-]{20,}$/.test(v.trim());

/** What ops needs on this machine for a config, each with how to fix it. */
export async function checks(c: Config, code = CODE): Promise<Check[]> {
  const out: Check[] = [];
  // only the agent CLIs the accounts run (an account without a runtime runs Claude Code); with no account yet, any one
  const kinds = new Set(c.accounts.map((a) => c.runtimes[a]?.kind ?? "claude-code"));
  if (!kinds.size) {
    const bins = Object.values(RUNTIMES).map((r) => r.bin);
    out.push({
      ok: bins.some((b) => Bun.which(b) !== null),
      what: "a coding agent on PATH",
      fix: `install one of: ${[...new Set(bins)].join(", ")}`,
    });
  }
  for (const bin of ["git", "gh"]) out.push({ ok: Bun.which(bin) !== null, what: `${bin} on PATH`, fix: `install ${bin}` });
  if (Bun.which("gh")) {
    const who = ghAccount();
    out.push({
      ok: who !== "",
      what: who ? `GitHub CLI signed in as ${who}` : "GitHub CLI signed in",
      fix: "gh auth login   (agents open pull requests and read issues through it)",
    });
  }
  for (const id of kinds) {
    const rt = RUNTIMES[id];
    const v = versionOf(rt);
    out.push({
      ok: v !== "",
      what: `${rt.label} (${rt.bin}) ${v || "on PATH"}`.trim(),
      fix: `install ${rt.label} and sign it in, or pick another agent for this account in Settings`,
    });
  }
  for (const t of PLATFORM_TOOLS) out.push({ ok: Bun.which(t.bin) !== null, what: `${t.bin} on PATH`, fix: t.fix });
  for (const x of c.clients) {
    out.push({
      ok: existsSync(join(code, x.dir)),
      what: `${x.name}: folder ${x.dir}`,
      fix: `mkdir -p ${join(code, x.dir)} and clone its repos there`,
    });
  }
  const acct = c.owner.keychainAccount;
  const optional = new Set([
    ...c.clients.flatMap((x) => [...x.status.vercelSecrets, ...x.status.sentrySecrets]),
    ...c.status.vercelSecrets,
    ...c.status.sentrySecrets,
    c.status.icalSecret,
    c.ntfySecret,
    ...keyedRuntimes(c),
  ]);
  // a Claude account on its own sign-in: Claude Code says whether it's signed in there; the credential is never read
  // (or on the one already on this computer); a Codex account with a login of its own: its auth.json there
  for (const a of c.accounts) {
    const kind = c.runtimes[a]?.kind ?? "claude-code";
    const home = ownSignInHome(a, c);
    if (kind === "codex" && home)
      out.push({
        ok: existsSync(join(home, "auth.json")),
        what: `Account ${a}: signed in to Codex`,
        fix: `${accountLoginCommand(a, c)}   (Codex's own sign-in, kept in that folder)`,
      });
    if (kind !== "claude-code" || !home) continue;
    out.push({
      ok: await claudeSignedIn(home),
      what: `Account ${a}: signed in to Claude Code`,
      fix: `${claudeLoginCommand(home)}   (Claude Code's own sign-in, kept in that folder)`,
    });
  }
  for (const s of secretsOf(c)) {
    const key = s.startsWith("anthropic-key-") ? s.slice(14) : "";
    const legacy = s.startsWith("claude-token-"); // ponytail: the local opt-in's token (legacy-token.ts)
    const update = c.updates.find((u) => updateSecret(u.id) === s);
    const value = key || legacy ? readSecret(s) : readSecret(s, acct);
    const malformed = key !== "" && value !== null && !looksLikeAnthropicKey(value);
    out.push({
      ok: value !== null && !malformed,
      what: key
        ? `Account ${key}: Anthropic API key${malformed ? " (the stored key doesn't look like an Anthropic API key, sk-ant-api…)" : ""}`
        : legacy
          ? `Account ${s.slice(13)}: stored Claude token (local opt-in)`
          : update
            ? `Status update ${update.name}: webhook URL in ${SECRET_STORE}`
            : `${SECRET_STORE} ${s}`,
      fix: key
        ? `${secretCommand(s, acct)}   # paste an Anthropic API key from platform.claude.com`
        : `${secretCommand(s, acct)}   # paste the ${update ? "webhook URL" : "API token"}`,
      secret: s,
      optional: optional.has(s),
    });
  }
  for (const [a, p] of Object.entries(c.providers))
    if (p.kind === "gateway")
      out.push({
        ok: await answers(p.baseUrl),
        what: `Account ${a}: gateway ${p.baseUrl}`,
        fix: "nothing answers there: start the gateway or fix its URL",
      });
  for (const g of c.godmode)
    out.push({ ok: existsSync(join(code, g.dir)), what: `lead ${g.key}: ${g.dir}`, fix: "fix its folder in Settings" });
  return out;
}

/**
 * How to start the daemon: `start` installs the same login service as the installed binary (launchd or systemd, one
 * name), so `stop` and `uninstall` stop it too; `daemon` runs it in this terminal.
 */
const startHint = (): string =>
  "Start it at every login: bun run.ts start  (Overhand on http://127.0.0.1:4317; bun run.ts daemon runs it in this terminal)";

/** Interviews when there is no config yet, then prints every check and exits 1 when something must be fixed. */
export async function runSetup(): Promise<void> {
  if (!existsSync(FILE)) interview();
  try {
    const list = await checks(loadConfig(OPS));
    for (const x of list)
      console.log(`${x.ok ? "✓" : x.optional ? "–" : "✗"} ${x.what}${x.ok ? "" : x.optional ? " (optional, skipped)" : `\n    ${x.fix}`}`);
    const missing = list.filter((x) => !x.ok && !x.optional).length;
    console.log(missing ? `\n${missing} thing(s) to fix, then run bun run setup again.` : `\nAll set. ${startHint()}`);
    process.exit(missing ? 1 : 0);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
