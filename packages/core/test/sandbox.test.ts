import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_HOMES } from "../src/agent-home";
import { type Beat, beatOf, forgetRun, ingestOutboxes, outboxDir, RUN_KEY_ENV, recordSpawn, runOf, saveBeat } from "../src/control";
import { OPS } from "../src/env";
import { guardWriteRoot, trustIdentity } from "../src/guard";
import { gitPointersOk } from "../src/runtimes/runtime";
import {
  bwrapArgs,
  cleanCreated,
  guarded,
  macProfile,
  probeSandbox,
  type RunPlaces,
  real,
  sandboxArgv,
  sandboxPolicy,
  sandboxSpawn,
  sandboxState,
} from "../src/sandbox";

const scratch = () => real(mkdtempSync(join(tmpdir(), "overhand-sbx-")));

/** A home, an Overhand folder and a repo with a ticket worktree, as folders on disk. */
function places(over: Partial<RunPlaces> = {}) {
  const root = scratch();
  const home = join(root, "home");
  const ops = join(home, ".overhand");
  const repo = join(root, "code", "app");
  const common = join(repo, ".git");
  const wt = join(repo, ".claude", "worktrees", "T-1");
  for (const d of [
    join(common, "worktrees", "T-1"),
    join(common, "hooks"),
    join(wt, ".claude"),
    join(ops, "agent-home", "claude-code"),
    join(home, ".aws"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(common, "config"), "");
  const r: RunPlaces = {
    cwd: wt,
    gitCommon: common,
    gitDir: join(common, "worktrees", "T-1"),
    runtime: "claude-code",
    configDir: join(ops, "agent-home", "claude-code"),
    run: "T-1",
    readOnly: false,
    ...over,
  };
  return { root, home, ops, repo, common, wt, r, policy: sandboxPolicy(r, home, ops) };
}

test("a ticket run writes its worktree, the git pieces a worktree commit needs, caches and its CLI's state, nothing else", () => {
  const { home, ops, common, wt, policy } = places();
  for (const p of [wt, join(common, "worktrees", "T-1"), join(common, "objects"), join(common, "refs"), join(common, "logs")])
    expect(policy.write).toContain(p);
  expect(policy.write).toContain(join(ops, "agent-home", "claude-code"));
  // your own caches aren't its to write: it gets caches of its own (runCacheEnv)
  expect(policy.write).not.toContain(join(home, ".bun", "install", "cache"));
  expect(policy.write).toContain(outboxDir(ops, "T-1"));
  expect(policy.write).toContain(join(ops, "slots"));
  expect(policy.deny).not.toContain(join(ops, "slots"));
  // never the repo's own config and hooks, the other checkout, your own Claude config or Overhand's own files
  expect(policy.write).not.toContain(common);
  expect(policy.write.some((w) => w === join(home, ".claude") || w === home || w === ops)).toBe(false);
  for (const p of [
    join(common, "config"),
    join(common, "hooks"),
    join(wt, ".claude", "settings.local.json"),
    join(ops, "overhand.config.json"),
  ])
    expect(policy.deny).toContain(p);
  expect(policy.deny).toContain(join(ops, "agent-home", "claude-code", "settings.json"));
  expect(policy.deny).toContain(join(ops, "control"));
  expect(policy.hide).toContain(join(home, ".aws"));
  expect(policy.hide).toContain(join(ops, "control", "local-key"));
});

test("a denied path's folders up to the writable one are denied too, so renaming one away can't carry it off", () => {
  const { wt, policy } = places();
  const all = guarded(policy);
  expect(all).toContain(join(wt, ".claude", "settings.json"));
  expect(all).toContain(join(wt, ".claude"));
  expect(all).toContain(wt);
});

test("a lead in its own checkout writes the project but not its .git config or hooks; on watch, not even the project", () => {
  const { repo, common, r, home, ops } = places();
  const lead = sandboxPolicy({ ...r, cwd: repo, gitDir: common, run: "lead-app" }, home, ops);
  expect(lead.write).toContain(repo);
  expect(lead.deny).toContain(join(common, "config"));
  expect(guarded(lead)).toContain(common);
  const watch = sandboxPolicy({ ...r, readOnly: true }, home, ops);
  expect(watch.write).not.toContain(r.cwd);
  expect(watch.write.some((w) => w.startsWith(common))).toBe(false);
});

test("a CLI whose login can't move writes its state folder under your home, never the files that steer it", () => {
  const { r, home, ops } = places();
  const cursor = sandboxPolicy({ ...r, runtime: "cursor", configDir: "" }, home, ops);
  expect(cursor.write).toContain(join(home, ".cursor"));
  expect(cursor.deny).toContain(join(home, ".cursor", "hooks.json"));
});

test("no run writes your own Claude Code or Codex config and state, even one that came with no folder", () => {
  const { r, home, ops } = places();
  for (const run of [r, { ...r, runtime: "codex" as const, configDir: "" }, { ...r, configDir: "" }]) {
    const p = sandboxPolicy(run, home, ops);
    for (const own of [".claude", ".claude.json", ".codex"]) {
      expect(p.write).not.toContain(join(home, own));
      expect(p.deny).toContain(join(home, own));
    }
  }
});

test("the macOS profile denies on enforce and only reports on log", () => {
  const { policy } = places();
  const enforce = macProfile(policy, "enforce");
  expect(enforce).toContain(`(deny file-write* (subpath "/"))`);
  expect(enforce).toContain("(deny file-read*");
  expect(enforce).toContain("tmux-");
  const log = macProfile(policy, "log");
  expect(log).not.toContain("(deny");
  expect(log).toContain("(with report)");
});

test("bubblewrap's stand-in for a missing commondir says '.', so git in and out of the sandbox works, then goes", () => {
  const { repo, common, r, home, ops } = places();
  const lead = sandboxPolicy({ ...r, cwd: repo, gitDir: common, run: "lead-app" }, home, ops);
  const { args, created } = bwrapArgs(lead);
  const commondir = join(common, "commondir");
  expect(created).toContain(commondir);
  expect(readFileSync(commondir, "utf8")).toBe(".\n"); // what git outside reads while the run lasts: its own repo
  expect(args.join(" ")).toContain(`--ro-bind ${commondir} ${commondir}`);
  expect(gitPointersOk(repo)).toBe(true);
  cleanCreated(created);
  expect(existsSync(commondir)).toBe(false);
  // a commondir pointing anywhere else is still refused
  writeFileSync(commondir, "/elsewhere\n");
  expect(gitPointersOk(repo)).toBe(false);
});

test("bubblewrap masks only what's there, by its path on disk: a missing socket is left out, a linked folder resolved", () => {
  const root = scratch();
  mkdirSync(join(root, "run"));
  writeFileSync(join(root, "run", "here.sock"), "");
  symlinkSync(join(root, "run"), join(root, "varrun")); // like /var/run → /run
  const policy = {
    write: [],
    deny: [],
    hide: [join(root, "varrun", "here.sock"), join(root, "varrun", "docker.sock"), join(root, "gone", "x")],
  };
  const { args } = bwrapArgs(policy);
  const masked = args.flatMap((a, i) => (a === "--ro-bind" && args[i + 1] === "/dev/null" ? [args[i + 2] ?? ""] : []));
  expect(masked).toContain(join(root, "run", "here.sock")); // through the link, where bwrap can make a mount point
  expect(masked.some((m) => m.includes("varrun"))).toBe(false);
  expect(args.join(" ")).not.toContain(join(root, "run", "docker.sock")); // the fixture's missing socket
  expect(args.join(" ")).not.toContain(join(root, "gone"));
});

test("bubblewrap binds each denied path read-only on top, and a missing one becomes an empty mount point to clean up", () => {
  const { policy, common, wt } = places();
  const { args, created } = bwrapArgs(policy);
  const pairs = args.flatMap((a, i) => (a === "--ro-bind" ? [`${args[i + 1]} ${args[i + 2]}`] : []));
  expect(pairs).toContain(`${join(common, "config")} ${join(common, "config")}`);
  expect(created).toContain(join(wt, ".claude", "settings.json"));
  expect(args.join(" ")).toContain(`--bind ${join(wt, ".claude")} ${join(wt, ".claude")}`);
});

test("off and unsupported systems run the command as it is; log on Linux too (bubblewrap can't only report)", () => {
  const { policy } = places();
  expect(sandboxArgv(["true"], policy, "off", "darwin").argv).toEqual(["true"]);
  expect(sandboxArgv(["true"], policy, "enforce", "win32").argv).toEqual(["true"]);
  expect(sandboxArgv(["true"], policy, "log", "linux").argv).toEqual(["true"]);
  expect(sandboxArgv(["true"], policy, "enforce", "darwin").argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
  expect(sandboxArgv(["true"], policy, "enforce", "linux").argv.at(-2)).toBe("--");
});

test.skipIf(process.platform !== "darwin")("the probe works on this Mac: true runs, a refused write is refused", () => {
  expect(probeSandbox()).toEqual({ ok: true, why: "" });
});

test.skipIf(process.platform !== "darwin")("both generated profiles are ones macOS accepts", () => {
  const { policy } = places();
  for (const mode of ["log", "enforce"] as const) {
    const r = Bun.spawnSync(sandboxArgv(["/usr/bin/true"], policy, mode).argv, { stderr: "pipe" });
    expect(r.stderr.toString(), mode).toBe("");
    expect(r.exitCode, mode).toBe(0);
  }
});

test("the daemon takes in a sandboxed run's outbox as claims: only its own run's heartbeats, blocks and requests", () => {
  const ops = scratch();
  const box = outboxDir(ops, "T-1");
  const beat = (id: string, run: string): Beat => ({
    ...{ id, run, project: "app", pid: 0, cwd: "/x", home: "", transcript: "", startedAt: 1, lastAt: 1, lastTool: "Bash" },
    ...{ files: [], rulesSeen: "", prs: [] },
  });
  saveBeat(ops, beat("yours", ""));
  saveBeat(box, beat("s-mine", "T-1"));
  saveBeat(box, beat("s-forged", "T-2")); // claims another run
  saveBeat(box, beat("yours", "T-1")); // claims your own session
  const row = (run: string) => JSON.stringify({ at: 1, project: "app", run, tool: "Bash", action: "x", rule: "r" });
  writeFileSync(join(box, "guardrails.jsonl"), [row("T-1"), row("T-2"), "not json"].join("\n"));
  const log = join(ops, "guardrails.jsonl");
  ingestOutboxes(ops, log);
  expect(beatOf(ops, "s-mine")?.run).toBe("T-1");
  expect(beatOf(ops, "s-forged")).toBeNull();
  expect(beatOf(ops, "yours")?.run).toBe("");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines.map((l) => (JSON.parse(l) as { run: string }).run)).toEqual(["T-1"]);
  expect(existsSync(join(box, "guardrails.jsonl"))).toBe(false);
});

test("the probe says why when the sandbox tool is missing", () => {
  expect(probeSandbox("win32").ok).toBe(false);
});

test("where the sandbox can't run: macOS refuses runs, Linux runs on the guard alone unless told to refuse", () => {
  const broken = () => ({ ok: false, why: "user namespaces are off" });
  const fine = () => ({ ok: true, why: "" });
  const on = { mode: "enforce" as const, required: false };
  expect(sandboxState({ mode: "off", required: true }, "linux", broken)).toMatchObject({ effective: "off", refuse: false });
  expect(sandboxState(on, "darwin", broken)).toMatchObject({ effective: "off", ok: false, refuse: true });
  expect(sandboxState(on, "linux", broken)).toMatchObject({ effective: "off", ok: false, refuse: false, why: "user namespaces are off" });
  expect(sandboxState({ ...on, required: true }, "linux", broken)).toMatchObject({ refuse: true });
  expect(sandboxState(on, "linux", fine)).toMatchObject({ effective: "enforce", ok: true });
  // log only records on macOS
  expect(sandboxState({ mode: "log", required: false }, "linux", fine).effective).toBe("off");
  expect(sandboxState({ mode: "log", required: false }, "darwin", fine).effective).toBe("log");
});

test("a spawn gets its own run key always, the sandbox when it's on, and none when it must refuse", () => {
  const { r, ops } = places();
  // a config folder of Overhand's: one on your own config waits under enforce (sandbox-move.test.ts)
  const s = { ...r, configDir: join(AGENT_HOMES, "claude-code"), argv: ["claude", "-p", "hi"], env: { PATH: "/usr/bin" } };
  const st = (effective: "off" | "enforce", refuse = false) => ({
    mode: effective,
    effective,
    ok: !refuse,
    why: refuse ? "no" : "",
    refuse,
  });
  const off = sandboxSpawn(s, st("off"), () => "", ops);
  expect(off.argv).toEqual(s.argv);
  expect(off.sandboxed).toBe(false);
  expect(off.env[RUN_KEY_ENV]?.length).toBeGreaterThanOrEqual(43);
  const on = sandboxSpawn(s, st("enforce"), () => r.gitCommon, ops);
  expect(on.sandboxed).toBe(on.argv[0] !== "claude");
  expect(on.argv.slice(-3)).toEqual(s.argv);
  expect(existsSync(outboxDir(ops, "T-1"))).toBe(on.sandboxed);
  expect(() => sandboxSpawn(s, st("enforce", true), () => "", ops)).toThrow("can't run here");
});

test("a sandboxed run's record says so, and its guard writes to its outbox, never control/", () => {
  recordSpawn(OPS, { pid: process.pid, exited: new Promise(() => {}) }, { OVERHAND_RUN: "T-9" }, true);
  expect(runOf(OPS, [process.pid])).toMatchObject({ run: "T-9", sandboxed: true });
  const env: Record<string, string | undefined> = { OVERHAND_RUN: "T-9" };
  trustIdentity([process.pid], env);
  expect(guardWriteRoot()).toBe(outboxDir(OPS, "T-9"));
  forgetRun(OPS, process.pid);
  trustIdentity([process.pid], {});
  expect(guardWriteRoot()).toBe(OPS);
});
