/**
 * A lead's git and gh, with your sign-in, which the lead itself never has (sandbox.ts SIGN_INS): its PATH starts with
 * Overhand's stand-ins for both (writeShims). `git push`, `fetch`, `pull` and `ls-remote` and every `gh` command come
 * to the daemon by the lead's own run key (brokerCli → server.ts RUN_ROUTES → brokerRoute), which checks them as the
 * guard would and runs them; every other git command runs the real git, inside the lead's sandbox, as before.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { selfCommand } from "./agent-home";
import type { RunWho } from "./control";
import { localHeaders } from "./devices";
import { CFG, DASHBOARD, OPS, sh, shAsync } from "./env";
import { check, logBlock, outwardBlock, protectedBranch, pushBranchesOf, selfPaths } from "./guard";
import { leadDir } from "./leads";
import { gitCommonDir } from "./runtimes/runtime";

/** Where the stand-ins are: Overhand's own folder, which a run reads and never writes (sandbox.ts selfPaths). */
export const SHIMS = join(OPS, "shims");
/** The route the stand-ins call. */
export const BROKER_ROUTE = "/api/run/broker";

/** The git commands that need your sign-in; the stand-in hands only these to the daemon. */
const REMOTE = ["push", "fetch", "pull", "ls-remote"];
/** git's own options that take a value, which the stand-in steps over to find the command. */
const GIT_VALUED = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"];

const sq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** The `git` and `gh` stand-ins a lead starts with, written fresh (they name this copy of Overhand and the real git). */
export function writeShims(dir = SHIMS, self = selfCommand(), realGit = realBinary("git", dir)): string {
  mkdirSync(dir, { recursive: true });
  const run = [...self, "broker"].map(sq).join(" ");
  const git = [
    "#!/bin/sh",
    "# Overhand: git push, fetch, pull and ls-remote go through Overhand, which has your sign-in (broker.ts)",
    "skip=",
    "for a do",
    '  if [ -n "$skip" ]; then skip=; continue; fi',
    '  case "$a" in',
    `    ${GIT_VALUED.join("|")}) skip=1 ;;`,
    "    -*) ;;",
    `    ${REMOTE.join("|")}) OVERHAND_REAL_GIT=${sq(realGit)} exec ${run} git "$@" ;;`,
    "    *) break ;;",
    "  esac",
    "done",
    `exec ${sq(realGit)} "$@"`,
    "",
  ].join("\n");
  const gh = ["#!/bin/sh", "# Overhand: gh runs through Overhand, which has your sign-in (broker.ts)", `exec ${run} gh "$@"`, ""].join(
    "\n",
  );
  for (const [name, text] of Object.entries({ git, gh })) {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** `name` on PATH outside `skip` (the stand-ins' own folder), else /usr/bin's. */
function realBinary(name: string, skip: string): string {
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((d) => d && resolve(d) !== resolve(skip))
    .join(":");
  return Bun.which(name, { PATH: path }) ?? `/usr/bin/${name}`;
}

// ---------- the stand-in's side, inside the lead ----------

/** gh's options that name a file gh reads (a body); the stand-in reads it, as the lead may, and sends what's in it. */
const GH_FILE_FLAGS = new Set(["--body-file", "-F"]);
const FILE_MARK = "@@overhand-file:";

/** The file a value names ("-" is stdin), as text. */
const readArg = async (path: string): Promise<string> => (path === "-" ? await Bun.stdin.text() : readFileSync(path, "utf8"));

/** An argument as gh's file flag and the value given with it (`--body-file=x`, `-Fx`), or null. */
function fileFlag(a: string): { flag: string; value: string } | null {
  if (a.startsWith("--body-file=")) return { flag: "--body-file", value: a.slice("--body-file=".length) };
  if (a.startsWith("-F") && a.length > 2) return { flag: "-F", value: a.slice(2) };
  return null;
}

/** gh's argv with each file it would read swapped for a mark, and what each file holds. */
export async function ghFiles(args: string[], read = readArg): Promise<{ args: string[]; files: string[] }> {
  const files: string[] = [];
  const mark = async (path: string): Promise<string> => {
    files.push(await read(path));
    return `${FILE_MARK}${files.length - 1}`;
  };
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const joined = fileFlag(a);
    if (joined) out.push(joined.flag, await mark(joined.value));
    else if (GH_FILE_FLAGS.has(a)) out.push(a, await mark(args[++i] ?? ""));
    else out.push(a);
  }
  return { args: out, files };
}

/** `git [-C dir]… <command> …`: the folder it runs in and the rest; null when another of git's own options comes first. */
export function gitParts(args: string[], cwd: string): { cwd: string; args: string[] } | null {
  let at = cwd;
  let i = 0;
  while ((args[i] ?? "").startsWith("-")) {
    if (args[i] !== "-C") return null;
    at = resolve(at, args[i + 1] ?? "");
    i += 2;
  }
  return { cwd: at, args: args.slice(i) };
}

/** `git pull`'s options the stand-in passes on to the merge or rebase it runs after the fetch. */
const PULL_LOCAL = new Set(["--ff-only", "--ff", "--no-ff", "-q", "--quiet", "--no-edit", "--autostash"]);

/**
 * `overhand broker git|gh …`, what the stand-ins run inside a lead: hands the command to the daemon and prints what it
 * printed, with its exit code. A `git pull` is a fetch there, then the merge or rebase here, with the real git.
 */
export async function brokerCli(argv: string[], env = process.env): Promise<number> {
  const [tool = "", ...rest] = argv;
  let body: { tool: string; args: string[]; cwd: string; files: string[] };
  let after: string[] | null = null;
  if (tool === "gh") body = { tool, cwd: process.cwd(), ...(await ghFiles(rest)) };
  else if (tool === "git") {
    const parts = gitParts(rest, process.cwd());
    if (!parts) {
      console.error("overhand: Overhand runs git's push, fetch, pull and ls-remote for you; give them without git's own options (but -C)");
      return 2;
    }
    let args = parts.args;
    if (args[0] === "pull") {
      const local = args.slice(1).filter((a) => a.startsWith("-"));
      const rebase = local.some((a) => a === "--rebase" || a === "-r") || (!local.includes("--no-rebase") && pullRebases(env, parts.cwd));
      const passed = local.filter((a) => PULL_LOCAL.has(a));
      const other = local.filter((a) => !PULL_LOCAL.has(a) && !["--rebase", "-r", "--no-rebase"].includes(a));
      if (other.length) {
        console.error(
          `overhand: git pull through Overhand takes ${[...PULL_LOCAL, "--rebase", "--no-rebase"].join(", ")}; not ${other.join(" ")}`,
        );
        return 2;
      }
      args = ["fetch", ...args.slice(1).filter((a) => !a.startsWith("-"))];
      after = rebase
        ? ["rebase", ...passed.filter((a) => a === "-q" || a === "--quiet" || a === "--autostash"), "FETCH_HEAD"]
        : ["merge", ...passed, "FETCH_HEAD"];
    }
    body = { tool, cwd: parts.cwd, args, files: [] };
  } else {
    console.error("usage: overhand broker git|gh …   (what a lead's git and gh run)");
    return 2;
  }
  const res = await fetch(`${DASHBOARD}${BROKER_ROUTE}`, {
    method: "POST",
    headers: { ...localHeaders(DASHBOARD, env), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(11 * 60_000),
  }).catch(() => null);
  if (!res) {
    console.error(`overhand: Overhand isn't answering, so ${tool} can't use your sign-in; it starts again on its own`);
    return 1;
  }
  const r = BrokerAnswer.catch({ code: 1, out: "", err: `overhand: ${res.status}` }).parse(await res.json().catch(() => null));
  if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
  if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
  if (r.code !== 0 || !after) return r.code;
  const real = env.OVERHAND_REAL_GIT || "/usr/bin/git";
  return Bun.spawnSync([real, ...after], { cwd: body.cwd, stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
}

/** Whether git here is set to rebase on pull (pull.rebase), read with the real git. */
function pullRebases(env: Record<string, string | undefined>, cwd: string): boolean {
  const v = Bun.spawnSync([env.OVERHAND_REAL_GIT || "/usr/bin/git", "config", "pull.rebase"], { cwd })
    .stdout.toString()
    .trim();
  return v !== "" && v !== "false";
}

const BrokerAnswer = z.object({ code: z.number(), out: z.string(), err: z.string() });
type Answer = z.infer<typeof BrokerAnswer>;

// ---------- the daemon's side ----------

const BrokerAsk = z.object({
  tool: z.enum(["git", "gh"]),
  args: z.array(z.string()).max(200),
  cwd: z.string(),
  files: z.array(z.string().max(1_000_000)).max(10).default([]),
});

/** Each remote git command's options a lead may give (`--depth=` and the like by their prefix). */
const GIT_OPTIONS: Record<string, string[]> = {
  // no tags, deletes or other branches: a push is the lead's own branch, by its name (pushRefspec)
  push: ["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "-n", "--dry-run", "--porcelain"],
  fetch: [
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-p",
    "--prune",
    "-n",
    "--no-tags",
    "--unshallow",
    "--dry-run",
    "--depth=",
    "--shallow-since=",
  ],
  "ls-remote": ["-q", "--quiet", "-h", "--heads", "-t", "--tags", "--refs", "--exit-code", "--symref"],
};

/** What a lead's git push may name: nothing (the branch's upstream), HEAD, or the branch it's on. */
const ownBranch = (spec: string, branch: string): boolean =>
  [
    "HEAD",
    branch,
    `HEAD:${branch}`,
    `${branch}:${branch}`,
    `HEAD:refs/heads/${branch}`,
    `refs/heads/${branch}`,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ].includes(spec);

/**
 * Why Overhand won't run this git command for a lead, or null. `remotes` are the repo's own remote names, `branch` the
 * one it's on ("" detached) and `push` the protected branches its config opens (guard.ts pushBranchesOf).
 */
export function gitRefusal(args: string[], remotes: string[], branch: string, push: readonly string[]): string | null {
  const [cmd = "", ...rest] = args;
  const allowed = GIT_OPTIONS[cmd];
  if (!allowed) return `Overhand runs git's ${Object.keys(GIT_OPTIONS).join(", ")} and pull for a lead, not ${cmd || "that"}`;
  const flag = rest.find((a) => a.startsWith("-") && !allowed.some((o) => (o.endsWith("=") ? a.startsWith(o) : a === o)));
  if (flag) return `git ${cmd} through Overhand doesn't take ${flag}`;
  const [remote, ...specs] = rest.filter((a) => !a.startsWith("-"));
  // a remote by its name only: a URL or a path would let a push run the receiving repo's hooks as you
  if (remote !== undefined && !remotes.includes(remote))
    return `name one of this repo's remotes (${remotes.join(", ") || "none"}), not ${remote}`;
  if (cmd !== "push") return null;
  if (!branch) return "switch to your branch first: Overhand pushes the branch you're on, never a detached HEAD";
  if (protectedBranch(branch) && !push.includes(branch)) return "push only the agent's own feature branch";
  if (specs.length > 1 || specs.some((sp) => !ownBranch(sp, branch)))
    return `Overhand pushes only the branch you're on (${branch}), by its own name: no tags, deletes or other branches`;
  return null;
}

/** The push Overhand runs for a lead: its options and remote, then the branch it's on and nothing else. */
export function pushRefspec(args: string[], branch: string): string[] {
  const flags = args.slice(1).filter((a) => a.startsWith("-"));
  const [remote = "origin"] = args.slice(1).filter((a) => !a.startsWith("-"));
  return ["push", ...flags, remote, `HEAD:refs/heads/${branch}`];
}

/**
 * gh's commands a lead may run, by command and subcommand: reading, and the everyday writes a lead does (pull
 * requests, issues, comments, labels). Nothing that deletes, merges, changes settings or access, runs workflows,
 * downloads files or runs code; `api` reads only.
 */
const GH_ALLOWED: Record<string, string[]> = {
  pr: ["view", "list", "diff", "checks", "status", "create", "comment", "edit", "ready"],
  issue: ["view", "list", "status", "create", "comment", "edit"],
  run: ["view", "list", "watch"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  repo: ["view"],
  label: ["list", "create"],
  search: ["issues", "prs", "code", "commits"],
  status: [""],
  api: [""],
};
/** gh's options that take a value, so the word after one isn't the command's. */
const GH_VALUED = new Set(["-R", "--repo", "-q", "--jq", "-t", "--template", "--json", "-H", "--header"]);

/** gh's command words, the options' values left out. */
const ghWords = (args: string[]): string[] =>
  args.filter((a, i) => !a.startsWith("-") && !GH_VALUED.has(args[i - 1] ?? "") && !GH_FILE_FLAGS.has(args[i - 1] ?? ""));

/** An endpoint or repository the lead's own repo (`slug`, owner/name) covers. */
const ownRepo = (ref: string, slug: string): boolean => {
  const r = ref.replace(/^\/+/, "").toLowerCase();
  const own = `repos/${slug.toLowerCase()}`;
  return r === own || r.startsWith(`${own}/`) || r === "repos/{owner}/{repo}" || r.startsWith("repos/{owner}/{repo}/");
};

/**
 * Why Overhand won't run this gh command for a lead, or null. `files` are how many files the stand-in sent, `slug`
 * the lead's own GitHub repository (owner/name), which every command keeps to.
 */
export function ghRefusal(args: string[], files: number, slug: string): string | null {
  const [cmd = "", sub = "", ...rest] = ghWords(args);
  const subs = GH_ALLOWED[cmd];
  if (!subs) return `Overhand runs gh's ${Object.keys(GH_ALLOWED).join(", ")} for a lead, not ${cmd || "that"}`;
  if (cmd === "api") {
    // reads only: a method other than GET, or a field (which makes it a POST), is a write
    const method = args.find((a, i) => args[i - 1] === "-X" || args[i - 1] === "--method" || a.startsWith("--method="));
    const m = (method?.startsWith("--method=") ? method.slice(9) : (method ?? "GET")).toUpperCase();
    if (m !== "GET" || args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a)))
      return "gh api through Overhand only reads (GET, no fields)";
    if (!sub.startsWith("search/") && !(slug && ownRepo(sub, slug))) return `gh api through Overhand reads only ${slug || "this repo"}`;
  } else if (!subs.includes(sub)) return `Overhand runs gh ${cmd} ${subs.filter(Boolean).join(", ")} for a lead, not ${sub || "that"}`;
  const repo =
    args.find((_a, i) => args[i - 1] === "-R" || args[i - 1] === "--repo") ?? args.find((a) => a.startsWith("--repo="))?.slice(7);
  if (repo !== undefined && repo.toLowerCase() !== slug.toLowerCase())
    return `a lead works in ${slug || "its own repository"}, not ${repo}`;
  if (rest.some((w) => /github\.com\//i.test(w) && !w.toLowerCase().includes(`github.com/${slug.toLowerCase()}/`)))
    return `a lead works in ${slug || "its own repository"} only`;
  // every file gh reads is one the stand-in sent: a path left in would be read by the daemon, as you
  const marks = [...args.join("\n").matchAll(new RegExp(`${FILE_MARK}(\\d+)`, "g"))].map((m) => Number(m[1]));
  if (marks.some((n) => n >= files)) return "a file the stand-in didn't send";
  const named = args.some((a, i) => {
    const joined = fileFlag(a);
    if (joined) return !joined.value.startsWith(FILE_MARK);
    return GH_FILE_FLAGS.has(args[i - 1] ?? "") && !a.startsWith(FILE_MARK);
  });
  if (named || args.some((a) => /^--(notes-file|input)(=|$)/.test(a))) return "send files through Overhand's gh, not by a path";
  return null;
}

/** The lead's GitHub repository as owner/name, from its origin's address; "" when it isn't on GitHub. */
export const githubSlug = (remote: string): string => remote.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? "";

/** The lead a run is, or null: only a lead's own run asks Overhand for git and gh. */
const leadOf = (who: RunWho) => CFG.godmode.find((g) => who.run === `lead-${g.key}`) ?? null;

/**
 * A lead's git or gh command, run with your sign-in: in a checkout of the lead's own repository (or, for gh, its
 * folder), when the guard would let the lead run it and Overhand takes it (gitRefusal, ghRefusal).
 */
export async function brokerRoute(raw: unknown, who: RunWho): Promise<Answer> {
  const lead = leadOf(who);
  if (!lead) return { code: 1, out: "", err: "overhand: only a lead runs git and gh through Overhand" };
  const ask = BrokerAsk.safeParse(raw);
  if (!ask.success) return { code: 2, out: "", err: "overhand: that isn't a git or gh command" };
  const { tool, args, files } = ask.data;
  const home = leadDir(lead);
  const repo = gitCommonDir(home);
  const inRepo = repo !== "" && gitCommonDir(ask.data.cwd) === repo;
  if (tool === "git" && !inRepo) return { code: 1, out: "", err: `overhand: Overhand runs git only in ${lead.label}'s own repository` };
  const cwd = inRepo ? ask.data.cwd : home;
  const remotes = tool === "git" ? sh(["git", "remote"], cwd).out.split("\n").filter(Boolean) : [];
  const branch = tool === "git" ? sh(["git", "symbolic-ref", "--short", "-q", "HEAD"], cwd).out : "";
  const slug = githubSlug(sh(["git", "remote", "get-url", "origin"], home).out);
  const push = pushBranchesOf(who.run);
  const command = [tool, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : sq(a))).join(" ");
  const refusal =
    (tool === "git" ? gitRefusal(args, remotes, branch, push) : ghRefusal(args, files.length, slug)) ??
    check("Bash", { command }, selfPaths(), who.autonomy, who.run, push, cwd) ??
    outwardBlock("Bash", { command: [command, ...files].join("\n") }, who.project);
  if (refusal) {
    logBlock("Bash", { command }, refusal, { ...process.env, OVERHAND_RUN: who.run });
    return { code: 1, out: "", err: `overhand: ${refusal}` };
  }
  const dir = files.length ? mkdtempSync(join(tmpdir(), "overhand-broker-")) : "";
  try {
    const paths = files.map((text, i) => {
      const p = join(dir, String(i));
      writeFileSync(p, text, { mode: 0o600 });
      return p;
    });
    const marked = tool === "git" && args[0] === "push" ? pushRefspec(args, branch) : args;
    const real = marked.map((a) => a.replace(new RegExp(`${FILE_MARK}(\\d+)`, "g"), (_, n: string) => paths[Number(n)] ?? ""));
    const r = await shAsync([tool, ...real], cwd);
    return { code: r.ok ? 0 : 1, out: r.out, err: r.err };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
