import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Finding, projectTerms, type Summary, seededTerms, type TeamSend, termHits, UpdateChannelSchema } from "@overhand/contract";
import { openPr } from "../src/agent";
import { findingId, loadFindings } from "../src/assign";
import type { Client } from "../src/config";
import { CFG, CLIENTS, OPS } from "../src/env";
import { outwardBlock, outwardOf } from "../src/guard";
import { allowOnce, cleared, type FirewallConfig, HeldError, maskSecrets, scanOutward, secretHits } from "../src/outward";
import { releaseLeak } from "../src/outward-release";
import { teamCleared } from "../src/team";
import { comment, createTicket } from "../src/trackers/index";
import type { Ticket } from "../src/trackers/types";
import { sendUpdate } from "../src/updates";
import { scratchWorktree } from "./fixtures/scratch-git";

afterAll(() => {
  for (const f of ["findings.json", "outward-allow.json", "updates.json"]) rmSync(join(OPS, f), { force: true });
});

// a GitHub-shaped token built at runtime, so no secret scanner flags this file
const TOKEN = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

const client = (name: string, prefix: string, over: Partial<Client> = {}): Client => ({
  name,
  dir: name.toLowerCase(),
  prefix,
  host: "github",
  tracker: { kind: "github", repo: `org/${name.toLowerCase()}` },
  aliases: [],
  accounts: [],
  fallbackToAll: true,
  autonomy: "act",
  assignedAutonomy: "act",
  status: { vercelSecrets: [], sentrySecrets: [] },
  ...over,
});

const cfg = (clients: Client[], deny: string[] = []): FirewallConfig => ({ clients, outward: { ...CFG.outward, deny } });
const TWO = cfg([client("Honeycrust", "HONEY", { aliases: ["honeycrust-inc"] }), client("Fernway", "FERN")]);
const held = (title: string): Finding | undefined => loadFindings().find((f) => f.title === title);

// ---------- what matches ----------

test("another project's name, alias or ticket key may not go to this project; its own may", () => {
  const hits = scanOutward("Same fix as Fernway's checkout, see FERN-12", ["Honeycrust"], TWO);
  expect(hits.map((h) => [h.term, h.why, h.project])).toEqual([
    ["Fernway", "project", "Fernway"],
    ["FERN-12", "project", "Fernway"],
  ]);
  expect(scanOutward("Same fix as Fernway's checkout, see FERN-12", ["Fernway"], TWO)).toEqual([]);
  expect(scanOutward("ported from honeycrust-inc/web", ["Fernway"], TWO).map((h) => h.term)).toEqual(["honeycrust-inc"]);
  // the spans point at the words, so the dashboard can mark them
  const text = "ask the Honeycrust team";
  const [h] = scanOutward(text, ["Fernway"], TWO);
  expect(text.slice(h?.start, h?.end)).toBe("Honeycrust");
});

test("false positives: common words, parts of words, a prefix without a number, other casing of a key", () => {
  const c = cfg([client("Core", "CORE"), client("Web", "WEB"), client("Fernway", "FERN")]);
  // a project named after a common word isn't blocked by that word...
  expect(scanOutward("Refactor the core web api and the main dashboard", ["Fernway"], c)).toEqual([]);
  expect(seededTerms({ name: "Core", prefix: "CORE" })).toEqual(["CORE-123"]);
  // ...but its ticket keys still are
  expect(scanOutward("Same as CORE-4", ["Fernway"], c).map((h) => h.term)).toEqual(["CORE-4"]);
  // whole words only
  expect(scanOutward("the Fernwayside depot, fernwaying", ["Honeycrust"], TWO)).toEqual([]);
  expect(scanOutward("FERN alone, FERN-x, XFERN-12, fern-12", ["Honeycrust"], TWO)).toEqual([]);
  // nothing to tell apart when the destination isn't a project
  expect(scanOutward("Fernway and Honeycrust", [], TWO)).toEqual([]);
});

test("a destination owns a word it shares: a longer name containing another project's isn't a leak", () => {
  const c = cfg([client("Acme", "ACME"), client("Acme Labs", "LABS")]);
  expect(scanOutward("Acme Labs release notes", ["Acme Labs"], c)).toEqual([]);
  expect(scanOutward("Acme Labs and plain Acme", ["Acme Labs"], c).map((h) => h.start)).toEqual([20]);
  // a shared alias belongs to both, so neither blocks it
  const shared = cfg([client("Acme", "ACME", { aliases: ["northstar"] }), client("Fernway", "FERN", { aliases: ["northstar"] })]);
  expect(scanOutward("northstar build", ["Fernway"], shared)).toEqual([]);
});

test("your private words: a project's own list, and the global deny-list everywhere", () => {
  const c = cfg(
    [client("Honeycrust", "HONEY", { private: ["Project Bluebird"] }), client("Fernway", "FERN")],
    ["jane@private.example", "db.internal.example"],
  );
  expect(scanOutward("ship Project Bluebird", ["Fernway"], c).map((h) => [h.term, h.why])).toEqual([["Project Bluebird", "private"]]);
  expect(scanOutward("ship Project Bluebird", ["Honeycrust"], c)).toEqual([]);
  expect(scanOutward("mail jane@private.example about db.internal.example", ["Honeycrust"], c).map((h) => h.term)).toEqual([
    "jane@private.example",
    "db.internal.example",
  ]);
  // the deny-list applies with no destination too
  expect(scanOutward("jane@private.example", [], c)).toHaveLength(1);
  expect(projectTerms({ name: "Honeycrust", prefix: "HONEY", private: [" ", ""] }).map((t) => t.term)).toEqual(["Honeycrust", "HONEY-"]);
});

test("secrets: token formats, named secrets and URL passwords; placeholders and variables aren't", () => {
  expect(secretHits(`use ${TOKEN} here`).map((h) => h.term)).toEqual([TOKEN]);
  expect(secretHits("API_TOKEN=hunter2hunter2 and postgres://app:s3cr3tpw@db/x").map((h) => h.term)).toEqual([
    "hunter2hunter2",
    "s3cr3tpw",
  ]);
  expect(secretHits("GITHUB_TOKEN=$GITHUB_TOKEN, API_KEY=<your-key>, AKIAXXXXXXXXXXXXEXAMPLE, token budget")).toEqual([]);
  const text = `deploy with ${TOKEN} to Fernway`;
  const m = maskSecrets(text, scanOutward(text, ["Honeycrust"], TWO));
  expect(m.text).toBe("deploy with [secret] to Fernway");
  expect(m.hits.map((h) => m.text.slice(h.start, h.end))).toEqual(["[secret]", "Fernway"]);
});

test("the contract's matcher alone: no deny-list, no destination, nothing", () => {
  expect(termHits("Fernway", [], TWO.clients)).toEqual([]);
});

// ---------- every outward path ----------

const ticket = (c: Client, key: string): Ticket => ({
  client: c,
  key,
  id: "1",
  title: "Checkout",
  url: "",
  status: "open",
  statusType: "started",
  priority: "",
  labels: [],
  description: "",
  comments: [],
});

test("tracker comments: a leak is held with its spans and the destination, never posted", async () => {
  const honey = CLIENTS.find((c) => c.name === "Honeycrust");
  if (!honey) throw new Error("the example config has Honeycrust");
  const tk = ticket(honey, "HONEY-901");
  expect(await comment(tk, `Same root cause as FERN-3 on Fernway, token ${TOKEN}`)).toBe(false);
  const f = held("HONEY-901: Checkout");
  expect(f?.leak?.kind).toBe("comment");
  expect(f?.leak?.dest).toBe("Honeycrust tracker, HONEY-901");
  expect(f?.leak?.payload).toEqual({ key: "HONEY-901" });
  // the secret is never stored, and every hit points at its span in what is
  expect(f?.text).not.toContain(TOKEN);
  expect(f?.leak?.hits.map((h) => f.text.slice(h.start, h.end))).toEqual(["FERN-3", "Fernway", "[secret]"]);
});

test("tracker tickets: a leak throws HeldError (the caller waits on a key) and is held", async () => {
  const fern = CLIENTS.find((c) => c.name === "Fernway");
  if (!fern) throw new Error("the example config has Fernway");
  const e = await createTicket(fern, "Port the Honeycrust fix", "as on HONEY-7", "agent").catch((x: unknown) => x);
  expect(e).toBeInstanceOf(HeldError);
  const f = held("New ticket: Port the Honeycrust fix");
  expect(f?.leak?.kind).toBe("ticket");
  expect(f?.leak?.payload).toEqual({ label: "agent" });
  expect(f?.text).toBe("Port the Honeycrust fix\n\nas on HONEY-7");
});

test("Overhand's own PR: a leaking title or body is held with what reopening it needs", async () => {
  const fern = CLIENTS.find((c) => c.name === "Fernway");
  if (!fern) throw new Error("the example config has Fernway");
  const wt = scratchWorktree("FERN-5-cart");
  const r = { status: "done" as const, pr_title: "Fix the cart", pr_body: "Copied from the honeycrust-inc repo", message: "" };
  expect(await openPr({ client: fern }, wt, r).catch((x: unknown) => x)).toBeInstanceOf(HeldError);
  const f = held("PR: Fix the cart");
  expect(f?.leak?.kind).toBe("pr");
  expect(f?.leak?.payload).toEqual({ host: "github", dir: wt.mainRepo, branch: wt.branch, base: "main", flags: "" });
});

test("status updates: a leak never reaches the webhook; Health says it's held", async () => {
  const sent: string[] = [];
  const deps = {
    secret: () => "https://hooks.example.test/x",
    fetch: async (url: string) => {
      sent.push(url);
      return new Response("ok");
    },
  };
  const ch = UpdateChannelSchema.parse({ id: "fw-1", name: "Fernway weekly", kind: "slack", projects: ["Fernway"] });
  const item = (title: string) => ({ project: "Fernway", key: "FERN-1", title, url: "" });
  const S: Summary = {
    span: "day",
    from: 0,
    to: 1,
    shipped: [item("Ported Honeycrust's cart")],
    opened: [],
    review: [],
    blocked: [],
    next: [],
    spend: {},
    guides: [],
  };
  expect(await sendUpdate(ch, S, 1000, deps)).toContain("outward firewall");
  expect(sent).toEqual([]);
  const f = held("Status update to Fernway weekly");
  expect(f?.leak?.kind).toBe("update");
  expect(f?.leak?.payload.channel).toBe("fw-1");
  expect(f?.leak?.payload.to).toBe("Fernway");
  // a clean one goes
  expect(await sendUpdate(ch, { ...S, shipped: [item("Fixed the cart")] }, 2000, deps)).toBe("");
  expect(sent).toHaveLength(1);
});

test("the team feed: free text naming another project or a secret is held; presence and clean text go", () => {
  const q: TeamSend = { k: "question", id: "q1", project: "Fernway", lead: "web", text: "Do we reuse the Honeycrust job?", fallback: "" };
  expect(teamCleared(q)).toBe(false);
  expect(held("Message to your team about Fernway")?.leak?.kind).toBe("team");
  expect(teamCleared({ ...q, text: "Do we reuse the old job?" })).toBe(true);
  expect(teamCleared({ k: "comment", id: "c1", item: "ticket:FERN-1", text: `key ${TOKEN}`, mentions: [] })).toBe(false);
  expect(teamCleared({ k: "presence", agents: 1, quiet: false, viewing: null, claims: [], projects: [] })).toBe(true);
});

test("agents' commits, PRs and Slack drafts: the guard blocks a leak, holds it, and lets it through once on Post anyway", () => {
  const block = (command: string, project = "Fernway") => outwardBlock("Bash", { command }, project, TWO);
  expect(block(`git commit -m "fix: same as HONEY-12"`)).toContain('"HONEY-12" (Honeycrust)');
  expect(block(`cd web && gh pr create --title "Cart" --body "$(cat <<'EOF'\nMirrors Honeycrust\nEOF\n)"`)).toContain("Honeycrust");
  expect(block(`gh pr edit 4 --body "token ${TOKEN}"`)).toContain("a secret");
  expect(block(`git -C web commit -m "fix(FERN-3): cart"`)).toBeNull();
  expect(block("git push -u origin FERN-3-cart")).toBeNull();
  expect(block("grep -rn Honeycrust .")).toBeNull();
  // a Slack draft goes to the project its workspace belongs to
  const slack = [{ server: "slack_honeycrust", client: "Honeycrust" }];
  expect(outwardOf("mcp__slack_honeycrust__slack_send_message_draft", { channel: "C1", message: "hi" }, "Fernway", slack)?.project).toBe(
    "Honeycrust",
  );
  expect(outwardBlock("mcp__slack_fernway__slack_send_message_draft", { message: "Honeycrust is late" }, "Fernway", TWO)).toContain(
    "Honeycrust",
  );
  expect(outwardOf("Read", { file_path: "/x" }, "Fernway")).toBeNull();
  // Post anyway on its finding lets that exact text through, once
  const cmd = `git commit -m "fix: as in HONEY-99"`;
  expect(block(cmd)).not.toBeNull();
  const f = loadFindings().find((x) => x.leak?.kind === "agent" && x.text.includes("HONEY-99"));
  if (!f) throw new Error("the guard held it");
  allowOnce(f.id);
  expect(block(cmd)).toBeNull();
  expect(block(cmd)).not.toBeNull();
});

test("cleared: dismissed stays held without asking again; a released finding is the same id the sender computes", () => {
  const o = { kind: "agent" as const, project: "Fernway", dest: "x", title: "t", text: "about Honeycrust" };
  expect(cleared(o, TWO)).toBe(false);
  const f = loadFindings().find((x) => x.text === "about Honeycrust");
  expect(f && findingId(f)).toBe(f?.id);
});

test("release: Edit and post checks your text again; Post anyway needs confirming; an agent's text isn't edited here", async () => {
  const o = { kind: "agent" as const, project: "Fernway", dest: "x", title: "release test", text: "Honeycrust again" };
  cleared(o, TWO);
  const f = held("release test");
  if (!f) throw new Error("held");
  await expect(releaseLeak(f, null, false)).rejects.toThrow("Confirm");
  await expect(releaseLeak(f, "a clean line", false)).rejects.toThrow("writes its own text");
  // an edit that still names another project comes back marked, nothing sent
  const c = loadFindings().find((x) => x.leak?.kind === "comment");
  if (!c) throw new Error("the comment test held one");
  const r = await releaseLeak(c, "still about Fernway", false);
  expect("hits" in r && r.hits.map((h) => h.term)).toEqual(["Fernway"]);
  // Post anyway on an agent's: let through once, and the finding is closed
  expect(await releaseLeak(f, null, true)).toEqual({ sent: true });
  expect(held("release test")).toBeUndefined();
  expect(cleared(o, TWO)).toBe(true);
});
