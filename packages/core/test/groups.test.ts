import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsFor } from "../src/claude";
import { blankConfig, type Config, loadConfig, type StoredClient, saveConfig } from "../src/config";
import { ruleHold } from "../src/control";
import {
  acceptGrouping,
  autonomyFor,
  effectiveClients,
  firewallDest,
  leadAccounts,
  leadPushBranches,
  moveProject,
  ruleSource,
  setGroupRules,
  windowsFor,
} from "../src/groups";
import { pushBranchesOf } from "../src/guard";
import { scanOutward } from "../src/outward";
import { routeOrder } from "../src/routing";

const scratch = () => mkdtempSync(join(tmpdir(), "overhand-groups-"));

const project = (name: string, prefix: string, over: Partial<StoredClient> = {}): StoredClient => ({
  name,
  dir: name.toLowerCase(),
  prefix,
  host: "github",
  tracker: { kind: "github", repo: `org/${name.toLowerCase()}` },
  aliases: [],
  status: { vercelSecrets: [], sentrySecrets: [] },
  ...over,
});

const base = (clients: StoredClient[], over: Partial<Config> = {}): Config => ({
  ...blankConfig("alex"),
  accounts: ["main", "work"],
  clients,
  ...over,
});

const eff = (c: Config, name: string) => effectiveClients(c).find((x) => x.name === name);

// ---------- resolution ----------

test("no groups: every project resolves exactly as before groups (its own value, else the old default)", () => {
  const c = base([project("Acme", "ACME", { autonomy: "watch", accounts: ["work"] }), project("Kite", "KITE")]);
  expect(eff(c, "Acme")).toMatchObject({ autonomy: "watch", assignedAutonomy: "act", accounts: ["work"], fallbackToAll: true });
  expect(eff(c, "Kite")).toMatchObject({ autonomy: "act", assignedAutonomy: "act", accounts: [], fallbackToAll: true });
});

test("a member inherits every rule its group sets, and overrides any it sets itself", () => {
  const c = base([project("Web", "WEB"), project("Api", "API", { autonomy: "act", accounts: ["main"] })], {
    groups: [
      {
        name: "Acme",
        members: ["Web", "Api"],
        rules: { autonomy: "propose", assignedAutonomy: "propose", accounts: ["work"], fallbackToAll: false },
      },
    ],
  });
  expect(eff(c, "Web")).toMatchObject({ autonomy: "propose", assignedAutonomy: "propose", accounts: ["work"], fallbackToAll: false });
  expect(eff(c, "Api")).toMatchObject({ autonomy: "act", assignedAutonomy: "propose", accounts: ["main"], fallbackToAll: false });
  expect(ruleSource(c, "Web", "autonomy")).toBe("group");
  expect(ruleSource(c, "Api", "autonomy")).toBe("own");
  expect(ruleSource(c, "Api", "fallbackToAll")).toBe("group");
  expect(ruleSource(base([project("Solo", "SOLO")]), "Solo", "autonomy")).toBe("default");
});

test("private words add up: the group's and the member's", () => {
  const c = base([project("Web", "WEB", { private: ["Bluefin"] }), project("Api", "API")], {
    groups: [{ name: "Acme", members: ["Web", "Api"], rules: { private: ["Orca"] } }],
  });
  expect(eff(c, "Web")?.private).toEqual(["Orca", "Bluefin"]);
  expect(eff(c, "Api")?.private).toEqual(["Orca"]);
});

// ---------- every reader that matters ----------

test("routing: a run's accounts come from the group unless the project sets its own", () => {
  const c = base([project("Web", "WEB"), project("Api", "API", { accounts: ["main"] })], {
    groups: [{ name: "Acme", members: ["Web", "Api"], rules: { accounts: ["work"] } }],
  });
  const web = eff(c, "Web");
  const api = eff(c, "Api");
  if (!web || !api) throw new Error("projects resolve");
  expect(accountsFor(c.accounts, web.accounts, web.fallbackToAll, 0, null)).toEqual(["work"]);
  expect(accountsFor(c.accounts, api.accounts, api.fallbackToAll, 0, null)).toEqual(["main"]);
  // a group on watch keeps today's order even with routing on auto
  const watch = effectiveClients(setGroupRules(c, "Acme", { autonomy: "watch" })).find((x) => x.name === "Web");
  const identity = (a: string) => ({ combo: a, pool: a });
  expect(
    routeOrder({ mode: "auto", autonomy: watch?.autonomy ?? "act", today: ["work"], allowed: c.accounts, identity, rows: [] }),
  ).toEqual(["work"]);
});

test("guard: a lead pushes to its group's branches unless it lists its own", () => {
  const groups: Config["groups"] = [{ name: "Acme", members: ["Web"], rules: { pushBranches: ["develop"] } }];
  const godmode = [
    { key: "web", project: "Web" },
    { key: "acme", project: "Acme" },
    { key: "own", project: "Web", pushBranches: ["main"] },
    { key: "none", project: "Web", pushBranches: [] },
    { key: "loose", project: "Kite" },
  ];
  expect(leadPushBranches({ groups, godmode }, "web")).toEqual(["develop"]);
  expect(leadPushBranches({ groups, godmode }, "acme")).toEqual(["develop"]);
  expect(leadPushBranches({ groups, godmode }, "own")).toEqual(["main"]);
  expect(leadPushBranches({ groups, godmode }, "none")).toEqual([]);
  expect(leadPushBranches({ groups, godmode }, "loose")).toEqual([]);
  // and the hook reads it fresh from the file
  const file = join(scratch(), "overhand.config.json");
  writeFileSync(file, JSON.stringify({ groups, godmode }));
  expect(pushBranchesOf("lead-web", file)).toEqual(["develop"]);
  expect(pushBranchesOf("lead-own", file)).toEqual(["main"]);
  expect(pushBranchesOf("ticket-1", file)).toEqual([]);
});

test("governor: a group's quiet window holds heavy jobs in its projects only", () => {
  const c = base([project("Web", "WEB"), project("Kite", "KITE")], {
    groups: [{ name: "Acme", members: ["Web"], rules: { windows: [{ from: "09:00", to: "17:00", kinds: ["browser"] }] } }],
  });
  const noon = new Date(2026, 9, 21, 12, 0).getTime();
  const ops = scratch();
  const held = (p: string) =>
    ruleHold("browser", { ...c.control, windows: windowsFor(c, p) }, { ops, project: p, session: "s", now: noon });
  expect(held("Web")).toMatch(/hold browser jobs until 17:00/);
  expect(held("Kite")).toBeNull();
  expect(held("")).toBeNull();
  expect(windowsFor(c, "Web")).toHaveLength(1);
});

test("firewall: a group's private words are held outside it, and its members may name each other", () => {
  const c = base(
    [project("Web", "WEB", { aliases: ["acme-web"] }), project("Api", "API", { aliases: ["acme-api"] }), project("Kite", "KITE")],
    { groups: [{ name: "Acme", members: ["Web", "Api"], rules: { private: ["Orca"] } }] },
  );
  expect(firewallDest(c, ["Web"]).sort()).toEqual(["Api", "Web"]);
  expect(scanOutward("ported from acme-api, codename Orca", ["Web"], c)).toEqual([]);
  expect(scanOutward("ported from acme-api, codename Orca", ["Kite"], c).map((h) => h.term)).toEqual(["acme-api", "Orca"]);
  // without groups, the same text to a sibling project is held as before
  expect(scanOutward("ported from acme-api", ["Web"], { ...c, groups: [] }).map((h) => h.term)).toEqual(["acme-api"]);
});

test("leads: a group lead runs at the group's level, else the most careful member's; accounts from the group", () => {
  const c = base([project("Web", "WEB", { autonomy: "watch" }), project("Api", "API", { autonomy: "act" })], {
    groups: [{ name: "Acme", members: ["Web", "Api"], rules: { accounts: ["work"] } }],
  });
  expect(autonomyFor(c, "Acme")).toBe("watch");
  expect(autonomyFor(c, "Api")).toBe("act");
  expect(autonomyFor(c, "Nobody")).toBe("act");
  expect(autonomyFor(setGroupRules(c, "Acme", { autonomy: "propose" }), "Acme")).toBe("propose");
  expect(leadAccounts(c, { account: "", project: "Acme" })).toEqual(["work"]);
  expect(leadAccounts(c, { account: "", project: "Web" })).toEqual(["work"]);
  expect(leadAccounts(c, { account: "main", project: "Web" })).toEqual(["main"]);
  expect(leadAccounts(c, { account: "", project: "Kite" })).toEqual([]);
  // a lead's own list, in order, wins over its one account and its group's
  expect(leadAccounts(c, { account: "main", accounts: ["a", "b"], project: "Web" })).toEqual(["a", "b"]);
});

// ---------- changing groups without changing behaviour ----------

test("accepting a grouping lifts shared rules into the group and changes no project's effective rules", () => {
  // as an existing config reads: every project carries the defaults it was saved with
  const saved: Partial<StoredClient> = { autonomy: "act", assignedAutonomy: "act", accounts: [], fallbackToAll: true };
  const c = base([
    project("Web", "WEB", { ...saved, accounts: ["work"] }),
    project("Api", "API", { ...saved, accounts: ["work"], autonomy: "propose" }),
    project("Kite", "KITE", saved),
  ]);
  const before = effectiveClients(c);
  const next = acceptGrouping(c, [{ name: "Acme", members: ["Web", "Api", "Ghost"] }]);
  expect(effectiveClients(next)).toEqual(before);
  expect(next.groups).toEqual([
    { name: "Acme", members: ["Web", "Api"], rules: { assignedAutonomy: "act", accounts: ["work"], fallbackToAll: true } },
  ]);
  expect(next.clients.find((x) => x.name === "Web")).not.toHaveProperty("accounts");
  expect(next.clients.find((x) => x.name === "Api")?.autonomy).toBe("propose");
  // again: nothing more changes
  expect(acceptGrouping(next, [{ name: "Acme", members: ["Web", "Api"] }])).toEqual(next);
});

test("joining a group that already sets rules pins the joiner's own, so nothing it does changes", () => {
  const c = base([project("Web", "WEB"), project("Kite", "KITE")], {
    groups: [{ name: "Acme", members: ["Web"], rules: { autonomy: "watch" } }],
  });
  const next = acceptGrouping(c, [{ name: "Acme", members: ["Kite"] }]);
  expect(eff(next, "Kite")?.autonomy).toBe("act");
  expect(next.clients.find((x) => x.name === "Kite")?.autonomy).toBe("act");
});

test("moving a project: it follows its new group's rules, or keeps its own with pin; empty groups go", () => {
  const c = base([project("Web", "WEB"), project("Kite", "KITE")], {
    groups: [
      { name: "Acme", members: ["Web"], rules: { autonomy: "watch" } },
      { name: "Side", members: ["Kite"], rules: {} },
    ],
  });
  const moved = moveProject(c, "Kite", "Acme");
  expect(eff(moved, "Kite")?.autonomy).toBe("watch");
  expect(moved.groups.map((g) => g.name)).toEqual(["Acme"]);
  expect(eff(moveProject(c, "Kite", "Acme", true), "Kite")?.autonomy).toBe("act");
  expect(eff(moveProject(c, "Web", ""), "Web")?.autonomy).toBe("act");
  expect(moveProject(c, "Web", "New").groups.find((g) => g.name === "New")?.members).toEqual(["Web"]);
  expect(() => moveProject(c, "Ghost", "Acme")).toThrow(/no project/);
});

test("group rules: members that override keep it, unless reset", () => {
  const c = base([project("Web", "WEB"), project("Api", "API", { autonomy: "act" })], {
    groups: [{ name: "Acme", members: ["Web", "Api"], rules: {} }],
  });
  const set = setGroupRules(c, "Acme", { autonomy: "propose" });
  expect(eff(set, "Web")?.autonomy).toBe("propose");
  expect(eff(set, "Api")?.autonomy).toBe("act");
  expect(eff(setGroupRules(c, "Acme", { autonomy: "propose" }, true), "Api")?.autonomy).toBe("propose");
  expect(setGroupRules(set, "Acme", { autonomy: undefined }).groups[0]?.rules).toEqual({});
  expect(() => setGroupRules(c, "Nope", {})).toThrow(/no group/);
});

// ---------- the config file ----------

test("the config accepts groups, checks them, and keeps an older config's meaning", () => {
  const dir = scratch();
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "overhand.config.example.json"), "utf8"));
  const old = saveConfig(dir, raw);
  expect(old.groups).toEqual([]);
  expect(effectiveClients(old).map((c) => c.autonomy)).toEqual(["act", "act"]);
  const withGroup = { ...raw, groups: [{ name: "Clients", members: ["Honeycrust", "Fernway"], rules: { autonomy: "propose" } }] };
  const saved = saveConfig(dir, withGroup);
  expect(loadConfig(dir).groups[0]?.rules).toEqual({ autonomy: "propose" });
  expect(effectiveClients(saved).map((c) => c.autonomy)).toEqual(["propose", "propose"]);
  // a lead may name a group
  expect(() =>
    saveConfig(dir, { ...withGroup, godmode: [{ key: "clients", label: "Clients", dir: "x", project: "Clients" }] }),
  ).not.toThrow();
  expect(() => saveConfig(dir, { ...raw, groups: [{ name: "A", members: ["Ghost"] }] })).toThrow(/unknown project Ghost/);
  expect(() =>
    saveConfig(dir, {
      ...raw,
      groups: [
        { name: "A", members: ["Fernway"] },
        { name: "B", members: ["Fernway"] },
      ],
    }),
  ).toThrow(/in two groups/);
  expect(() => saveConfig(dir, { ...raw, groups: [{ name: "A", members: [], rules: { accounts: ["nobody"] } }] })).toThrow(
    /unknown accounts/,
  );
});
