import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AGENT_HOMES, selfCommand } from "../src/agent-home";
import { brokerRoute, ghFiles, ghRefusal, gitParts, gitRefusal, writeShims } from "../src/broker";
import { RUN_KEY_ENV, RUN_KEY_HEADER, recordSpawn, runKey } from "../src/control";
import { CFG, CODE, DASHBOARD, OPS } from "../src/env";
import type { Godmode } from "../src/leads";
import { sandboxSpawn, sandboxState } from "../src/sandbox";
import { handle } from "../src/server";

const root = realpathSync(mkdtempSync(join(tmpdir(), "overhand-broker-test-")));
const repo = join(root, "app");
const remote = join(root, "remote.git");
const bin = join(root, "bin");
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .stdout.toString()
    .trim();

const lead: Godmode = {
  key: "broker-test",
  label: "Broker test lead",
  name: "",
  dir: relative(CODE, repo),
  project: "",
  goal: "",
  prompt: "",
  supervised: false,
  onDemand: false,
  account: "",
  fallbackToAll: true,
  lockFile: "",
  lockStaleMin: 45,
  inboxFile: "",
  restartAfterMin: 5,
  maxCrashesPerHour: 3,
  answerWaitHours: 4,
  pushBranches: [],
};
const who = { run: "lead-broker-test", autonomy: "act", project: "" };
const saved = { godmode: CFG.godmode, path: process.env.PATH };

beforeAll(() => {
  git(root, "init", "-q", "--bare", remote);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "feat");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "commit", "-q", "--allow-empty", "-m", "one");
  // a stand-in gh: what it was run with, and the files it was handed
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh $*"\nfor a do case "$a" in /*) [ -f "$a" ] && cat "$a";; esac; done\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${saved.path}`;
  CFG.godmode = [...CFG.godmode, lead];
});
afterAll(() => {
  CFG.godmode = saved.godmode;
  process.env.PATH = saved.path;
  rmSync(root, { recursive: true, force: true });
});

test("the stand-in sends what each file gh would read holds, never its path", async () => {
  const read = async (p: string) => `<${p}>`;
  expect(await ghFiles(["pr", "create", "--body-file", "/tmp/b.md", "-t", "x"], read)).toEqual({
    args: ["pr", "create", "--body-file", "@@overhand-file:0", "-t", "x"],
    files: ["</tmp/b.md>"],
  });
  expect((await ghFiles(["issue", "comment", "1", "-F", "c.md"], read)).files).toEqual(["<c.md>"]);
  expect(await ghFiles(["api", "repos/o/r", "-F", "body=@x.json", "-F", "n=1", "--input=-"], read)).toEqual({
    args: ["api", "repos/o/r", "-F", "body=@@@overhand-file:0", "-F", "n=1", "--input=@@overhand-file:1"],
    files: ["<x.json>", "<->"],
  });
});

test("Overhand runs a lead's gh only as gh's own commands it takes, and never reads a file by its path", () => {
  expect(ghRefusal(["pr", "create", "--body-file", "@@overhand-file:0"], 1)).toBeNull();
  expect(ghRefusal(["pr", "view", "3", "--json", "state"], 0)).toBeNull();
  expect(ghRefusal(["pr", "create", "--body-file", `${process.env.HOME}/.ssh/id_rsa`], 0)).toContain("not by a path");
  expect(ghRefusal(["api", "x", "-F", "k=@/etc/passwd"], 0)).toContain("not by a path");
  expect(ghRefusal(["pr", "create", "--body-file", "@@overhand-file:3"], 1)).toContain("didn't send");
  expect(ghRefusal(["auth", "token"], 0)).toContain("not auth");
  expect(ghRefusal(["extension", "exec", "x"], 0)).toContain("not extension");
  expect(ghRefusal(["pr", "checkout", "3"], 0)).toContain("git switch");
  expect(ghRefusal(["repo", "clone", "o/r"], 0)).toContain("view and list");
  expect(ghRefusal(["run", "download", "1", "-D", "/tmp"], 0)).toContain("download");
});

test("Overhand pushes and fetches only by a remote's name, with options it knows", () => {
  const remotes = ["origin"];
  expect(gitRefusal(["push", "-u", "origin", "feat"], remotes)).toBeNull();
  expect(gitRefusal(["fetch", "--depth=1", "origin"], remotes)).toBeNull();
  expect(gitRefusal(["push"], remotes)).toBeNull();
  expect(gitRefusal(["push", "/tmp/evil.git", "feat"], remotes)).toContain("remotes");
  expect(gitRefusal(["push", "ext::sh -c id", "feat"], remotes)).toContain("remotes");
  expect(gitRefusal(["push", "--receive-pack=sh", "origin"], remotes)).toContain("--receive-pack");
  expect(gitRefusal(["fetch", "--upload-pack", "sh", "origin"], remotes)).toContain("--upload-pack");
  expect(gitRefusal(["push", "origin", "+feat"], remotes)).toContain("force");
  expect(gitRefusal(["commit", "-m", "x"], remotes)).toContain("not commit");
  expect(gitParts(["-C", "sub", "push"], "/r")).toEqual({ cwd: "/r/sub", args: ["push"] });
  expect(gitParts(["-c", "core.sshCommand=sh", "push"], "/r")).toBeNull();
});

test("a lead's push goes to its remote with your sign-in; the guard's rules still hold", async () => {
  expect(await brokerRoute({ tool: "git", args: ["push", "-q", "origin", "feat"], cwd: repo }, who)).toMatchObject({ code: 0 });
  expect(git(remote, "rev-parse", "feat")).toBe(git(repo, "rev-parse", "HEAD"));
  const main = await brokerRoute({ tool: "git", args: ["push", "origin", "feat:main"], cwd: repo }, who);
  expect(main.code).toBe(1);
  expect(main.err).toContain("feature branch");
  expect((await brokerRoute({ tool: "git", args: ["push", "origin", "feat"], cwd: root }, who)).err).toContain("own repository");
});

test("only a lead's own run asks, and gh gets the files' text in files of the daemon's", async () => {
  expect((await brokerRoute({ tool: "gh", args: ["pr", "list"], cwd: repo }, { ...who, run: "APP-1" })).err).toContain("only a lead");
  const r = await brokerRoute(
    { tool: "gh", args: ["pr", "create", "--body-file", "@@overhand-file:0"], cwd: repo, files: ["the body"] },
    who,
  );
  expect(r.code).toBe(0);
  expect(r.out).toContain("gh pr create --body-file /");
  expect(r.out).toContain("the body");
  expect((await brokerRoute({ tool: "gh", args: ["pr", "merge", "3"], cwd: repo }, who)).err).toContain("for humans");
});

test("the git stand-in hands push, fetch, pull and ls-remote to Overhand and runs everything else itself", () => {
  const self = join(root, "self.sh");
  writeFileSync(self, `#!/bin/sh\necho "$*"\n`);
  chmodSync(self, 0o755);
  const shims = writeShims(join(root, "shims"), [self], "/usr/bin/git");
  const run = (...args: string[]) =>
    Bun.spawnSync([join(shims, "git"), ...args], { cwd: repo })
      .stdout.toString()
      .trim();
  expect(run("-C", repo, "push", "origin")).toBe(`broker git -C ${repo} push origin`);
  expect(run("fetch")).toBe("broker git fetch");
  expect(run("rev-parse", "--abbrev-ref", "HEAD")).toBe("feat"); // the real git
  expect(run("log", "-1", "--format=%s", "--grep", "push")).toBe(""); // "push" after the command is the command's
  expect(run("tag", "push")).toBe("");
  expect(git(repo, "tag")).toBe("push");
  expect(readFileSync(join(shims, "gh"), "utf8")).toContain(`'${self}' 'broker' gh "$@"`);
});

test("the stand-in reaches the daemon by the lead's own run key, and a ticket run's key gets nothing done", async () => {
  const ask = (k: string) =>
    handle(
      new Request(`${DASHBOARD}/api/run/broker`, {
        method: "POST",
        headers: { origin: DASHBOARD, "content-type": "application/json", [RUN_KEY_HEADER]: k },
        body: JSON.stringify({ tool: "git", args: ["ls-remote", "--heads", "origin"], cwd: repo }),
      }),
    );
  const leadKey = runKey();
  recordSpawn(OPS, { pid: process.pid, exited: new Promise(() => {}) }, { OVERHAND_RUN: who.run, [RUN_KEY_ENV]: leadKey });
  const ok = (await (await ask(leadKey)).json()) as { code: number; out: string };
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("refs/heads/feat");
  const ticketKey = runKey();
  recordSpawn(OPS, { pid: process.pid, exited: new Promise(() => {}) }, { OVERHAND_RUN: "APP-1", [RUN_KEY_ENV]: ticketKey });
  expect(((await (await ask(ticketKey)).json()) as { err: string }).err).toContain("only a lead");
  expect((await ask("not-a-key")).status).toBe(401);
});

// the whole way, as a lead runs it: its stand-in git, inside the OS sandbox with no sign-in, through the daemon's route
test.skipIf(process.platform !== "darwin" || !Bun.which("sandbox-exec"))("a sandboxed lead pushes through its stand-in git", async () => {
  git(repo, "commit", "-q", "--allow-empty", "-m", "two");
  // the daemon's handler on a port of its own (the tests' own port is a running Overhand's)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set("origin", DASHBOARD);
      headers.set("host", new URL(DASHBOARD).host);
      return handle(new Request(`${DASHBOARD}${url.pathname}`, { method: req.method, headers, body: req.body }));
    },
  });
  try {
    const shims = writeShims(join(root, "lead-shims"), selfCommand(false, process.execPath, join(import.meta.dir, "..", "..", "..")));
    const spawn = sandboxSpawn(
      {
        cwd: repo,
        runtime: "claude-code",
        configDir: join(AGENT_HOMES, "claude-code"),
        run: who.run,
        readOnly: false,
        argv: ["git", "push", "-q", "origin", "feat"],
        env: {
          PATH: `${shims}:/usr/bin:/bin`,
          HOME: process.env.HOME ?? "",
          OVERHAND_HOME: OPS,
          OVERHAND_PORT: String(server.port),
          OVERHAND_RUN: who.run,
        },
      },
      sandboxState({ mode: "enforce", required: false, project: "inherit" }, "darwin", () => ({ ok: true, why: "" })),
      () => git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const proc = Bun.spawn(spawn.argv, { cwd: repo, env: spawn.env, stdout: "pipe", stderr: "pipe" });
    recordSpawn(OPS, proc, spawn.env);
    const code = await proc.exited;
    spawn.done(Date.now());
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(code).toBe(0);
    expect(git(remote, "rev-parse", "feat")).toBe(git(repo, "rev-parse", "HEAD"));
  } finally {
    server.stop(true);
  }
});
