import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { agentSettings, hookCommand, writeAgentHome } from "../src/agent-home";
import { ancestors, clearStale, forgetRun, pruneRuns, recordRun, recordSpawn, runOf, withLock } from "../src/control";
import { OPS } from "../src/env";
import { attempted, check, guardBlocks, handCheck, logBlock, pushBranchesOf, selfPaths, trustIdentity, UNRECORDED_RUN } from "../src/guard";
import { RUNTIMES } from "../src/runtimes";
import type { RunInput } from "../src/runtimes/runtime";

const scratch = (): string => mkdtempSync(join(tmpdir(), "overhand-guard-"));

test("agents can't merge or turn on auto-merge through the API either: only Ship's daemon does that", () => {
  const bash = (command: string) => check("Bash", { command });
  expect(
    bash("gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}'"),
  ).not.toBeNull();
  expect(bash("gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'")).not.toBeNull();
  expect(bash("gh api repos/o/r/pulls/1/merge -X PUT")).not.toBeNull();
  expect(bash("gh api -X PUT repos/o/r/pulls/1/merge")).not.toBeNull();
  expect(bash("gh api --method PUT /repos/o/r/pulls/1/merge")).not.toBeNull();
  expect(bash("curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/1/merge")).not.toBeNull();
  expect(bash("wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge")).not.toBeNull();
  expect(bash('curl https://api.github.com/graphql -d \'{"query":"mutation{enablePullRequestAutoMerge(input:{})}"}\'')).not.toBeNull();
  expect(bash("gh auth token")).not.toBeNull();
  expect(bash("gh auth status -t")).not.toBeNull();
  expect(bash("gh auth status --show-token")).not.toBeNull();
  expect(bash("gh auth status --hostname github.com -t")).not.toBeNull();
  expect(bash("gh auth status")).toBeNull();
  expect(bash("gh api graphql -F query=@arm.graphql -F id=PR_x")).not.toBeNull();
  expect(bash("gh api graphql --input body.json")).not.toBeNull();
  expect(bash('gh api graphql -f query="$(cat arm.graphql)"')).not.toBeNull();
  // reading a PR through the API stays fine
  expect(bash("gh api repos/o/r/pulls/1/files --paginate")).toBeNull();
  expect(bash('gh api graphql -f query=\'{repository(owner:"o",name:"r"){pullRequest(number:1){mergeable}}}\'')).toBeNull();
});

test("guard blocks dangerous commands and allows normal work", () => {
  const bash = (command: string) => check("Bash", { command });
  expect(bash("git push --force origin claude/HONEY-1-x")).not.toBeNull();
  expect(bash("git push origin main")).not.toBeNull();
  expect(bash("git push -u origin develop")).not.toBeNull();
  expect(bash("gh pr merge 12 --squash")).not.toBeNull();
  expect(bash("vercel --prod")).not.toBeNull();
  expect(bash("cd apps/web && vercel deploy")).not.toBeNull();
  expect(bash("eas submit -p ios")).not.toBeNull();
  expect(bash("cat ~/honeycrust-prod-admin-password.txt")).not.toBeNull();
  expect(bash("security find-generic-password -s ops-bitbucket -w")).not.toBeNull();
  expect(bash("rm -rf ~")).not.toBeNull();
  expect(bash("psql $PROD_DATABASE_URL")).not.toBeNull();
  expect(bash("psql postgres://u@db.prod.rds.amazonaws.com/app")).not.toBeNull();

  expect(bash("git push -u origin claude/HONEY-1693-fix-invite")).toBeNull();
  expect(bash("bun run typecheck && bun test")).toBeNull();
  expect(bash("git -C fernway worktree add .claude/worktrees/hero-339 -b claude/FERN-339-copy origin/main")).toBeNull();
  expect(bash("rm -rf node_modules/.cache")).toBeNull();
  expect(bash("vercel env pull .env.local")).toBeNull();

  expect(check("Read", { file_path: "/Users/sam/honeycrust-prod-admin-password.txt" })).not.toBeNull();
  expect(check("Read", { file_path: "/Users/sam/Code/fernway/web/.env.production" })).not.toBeNull();
  expect(check("Edit", { file_path: "/Users/sam/Code/fernway/web/src/app.tsx" })).toBeNull();

  expect(check("mcp__slack_fernway__slack_send_message", {})).not.toBeNull();
  expect(check("mcp__slack_bluekite__slack_send_message_draft", {})).toBeNull();
  expect(check("Bash", { command: "curl -X POST https://slack.com/api/chat.postMessage -d text=hi" })).not.toBeNull();
  expect(check("Bash", { command: "curl https://slack.com/api/conversations.history?channel=C1" })).toBeNull();
  expect(check("mcp__slack_potluck__slack_add_reaction", {})).not.toBeNull();
  expect(check("mcp__slack_fernway__slack_search_public_and_private", {})).toBeNull();
  expect(check("mcp__slack_bluekite__slack_read_thread", {})).toBeNull();
});

test("guard protects Overhand's own files, wherever OPS and SRC are", () => {
  const ops = join(homedir(), ".overhand-test");
  const bin = "/opt/overhand/overhand";
  const installed = selfPaths(ops, "/opt/overhand", true, bin);
  const edit = (file_path: string, self: string[]) => check("Edit", { file_path }, self);
  expect(edit(join(ops, "agent-home", "claude-code", "settings.json"), installed)).not.toBeNull();
  expect(edit(join(ops, "agent-home", "claude-code", "CLAUDE.md"), installed)).not.toBeNull();
  expect(edit(join(ops, "overhand.config.json"), installed)).not.toBeNull();
  // local code runs inside the daemon, so an agent can't add or change any
  expect(check("Write", { file_path: join(ops, "local-code", "order.ts") }, installed)).not.toBeNull();
  expect(check("Bash", { command: "cp x.ts ~/.overhand-test/local-code/" }, installed)).not.toBeNull();
  // plugins/ too: a file dropped there must never reach the daemon
  expect(check("Write", { file_path: join(ops, "plugins", "x.ts") }, installed)).not.toBeNull();
  expect(check("Bash", { command: "echo x > ~/.overhand-test/plugins/x.ts" }, installed)).not.toBeNull();
  expect(check("Write", { file_path: bin }, installed)).not.toBeNull();
  expect(check("Bash", { command: "cat > ~/.overhand-test/agent-home/claude-code/settings.json" }, installed)).not.toBeNull();
  expect(check("Bash", { command: "rm $HOME/.overhand-test/overhand.config.json" }, installed)).not.toBeNull();
  expect(edit(join(ops, "agent-home-other", "x"), installed)).toBeNull(); // a sibling, not inside
  expect(edit("/Users/sam/Code/fernway/src/app.tsx", installed)).toBeNull();
  expect(check("Bash", { command: "git commit -am 'fix(app): x'" }, installed)).toBeNull();

  const src = "/Users/sam/Code/overhand";
  const checkout = selfPaths(src, src, false, "/usr/local/bin/bun");
  expect(edit(join(src, "packages", "core", "src", "guard.ts"), checkout)).not.toBeNull();
  expect(edit(join(src, "run.ts"), checkout)).not.toBeNull();
  // a ticket worktree of Overhand's own repo is ordinary work
  expect(edit(join(src, ".claude", "worktrees", "HL-1", "packages", "core", "src", "guard.ts"), checkout)).toBeNull();
  expect(edit("/usr/local/bin/bun", checkout)).toBeNull();
});

test("the hook runs the binary itself when installed, run.ts from a checkout, and blocks if it can't start", () => {
  const home = "/Users/sam/.overhand";
  expect(hookCommand(true, "/Users/sam/.overhand/bin/overhand", "/Users/sam/.overhand/bin", "claude", home)).toBe(
    "OVERHAND_HOME='/Users/sam/.overhand' '/Users/sam/.overhand/bin/overhand' guard || exit 2",
  );
  expect(hookCommand(false, "/opt/bun/bin/bun", "/Users/sam/Code/overhand", "claude", home)).toBe(
    "OVERHAND_HOME='/Users/sam/.overhand' '/opt/bun/bin/bun' '/Users/sam/Code/overhand/run.ts' guard || exit 2",
  );
  expect(hookCommand(true, "/Users/o'neil/overhand", "/x", "claude", "/h")).toBe(
    "OVERHAND_HOME='/h' '/Users/o'\\''neil/overhand' guard || exit 2",
  );
  // other CLIs' hooks keep today's command
  expect(hookCommand(true, "/x/overhand", "/x", "gemini", home)).toBe("'/x/overhand' guard gemini || exit 2");
});

test("Claude Code's hook names Overhand's folder itself: a nested agent's OVERHAND_HOME can't move the guard", () => {
  const command = hookCommand(false, process.execPath, join(import.meta.dir, "..", "..", ".."), "claude", OPS);
  const config = { tool_name: "Write", tool_input: { file_path: join(OPS, "overhand.config.json") } };
  const code = Bun.spawnSync(["sh", "-c", command], {
    stdin: Buffer.from(JSON.stringify(config)),
    env: { ...process.env, OVERHAND_HOME: scratch() }, // what a nested agent's environment says
  }).exitCode;
  expect(code).toBe(2);
});

test("the agent config home gets the instructions and the guard hook, keeps your files, and rewrites the same", () => {
  const dir = scratch();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus", theme: "light" }));
  writeFileSync(join(dir, "notes.md"), "mine");
  writeAgentHome(dir, "'/bin/overhand' guard");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.model).toBe("opus"); // your own key stays
  expect(settings.theme).toBe("dark"); // Overhand's key wins
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("'/bin/overhand' guard");
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("## Hard limits");
  expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("mine");
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  writeAgentHome(dir, "'/bin/overhand' guard");
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
  expect(readdirSync(dir).sort()).toEqual(["CLAUDE.md", "notes.md", "settings.json"]);
  // an update's hook command replaces the old one
  writeAgentHome(dir, "'/new/overhand' guard");
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).hooks).toEqual(agentSettings("'/new/overhand' guard").hooks);
});

test("every other CLI gets Overhand's agent instructions outside the repo", () => {
  const dir = scratch();
  const file = join(dir, "CLAUDE.md");
  writeFileSync(file, "RULES-TEXT");
  const r: RunInput = {
    account: "a",
    cwd: dir,
    prompt: "Fix it",
    schema: "",
    schemaFile: join(dir, "s.json"),
    alias: "",
    provider: { kind: "claude", auth: "login" },
    model: "",
    attribution: false,
    args: [],
    configDir: "",
    instructions: file,
    read: (s: string) => (s.startsWith("gemini-key-") ? "gk" : null),
  };
  expect(RUNTIMES.codex.task(r).argv).toContain(`developer_instructions=${JSON.stringify("RULES-TEXT")}`);
  expect(RUNTIMES.aider.task(r).argv.join(" ")).toContain(`--read ${file}`);
  const oc = JSON.parse(RUNTIMES.opencode.task(r).env.OPENCODE_CONFIG_CONTENT ?? "{}");
  expect(oc.instructions).toEqual([file]);
  expect(oc.permission).toBeUndefined(); // the guard plugin decides, not a list of globs
  for (const id of ["gemini", "cursor"] as const) expect(RUNTIMES[id].task(r).argv[2]?.startsWith("RULES-TEXT")).toBe(true);
  // leads pass no instructions: nothing added
  expect(RUNTIMES.codex.task({ ...r, instructions: "" }).argv.join(" ")).not.toContain("developer_instructions");
  expect(RUNTIMES.opencode.task({ ...r, instructions: "" }).env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
});

test("a guard that can't start blocks the tool call instead of letting it through", () => {
  const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd]).exitCode;
  expect(sh("'/nonexistent/overhand' guard || exit 2")).toBe(2);
  expect(sh("true || exit 2")).toBe(0);
});

test("every block lands in the guardrail log with its run, project and rule, secrets redacted", () => {
  const dir = scratch();
  const run = (input: object, env: Record<string, string> = {}) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard"], {
      stdin: Buffer.from(JSON.stringify(input)),
      env: { ...process.env, OVERHAND_HOME: dir, ...env },
    }).exitCode;
  // who the run is comes from Overhand's record of the process tree (this test is the hook's ancestor), not the env
  recordRun(dir, process.pid, { run: "HONEY-7-fix", autonomy: "act", project: "Honeycrust" });
  const who = {};
  expect(run({ tool_name: "Bash", tool_input: { command: "GITHUB_TOKEN=abc123secretvalue git push origin main" } }, who)).toBe(2);
  expect(run({ tool_name: "Read", tool_input: { file_path: "/srv/app/.env.production" } }, who)).toBe(2);
  expect(run({ tool_name: "Bash", tool_input: { command: "git status" } }, who)).toBe(0); // allowed: not logged (not a suite, so machine load cannot hold it)
  const rows = guardBlocks(0, 50, join(dir, "guardrails.jsonl"));
  expect(rows.map((r) => [r.project, r.run, r.tool, r.action, r.rule])).toEqual([
    ["Honeycrust", "HONEY-7-fix", "Bash", "GITHUB_TOKEN=[redacted] git push origin main", "push only the agent's own feature branch"],
    ["Honeycrust", "HONEY-7-fix", "Read", "/srv/app/.env.production", "no access to production env files"],
  ]);
  expect(readFileSync(join(dir, "guardrails.jsonl"), "utf8")).not.toContain("abc123secretvalue");
});

test("the guardrail log reads back only what's recent, skips bad lines, and never throws on write", () => {
  const file = join(scratch(), "guardrails.jsonl");
  logBlock("Bash", { command: "gh pr close 3" }, "merging, closing and approving are for humans", {}, file);
  writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"at":1}\n`);
  const [row] = guardBlocks(Date.now() - 60_000, 50, file);
  expect(row).toMatchObject({ project: "", run: "", action: "gh pr close 3" });
  expect(guardBlocks(Date.now() + 60_000, 50, file)).toEqual([]);
  expect(() => logBlock("Bash", {}, "x", {}, "/nonexistent/dir/log.jsonl")).not.toThrow();
  expect(attempted("mcp__slack__post", {})).toBe("mcp__slack__post");
});

test("ticket and fix-round agents can't comment as you; leads can", () => {
  const say = "Overhand posts comments for you; say it in your commits or your report";
  const as = (run: string, command: string) => check("Bash", { command }, [], "act", run);
  for (const command of [
    'gh pr comment 7 --body "done"',
    "gh pr review 7 --comment -b ok",
    "gh issue comment 12 --body hi",
    "gh api repos/o/r/issues/7/comments -f body=hi",
    "gh api -X POST repos/o/r/pulls/7/reviews --input r.json",
    "gh api --method PATCH repos/o/r/issues/comments/9 -f body=x",
  ]) {
    expect(as("HONEY-1", command)).toBe(say);
    expect(as("HONEY-1-fix", command)).toBe(say);
    expect(as("lead-honeycrust", command)).toBeNull(); // leads talk to reviewers; they mark what they post
    expect(as("", command)).toBeNull(); // not a run Overhand started
  }
  expect(as("HONEY-1", "gh api repos/o/r/pulls/7/comments")).toBeNull(); // reading is fine
  expect(as("HONEY-1", "gh pr view 7 --comments")).toBeNull();
  expect(as("HONEY-1", 'gh pr create --draft --title x --body "y"')).toBeNull();
});

test("a lead pushes to the protected branches its config lists, nothing else does", () => {
  const lists = ["develop", "main"];
  const push = (cmd: string, run: string, allowed: string[]) => check("Bash", { command: cmd }, [], "act", run, allowed);
  expect(push("git push origin develop", "lead-mono", lists)).toBeNull();
  expect(push("git push origin HEAD:main", "lead-mono", lists)).toBeNull();
  expect(push("git push origin staging", "lead-mono", lists)).not.toBeNull();
  expect(push("git push origin develop:production", "lead-mono", lists)).not.toBeNull();
  expect(push(["git push", "--force", "origin develop"].join(" "), "lead-mono", lists)).not.toBeNull();
  expect(push("git push origin main", "lead-other", [])).not.toBeNull();
  expect(check("Bash", { command: "git push origin main" }, [], "watch", "lead-mono", ["main"])).not.toBeNull();
});

test("pushBranchesOf reads a lead's list from the config and gives nothing to other runs", () => {
  const file = join(scratch(), "overhand.config.json");
  writeFileSync(file, JSON.stringify({ godmode: [{ key: "mono", pushBranches: ["develop"] }, { key: "other" }] }));
  expect(pushBranchesOf("lead-mono", file)).toEqual(["develop"]);
  expect(pushBranchesOf("lead-other", file)).toEqual([]);
  expect(pushBranchesOf("ticket-1", file)).toEqual([]);
  writeFileSync(file, "{not json");
  expect(pushBranchesOf("lead-mono", file)).toEqual([]);
});

test("searching files goes through the guard too: Glob and Grep can't reach secrets, and cloud credentials are off limits", () => {
  expect(agentSettings("x").hooks).toMatchObject({ PreToolUse: [{ matcher: expect.stringContaining("Glob|Grep") }] });
  expect(check("Glob", { pattern: "*", path: "/Users/sam/.ssh" })).not.toBeNull();
  expect(check("Glob", { pattern: "**/.env.production" })).not.toBeNull();
  expect(check("Grep", { pattern: "token", path: "/Users/sam/.aws/credentials" })).not.toBeNull();
  expect(check("Grep", { pattern: "key", path: "/Users/sam", glob: ".config/gcloud/**" })).not.toBeNull();
  expect(check("Read", { file_path: "/Users/sam/.config/gcloud/application_default_credentials.json" })).not.toBeNull();
  expect(check("Read", { file_path: "/Users/sam/.azure/msal_token_cache.json" })).not.toBeNull();
  // ordinary searches, including for the word "password" in code, carry on
  expect(check("Grep", { pattern: "password", path: "/Users/sam/Code/fernway/web/src" })).toBeNull();
  expect(check("Glob", { pattern: "src/**/*.tsx", path: "/Users/sam/Code/fernway/web" })).toBeNull();
});

test("a lead writes only in its own folder under Overhand's leads; other leads, ticket runs and your own sessions can't", () => {
  const leads = join(OPS, "leads");
  const as = (run: string, tool: string, file_path: string) => check(tool, { file_path }, [], "act", run);
  const mine = join(leads, "mine", "questions.md");
  const theirs = join(leads, "theirs", "questions.md");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    expect(as("lead-mine", tool, mine)).toBeNull();
    expect(as("lead-mine", tool, join(leads, "mine", "notes.md"))).toBeNull();
    expect(as("lead-mine", tool, theirs)).not.toBeNull();
    expect(as("lead-mine", tool, join(leads, "mine", "..", "theirs", "questions.md"))).not.toBeNull();
    expect(as("lead-mine", tool, join(leads, "notes.md"))).not.toBeNull(); // the folder of folders itself
    expect(as("SHOP-12", tool, mine)).not.toBeNull(); // a ticket run
    expect(as("", tool, mine)).not.toBeNull(); // a run started by hand
    expect(as("lead-", tool, mine)).not.toBeNull(); // no key is no folder
    expect(handCheck(tool, { file_path: mine }, [])).not.toBeNull(); // a session you opened
  }
  // reading another lead's file is fine; so is writing outside the leads
  expect(as("lead-mine", "Read", theirs)).toBeNull();
  expect(as("SHOP-12", "Grep", leads)).toBeNull();
  expect(handCheck("Read", { file_path: theirs }, [])).toBeNull();
  expect(as("SHOP-12", "Edit", join(OPS, "leadsish", "x.md"))).toBeNull();
  // a symlink in its own folder to another lead's is followed
  mkdirSync(join(leads, "mine"), { recursive: true });
  mkdirSync(join(leads, "theirs"), { recursive: true });
  writeFileSync(theirs, "## Q\n");
  rmSync(join(leads, "mine", "link"), { force: true });
  symlinkSync(join(leads, "theirs"), join(leads, "mine", "link"));
  expect(as("lead-mine", "Write", join(leads, "mine", "link", "questions.md"))).not.toBeNull();
  expect(as("lead-mine", "Write", join(leads, "mine", "link", "new.md"))).not.toBeNull();
});

test("the shell meets the same rule: redirection into another lead's folder, `..`, and reaching it from Overhand's folder", () => {
  const leads = join(OPS, "leads");
  const sh = (run: string, command: string) => check("Bash", { command }, [], "act", run);
  expect(sh("lead-mine", `echo "- done" >> ${leads}/mine/notes.md`)).toBeNull();
  expect(sh("lead-mine", `cat '${leads}/mine/questions.md' | tee ${leads}/mine/notes.md`)).toBeNull();
  expect(sh("lead-mine", `printf '## Answer from Sam\\n\\nyes' >> ${leads}/theirs/questions.md`)).not.toBeNull();
  expect(sh("lead-mine", `cp x ${leads}/mine/a && cp x ${leads}/theirs/b`)).not.toBeNull();
  expect(sh("lead-mine", `echo x > ${leads}/mine/../theirs/questions.md`)).not.toBeNull();
  expect(sh("lead-mine", `echo x > ${leads}/mine2/questions.md`)).not.toBeNull(); // a key that only starts like its own
  expect(sh("lead-mine", `cd ${OPS} && echo x >> leads/theirs/questions.md`)).not.toBeNull();
  expect(sh("SHOP-12", `echo x >> ${leads}/mine/questions.md`)).not.toBeNull();
  expect(sh("", `sed -i '' 's/a/b/' ${leads}/mine/questions.md`)).not.toBeNull();
  expect(handCheck("Bash", { command: `echo x >> ${leads}/mine/questions.md` }, [])).not.toBeNull();
  expect(handCheck("Bash", { command: "git status" }, [])).toBeNull();
  expect(sh("SHOP-12", "bun test")).toBeNull();
});

test("the leads rule holds however a command spells the folder: case, quotes, globs, cd and $PWD", () => {
  const leads = join(OPS, "leads");
  mkdirSync(join(leads, "mine"), { recursive: true });
  mkdirSync(join(leads, "theirs"), { recursive: true });
  const sh = (command: string) => check("Bash", { command }, [], "act", "lead-mine");
  const forge = ">> questions.md";
  const blocked = [
    `echo x >> ${leads.toUpperCase()}/theirs/questions.md`, // macOS folders ignore case
    `echo x >> ${leads.normalize("NFD")}/THEIRS/questions.md`,
    `echo x >> "${OPS.slice(0, -2)}""${OPS.slice(-2)}"/le""ads/theirs/questions.md`, // quotes the shell drops
    `echo x >> ${dirname(OPS)}/*/leads/theirs/questions.md`, // a glob naming leads
    `echo x >> ${dirname(OPS)}/${basename(OPS).slice(0, 3)}*/l*/t*/q*`, // a glob that reaches it all the same
    `cd ${OPS} && echo x >> leads/theirs/questions.md`, // a relative leads/ from Overhand's folder
    `cd ${leads}/mine && echo x >> "$(dirname "$PWD")/theirs/questions.md"`, // moving about from its own folder
    `cd ${leads}/mine && cd .. && cd theirs && echo x ${forge}`,
    `echo x >> ${dirname(OPS)}/*/leads/*/questions.md`, // a glob into Overhand's folder from its parent
  ];
  for (const c of blocked) expect([c, sh(c)]).toEqual([c, expect.any(String)]);
  // its own folder, by its own absolute path, still works; so does ordinary work with globs
  expect(sh(`echo "- done" >> ${leads}/mine/notes.md`)).toBeNull();
  expect(sh("ls src/*.ts && bun test test/leads*")).toBeNull();
  // the same for Overhand's own files, and for file tools
  const control = join(OPS, "control", "written.json");
  expect(check("Bash", { command: `echo [] > ${control.toUpperCase()}` }, selfPaths(), "act", "lead-mine")).not.toBeNull();
  expect(check("Bash", { command: `echo [] > ${join(OPS, "c*", "w*")}` }, selfPaths(), "act", "lead-mine")).not.toBeNull();
  expect(check("Write", { file_path: control.toUpperCase() }, selfPaths(), "act", "lead-mine")).not.toBeNull();
  expect(check("Write", { file_path: join(leads.toUpperCase(), "theirs", "questions.md") }, [], "act", "lead-mine")).not.toBeNull();
  // one name in two Unicode forms is one folder
  expect(check("Write", { file_path: "/tmp/cafe\u0301/x.md" }, ["/tmp/caf\u00e9"], "act", "lead-mine")).not.toBeNull();
});

test("a relative path after a cd, or Overhand's folder by its own name from anywhere, still reaches it", () => {
  const base = basename(OPS);
  const self = selfPaths();
  const writes = [
    `cd ${dirname(OPS)} && echo x >> ${base}/leads/other/questions.md`,
    `cd ~ && echo x >> ${base}/leads/other/questions.md`,
    `cd ~ && sed -i '' s/a/b/ ${base}/leads/other/questions.md`,
    `cd ~ && echo {} > ${base}/control/written.json`,
    `cd ~ && cp /tmp/x ${base}/overhand.config.json`,
    `cd ${OPS} && echo {} > control/written.json`,
    `cd ${dirname(OPS)}/${base.slice(0, 4)}* && echo x >> leads/other/questions.md`,
    `cd ${dirname(OPS)} ; cd ${base}/leads/other && echo x >> questions.md`,
    `cd ${OPS}/leads/mine && cd .. && cd other && echo x >> questions.md`,
  ];
  for (const command of writes) {
    expect([command, check("Bash", { command }, self, "act", "lead-mine")]).toEqual([command, expect.any(String)]);
    expect([command, handCheck("Bash", { command }, self)]).toEqual([command, expect.any(String)]);
  }
  // where the hook runs counts too: a relative path from Overhand's folder
  const rel = "echo x >> leads/other/questions.md";
  expect(check("Bash", { command: rel }, self, "act", "lead-mine", [], OPS)).not.toBeNull();
  expect(handCheck("Bash", { command: rel }, self, OPS)).not.toBeNull();
  expect(check("Bash", { command: rel }, self, "act", "lead-mine", [], "/code/crm")).toBeNull();
  // your own session may read your leads and Overhand's files; only writes are stopped
  for (const command of [
    `cat ${OPS}/leads/x/questions.md`,
    `tail -f ${OPS}/leads/x/questions.md`,
    `cat ${OPS}/overhand.config.json | jq .`,
  ])
    expect([command, handCheck("Bash", { command }, self)]).toEqual([command, null]);
  expect(handCheck("Bash", { command: `cat /tmp/x > ${OPS}/leads/x/questions.md` }, self)).not.toBeNull();
  // a read that also runs something else isn't a read: a job in the background, a command or process substitution
  for (const command of [
    `cat a & rm -rf ${OPS}/control`,
    `cat "$(rm -rf ${OPS}/control)"`,
    `ls \`rm ${OPS}/control/written.json\``,
    `cat <(rm ${OPS}/control/written.json)`,
    `cat ${OPS}/control/runs.json >(tee ${OPS}/control/written.json)`,
    // readers that can run a command or write one: never taken for a plain read
    `rg --pre=sh x ${OPS}/control`,
    `bat --pager="rm -rf ${OPS}/control" ${OPS}/control/runs.json`,
    `less +"!rm -rf ${OPS}/control" ${OPS}/control/runs.json`,
    `more ${OPS}/control/runs.json`,
    `file -C -m ${OPS}/control/runs.json`,
  ])
    expect([command, handCheck("Bash", { command }, self)]).toEqual([command, expect.any(String)]);
});

test("Overhand's whole folder can't be deleted, moved or rewritten: by name, from above it, or from inside it", () => {
  const self = selfPaths();
  const blocked: [string, string][] = [
    [`rm -rf ${OPS}`, ""],
    [`mv ${OPS} /tmp/elsewhere`, ""],
    [`find ${OPS} -delete`, ""],
    [`find ${OPS} -name x -exec rm {} ;`, ""],
    [`rm -rf ${dirname(OPS)}`, ""],
    ["rm -rf ~", ""],
    ["rm -rf /", ""],
    [`cd ${OPS} && git checkout -- .`, ""],
    [`cd ${OPS} && find . -delete`, ""],
    ["git checkout -- .", OPS],
    ["rm -rf leads", OPS],
    ["rm -rf reports", OPS],
    [`cd ${OPS} && find -delete`, ""],
    ["sed -i '' s/a/b/ overhand.config.json", OPS],
  ];
  for (const [command, cwd] of blocked) {
    expect([command, check("Bash", { command }, self, "act", "SHOP-1", [], cwd)]).toEqual([command, expect.any(String)]);
    expect([command, handCheck("Bash", { command }, self, cwd)]).toEqual([command, expect.any(String)]);
  }
  // ordinary work elsewhere, and reading inside it, carry on
  for (const [command, cwd] of [
    ["rm -rf build", "/code/crm"],
    ["git checkout -- .", "/code/crm"],
    ["find . -name '*.ts'", OPS],
    [`ls ${OPS}`, ""],
  ])
    expect([command, check("Bash", { command }, self, "act", "SHOP-1", [], cwd)]).toEqual([command, null]);
});

test("a project's own leads folder is its own: a CRM's src/leads is never taken for Overhand's", () => {
  for (const command of [
    "ls src/leads/*.ts",
    "git diff -- 'src/leads/**'",
    "cd web && cat leads/index.ts",
    "cat ./leads/x.ts && mv leads/a.ts leads/b.ts",
    "bun test src/leads/*.test.ts",
    "ls */*",
    "rm -rf build/*/*",
    "cp -r apps/*/* out",
  ]) {
    expect([command, check("Bash", { command }, selfPaths(), "act", "CRM-1")]).toEqual([command, null]);
    expect([command, handCheck("Bash", { command }, selfPaths())]).toEqual([command, null]);
  }
});

test("a run is who Overhand recorded for its process tree, never what its environment says", async () => {
  const dir = scratch();
  const hook = (input: object, env: Record<string, string>) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard"], {
      stdin: Buffer.from(JSON.stringify(input)),
      env: { ...process.env, OVERHAND_HOME: dir, ...env },
    }).exitCode;
  const edit = { tool_name: "Edit", tool_input: { file_path: "/srv/app/src/app.ts" } };
  // this test's process is the hook's ancestor: recorded as a ticket run on a project on watch
  recordRun(dir, process.pid, { run: "SHOP-1", autonomy: "watch", project: "Shop" });
  expect(hook(edit, { OVERHAND_RUN: "lead-other", OVERHAND_AUTONOMY: "act" })).toBe(2); // the claim is ignored
  // recorded to act, it may edit, whatever its environment says
  recordRun(dir, process.pid, { run: "SHOP-1", autonomy: "act", project: "Shop" });
  expect(hook(edit, { OVERHAND_AUTONOMY: "watch" })).toBe(0);
  // with no recorded ancestor but a run named in its environment, it's judged with the most care: watch, no lead's
  // folder, whatever the claim; with nothing named, it's a session started by hand
  forgetRun(dir, process.pid);
  const env: Record<string, string | undefined> = { OVERHAND_RUN: "lead-mine", OVERHAND_AUTONOMY: "act", OVERHAND_PROJECT: "Shop" };
  expect(trustIdentity([process.pid], env)).toBe("claimed");
  expect(env).toEqual({ OVERHAND_RUN: UNRECORDED_RUN, OVERHAND_AUTONOMY: "watch" });
  expect(hook(edit, { OVERHAND_RUN: "lead-mine", OVERHAND_AUTONOMY: "act" })).toBe(2);
  expect(check("Write", { file_path: join(OPS, "leads", "mine", "questions.md") }, [], "watch", UNRECORDED_RUN)).not.toBeNull();
  const none: Record<string, string | undefined> = {};
  expect(trustIdentity([process.pid], none)).toBe("none");
  expect(none).toEqual({});
  expect(hook(edit, {})).toBe(0);
  // run as your own session's hook, a named but unrecorded run isn't let through as one: it gets the agent rules
  const hand = (env: Record<string, string>) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard", "hand"], {
      stdin: Buffer.from(JSON.stringify({ ...edit, session_id: "s-1", cwd: dir })),
      env: { ...process.env, OVERHAND_HOME: dir, ...env },
    }).exitCode;
  expect(hand({ OVERHAND_RUN: "lead-mine" })).toBe(2);
  expect(hand({})).toBe(0);
  recordRun(OPS, process.pid, { run: "lead-mine", autonomy: "propose", project: "Shop" });
  expect(trustIdentity([123_456_789, process.pid], env)).toBe("recorded");
  expect(env).toEqual({ OVERHAND_RUN: "lead-mine", OVERHAND_AUTONOMY: "propose", OVERHAND_PROJECT: "Shop" });
  forgetRun(OPS, process.pid);
  // a spawn is recorded with the identity its runtime gave it, and forgotten when it ends
  let end = () => {};
  const exited = new Promise<void>((r) => {
    end = r;
  });
  recordSpawn(dir, { pid: process.pid, exited }, { OVERHAND_RUN: "BOOK-2", OVERHAND_AUTONOMY: "propose" });
  expect(runOf(dir, [process.pid])).toEqual({ run: "BOOK-2", autonomy: "propose", project: "" });
  end();
  await exited;
  await Bun.sleep(0);
  expect(runOf(dir, [process.pid])).toBeNull();
  // the chain runs from a process up through its parents
  expect(ancestors(process.pid).slice(0, 2)).toEqual([process.pid, process.ppid]);
});

test("ordinary commands with env flags, a scratch OVERHAND_HOME, or the word leads in a checkout carry on", () => {
  const sh = (command: string) => check("Bash", { command }, [], "act", "lead-mine");
  for (const c of [
    "env X=1 bun test -u",
    "env FORCE_COLOR=0 bun test -i",
    "OVERHAND_HOME=$(mktemp -d) bun test",
    `cd ${OPS} && bun test leads`,
    `cd ${OPS} && bun test packages/core/test/leads.test.ts`,
  ])
    expect([c, sh(c)]).toEqual([c, null]);
});

test("a file tool's every path is checked: a move's source and destination, and a list of paths", () => {
  const leads = join(OPS, "leads");
  const as = (input: Record<string, unknown>, self: string[] = []) => check("Move", input, self, "act", "lead-mine");
  expect(as({ source: join(leads, "mine", "a.md"), destination: join(leads, "theirs", "questions.md") })).not.toBeNull();
  expect(as({ paths: [join(leads, "mine", "a.md"), join(leads, "theirs", "questions.md")] })).not.toBeNull();
  expect(as({ target: join(OPS, "control", "written.json") }, selfPaths())).not.toBeNull();
  expect(as({ source: "/tmp/a", destination: join(leads, "mine", "b.md") })).toBeNull();
  expect(handCheck("Move", { destination: join(leads, "mine", "questions.md") }, [])).not.toBeNull();
  expect(handCheck("Move", { paths: ["/tmp/x", join(OPS, "control", "holds.json")] }, selfPaths())).not.toBeNull();
});

test("a symlink to one of Overhand's own files is followed, for agents and your own sessions", () => {
  const control = join(OPS, "control");
  mkdirSync(control, { recursive: true });
  const dir = scratch();
  symlinkSync(control, join(dir, "c"));
  symlinkSync(join(OPS, "overhand.config.json"), join(dir, "cfg.json"));
  const link = join(dir, "c", "written.json");
  expect(check("Write", { file_path: link }, selfPaths(), "act", "lead-mine")).not.toBeNull();
  expect(check("Edit", { file_path: join(dir, "cfg.json") }, selfPaths(), "act", "SHOP-1")).not.toBeNull();
  expect(handCheck("Write", { file_path: link }, selfPaths())).not.toBeNull();
  expect(check("Write", { file_path: join(dir, "plain.md") }, selfPaths(), "act", "lead-mine")).toBeNull();
});

test("a recorded run is the process that started then: a reused pid is no one's, and never skips your session's checks", () => {
  const dir = scratch();
  const who = { run: "lead-mine", autonomy: "act", project: "" };
  recordRun(dir, process.pid, who, () => true, Date.now(), "Mon Jan  1 00:00:00 2001"); // another process's start
  expect(runOf(dir, [process.pid])).toBeNull();
  // your own session's hook under that stale record still checks everything: no early way out
  const hand = () =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "run.ts"), "guard", "hand"], {
      stdin: Buffer.from(
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "overhand.config.json") }, session_id: "s" }),
      ),
      env: { ...process.env, OVERHAND_HOME: dir },
    }).exitCode;
  expect(hand()).toBe(2);
  recordRun(dir, process.pid, who); // the real start: a run Overhand started, whose own guard covers it
  expect(runOf(dir, [process.pid])).toEqual(who);
  expect(hand()).toBe(0);
  // the daemon's start drops every record whose process is gone or isn't the one recorded
  recordRun(dir, 999_999, who, () => true, Date.now(), "Mon Jan  1 00:00:00 2001");
  pruneRuns(dir);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "control", "runs.json"), "utf8")))).toEqual([String(process.pid)]);
});

test("a lock is removed only by the holder that took it, and a stale one is taken over", () => {
  const file = join(scratch(), "x.json");
  const lock = `${file}.lock`;
  withLock(file, () => writeFileSync(lock, "another-holder")); // someone else took it over meanwhile
  expect(readFileSync(lock, "utf8")).toBe("another-holder"); // not ours: left for them
  utimesSync(lock, new Date(0), new Date(0)); // its holder died long ago
  expect(withLock(file, () => 42)).toBe(42);
  expect(existsSync(lock)).toBe(false);
  writeFileSync(lock, "a-live-holder");
  expect(() => withLock(file, () => 1, 10_000, 50)).toThrow();
  expect(readFileSync(lock, "utf8")).toBe("a-live-holder");
  // a stale lock is deleted only while it still holds what was seen and is still old; it's never moved or written over
  expect(clearStale(lock, "the-dead-holder", 10_000)).toBe(false); // another holder's lock now
  expect(clearStale(lock, "a-live-holder", 10_000)).toBe(false); // the one seen, but fresh: someone holds it
  expect(readFileSync(lock, "utf8")).toBe("a-live-holder");
  utimesSync(lock, new Date(0), new Date(0));
  expect(clearStale(lock, "the-dead-holder", 10_000)).toBe(false); // old, but not the lock that was seen stale
  expect(readFileSync(lock, "utf8")).toBe("a-live-holder");
  expect(clearStale(lock, "a-live-holder", 10_000)).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(dirname(lock))).toEqual([]);
});

test("the daemon and a CLI recording runs at once never drop each other's", async () => {
  const dir = scratch();
  const control = join(import.meta.dir, "..", "src", "control.ts");
  const script = (n: number) =>
    `const { recordRun } = await import(${JSON.stringify(control)}); for (let i = 0; i < 25; i++) recordRun(${JSON.stringify(dir)}, ${n * 1000} + i, { run: "r", autonomy: "act", project: "" }, () => true, 0, "s");`;
  const procs = Array.from({ length: 8 }, (_, n) => Bun.spawn(["bun", "-e", script(n + 1)], { stdout: "ignore", stderr: "inherit" }));
  await Promise.all(procs.map((p) => p.exited));
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "control", "runs.json"), "utf8")))).toHaveLength(200);
}, 30_000);

// how a command is quoted changes nothing about what the shell runs, so it changes nothing about what the guard decides
test("quoting, separators inside quotes and inner scripts don't hide a refused command", () => {
  const bash = (command: string) => check("Bash", { command }, undefined, "act", "lead-app", []);
  const force = ["--", "force"].join("");
  for (const command of [
    "gh pr 'mer'ge 12",
    'gh pr "merge" 12',
    "gh pr me\\rge 12",
    "git push origin 'x;' main",
    `git push origin "$(echo x);" ${force}`,
    "sh -c 'gh pr merge 12'",
    `bash -c "git push ${force} origin feat"`,
    "eval 'gh pr merge 12'",
    "echo $(gh pr merge 12)",
    "echo `gh pr merge 12`",
    "env X=1 sh -c 'gh pr close 3'",
  ])
    expect(bash(command), command).not.toBeNull();
  expect(bash("echo 'unclosed")).toContain("can't read that command");
  for (const command of ["git status", "bun test && git commit -m 'fix: a; b'", `echo "it's fine"`, "ls -la # a comment"])
    expect(bash(command), command).toBeNull();
});

test("more credentials stay closed, named in a command or opened by a file tool", () => {
  const bash = (command: string) => check("Bash", { command });
  for (const p of ["~/.kube/config", "~/.docker/config.json", "~/.config/gh/hosts.yml", "~/.netrc", "~/.zsh_history", "~/.bash_history"])
    expect(bash(`cat ${p}`), p).toBe("no access to credentials");
  expect(bash("cat $HISTFILE")).toBe("no access to credentials");
  expect(bash("cp ~/Library/Application\\ Support/Google/Chrome/Default/Cookies /tmp/x")).toBe("no access to credentials");
  for (const p of ["/Users/x/.kube/config", "/Users/x/.netrc", "/home/x/.bash_history", "/Users/x/Library/Cookies/Cookies.binarycookies"])
    expect(check("Read", { file_path: p }), p).toBe("no access to credentials");
  expect(check("Read", { file_path: "/Users/x/code/app/src/history.ts" })).toBeNull();
});
