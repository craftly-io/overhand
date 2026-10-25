import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { blankConfig, loadConfig, saveConfig } from "../src/config";
import {
  configFromSetup,
  type FoundAgent,
  homePath,
  parseRemote,
  pickAgent,
  pickBackend,
  pickLocalModel,
  prefixFor,
  proposeProjects,
  SetupSchema,
  scanRepos,
} from "../src/onboard";

test("parseRemote reads ssh and https remotes on GitHub and Bitbucket", () => {
  expect(parseRemote("git@github.com:honeycrust/web.git")).toEqual({ host: "github", owner: "honeycrust", name: "web" });
  expect(parseRemote("https://github.com/honeycrust/api")).toEqual({ host: "github", owner: "honeycrust", name: "api" });
  expect(parseRemote("https://token@github.com/honeycrust/api.git")).toEqual({ host: "github", owner: "honeycrust", name: "api" });
  expect(parseRemote("git@bitbucket.org:fernway/app.git")).toEqual({ host: "bitbucket", owner: "fernway", name: "app" });
  expect(parseRemote("not a remote")).toBeNull();
});

test("prefixFor makes a valid, unused ticket prefix", () => {
  expect(prefixFor("Honeycrust", new Set())).toBe("HONEY");
  expect(prefixFor("honeycrust-labs", new Set())).toBe("HONEY");
  expect(prefixFor("Fernway-com", new Set())).toBe("FERNW");
  expect(prefixFor("Honeycrust", new Set(["HONEY"]))).toBe("HONE2");
  expect(prefixFor("9x", new Set())).toBe("XPRJ");
  expect(prefixFor("Globalexchange", new Set())).toBe("GLOBA");
});

test("proposeProjects makes one project per GitHub owner, in the folder most of its repos share", () => {
  const ps = proposeProjects([
    { path: "honeycrust/web", host: "github", owner: "honeycrust", name: "web" },
    { path: "honeycrust/api", host: "github", owner: "Honeycrust", name: "api" },
    { path: "misc/honeycrust-tools", host: "github", owner: "honeycrust", name: "tools" },
    { path: "fernway", host: "bitbucket", owner: "fernway", name: "app" },
    { path: "blog", host: "github", owner: "sam", name: "blog" },
  ]);
  expect(ps.map((p) => [p.name, p.dir, p.prefix, p.trackerRepo, p.repos.length])).toEqual([
    ["Honeycrust", "honeycrust", "HONEY", "honeycrust/web", 3],
    ["blog", "blog", "BLOG", "sam/blog", 1], // one repo: named after it, not its owner
  ]);
  expect(ps[0]?.trackerRepos).toEqual(["honeycrust/web", "Honeycrust/api", "honeycrust/tools"]); // the choices for its issues
  // the one repo a newcomer picked was "Octocat" with key OCTOC; it's the repo's own name
  const [one] = proposeProjects([{ path: "octocat/Hello-World", host: "github", owner: "octocat", name: "Hello-World" }]);
  expect([one?.name, one?.prefix]).toEqual(["Hello-World", "HELLO"]);
});

test("scanRepos finds repos one and two levels down and skips folders without an origin", () => {
  const root = mkdtempSync(join(tmpdir(), "overhand-scan-"));
  const repo = (p: string, url?: string) => {
    const dir = join(root, p);
    mkdirSync(dir, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", dir]);
    if (url) Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]);
  };
  repo("honeycrust/web", "git@github.com:honeycrust/web.git");
  repo("blog", "https://github.com/sam/blog");
  repo("scratch");
  expect(scanRepos(root).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: "blog", host: "github", owner: "sam", name: "blog" },
    { path: "honeycrust/web", host: "github", owner: "honeycrust", name: "web" },
  ]);
});

const GB = 1024 ** 3;

test("setup proposes a signed-in agent CLI, else an installed one, Claude Code first; Claude Code when none is there", () => {
  const a = (id: FoundAgent["id"], installed: boolean, signedIn = false): FoundAgent => ({ id, installed, signedIn });
  expect(pickAgent([a("claude-code", true, true), a("codex", true, true)])).toBe("claude-code");
  expect(pickAgent([a("claude-code", true), a("cursor", true, true)])).toBe("cursor");
  expect(pickAgent([a("claude-code", false), a("aider", true), a("opencode", true)])).toBe("opencode");
  expect(pickAgent([a("claude-code", false), a("codex", false)])).toBe("claude-code");
});

test("setup proposes a local model that can call tools, the largest of its family that fits; never an embedding model", () => {
  const models = [
    { name: "nomic-embed-text:latest", size: 0.3 * GB },
    { name: "qwen3:1.7b", size: 1.4 * GB },
    { name: "llama3.1:8b", size: 4.9 * GB },
    { name: "qwen2.5-coder:1.5b", size: 1 * GB },
    { name: "qwen2.5-coder:7b", size: 4.7 * GB },
    { name: "qwen2.5-coder:32b", size: 20 * GB },
  ];
  // qwen3 called tools in our end-to-end runs; qwen2.5-coder wrote its tool calls as text
  expect(pickLocalModel(models, 32 * GB)).toBe("qwen3:1.7b");
  expect(pickLocalModel([...models, { name: "qwen3:14b", size: 9 * GB }], 32 * GB)).toBe("qwen3:14b");
  expect(
    pickLocalModel(
      models.filter((m) => !m.name.startsWith("qwen3")),
      32 * GB,
    ),
  ).toBe("llama3.1:8b");
  expect(pickLocalModel([{ name: "qwen2.5-coder:7b", size: 4.7 * GB }], 32 * GB)).toBe("qwen2.5-coder:7b");
  expect(pickLocalModel([{ name: "big:70b", size: 40 * GB }], 16 * GB)).toBe("big:70b");
  expect(pickLocalModel([{ name: "nomic-embed-text", size: GB }], 16 * GB)).toBe("");
  // Claude when it already reaches it (signed in or a key); then Ollama; with neither, Claude (and setup asks you to sign in)
  expect(pickBackend(true, models, 32 * GB)).toEqual({ kind: "claude" });
  expect(pickBackend(false, models, 32 * GB)).toEqual({ kind: "ollama", model: "qwen3:1.7b" });
  expect(pickBackend(false, [], 32 * GB)).toEqual({ kind: "claude" });
});

test("configFromSetup: today's Claude path unchanged; another agent CLI and a local or gateway model become the account's", () => {
  const base = blankConfig("me");
  const setup = (over: object) =>
    SetupSchema.parse({
      owner: "Me",
      codeRoot: "/code",
      projects: [{ name: "Honeycrust", dir: "honeycrust", prefix: "HONEY", trackerRepo: "honeycrust/web" }],
      credential: { kind: "login", value: "" },
      ...over,
    });
  const claude = configFromSetup(setup({}), base);
  expect(claude).toMatchObject({ accounts: ["main"], providers: {}, runtimes: {} });
  // setup offers exactly two ways to reach Claude: Claude Code's own sign-in or an API key; never a subscription token
  expect(SetupSchema.shape.credential.shape.kind.options).toEqual(["login", "key"]);
  expect(() => setup({ credential: { kind: "token", value: "sk-ant-oat01-x" } })).toThrow();
  expect(configFromSetup(setup({ credential: { kind: "key", value: "" } }), base)).toMatchObject({
    providers: { main: { kind: "claude", auth: "key" } },
  });
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  expect(saveConfig(dir, claude).accounts).toEqual(["main"]);
  const local = saveConfig(dir, configFromSetup(setup({ agent: "aider", backend: { kind: "ollama", model: "qwen2.5-coder:7b" } }), base));
  expect(local.providers.main).toMatchObject({ kind: "gateway", baseUrl: "http://localhost:11434", model: "qwen2.5-coder:7b" });
  expect(local.runtimes.main).toEqual({ kind: "aider", model: "ollama_chat/qwen2.5-coder:7b" });
  const gw = configFromSetup(setup({ agent: "codex", backend: { kind: "gateway", baseUrl: "http://gw:4000", model: "m" } }), base);
  expect(saveConfig(dir, gw).runtimes.main).toEqual({ kind: "codex", model: "" });
  expect(loadConfig(dir).providers.main).toMatchObject({ kind: "gateway", baseUrl: "http://gw:4000", model: "m" });
  // no project yet is a valid start: the dashboard shows how to add one
  expect(saveConfig(dir, configFromSetup(setup({ projects: [] }), base)).clients).toEqual([]);
});

test("a typed ~ folder means the home folder, in the wizard's scan and in the saved setup", () => {
  const home = homedir();
  expect(homePath("~/Code")).toBe(join(home, "Code"));
  expect(homePath("~")).toBe(home);
  expect(homePath("/srv/~code")).toBe("/srv/~code");
  expect(SetupSchema.shape.codeRoot.parse("~/Code")).toBe(join(home, "Code"));
});
