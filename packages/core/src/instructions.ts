/**
 * Finds and reads each project's agent instruction files for the dashboard. Read-only: nothing here writes to a repo.
 * File text is cached by modification time, and discovery (one `git ls-files`) per repo for a few minutes.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  INSTRUCTION_PATHSPECS,
  isInstructionPath,
  type ProjectInstructions,
  projectInstructions,
  type RepoInput,
} from "@overhand/contract";
import { gitReposAsync } from "./cleanup";
import { ACCOUNTS, CLIENTS, CODE, MIN, repoActive, runtimeOf, shAsync } from "./env";
import { parseRemote } from "./onboard";

/** Files bigger than this are listed but not parsed: no one writes 256 KB of instructions by hand. */
const MAX_BYTES = 256 * 1024;

const texts = new Map<string, { mtime: number; text: string; changedAt: number }>();
const scans = new Map<string, { at: number; lastCommit: number; remote: string; listed: { path: string; tracked: boolean }[] }>();

/** The web page of a committed file on GitHub or Bitbucket; "" for any other remote. */
export function fileUrl(remote: string, path: string): string {
  const r = parseRemote(remote);
  if (r?.host === "github") return `https://github.com/${r.owner}/${r.name}/blob/HEAD/${path}`;
  if (r?.host === "bitbucket") return `https://bitbucket.org/${r.owner}/${r.name}/src/HEAD/${path}`;
  return "";
}

/** One repo's instruction files, last commit and remote, rescanned at most every five minutes. */
async function scan(repo: string, now: number) {
  const hit = scans.get(repo);
  if (hit && now - hit.at < 5 * MIN) return hit;
  // -t tags each path: H committed, ? not; --others with --exclude-standard leaves ignored files out
  const [ls, last, remote] = await Promise.all([
    shAsync(["git", "ls-files", "-t", "--cached", "--others", "--exclude-standard", "--", ...INSTRUCTION_PATHSPECS], repo, 20_000),
    shAsync(["git", "log", "-1", "--format=%ct"], repo, 20_000),
    shAsync(["git", "remote", "get-url", "origin"], repo, 20_000),
  ]);
  const seen = new Set<string>();
  const listed = ls.out
    .split("\n")
    .map((l) => ({ tracked: !l.startsWith("?"), path: l.slice(2) }))
    .filter((f) => f.path && isInstructionPath(f.path) && !seen.has(f.path) && seen.add(f.path));
  const entry = { at: now, lastCommit: Number(last.out) * 1000 || 0, remote: remote.out, listed };
  scans.set(repo, entry);
  return entry;
}

/** A file's text and when it last changed (its last commit, else its mtime), re-read only when its mtime moves. */
async function read(repo: string, path: string, tracked: boolean): Promise<{ text: string; changedAt: number } | null> {
  const abs = join(repo, path);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  const hit = texts.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const committed = tracked ? Number((await shAsync(["git", "log", "-1", "--format=%ct", "--", path], repo, 20_000)).out) * 1000 : 0;
  const entry = {
    mtime: st.mtimeMs,
    text: st.size > MAX_BYTES ? "" : readFileSync(abs, "utf8"),
    changedAt: committed || st.mtimeMs,
  };
  texts.set(abs, entry);
  return entry;
}

/** A repo as `projectInstructions` reads it. */
export async function repoInput(repo: string, now = Date.now()): Promise<RepoInput> {
  const s = await scan(repo, now);
  const aider = join(repo, ".aider.conf.yml");
  const files = await Promise.all(
    s.listed.map(async (f) => {
      const r = await read(repo, f.path, f.tracked);
      return r
        ? [{ path: f.path, text: r.text, changedAt: r.changedAt, tracked: f.tracked, url: f.tracked ? fileUrl(s.remote, f.path) : "" }]
        : [];
    }),
  );
  return {
    name: basename(repo),
    lastCommit: s.lastCommit,
    aiderConf: existsSync(aider) ? readFileSync(aider, "utf8") : "",
    files: files.flat(),
  };
}

let cached: { at: number; list: ProjectInstructions[] } = { at: 0, list: [] };

/** Every project's instructions and checks, as last read (`refreshInstructions`). Dormant repos are left out. */
export const instructions = (): ProjectInstructions[] => cached.list;

/** Reads every project's instructions again when the last read is a minute old; git runs without blocking the daemon. */
export async function refreshInstructions(now = Date.now()): Promise<void> {
  if (now - cached.at < MIN) return;
  cached.at = now; // one read at a time
  const list: ProjectInstructions[] = [];
  // one repo after another: nothing waits on this, so a burst of git processes buys nothing
  for (const c of CLIENTS) {
    const accounts = c.accounts.length ? c.accounts : ACCOUNTS.slice(0, 1);
    const runtimes = [...new Set(accounts.map((a) => runtimeOf(a).kind))];
    const repos: RepoInput[] = [];
    for (const r of await gitReposAsync(join(CODE, c.dir))) {
      const input = await repoInput(r, now);
      if (repoActive(r, input.lastCommit, now)) repos.push(input);
    }
    list.push(projectInstructions(c.name, runtimes, repos, now));
  }
  cached = { at: now, list };
}
