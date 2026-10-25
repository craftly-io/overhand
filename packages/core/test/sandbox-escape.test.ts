/**
 * Escape tests inside the real OS sandbox (macOS sandbox-exec; Linux bubblewrap where it runs, as in CI): what a run
 * must never write or read fails however it's spelled, and what a run needs (its worktree, caches, git in a worktree)
 * works. Each case runs a shell inside the sandbox built from the same policy every run gets (sandbox.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { localKey } from "../src/devices";
import { OPS, UI_PORT } from "../src/env";
import {
  claudeCache,
  probeSandbox,
  projectCache,
  type RunPlaces,
  real,
  runCacheEnv,
  type SandboxPolicy,
  sandboxArgv,
  sandboxPolicy,
} from "../src/sandbox";
import { handle } from "../src/server";

const works = probeSandbox().ok;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const mac = process.platform === "darwin";

// CI installs bubblewrap (ci.yml): there these tests must run, never skip quietly
test.skipIf(!process.env.CI)("in CI the sandbox runs, so the escape tests below aren't skipped", () => {
  expect(probeSandbox()).toEqual({ ok: true, why: "" });
});

const root = real(mkdtempSync(join(tmpdir(), "overhand-escape-")));
const home = join(root, "home");
const runTmp = join(root, "run-tmp");
const repo = join(root, "code", "app");
const other = join(root, "code", "other");
const remote = join(root, "remote.git");
const wt = join(repo, ".claude", "worktrees", "T-1");
const common = join(repo, ".git");
const ownTmp = join(root, "own-tmp");
const ownCache = projectCache("app", OPS);
const tmuxSock = `/private/tmp/tmux-sbxtest-${process.pid}/default`;
let tmux: ReturnType<typeof Bun.listen> | null = null;
let plainSock: ReturnType<typeof Bun.listen> | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let gitPort = 0;
let server: ReturnType<typeof Bun.serve> | null = null;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

beforeAll(async () => {
  if (!works) return;
  // as on a real machine: bun's cache is there already, and the daemon makes the run's outbox before it starts
  const made = [join(home, ".bun", "install", "cache"), join(OPS, "from-runs", "T-1", "control", "sessions")];
  const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
  const dirs = [
    home,
    runTmp,
    ownTmp,
    ownCache,
    projectCache("other", OPS),
    other,
    join(home, "Library", "LaunchAgents"),
    join(home, ".claude"),
    join(home, ".ssh"),
    chrome,
    // as sandboxSpawn makes it before a Claude Code run, and another project's beside it
    claudeCache(wt, home),
    claudeCache(other, home),
  ];
  for (const d of [...dirs, join(OPS, "agent-home", "claude-code", "plugins"), ...made]) mkdirSync(d, { recursive: true });
  writeFileSync(join(chrome, "Cookies"), "secret");
  // a terminal multiplexer's socket, where tmux keeps it
  if (mac) {
    mkdirSync(dirname(tmuxSock), { recursive: true });
    tmux = Bun.listen({ unix: tmuxSock, socket: { data() {} } });
    plainSock = Bun.listen({ unix: join(dirname(tmuxSock), "..", `plain-${process.pid}.sock`), socket: { data() {} } });
  }
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  writeFileSync(join(home, ".zshrc"), "");
  writeFileSync(join(home, ".ssh", "id_test"), "secret");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "secret");
  writeFileSync(join(home, ".git-credentials"), "secret");
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".aws", "credentials"), "secret");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), "{}");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(root, "init", "-q", "--bare", remote);
  git(repo, "worktree", "add", "-q", "-b", "feat", wt, "main");
  mkdirSync(join(OPS, "agent-home", "claude-code"), { recursive: true });
  writeFileSync(join(OPS, "agent-home", "claude-code", "settings.json"), "{}");
  localKey(OPS);
  // a git remote over the network, as a real one is: git daemon on loopback
  gitPort = 20000 + Math.floor(Math.random() * 20000);
  daemon = Bun.spawn(
    [
      "git",
      "daemon",
      "--export-all",
      "--enable=receive-pack",
      "--reuseaddr",
      `--base-path=${root}`,
      `--port=${gitPort}`,
      "--listen=127.0.0.1",
      root,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    const ok = await Bun.connect({ hostname: "127.0.0.1", port: gitPort, socket: { data() {} } }).then(
      (s) => {
        s.end();
        return true;
      },
      () => false,
    );
    if (ok) break;
    await Bun.sleep(100);
  }
  git(repo, "remote", "add", "origin", `git://127.0.0.1:${gitPort}/remote.git`);
  // the dashboard API, answering like the daemon does
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
});

afterAll(() => {
  tmux?.stop(true);
  plainSock?.stop(true);
  daemon?.kill();
  void server?.stop(true);
});

const place = (over: Partial<RunPlaces> = {}): RunPlaces => ({
  cwd: wt,
  gitCommon: common,
  gitDir: join(common, "worktrees", "T-1"),
  runtime: "claude-code",
  configDir: join(OPS, "agent-home", "claude-code"),
  run: "T-1",
  readOnly: false,
  runTmp: ownTmp,
  cache: ownCache,
  ...over,
});
const ticket = (): SandboxPolicy => sandboxPolicy(place(), home, OPS);
const lead = (): SandboxPolicy => sandboxPolicy(place({ cwd: repo, gitDir: common, run: "lead-app" }), home, OPS);

/** Runs `cmd` in a shell inside the sandbox for `policy`; true when it exited 0. */
function inside(policy: SandboxPolicy, cmd: string, cwd = wt): boolean {
  const r = Bun.spawnSync(sandboxArgv(["/bin/sh", "-c", cmd], policy, "enforce").argv, {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...runCacheEnv(ownTmp, ownCache) },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  // in CI, what a refused command said, so a failing case can be read from the log
  if (process.env.CI && r.exitCode !== 0) console.error(`inside the sandbox: ${cmd}\n${r.stderr.toString().trim()}`);
  return r.exitCode === 0;
}

const q = (p: string) => `'${p}'`;
/** A shell command that connects to a unix socket and exits 0 when it could (macOS's nc can't test a unix socket). */
const connect = (sock: string) =>
  `bun -e 'await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }).then((s) => { s.end(); process.exit(0) }, () => process.exit(1))'`;

describe.skipIf(!works)("inside the real sandbox, a run can't", () => {
  const cases: [string, () => SandboxPolicy, string][] = [
    ["write Overhand's config", ticket, `echo x >> ${q(join(OPS, "overhand.config.json"))}`],
    ["write Overhand's control folder", ticket, `echo x > ${q(join(OPS, "control", "runs.json"))}`],
    ["write another project", ticket, `echo x > ${q(join(other, "x"))}`],
    ["write the main checkout", ticket, `echo x > ${q(join(repo, "x"))}`],
    ["write your own ~/.claude/settings.json", ticket, `echo x >> ${q(join(home, ".claude", "settings.json"))}`],
    ["write your own Claude Code state", ticket, `mkdir -p ${q(join(home, ".claude", "projects", "x"))}`],
    ["write your own ~/.claude.json (your sessions' MCP servers)", ticket, `echo '{}' > ${q(join(home, ".claude.json"))}`],
    ["write your own ~/.codex", ticket, `mkdir -p ${q(join(home, ".codex"))}`],
    ["write the settings of its own agent's folder", ticket, `echo x >> ${q(join(OPS, "agent-home", "claude-code", "settings.json"))}`],
    ["write the project's .claude/settings.json", lead, `echo x >> ${q(join(repo, ".claude", "settings.json"))}`],
    ["write ~/.zshrc", ticket, `echo x >> ${q(join(home, ".zshrc"))}`],
    ["write a LaunchAgent", ticket, `echo x > ${q(join(home, "Library", "LaunchAgents", "x.plist"))}`],
    ["write .git/config from a worktree", ticket, `echo x >> ${q(join(common, "config"))}`],
    ["write .git/config from its own checkout", lead, `echo x >> ${q(join(common, "config"))}`],
    ["write a git hook", lead, `echo x > ${q(join(common, "hooks", "pre-commit"))}`],
    ["rename .git away to reach its config", lead, `mv ${q(common)} ${q(join(repo, ".gitx"))}`],
    ["rename .claude away to reach its settings", lead, `mv ${q(join(repo, ".claude"))} ${q(join(repo, ".claudex"))}`],
    ["write through a symlink it made", ticket, `ln -sf ${q(join(other, "y"))} link && echo x > link`],
    ["hard-link a protected file to a writable name", lead, `ln ${q(join(common, "config"))} ${q(join(repo, "cfg"))}`],
    ["read an SSH key it isn't given", ticket, `cat ${q(join(home, ".aws", "credentials"))}`],
    // your GitHub and SSH sign-ins: Overhand pushes a run's branch itself (agent.ts pushBranch)
    ["read your SSH keys", ticket, `cat ${q(join(home, ".ssh", "id_test"))}`],
    ["read gh's GitHub sign-in", ticket, `cat ${q(join(home, ".config", "gh", "hosts.yml"))}`],
    ["read git's stored passwords", ticket, `cat ${q(join(home, ".git-credentials"))}`],
    ["read Overhand's local key", ticket, `cat ${q(join(OPS, "control", "local-key"))}`],
    ["read a browser's cookies", ticket, `cat ${q(join(home, "Library", "Application Support", "Google", "Chrome", "Cookies"))}`],
    // where git finds the repository: rewritten, the daemon's next git there would read the run's own config
    ["rewrite its worktree's .git file", ticket, `echo 'gitdir: /tmp/x' > .git`],
    ["rewrite its worktree's commondir", ticket, `echo /tmp/x > ${q(join(common, "worktrees", "T-1", "commondir"))}`],
    ["point its main checkout's git at another repository (commondir)", lead, `echo /tmp/x > ${q(join(common, "commondir"))}`],
    ["write its worktree's own git config", ticket, `echo x > ${q(join(common, "worktrees", "T-1", "config.worktree"))}`],
    ["add a project MCP server", ticket, `echo '{}' > .mcp.json`],
    [
      "swap its outbox's sessions folder for a symlink",
      ticket,
      `mv ${q(join(OPS, "from-runs", "T-1", "control", "sessions"))} ${q(join(OPS, "from-runs", "T-1", "control", "s2"))}`,
    ],
    ["write the shared temp folder", ticket, `echo x > ${q(join(tmpdir(), `shared-${process.pid}`))}`],
    ["rewrite another worktree's gitdir from its checkout", lead, `echo /tmp/x > ${q(join(common, "worktrees", "T-1", "gitdir"))}`],
    // its caches are its own, gone when it ends: a hook or browser it downloads never runs later as you
    ["write your own package cache", ticket, `mkdir -p ${q(join(home, ".bun", "install", "cache", "pkg"))}`],
    ["add a plugin to its agent's folder", ticket, `echo x > ${q(join(OPS, "agent-home", "claude-code", "plugins", "p.json"))}`],
    ["write another project's cache", ticket, `echo x > ${q(join(projectCache("other", OPS), "x"))}`],
    ["rename its outbox away", ticket, `mv ${q(join(OPS, "from-runs", "T-1"))} ${q(join(OPS, "from-runs", "T-1x"))}`],
    ["write a project on watch", () => sandboxPolicy(place({ readOnly: true }), home, OPS), "echo x > w.txt"],
    // Claude Code's own state: only this run's folders, never the shared parents or another project's
    ["write the shared /tmp", ticket, `echo x > /tmp/overhand-shared-${process.pid}`],
    ["write Claude Code's shared temp", ticket, `mkdir -p /tmp/claude-${uid}/overhand-${process.pid}`],
    ["write another project's Claude Code logs", ticket, `echo x > ${q(join(claudeCache(other, home), "x"))}`],
    ["make a Claude Code log folder of its choosing", ticket, `mkdir ${q(join(dirname(claudeCache(wt, home)), `x-${process.pid}`))}`],
    ["swap its Claude Code log folder for a symlink", ticket, `mv ${q(claudeCache(wt, home))} ${q(`${claudeCache(wt, home)}x`)}`],
    ["write your own node-gyp headers", ticket, `mkdir -p ${q(join(home, "Library", "Caches", "node-gyp", "24"))}`],
  ];
  // macOS's per-user temp and cache folders (confstr DARWIN_USER_TEMP_DIR, DARWIN_USER_CACHE_DIR), which some tools use
  // whatever TMPDIR says: the shared folders stay closed, the run's temp is its own folder inside
  for (const name of ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"])
    test.skipIf(!mac)(`write macOS's shared ${name}`, () => {
      const dir = Bun.spawnSync(["getconf", name]).stdout.toString().trim();
      expect(dir).not.toBe("");
      expect(inside(ticket(), `echo x > ${q(join(dir, `overhand-shared-${process.pid}`))}`)).toBe(false);
    });
  test.skipIf(!mac)("connect to your tmux", () => {
    expect(inside(ticket(), connect(tmuxSock))).toBe(false);
  });
  for (const [what, policy, cmd] of cases) test(what, () => expect(inside(policy(), cmd)).toBe(false));

  // Not blocked: asking another app to act (osascript's Apple Events, `open`). Denying launchservicesd and appleevents
  // didn't stop `tell application "Finder"`, and denying lsd.* hangs AppKit tools; SANDBOX_LIMIT says so. This case
  // records it, so a profile that does block it shows up here.
  test.skipIf(!mac)("(known gap, SANDBOX_LIMIT) ask Finder something by Apple Events", () => {
    expect(inside(ticket(), `osascript -e 'tell application "Finder" to get name'`)).toBe(true);
  });

  test("call the daemon's API without the local key: 401", async () => {
    const port = server?.port ?? 0;
    // async: the API answers from this same process, which a blocking spawn would hold up
    const status = async (key: string) => {
      const curl = `curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:${UI_PORT}' -H "x-overhand-key: ${key}" http://127.0.0.1:${port}/api/state`;
      const p = Bun.spawn(sandboxArgv(["/bin/sh", "-c", curl], ticket(), "enforce").argv, {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        stdout: "pipe",
      });
      return new Response(p.stdout).text();
    };
    expect(await status(`$(cat ${q(join(OPS, "control", "local-key"))} 2>/dev/null)`)).toBe("401");
    expect(await status("guess")).toBe("401");
  });
});

describe.skipIf(!works)("inside the real sandbox, a run can", () => {
  test("write in its worktree, its own temp and its own package caches", () => {
    expect(inside(ticket(), "echo x > a.txt")).toBe(true);
    expect(inside(ticket(), `echo x > "$TMPDIR/t"`)).toBe(true);
    expect(inside(ticket(), `mkdir -p "$BUN_INSTALL_CACHE_DIR/pkg" && echo x > "$BUN_INSTALL_CACHE_DIR/pkg/x"`)).toBe(true);
    expect(inside(ticket(), `mkdir -p "$PRE_COMMIT_HOME" && echo x > "$PRE_COMMIT_HOME/hook"`)).toBe(true);
    // Gradle, Composer and Maven (whose repo comes by MAVEN_OPTS) cache in the project's folder too
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
    const m2 = 'case "$MAVEN_OPTS" in *maven.repo.local=*) mkdir -p "${MAVEN_OPTS##*=}";; *) exit 1;; esac';
    expect(inside(ticket(), `mkdir -p "$GRADLE_USER_HOME" "$COMPOSER_CACHE_DIR" && ${m2}`)).toBe(true);
  });
  test("build native modules, compile Python and keep Claude Code's state, in its own folders", () => {
    expect(inside(ticket(), `mkdir -p "$npm_config_devdir/24/include" && echo x > "$npm_config_devdir/24/include/common.gypi"`)).toBe(true);
    expect(
      inside(ticket(), `mkdir -p "$CLAUDE_CODE_TMPDIR/claude-${uid}/probe" && echo x > "$CLAUDE_CODE_TMPDIR/claude-${uid}/probe/x"`),
    ).toBe(true);
    expect(
      inside(
        ticket(),
        `mkdir -p ${q(join(claudeCache(wt, home), "mcp-logs-x"))} && echo x > ${q(join(claudeCache(wt, home), "mcp-logs-x", "l"))}`,
      ),
    ).toBe(true);
    expect(
      inside(ticket(), `echo 'x = 1' > m.py && python3 -c 'import m' && test -n "$(find "$PYTHONPYCACHEPREFIX" -name 'm*.pyc')"`),
    ).toBe(true);
  });
  test.skipIf(!mac)("connect to a local socket that isn't a multiplexer's or Docker's", () => {
    expect(inside(ticket(), connect(`/private/tmp/plain-${process.pid}.sock`))).toBe(true);
  });
  test("write its outbox, where its guard writes", () => {
    expect(
      inside(
        ticket(),
        `mkdir -p ${q(join(OPS, "from-runs", "T-1", "control", "sessions"))} && echo x > ${q(join(OPS, "from-runs", "T-1", "guardrails.jsonl"))}`,
      ),
    ).toBe(true);
  });
  test("not write another run's outbox", () => {
    expect(inside(ticket(), `mkdir -p ${q(join(OPS, "from-runs", `T-none-${process.pid}`))}`)).toBe(false);
  });
  test("run bun", () => expect(inside(ticket(), "bun --version")).toBe(true));
  // `overhand ask` and the guard load env.ts, which keeps OPS private: with OPS so already, it writes nothing there
  test("load Overhand's own code (overhand ask, the guard)", () => {
    const env = join(import.meta.dir, "..", "src", "env.ts");
    expect(inside(ticket(), `OVERHAND_HOME=${q(OPS)} bun -e ${q(`await import(${JSON.stringify(env)})`)}`)).toBe(true);
  });
  test("commit, push and fetch in its worktree", () => {
    const g = "git -c user.name=t -c user.email=t@t";
    expect(inside(ticket(), `echo y > b.txt && ${g} add b.txt && ${g} commit -q -m b`)).toBe(true);
    expect(inside(ticket(), `${g} push -q origin feat`)).toBe(true);
    expect(inside(ticket(), `${g} fetch -q origin`)).toBe(true);
    expect(existsSync(join(remote, "refs", "heads", "feat"))).toBe(true);
  });
  // a lead still pushes and uses gh itself (#14): it keeps your sign-ins, every other run has none
  test("as a lead, still read your SSH keys and gh's sign-in", () => {
    expect(inside(lead(), `cat ${q(join(home, ".ssh", "id_test"))} ${q(join(home, ".config", "gh", "hosts.yml"))}`, repo)).toBe(true);
  });
  test("reach your SSH agent only as a lead", async () => {
    const sock = join(real("/tmp"), `oh-agent-${process.pid}.sock`);
    const agent = Bun.listen({ unix: sock, socket: { data() {} } });
    process.env.SSH_AUTH_SOCK = sock;
    try {
      expect(inside(ticket(), connect(sock))).toBe(false);
      expect(inside(lead(), connect(sock), repo)).toBe(true);
    } finally {
      agent.stop(true);
    }
  });
  test("leave what it couldn't write as it was", () => {
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("");
    expect(existsSync(common)).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(true);
  });
});
