import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRepos } from "../src/cleanup";
import {
  agentForPlan,
  CHAT_PLANS,
  connectCommand,
  GEMINI_KEY_URL,
  geminiKeyItem,
  installCommand,
  proposeProjects,
  signInCommand,
} from "../src/onboard";
import {
  additions,
  addRepos,
  cloneInto,
  describeCopy,
  explainError,
  findCopies,
  forgetAdditions,
  newest,
  parseRepoInput,
  parseRepoList,
  remoteUrls,
  repoKey,
  tilde,
} from "../src/projects";

const scratch = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `overhand-${name}-`)));
const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** A bare repo with one commit: the "remote" a clone comes from, never the network. */
function bareRemote(root: string, name: string): string {
  const work = join(root, `${name}-work`);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "first");
  const bare = join(root, `${name}.git`);
  git(root, "clone", "-q", "--bare", work, bare);
  return bare;
}

/** A checkout with an origin URL and a commit at `when` (unix seconds). */
function checkout(dir: string, origin: string, when: number, extraRemote = ""): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  if (extraRemote) git(dir, "remote", "add", "upstream", extraRemote);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: `${when} +0000`, GIT_AUTHOR_DATE: `${when} +0000` },
  });
  return dir;
}

afterEach(() => forgetAdditions());

const FIXTURE = JSON.stringify([
  {
    name: "web",
    owner: { id: "1", login: "honeycrust" },
    isPrivate: true,
    isArchived: false,
    pushedAt: "2026-10-19T08:00:00Z",
    primaryLanguage: { name: "TypeScript" },
  },
  {
    name: "old",
    owner: { id: "1", login: "honeycrust" },
    isPrivate: false,
    isArchived: true,
    pushedAt: "2020-01-01T00:00:00Z",
    primaryLanguage: null,
  },
  { name: "notes", owner: { id: "1", login: "honeycrust" }, isPrivate: false, isArchived: false, pushedAt: null, primaryLanguage: null },
]);

test("parseRepoList reads gh repo list --json, leaves archived repos out, and survives junk", () => {
  expect(parseRepoList(FIXTURE)).toEqual([
    { owner: "honeycrust", name: "web", private: true, pushedAt: "2026-10-19T08:00:00Z", language: "TypeScript" },
    { owner: "honeycrust", name: "notes", private: false, pushedAt: "", language: "" },
  ]);
  expect(parseRepoList("not json")).toEqual([]);
  expect(parseRepoList('{"message":"Bad credentials"}')).toEqual([]);
});

test("parseRepoInput takes https and ssh URLs, with or without .git, page URLs and owner/name shorthand", () => {
  const web = { owner: "honeycrust", name: "web", url: "https://github.com/honeycrust/web.git" };
  for (const s of [
    "https://github.com/honeycrust/web",
    "https://github.com/honeycrust/web.git",
    "https://github.com/honeycrust/web/",
    "https://github.com/honeycrust/web/tree/main/src",
    "git@github.com:honeycrust/web.git",
    "git@github.com:honeycrust/web",
    "ssh://git@github.com/honeycrust/web.git",
    "honeycrust/web",
    "  honeycrust/web.git  ",
  ])
    expect(parseRepoInput(s), s).toEqual(web);
  expect(parseRepoInput("git@bitbucket.org:fernway/app.git")).toEqual({
    owner: "fernway",
    name: "app",
    url: "git@bitbucket.org:fernway/app.git",
  });
  for (const s of ["", "web", "not a url", "https://github.com/honeycrust"]) expect(parseRepoInput(s), s).toBeNull();
});

test("repoKey matches one repo across https, ssh, .git and case", () => {
  const k = "github/honeycrust/web";
  for (const u of ["https://github.com/Honeycrust/Web.git", "git@github.com:honeycrust/web", "ssh://git@github.com/HONEYCRUST/web.git"])
    expect(repoKey(u), u).toBe(k);
  expect(repoKey("git@github.com:honeycrust/api.git")).not.toBe(k);
  expect(
    remoteUrls(
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:a/b.git\n[remote "up"]\n\turl = https://github.com/c/d\n',
    ),
  ).toEqual(["git@github.com:a/b.git", "https://github.com/c/d"]);
});

test("errors become what to do: the org's SSO page, the exact gh auth refresh, or no access", () => {
  const sso = explainError(
    "remote: The 'honeycrust' organization has enabled or enforced SAML SSO. To access this repository, visit https://github.com/orgs/honeycrust/sso?authorization_request=AB12 and try your request again.",
    "honeycrust",
    "web",
  );
  expect(sso.fix).toBe("https://github.com/orgs/honeycrust/sso?authorization_request=AB12");
  expect(explainError("GraphQL: Resource protected by organization SAML enforcement.", "fernway").fix).toBe(
    "https://github.com/orgs/fernway/sso",
  );
  expect(explainError("error: your authentication token is missing required scopes [read:org]", "you").fix).toBe(
    "gh auth refresh -s read:org",
  );
  const none = explainError("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found", "x", "y");
  expect(none.fix).toBe("");
  expect(none.message).toContain("can't see x/y");
  expect(explainError("GraphQL: Could not resolve to a Repository with the name 'x/y'.", "x", "y").message).toContain("can't see");
});

test("proposeProjects groups added repos by owner and keeps a project's folder when it sits outside the code root", () => {
  const ps = proposeProjects(
    [
      { path: "../Overhand/projects/honeycrust/web", host: "github", owner: "honeycrust", name: "web" },
      { path: "../Overhand/projects/honeycrust/api", host: "github", owner: "honeycrust", name: "api" },
      { path: "sam/blog", host: "github", owner: "sam", name: "blog" },
    ],
    new Set(["HONEY"]),
  );
  expect(ps.map((p) => [p.name, p.dir, p.prefix, p.repos.length])).toEqual([
    ["Honeycrust", "../Overhand/projects/honeycrust", "HONE2", 2],
    ["Sam", "sam", "SAM", 1],
  ]);
});

test("cloneInto makes a full clone in the projects folder, so worktrees work", async () => {
  const root = scratch("clone");
  const bare = bareRemote(root, "web");
  const dest = join(root, "projects", "honeycrust", "web");
  expect(await cloneInto(bare, dest)).toEqual({ ok: true, err: "" });
  expect(git(dest, "rev-parse", "--is-shallow-repository")).toBe("false");
  git(dest, "worktree", "add", "-q", join(root, "wt"), "-b", "x");
  expect(existsSync(join(root, "wt", "README.md"))).toBe(true);
  const failed = await cloneInto(join(root, "missing.git"), join(root, "projects", "honeycrust", "gone"));
  expect(failed.ok).toBe(false);
  expect(existsSync(join(root, "projects", "honeycrust", "gone"))).toBe(false);
});

test("findCopies finds only the chosen repos, reads nothing but their git config, and prunes hidden and node_modules", async () => {
  const home = scratch("copies");
  checkout(join(home, "Code", "honeycrust", "web"), "git@github.com:Honeycrust/Web.git", 1_700_000_000);
  checkout(join(home, "Code", "honeycrust", "api"), "https://github.com/honeycrust/api", 1_700_000_000);
  checkout(join(home, "Code", "node_modules", "web"), "https://github.com/honeycrust/web", 1_700_000_000);
  checkout(join(home, "Code", ".hidden", "web"), "https://github.com/honeycrust/web", 1_700_000_000);
  // a fork whose upstream is the repo: every remote counts
  checkout(join(home, "projects", "fork"), "https://github.com/me/web", 1_700_000_000, "https://github.com/honeycrust/web.git");
  writeFileSync(join(home, "Code", "honeycrust", "web", "secret.env"), "nope");
  const reads: string[] = [];
  const read = async (p: string) => {
    reads.push(p);
    return Bun.file(p).text();
  };
  const { found, partial } = await findCopies(
    new Set(["github/honeycrust/web"]),
    [join(home, "Code"), join(home, "projects")],
    3_000,
    read,
  );
  expect(partial).toBe(false);
  expect((found.get("github/honeycrust/web") ?? []).sort()).toEqual([
    join(home, "Code", "honeycrust", "web"),
    join(home, "projects", "fork"),
  ]);
  expect(reads.length).toBeGreaterThan(0);
  for (const p of reads) expect(p.endsWith("/.git/config"), p).toBe(true);
  expect(reads.some((p) => p.includes("node_modules") || p.includes(".hidden"))).toBe(false);
});

test("findCopies stops at its time budget", async () => {
  const home = scratch("budget");
  for (let i = 0; i < 30; i++) mkdirSync(join(home, `d${i}`, "a", "b", "c"), { recursive: true });
  const t = Date.now();
  const { partial } = await findCopies(new Set(["github/x/y"]), [home], 0);
  expect(partial).toBe(true);
  expect(Date.now() - t).toBeLessThan(500);
});

test("several copies: the most recently committed is used; uncommitted changes don't stop it", async () => {
  const home = scratch("newest");
  const old = checkout(join(home, "Code", "web-old"), "https://github.com/honeycrust/web", 1_600_000_000);
  const recent = checkout(join(home, "src", "web"), "https://github.com/honeycrust/web", 1_700_000_000);
  writeFileSync(join(recent, "wip.txt"), "uncommitted\n");
  const copies = await Promise.all([old, recent].map(describeCopy));
  expect(newest(copies)?.path).toBe(recent);
  expect(copies[1]).toMatchObject({ committed: 1_700_000_000, branch: "main", dirty: true });
  expect(copies[0]?.dirty).toBe(false);
});

test("addRepos links a copy you already have instead of cloning, and clones only when there's none", async () => {
  const home = scratch("add");
  const projects = join(home, "Overhand", "projects");
  const mine = checkout(join(home, "Code", "honeycrust", "web"), "https://github.com/honeycrust/web.git", 1_700_000_000);
  writeFileSync(join(mine, "wip.txt"), "yours\n");
  const bare = bareRemote(home, "api");
  await addRepos(
    [
      { owner: "honeycrust", name: "web", url: "https://github.com/honeycrust/web.git" },
      { owner: "honeycrust", name: "api", url: bare },
    ],
    projects,
    [join(home, "Code")],
  );
  const [web, api] = additions();
  expect(web).toMatchObject({ state: "ready", via: "copy" });
  expect(web?.copy).toMatchObject({ path: mine, dirty: true });
  expect(lstatSync(join(projects, "honeycrust", "web")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(projects, "honeycrust", "web"))).toBe(mine);
  expect(api).toMatchObject({ state: "ready", via: "clone" });
  expect(existsSync(join(projects, "honeycrust", "api", ".git"))).toBe(true);
  // the project's repos include the linked one, so agents work it (in worktrees under its .claude, excluded from git status)
  expect(gitRepos(join(projects, "honeycrust")).sort()).toEqual([join(projects, "honeycrust", "api"), join(projects, "honeycrust", "web")]);
  // your checkout is untouched: same files, same status
  expect(git(mine, "status", "--porcelain")).toBe("?? wip.txt");
  // a fresh copy instead: only the link goes, never your checkout
  const bareWeb = bareRemote(home, "web");
  await addRepos([{ owner: "honeycrust", name: "web", url: bareWeb }], projects, [join(home, "Code")], true);
  expect(additions().find((a) => a.name === "web")).toMatchObject({ state: "ready", via: "clone" });
  expect(lstatSync(join(projects, "honeycrust", "web")).isSymbolicLink()).toBe(false);
  expect(existsSync(join(mine, "wip.txt"))).toBe(true);
});

test("addRepos explains a clone it couldn't make", async () => {
  const home = scratch("addfail");
  const bin = join(home, "bin");
  mkdirSync(bin);
  // a git that answers like GitHub does for a repo you can't see
  writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'remote: Repository not found.' >&2\nexit 128\n");
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await addRepos([{ owner: "x", name: "y", url: "https://github.com/x/y.git" }], join(home, "p"), []);
  } finally {
    process.env.PATH = path;
  }
  expect(additions()[0]).toMatchObject({ state: "failed" });
  expect(additions()[0]?.problem?.message).toContain("can't see x/y");
});

test("the agent setup offers is the one the chat plan you pay for includes; none means an API key", () => {
  expect(CHAT_PLANS.map((p) => [p, agentForPlan(p)])).toEqual([
    ["claude", { agent: "claude-code", credential: "login" }],
    ["chatgpt", { agent: "codex", credential: "login" }],
    ["gemini", { agent: "gemini", credential: "key" }],
    ["none", { agent: "claude-code", credential: "key" }],
  ]);
});

test("install commands are the vendors' own, per OS and what's on the machine; none where it isn't safe", () => {
  const mac = { os: "darwin" as const, brew: true, npm: true };
  const bareLinux = { os: "linux" as const, brew: false, npm: false };
  expect(installCommand("claude-code", mac)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(installCommand("claude-code", bareLinux)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(installCommand("codex", bareLinux)).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(installCommand("gemini", mac)).toBe("brew install gemini-cli");
  expect(installCommand("gemini", { ...bareLinux, npm: true })).toBe("npm install -g @google/gemini-cli");
  expect(installCommand("gemini", bareLinux)).toBeNull();
  expect(installCommand("codex", { os: "win32", brew: false, npm: true })).toBeNull();
  expect(installCommand("aider", mac)).toBeNull();
  expect(signInCommand("codex")).toBe("codex login");
  // Gemini CLI runs on a free AI Studio key, never a Google sign-in: its connect is the install alone
  expect(signInCommand("gemini")).toBeNull();
  expect(connectCommand("brew install gemini-cli", null)).toBe("brew install gemini-cli");
  expect(connectCommand("curl -fsSL https://chatgpt.com/codex/install.sh | sh", "codex login")).toBe(
    'curl -fsSL https://chatgpt.com/codex/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && codex login',
  );
  expect(connectCommand(null, "codex login")).toBe("codex login");
  expect(GEMINI_KEY_URL).toBe("https://aistudio.google.com/app/apikey");
  expect(geminiKeyItem("main")).toBe("gemini-key-main"); // the item the Gemini runtime passes as GEMINI_API_KEY
});

test("tilde shortens only a path inside the home folder, never a sibling folder that starts with its name", () => {
  expect(tilde("/Users/sam/code/app", "/Users/sam")).toBe("~/code/app");
  expect(tilde("/Users/samantha/code/app", "/Users/sam")).toBe("/Users/samantha/code/app");
  expect(tilde("/srv/code/app", "/Users/sam")).toBe("/srv/code/app");
  expect(tilde("", "/Users/sam")).toBe("");
});
