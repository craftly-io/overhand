import { expect, test } from "bun:test";
import type { Lead } from "@overhand/contract";
import { state } from "@overhand/contract/fixtures/state";
import { plainWords } from "@overhand/themes";
import { LEAD_WORDS, placeName, previewRows, prFor, refList, suggestions, worktreeFallback } from "./leads";

const pr = (number: number, review: string, checks = "SUCCESS") => ({
  client: "Honeycrust",
  repo: "web",
  number,
  title: `PR ${number}`,
  url: `u${number}`,
  draft: false,
  review,
  checks,
  updated: "",
});
const lead = (key: string, watch?: Lead["watch"]): Lead => ({
  key,
  label: key,
  name: "",
  project: "Honeycrust",
  supervised: true,
  onDemand: true,
  watch,
  running: false,
  mine: false,
  since: 0,
  stopped: false,
  reason: "",
  waiting: false,
  waitingLimit: false,
  cantStart: null,
  nextAt: 0,
  account: "",
  inbox: null,
  open: false,
  ask: null,
});
const signals = {
  at: 0,
  myPrs: [pr(4, "CHANGES_REQUESTED"), pr(5, "CHANGES_REQUESTED"), pr(6, "", "FAILURE")],
  reviews: [],
  ci: [],
  deploys: [],
  sentry: "Sentry isn't connected",
  calendar: [],
  errors: [],
};

test("a project is offered only the leads it has work for, most work first, with the counts that would wake them", () => {
  const s = state({ status: signals, tickets: { Honeycrust: [] } });
  const got = suggestions(s);
  expect(got.map((x) => [x.kind, x.items.length, x.needs ?? ""])).toEqual([
    ["reviews", 2, ""],
    ["ci", 1, ""],
    // no tickets armed: no backlog lead; Sentry not connected: the errors lead asks for it, last
    ["errors", 0, "sentry"],
  ]);
  expect(refList(got[0]?.items ?? [])).toBe("web#4 and web#5");
});

test("a kind a lead already watches isn't offered again, and a lead watching everything covers every kind", () => {
  expect(suggestions(state({ status: signals, godmode: [lead("honeycrust-reviews", ["reviews"])] })).map((x) => x.kind)).toEqual([
    "ci",
    "errors",
  ]);
  expect(suggestions(state({ status: signals, godmode: [lead("honeycrust-lead")] }))).toEqual([]);
});

test("Keep dependencies safe is offered only with open advisories, and its preview names each one", () => {
  const advisory = (n: number, pkg: string) => ({
    client: "Honeycrust",
    repo: "web",
    number: n,
    package: pkg,
    ecosystem: "npm",
    severity: "high",
    summary: "bad",
    fix: "2.0.0",
    url: `a${n}`,
  });
  const kinds = (advisories?: ReturnType<typeof advisory>[]) => suggestions(state({ status: { ...signals, advisories } }));
  // alerts off, unreadable or none open: never offered
  expect(kinds().some((x) => x.kind === "deps")).toBe(false);
  expect(kinds([]).some((x) => x.kind === "deps")).toBe(false);
  const deps = kinds([advisory(3, "axios"), advisory(4, "cookie")]).find((x) => x.kind === "deps");
  expect(deps?.items).toHaveLength(2);
  expect(plainWords[LEAD_WORDS.deps.why].replace("{n}", "2")).toBe("2 security advisories");
  const rows = new Map(previewRows({ kind: "deps", items: deps?.items ?? [] }, "act", "agent", plainWords));
  expect(rows.get(plainWords.leadPreviewNow)).toBe("Right now it would upgrade axios in web and cookie in web.");
});

test("every ready-made lead's count reads in both numbers", () => {
  for (const k of Object.values(LEAD_WORDS)) {
    expect(plainWords[k.why]).toContain("{n}");
    expect(plainWords[k.whyOne]).toMatch(/^1 /);
  }
});

test("the upkeep leads are offered only with their evidence, counted and named in a truthful preview", () => {
  const file = (path: string, n: number) => ({ client: "Honeycrust", repo: "web", path, n });
  const up = (pkg: string, update: "patch" | "minor" | "major") => ({
    client: "Honeycrust",
    repo: "web",
    manager: "bun",
    package: pkg,
    current: "1.0.0",
    next: update === "major" ? "2.0.0" : "1.1.0",
    update,
  });
  const offered = (extra: object) => suggestions(state({ status: { ...signals, ...extra } }));
  const kinds = (extra: object) => offered(extra).map((x) => x.kind);
  // no reading, an empty one, or only a major update: none of the three is offered
  for (const k of ["current", "untested", "todos"] as const) expect(kinds({})).not.toContain(k);
  expect(kinds({ outdated: [], untested: [], todos: [] })).toEqual(kinds({}));
  expect(kinds({ outdated: [up("next", "major")] })).not.toContain("current");
  const got = offered({
    outdated: [up("zod", "patch"), up("next", "major")],
    untested: [file("src/cart.ts", 9), file("src/pay.ts", 4)],
    todos: [file("src/a.ts", 3), file("src/b.ts", 2), file("src/c.ts", 1), file("src/d.ts", 1)],
  });
  const find = (k: string) => got.find((x) => x.kind === k);
  const why = (k: "current" | "untested" | "todos") => {
    const n = find(k)?.items.length ?? 0;
    return n === 1 ? plainWords[LEAD_WORDS[k].whyOne] : plainWords[LEAD_WORDS[k].why].replace("{n}", String(n));
  };
  // a major is listed for the owner, never counted as work
  expect(why("current")).toBe("1 dependency has a patch or minor update");
  expect(why("untested")).toBe("2 of the most-changed files have no test");
  expect(why("todos")).toBe("4 files have TODO notes");
  const rows = (k: "current" | "untested" | "todos", mode: "act" | "ship" = "act") =>
    new Map(previewRows({ kind: k, items: find(k)?.items ?? [] }, mode, "agent", plainWords));
  expect(rows("current").get(plainWords.leadPreviewNow)).toBe("Right now it would update zod in web.");
  expect(rows("untested").get(plainWords.leadPreviewNow)).toBe("Right now it would add tests for web/src/cart.ts and web/src/pay.ts.");
  expect(rows("todos").get(plainWords.leadPreviewNow)).toBe(
    "Right now it would clear the TODOs in web/src/a.ts, web/src/b.ts, web/src/c.ts and 1 more.",
  );
  // how often each wakes is its own; how far it goes is the project's mode, Ship included
  expect(rows("current").get(plainWords.leadPreviewWakes)).toBe(plainWords.leadWakesCurrent);
  expect(rows("todos").get(plainWords.leadPreviewWakes)).toBe(plainWords.leadWakesDaily);
  expect(rows("untested", "ship").get(plainWords.leadPreviewHowFar)).toBe(`${plainWords.autonomyShipName}. ${plainWords.autonomyShip}`);
});

test("a worktree's name: your rename, then its branch in words, then the ticket it names, then its place", () => {
  const s = state({
    names: { "work:Honeycrust/feat/x": "Night shift" },
    tickets: { Honeycrust: [{ key: "HONEY-8", title: "Gift card balance", status: "", priority: "", labels: [], url: "" }] },
  });
  expect(placeName(s, { project: "Honeycrust", branch: "feat/x", fallback: "Honeycrust" })).toBe("Night shift");
  expect(placeName(s, { project: "Honeycrust", branch: "HONEY-8", fallback: "Honeycrust" })).toBe("Gift card balance");
  expect(placeName(s, { project: "Honeycrust", branch: "main", fallback: "Honeycrust" })).toBe("Honeycrust");
  // a generated branch: the project's own words for the work (its PR title, its commits) name it, before its place
  const vocab = ["Show the gift card balance at checkout"];
  expect(placeName(s, { project: "Honeycrust", branch: "worktree-agent-a1b2c3d4", vocab, fallback: "detached" })).toBe(
    "Show gift card balance",
  );
});

test("a preview says what the lead does at the project's mode: on Ship its PRs merge once CI is green, on watch it only reports", () => {
  const x = { kind: "reviews" as const, items: suggestions(state({ status: signals }))[0]?.items ?? [] };
  const row = (mode: "watch" | "act" | "ship", k: string) => new Map(previewRows(x, mode, "agent", plainWords)).get(k) ?? "";
  // a lead's PRs go through the same Ship step as a ticket's: how far it goes is Ship's own line
  expect(row("ship", plainWords.leadPreviewHowFar)).toBe(`${plainWords.autonomyShipName}. ${plainWords.autonomyShip}`);
  expect(row("act", plainWords.leadPreviewHowFar)).toContain(plainWords.autonomyAct);
  expect(row("watch", plainWords.leadPreviewDoes)).toBe(
    "Reports what it finds in Needs you and changes nothing: no code, no PRs. This project is on Plan and warn only.",
  );
  expect(row("watch", plainWords.leadPreviewNow)).toBe("Right now it would look into web#4 and web#5 and report what it finds.");
  expect(row("act", plainWords.leadPreviewNow)).toBe("Right now it would answer the review on web#4 and web#5.");
});

test("a worktree without a branch name is named from its folder through the same filter, never a vendor or an id", () => {
  expect(worktreeFallback({ main: true, path: "~/Code/shop" }, plainWords)).toBe(plainWords.worktreeMain);
  expect(worktreeFallback({ main: false, path: "~/Code/shop/.claude/worktrees/claude-a1b2c3d4" }, plainWords)).toBe(
    plainWords.worktreeDetached,
  );
  expect(worktreeFallback({ main: false, path: "~/Code/shop-pricing-spike" }, plainWords)).toBe("Shop pricing spike");
});

test("a session's PR is the one opened from its branch in its own project", () => {
  const pr = (key: string) => ({ key, url: key, fixes: 0, branch: "fix-login", draft: false, corners: [], preview: "", reviewRound: 0 });
  const s = state({
    clients: [
      { name: "Honeycrust", prefix: "HONEY", host: "github", autonomy: "act", assignedAutonomy: "act" },
      { name: "Fernway", prefix: "FERN", host: "github", autonomy: "act", assignedAutonomy: "act" },
    ],
    prs: [pr("FERN-1"), pr("HONEY-2")],
  });
  expect(prFor(s, "Honeycrust", "fix-login")?.key).toBe("HONEY-2");
  expect(prFor(s, "Fernway", "fix-login")?.key).toBe("FERN-1");
  expect(prFor(s, "Honeycrust", "")).toBeUndefined();
});
