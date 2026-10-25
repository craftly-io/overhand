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
import { check, logBlock, outwardBlock, pushBranchesOf, selfPaths } from "./guard";
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

/** gh's options that name a file gh reads; the stand-in reads it (as the lead may) and sends what's in it. */
const GH_FILE_FLAGS = new Set(["--body-file", "--notes-file", "--input"]);
/** -F: a body file for most commands, a field (`key=@file` reads one) for these. */
const GH_FIELD_COMMANDS = new Set(["api", "workflow"]);
const FILE_MARK = "@@overhand-file:";

/** The file a value names ("-" is stdin), as text. */
const readArg = async (path: string): Promise<string> => (path === "-" ? await Bun.stdin.text() : readFileSync(path, "utf8"));

/** gh's argv with each file it would read swapped for a mark, and what each file holds. */
export async function ghFiles(args: string[], read = readArg): Promise<{ args: string[]; files: string[] }> {
  const files: string[] = [];
  const field = GH_FIELD_COMMANDS.has(args.find((a) => !a.startsWith("-")) ?? "");
  const mark = async (path: string): Promise<string> => {
    files.push(await read(path));
    return `${FILE_MARK}${files.length - 1}`;
  };
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const [flag = "", inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a];
    const isFile = GH_FILE_FLAGS.has(flag) || (!field && flag === "-F");
    const isField = field && (flag === "-F" || flag === "--field");
    if (!isFile && !isField) {
      out.push(a);
      continue;
    }
    const value = inline ?? args[++i] ?? "";
    const eq = value.indexOf("=");
    const v = isFile
      ? await mark(value)
      : eq > 0 && value[eq + 1] === "@"
        ? `${value.slice(0, eq + 1)}@${await mark(value.slice(eq + 2))}`
        : value;
    out.push(...(inline === undefined ? [flag, v] : [`${flag}=${v}`]));
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
  push: [
    "-u",
    "--set-upstream",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-n",
    "--dry-run",
    "--porcelain",
    "--tags",
    "--follow-tags",
    "-d",
    "--delete",
    "--no-verify",
    "--atomic",
  ],
  fetch: [
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-p",
    "--prune",
    "--prune-tags",
    "-t",
    "--tags",
    "-n",
    "--no-tags",
    "--all",
    "--unshallow",
    "--dry-run",
    "--depth=",
    "--shallow-since=",
  ],
  "ls-remote": ["-q", "--quiet", "-h", "--heads", "-t", "--tags", "--refs", "--exit-code", "--symref"],
};

/** gh's commands a lead may run through Overhand, and those of them it may not (they write files as you, or run code). */
const GH_ALLOWED = new Set(["pr", "issue", "run", "workflow", "api", "search", "label", "release", "repo", "status", "cache"]);
const GH_REFUSED: [RegExp, string][] = [
  [/^pr checkout\b/, "check a pull request out with git fetch and git switch"],
  [/^(run|release) download\b/, "Overhand doesn't download files for a lead"],
  [/^repo (?!view\b|list\b)/, "a lead may view and list repositories, nothing more"],
];

/** Why Overhand won't run this git command for a lead, or null. `remotes` are the repo's own remote names. */
export function gitRefusal(args: string[], remotes: string[]): string | null {
  const [cmd = "", ...rest] = args;
  const allowed = GIT_OPTIONS[cmd];
  if (!allowed) return `Overhand runs git's ${Object.keys(GIT_OPTIONS).join(", ")} and pull for a lead, not ${cmd || "that"}`;
  const flag = rest.find((a) => a.startsWith("-") && !allowed.some((o) => (o.endsWith("=") ? a.startsWith(o) : a === o)));
  if (flag) return `git ${cmd} through Overhand doesn't take ${flag}`;
  const [remote, ...specs] = rest.filter((a) => !a.startsWith("-"));
  // a remote by its name only: a URL or a path would let a push run the receiving repo's hooks as you
  if (remote !== undefined && !remotes.includes(remote))
    return `name one of this repo's remotes (${remotes.join(", ") || "none"}), not ${remote}`;
  if (specs.some((s) => s.startsWith("+"))) return "force push is never allowed";
  return null;
}

/** Why Overhand won't run this gh command for a lead, or null; `files` are how many files the stand-in sent. */
export function ghRefusal(args: string[], files: number): string | null {
  const words = args.filter((a) => !a.startsWith("-"));
  if (!GH_ALLOWED.has(words[0] ?? "")) return `Overhand runs gh's ${[...GH_ALLOWED].join(", ")} for a lead, not ${words[0] ?? "that"}`;
  const line = words.join(" ");
  for (const [re, why] of GH_REFUSED) if (re.test(line)) return why;
  // every file gh reads is one the stand-in sent: a path left in would be read by the daemon, as you
  const marks = [...args.join("\n").matchAll(new RegExp(`${FILE_MARK}(\\d+)`, "g"))].map((m) => Number(m[1]));
  if (marks.some((n) => n >= files)) return "a file the stand-in didn't send";
  if (args.some((_, i) => isFilePath(args, i))) return "send files through Overhand's gh, not by a path";
  return null;
}

/** args[i] is a file gh would read that isn't a mark (someone calling the route by hand). */
function isFilePath(args: string[], i: number): boolean {
  const a = args[i] ?? "";
  const prev = args[i - 1] ?? "";
  const field = GH_FIELD_COMMANDS.has(args.find((x) => !x.startsWith("-")) ?? "");
  const named = (v: string) => !v.startsWith(FILE_MARK);
  if (a.includes("=") && a.startsWith("--")) {
    const [flag = "", v = ""] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    if (GH_FILE_FLAGS.has(flag)) return named(v);
    if (field && flag === "--field") return /=@/.test(v) && !v.includes(`=@${FILE_MARK}`);
    return false;
  }
  if (GH_FILE_FLAGS.has(prev) || (!field && prev === "-F")) return named(a);
  if (field && (prev === "-F" || prev === "--field")) return /=@/.test(a) && !a.includes(`=@${FILE_MARK}`);
  return false;
}

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
  const command = [tool, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : sq(a))).join(" ");
  const refusal =
    (tool === "git" ? gitRefusal(args, remotes) : ghRefusal(args, files.length)) ??
    check("Bash", { command }, selfPaths(), who.autonomy, who.run, pushBranchesOf(who.run), cwd) ??
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
    const real = args.map((a) => a.replace(new RegExp(`${FILE_MARK}(\\d+)`, "g"), (_, n: string) => paths[Number(n)] ?? ""));
    const r = await shAsync([tool, ...real], cwd);
    return { code: r.ok ? 0 : 1, out: r.out, err: r.err };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
