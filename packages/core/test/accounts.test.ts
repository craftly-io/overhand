import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddAccount, accountLabel, addAccount, budgetAfterAdd, onSharedLogin, scopeAccount } from "../src/accounts";
import { accountLoginCommand, ownSignInHome, runHome } from "../src/agent-home";
import { blankConfig, type Config, FIRST_DAY_BUDGET_USD, parseConfig, saveConfig } from "../src/config";
import { RUNTIMES } from "../src/runtimes";
import type { RunInput } from "../src/runtimes/runtime";

type Opts = { existing: string | null; hasKey: (item: string) => boolean };
const noKeys: Opts = { existing: null, hasKey: () => false };
const req = (over: Partial<AddAccount>): AddAccount => ({ agent: "claude-code", label: "", how: "login", key: "", ...over });

/** Adds an account and saves the result to a fixture folder, so the config schema checks it too. */
function added(c: Config, a: AddAccount, opts: Opts = noKeys): { c: Config; label: string } {
  const r = addAccount(c, a, opts);
  if ("error" in r) throw new Error(r.error);
  return { c: saveConfig(mkdtempSync(join(tmpdir(), "accounts-")), { ...c, ...r.accounts }), label: r.label };
}
const error = (c: Config, a: AddAccount, opts: Opts = noKeys): string => {
  const r = addAccount(c, a, opts);
  return "error" in r ? r.error : "";
};

const base = (): Config => saveConfig(mkdtempSync(join(tmpdir(), "accounts-")), { ...blankConfig("me"), accounts: ["main"] });

test("a new account's label is its agent's short name, numbered when taken", () => {
  expect(accountLabel("claude-code", ["main"])).toBe("claude");
  expect(accountLabel("codex", ["codex", "codex-2"])).toBe("codex-3");
});

test("each Claude Code account signs in in a folder of its own, and the sign-in already here is used as is once", () => {
  const one = added(base(), req({}));
  expect(one.label).toBe("claude");
  expect(one.c.accounts).toEqual(["main", "claude"]); // last: it takes work once the ones before it are busy
  expect(ownSignInHome("claude", one.c, "/h")).toBe("/h/accounts/claude");
  expect(accountLoginCommand("claude", one.c, "/h")).toBe("CLAUDE_CONFIG_DIR='/h/accounts/claude' claude auth login");
  const mine = added(one.c, req({ how: "existing", label: "personal" }), { existing: "", hasKey: () => false });
  expect(mine.c.providers.personal).toEqual({ kind: "claude", auth: "login", existing: "" });
  // it signs in once in a folder of its own; its runs stay on your config until then (runHome)
  expect(accountLoginCommand("personal", mine.c, "/h")).toBe("CLAUDE_CONFIG_DIR='/h/accounts/personal' claude auth login");
  expect(runHome("personal", mine.c, "/h")).toBe("");
  expect(error(mine.c, req({ how: "existing" }), { existing: "", hasKey: () => false })).toContain("personal already uses");
  expect(error(base(), req({ how: "existing" }))).toContain("isn't signed in");
  expect(error(mine.c, req({ label: "personal" }))).toContain("already an account personal");
});

test("Codex accounts each keep their own login in CODEX_HOME; runs get the folder, the computer's login keeps none", () => {
  const first = added(base(), req({ agent: "codex", how: "existing" }));
  expect(first.c.runtimes.codex).toEqual({ kind: "codex", model: "" });
  // it signs in again in the account's own folder; until then its runs stay on ~/.codex (runHome "")
  expect(accountLoginCommand("codex", first.c, "/h")).toBe("CODEX_HOME='/h/accounts/codex' codex login");
  expect(runHome("codex", first.c, "/h")).toBe("");
  expect(onSharedLogin(first.c, "codex", () => false)).toBe("codex");
  expect(error(first.c, req({ agent: "codex", how: "existing" }))).toContain("codex already uses the Codex sign-in");
  const second = added(first.c, req({ agent: "codex", how: "login" }));
  expect(second.label).toBe("codex-2");
  expect(second.c.runtimes["codex-2"]).toEqual({ kind: "codex", model: "", ownLogin: true });
  expect(accountLoginCommand("codex-2", second.c, "/h")).toBe("CODEX_HOME='/h/accounts/codex-2' codex login");
  const run = (configDir: string) =>
    RUNTIMES.codex.task({
      account: "codex-2",
      cwd: "",
      prompt: "Fix it",
      schema: "",
      schemaFile: "/tmp/s.json",
      alias: "",
      provider: { kind: "claude", auth: "login" },
      model: "",
      attribution: false,
      args: [],
      configDir,
      instructions: "",
      read: () => null,
    } satisfies RunInput).env;
  expect(run("/h/accounts/codex-2").CODEX_HOME).toBe("/h/accounts/codex-2");
  expect(run("").CODEX_HOME).toBe(process.env.CODEX_HOME);
});

test("a CLI with one login per computer takes a second account only with a key; key-only CLIs never offer a login", () => {
  const cursor = added(base(), req({ agent: "cursor" }));
  expect(accountLoginCommand("cursor", cursor.c, "/h")).toBe("cursor-agent login");
  expect(error(cursor.c, req({ agent: "cursor" }))).toContain("one sign-in per computer, and cursor uses it");
  expect(error(cursor.c, req({ agent: "cursor", how: "key" }))).toBe("paste the API key");
  const keyed = added(cursor.c, req({ agent: "cursor", how: "key", key: "k" }));
  expect(keyed.label).toBe("cursor-2");
  // its config can't tell a key from a sign-in, so the key's billing is written down: paid per use; the login's isn't
  expect(keyed.c.billing).toEqual({ "cursor-2": "pay-per-use" });
  // a key account doesn't hold the computer's login
  expect(onSharedLogin(keyed.c, "cursor", (item) => item === "cursor-key-cursor-2")).toBe("cursor");
  expect(error(base(), req({ agent: "gemini" }))).toContain("no sign-in of its own");
  expect(error(base(), req({ agent: "opencode", how: "key", key: "k" }))).toContain("doesn't take an API key");
  expect(added(base(), req({ how: "key", key: "sk" })).c.providers.claude).toEqual({ kind: "claude", auth: "key" });
});

test("the first billed account added to an install with no cap brings the first-day budget; a chosen cap stays", () => {
  expect(budgetAfterAdd(0, false, true)).toBe(FIRST_DAY_BUDGET_USD);
  expect(budgetAfterAdd(0, true, true)).toBe(0); // billed accounts already ran without a cap: that was a choice
  expect(budgetAfterAdd(0, false, false)).toBe(0); // a sign-in isn't known to be billed here
  expect(budgetAfterAdd(25, false, true)).toBe(25);
});

test("setting an account up for a client keeps those projects on it alone and limits its MCP servers", () => {
  const c = parseConfig(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "overhand.config.example.json"), "utf8")));
  const [first, second] = c.clients;
  const account = c.accounts[0] ?? "";
  if (!first || !second) throw new Error("the example config needs two projects");
  const r = scopeAccount(c, { account, projects: [first.name], servers: ["linear"] });
  if ("error" in r) throw new Error(r.error);
  expect(r.clients.find((x) => x.name === first.name)).toMatchObject({ accounts: [account], fallbackToAll: false });
  expect(r.clients.find((x) => x.name === second.name)?.accounts).toEqual(second.accounts); // the others are left as they were
  expect(r.runtimes[account]?.mcpServers).toEqual(["linear"]);
  expect(scopeAccount(c, { account, projects: [], servers: [] })).toMatchObject({ runtimes: { [account]: { mcpServers: undefined } } });
  expect(scopeAccount(c, { account: "nope", projects: [], servers: [] })).toEqual({ error: "no agent account named nope" });
  expect(scopeAccount(c, { account, projects: ["ghost"], servers: [] })).toEqual({ error: "no project named ghost" });
});
