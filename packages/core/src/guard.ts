/**
 * The PreToolUse hook for Claude Code agent runs (`overhand guard`, or `bun run.ts guard` from a checkout): reads the tool
 * call as JSON on stdin and exits 2 to block it, telling the agent why. Hard rules live here, not in the prompt, because
 * prompts get ignored and hooks don't.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type GuardBlock, GuardBlockSchema } from "@overhand/contract";
import { z } from "zod";
import { freeGb } from "./cleanup";
import { GroupSchema } from "./config";
import {
  ancestors,
  type Beat,
  beatOf,
  claudePid,
  controlDir,
  dueFor,
  editRequests,
  houseRule,
  loadHolds,
  loadRequests,
  nextBeat,
  outboxDir,
  repoOf,
  requestText,
  ruleHold,
  rulesText,
  rulesVersion,
  runOf,
  saveBeat,
} from "./control";
import { redactSecrets } from "./corners";
import { BUNDLED, CFG, CLIENTS, CODE, HOME, OPS, SELF_EXEC, SRC } from "./env";
import { govern, type Heavy, protectedHit, readMachine, riskyScript, unwrapHeavy, type Verdict } from "./governor";
import { leadPushBranches, windowsFor } from "./groups";
import { type Dialect, dialectOf, type Event, eventOf, TOO_WIDE, UNKNOWN_FILE } from "./guard-dialects";
import { cleared, type FirewallConfig, scanOutward } from "./outward";

/** A push naming a protected branch; a lead may push to the ones its config lists (`pushBranches`), nothing else may. */
const PROTECTED_PUSH = /\bgit\s+push\b[^|;&]*\b(main|master|develop|dev|staging|production|prod|release)\b/;
const PROTECTED = /\b(main|master|develop|dev|staging|production|prod|release)\b/g;

/**
 * Each agent CLI's per-project config, which could turn the guard off for the next run in that repo (a Gemini CLI
 * workspace `hooksConfig`, an OpenCode plugin that rewrites a command after the guard saw it, Aider's shell setting):
 * no agent reads or writes it, by file tool or in a command.
 */
const AGENT_CONFIG =
  /(^|[^\w.-])(\.(gemini|codex|opencode)\b|\.cursor\/(hooks|cli)\.json\b|opencode\.jsonc?\b|\.aider\.conf\.ya?ml\b|\.aiderignore\b)/;
const AGENT_CONFIG_WHY = "no changing an agent CLI's project config";

const BASH_RULES: [RegExp, string][] = [
  [/\bgit\s+push\b[^|;&]*(\s-f\b|--force|\s\+\S)/, "force push is never allowed"],
  [PROTECTED_PUSH, "push only the agent's own feature branch"],
  [/\bgh\s+pr\s+(merge|close)\b|\bgh\s+pr\s+review\b[^|;&]*(--approve\b|\s-a\b)/, "merging, closing and approving are for humans"],
  // the same through the API: a merge or auto-merge mutation, or the REST merge endpoint, by gh, curl or wget (Ship's
  // auto-merge is Overhand's daemon's own step, never an agent's)
  [/\b(gh\s+api|curl|wget)\b[^|;&]*\b(merge\w*PullRequest|\w*AutoMerge\w*)\b/i, "merging, closing and approving are for humans"],
  [/\b(gh\s+api|curl|wget)\b[^|;&]*\/pulls\/\d+\/merge\b/, "merging, closing and approving are for humans"],
  // what would hide the query from the two rules above, or hand an agent the token to send it some other way (not
  // complete: Ship's live check turns off any auto-merge it didn't turn on)
  [/\bgh\s+auth\s+(token\b|status\b[^|;&]*(\s-t\b|--show-token\b))/, "the GitHub token stays with Overhand"],
  [/\bgh\s+api\s+graphql\b[^|;&]*(=@|--input\b|\$\(|`)/, "GraphQL queries must be written out in the command"],
  [/\bgh\s+(release|secret|variable|repo\s+(delete|edit|rename))\b/, "repo administration is off limits"],
  [
    /\bvercel\b[^|;&]*(--prod\b|\b(deploy|promote|rollback|remove|domains|alias|env\s+(add|rm|update)))/,
    "no Vercel deploys or env changes",
  ],
  [
    /\b(firebase\s+deploy|wrangler\s+(deploy|publish|secret|delete)|eas\s+(submit|update|build)|fly\s+deploy|(serverless|sls)\s+deploy|cdk\s+(deploy|destroy)|terraform\s+(apply|destroy)|kubectl\s+(apply|delete|scale|rollout)|helm\s+(install|upgrade|uninstall)|docker\s+push)\b/,
    "no deploys or infrastructure changes",
  ],
  [/\b(npm|yarn|pnpm|bun)\s+publish\b/, "no package publishing"],
  [/\bsecurity\s+(find|dump|export)|claude-token|\bkeychain\b/i, "no access to Keychain secrets"],
  [/password[^\s]*\.(txt|xlsx|csv)|Admin Password|env\.local\.docx/i, "no access to password files"],
  [/\.env\.(prod|production)\b/, "no access to production env files"],
  // the same credentials PATH_RULES keeps from the file tools, named in a command (`cat ~/.ssh/id_rsa`): CLIs whose agents
  // read files through the shell (Codex has no read tool) meet them here
  [
    /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)\/((\.ssh|\.aws|\.config\/gcloud|\.azure|Library\/Keychains)(\/|\b)|\.npmrc\b)/,
    "no access to credentials",
  ],
  [AGENT_CONFIG, AGENT_CONFIG_WHY],
  [/\b(psql|mongosh|mongo|mysql|redis-cli)\b[^|;&]*(prod|production|\.rds\.|mongodb\+srv)/i, "no production database access"],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "no destructive SQL"],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)\/?(\s|$)/, "no deleting home or root"],
  [/\bgit\s+branch\s+-D\s+(main|master|develop)\b/, "protected branch"],
  [
    /\bslack\.com\/api\/(?!(conversations\.(history|replies|info|list)|search\.|users\.(info|list))\b)/i,
    "Slack is read-only for Overhand's agents",
  ],
];

const PATH_RULES: [RegExp, string][] = [
  [AGENT_CONFIG, AGENT_CONFIG_WHY],
  [/password|Admin Password|env\.local\.docx/i, "no access to password files"],
  [/\.env\.(prod|production)\b/, "no access to production env files"],
  [/\/(\.ssh|\.aws|\.config\/gcloud|\.azure|Library\/Keychains)(\/|$)|\/\.npmrc$/, "no access to credentials"],
  [/\/\.claude[^/]*\/(settings(\.local)?\.json|\.claude\.json)$/, "no changing Claude Code's settings"],
];

/** What a project's autonomy level (OVERHAND_AUTONOMY, set on the agent's environment by its runtime) adds to the hard rules. */
const WATCH_RULES: [RegExp, string][] = [
  [
    /\bgit\s+(commit|push|merge|rebase|cherry-pick|am|reset|tag|stash|checkout\s+-[bB]|switch\s+-[cC])\b/,
    "this project is on watch: report, don't change anything",
  ],
  [
    /\bgh\s+(pr\s+(create|ready|edit|merge|close|comment|review)|issue\s+(create|edit|close|comment)|api\b[^|;&]*(-X|--method)\s*(POST|PATCH|PUT|DELETE))\b/i,
    "this project is on watch: report, don't change anything",
  ],
];

/**
 * Ticket and fix-round agents never comment: they post as you, so their words would read as your review feedback (and
 * Overhand learns rules from that). Overhand posts what's needed itself, marked. Leads may comment (they talk to
 * reviewers) and are told to mark what they post; only marked comments are kept out of learning.
 */
const COMMENT_RULE: [RegExp, string] = [
  /\bgh\s+(?:pr\s+(?:comment|review)|issue\s+comment)\b|\bgh\s+api\b(?=[^|;&]*\b(?:comments|reviews)\b)(?=[^|;&]*(?:(?:-X|--method)\s*(?:POST|PATCH|PUT)\b|\s(?:-f|-F|--field|--raw-field|--input)\b))/i,
  "Overhand posts comments for you; say it in your commits or your report",
];

/** A command with gh's `-R/--repo <repo>` taken out of each gh call, so `gh -R o/r pr merge 1` meets the same rules. */
const withoutGhRepo = (cmd: string): string => cmd.replace(/\bgh\b[^|;&]*/g, (seg) => seg.replace(/\s(?:-R|--repo)(?:\s+|=)\S+/g, ""));

/** A run Overhand started for one job (a ticket, its fix round, the planner): OVERHAND_RUN is set and isn't a lead's. */
const ticketRun = (run: string): boolean => run !== "" && !run.startsWith("lead-");

/** The autonomy rule a shell command breaks, or null. */
function autonomyRule(cmd: string, autonomy: string): string | null {
  if (autonomy === "watch") return WATCH_RULES.find(([re]) => re.test(cmd))?.[1] ?? null;
  if (autonomy !== "propose") return null;
  if (/\bgh\s+pr\s+ready\b/.test(cmd)) return "this project is on propose: a person marks drafts ready";
  if (/\bgh\s+pr\s+create\b/.test(cmd) && !/\s(--draft|-d)\b/.test(cmd)) return "this project is on propose: open the PR with --draft";
  return null;
}

const SELF = "Overhand can't be changed by its own agents";

/** The argv that runs Overhand in a governor wrap (`overhand heavy …`): the binary when bundled, else bun and run.ts. */
const HEAVY_SELF = BUNDLED ? [SELF_EXEC] : [process.execPath, join(SRC, "run.ts")];

/**
 * Overhand's own files an agent mustn't touch: the agent config home, config and state under `ops`, and the code that
 * runs it (the binary when bundled, run.ts and packages/ in a checkout).
 */
export function selfPaths(
  ops = OPS,
  src = SRC,
  bundled = BUNDLED,
  bin = process.execPath,
  stable = SELF_EXEC === process.execPath ? bin : SELF_EXEC,
): string[] {
  // the control room's files too: house rules live in the config, holds and requests under control/
  // and the governor's slots, whose locks name the process group a dead holder's job leaves behind; local code runs
  // inside the daemon
  const own = [
    join(ops, "agent-home"),
    join(ops, "overhand.config.json"),
    join(ops, "state.json"),
    controlDir(ops),
    join(ops, "slots"),
    join(ops, "local-code"),
    join(ops, "plugins"),
    // paired devices' session hashes: one written in would be a session of its own
    join(ops, ".devices.json"),
  ];
  // the binary by both its own path and the one that follows updates (Homebrew's opt link, npm/current)
  const bins = [...new Set([bin, stable])];
  return [...own, ...(bundled ? bins : [join(src, "run.ts"), join(src, "packages")])];
}

const LeadPushSchema = z.object({
  godmode: z
    .array(z.object({ key: z.string(), project: z.string().default(""), pushBranches: z.array(z.string()).optional() }))
    .default([]),
  groups: z.array(GroupSchema).default([]),
});

/**
 * The protected branches a lead may push to: its config `pushBranches`, else its group's (groups.ts), read fresh on
 * every call so a change in Settings applies at once. Empty for any run that isn't a lead, and when the config can't be
 * read.
 */
export function pushBranchesOf(run: string, file = join(OPS, "overhand.config.json")): string[] {
  if (!run.startsWith("lead-") || !existsSync(file)) return [];
  try {
    const cfg = LeadPushSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return cfg.success ? leadPushBranches(cfg.data, run.slice("lead-".length)) : [];
  } catch {
    return [];
  }
}

/** Every protected branch a push names is one the lead may push to. */
function pushAllowed(cmd: string, allowed: readonly string[]): boolean {
  const named = [...(cmd.match(PROTECTED_PUSH)?.[0] ?? "").matchAll(PROTECTED)].map((m) => m[1]);
  return allowed.length > 0 && named.every((b) => b !== undefined && allowed.includes(b));
}

/** The rule a shell command breaks, or null: the hard rules, comments for ticket runs, Overhand's own files, autonomy. */
function bashRule(cmd: string, self: string[], autonomy: string, run: string, push: readonly string[], cwd: string): string | null {
  for (const [re, why] of BASH_RULES) if (re.test(cmd) && !(re === PROTECTED_PUSH && pushAllowed(cmd, push))) return why;
  if (ticketRun(run) && COMMENT_RULE[0].test(cmd)) return COMMENT_RULE[1];
  return namesSelf(cmd, self, cwd) ? SELF : (leadsCommand(cmd, run, cwd) ?? autonomyRule(cmd, autonomy));
}

/** How paths compare: macOS folders ignore case, and one name can be written in more than one Unicode form. */
const fold = (s: string): string => s.normalize("NFC").toLowerCase();

/** `p` is `root` or inside it, compared as the disk does (fold). */
const under = (p: string, root: string): boolean => {
  const [a, b] = [fold(p), fold(root)];
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
};

/** A command as the shell reads its words, compared like paths: quotes and escapes gone, folded. */
const plain = (cmd: string): string => fold(cmd).replace(/["'\\]/g, "");

/** How a command can name a path, folded: as written, and from ~, $HOME or ${HOME} when it's in the home folder. */
const spellings = (p: string): string[] => {
  const rest = p.slice(HOME.length);
  return (under(p, HOME) ? [p, `~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`] : [p]).map(fold);
};

/** The command's words that are globs, as absolute patterns where they start from ~ or $HOME (folded). */
function globsIn(cmd: string): string[] {
  const home = fold(HOME);
  return plain(cmd)
    .split(/[\s;&|<>()`=]+/)
    .filter((w) => /[*?[{]/.test(w))
    .map((w) => w.replace(/^(~|\$home|\$\{home\})(?=\/|$)/, home));
}

/** A glob in the command that could name `root` or anything in it (`~/.over*`, `/users/*\/.o*\/l*`), or one naming `.overh`/`leads`. */
function globReaches(cmd: string, roots: readonly string[]): boolean {
  // its first segments, as many as the root has, match the root: it names the root or something inside it
  const reaches = (w: string, r: string): boolean => {
    const n = fold(r).split("/").length;
    const segs = w.split("/");
    return segs.length >= n && new Bun.Glob(segs.slice(0, n).join("/")).match(fold(r));
  };
  // only a glob that can land in Overhand's folder: from / or home, or naming .overh…; a repo's own src/leads/* is its own
  return globsIn(cmd).some((w) => /\.overh/.test(w) || (w.startsWith("/") && roots.some((r) => reaches(w, r))));
}

/** A path or glob (folded) that is `root` or inside it; a glob counts when its leading segments can match the root. */
function reaches(p: string, roots: readonly string[]): boolean {
  return roots.some((r) => {
    if (!/[*?[{]/.test(p)) return under(p, r) || under(realPath(p), r) || under(p, realPath(r));
    const n = fold(r).split("/").length;
    const segs = p.split("/");
    return segs.length >= n && new Bun.Glob(segs.slice(0, n).join("/")).match(fold(r));
  });
}

/** Programs whose every argument is a file: a bare name after one is a path where the command runs. */
const FILE_PROGRAMS = /^(rm|rmdir|unlink|mv|cp|ln|touch|tee|sed|perl|chmod|chown|truncate|install|dd|mkdir|cat|tail|head)$/;

/**
 * Every path a shell command's words could name, resolved and folded: from ~ or $HOME, absolute, or relative to the
 * folder it runs in (`cwd`, "" when unknown), followed through its `cd` steps (`cd ~ && …`, `cd .. ; …`). A `cd` the
 * guard can't follow (`cd -`) leaves the folder unknown, and relative words after it resolve to nothing.
 */
export function shellPaths(cmd: string, cwd = ""): string[] {
  return shellSteps(cmd, cwd).flatMap((s) => s.paths);
}

/** One step of a shell command: its words, the folder it runs in ("" when unknown), and the paths its words name. */
interface ShellStep {
  words: string[];
  at: string;
  paths: string[];
}

/** A word resolved against the folder `at` (folded): from ~ or $HOME, absolute, or relative; "" when `at` is unknown. */
function expandWord(w: string, at: string): string {
  const h = w.replace(/^(~|\$home|\$\{home\})(?=\/|$)/, fold(HOME));
  if (h.startsWith("/")) return resolve(h);
  return at ? resolve(at, h) : "";
}

/** A shell command's steps, the folder followed through its `cd`s (a `cd` is a step whose path is where it goes). */
function shellSteps(cmd: string, cwd = ""): ShellStep[] {
  // ponytail: simple `cd X &&` chains only; a subshell, a variable or a function body isn't followed
  let at = cwd ? fold(cwd) : "";
  const out: ShellStep[] = [];
  for (const step of plain(cmd).split(/&&|\|\||[;\n|&]/)) {
    const words = step
      .trim()
      .split(/[\s<>()`=]+/)
      .filter(Boolean);
    if (words[0] === "cd" || words[0] === "pushd") {
      const to = words[1] ?? "";
      at = !to || to === "~" ? fold(HOME) : to === "-" ? "" : expandWord(to, at);
      out.push({ words, at, paths: at ? [at] : [] });
      continue;
    }
    // a word is a path when it has a slash, is where output goes (> file), or is a file program's argument (rm, cp…);
    // a bare word elsewhere (`bun test leads`) is a word
    const writer = FILE_PROGRAMS.test(words[0] ?? "");
    const targets = new Set([...step.matchAll(/>>?\s*([^\s;&|<>]+)/g)].map((m) => m[1] ?? ""));
    const named = words.slice(1).filter((w) => !w.startsWith("-") && (w.includes("/") || writer || targets.has(w)));
    out.push({ words, at, paths: named.map((w) => expandWord(w, at)).filter(Boolean) });
  }
  return out;
}

/** Programs that change files, and the forms of git and find that do. */
const CHANGERS = /^(rm|rmdir|unlink|mv|cp|ln|chmod|chown|truncate|dd|install|rsync|tar|shred|touch|tee|mkdir)$/;
const changes = (words: readonly string[]): boolean => {
  const [program = "", sub = ""] = words;
  if (program === "find") return words.some((w) => /^-(delete|exec|execdir|ok|okdir)$/.test(w));
  if (program === "git") return /^(checkout|reset|clean|restore|stash|rm|mv|switch)$/.test(sub);
  if (program === "sed" || program === "perl") return words.some((w) => /^-[a-z]*i/.test(w));
  return CHANGERS.test(program);
};

/**
 * A command that changes, moves or deletes Overhand's whole folder: it names the folder itself or a folder holding it
 * (`rm -rf ~`, `mv ~/.overhand …`, `find ~/.overhand -delete`), or it runs inside the folder and works on `.` or a
 * relative path (`cd ~/.overhand && git checkout -- .`). The agents' own worktrees inside a checkout are their own.
 */
function changesOps(cmd: string, cwd: string): boolean {
  const worktrees = join(SRC, ".claude", "worktrees");
  return shellSteps(cmd, cwd).some((s) => {
    if (!changes(s.words)) return false;
    const inside = s.at !== "" && under(s.at, OPS) && !under(s.at, worktrees);
    const args = s.words.slice(1).filter((w) => !w.startsWith("-"));
    if (inside && (args.some((w) => !/^[~/$]/.test(w)) || /^(find|git)$/.test(s.words[0] ?? ""))) return true;
    // and a recursive delete of the home folder or the whole disk, whatever it holds
    const wipes = s.words[0] === "rm" && s.words.some((w) => /^-[a-z]*r|^--recursive$/i.test(w));
    return args.some((w) => {
      const p = expandWord(w, s.at);
      return p !== "" && (under(OPS, p) || (wipes && (p === "/" || p === fold(HOME))));
    });
  });
}

/**
 * A word naming Overhand's folder by its own name (or a glob of it) followed by one of `rels` (its files and folders
 * under it), whatever comes before: `.overhand/leads/…` from any folder. `allow` lets a path on through (a lead's own
 * folder).
 */
function namesUnderOps(cmd: string, rels: readonly string[], allow: (segs: string[]) => boolean = () => false): boolean {
  const base = fold(basename(OPS));
  const match = (pattern: string, name: string): boolean => (/[*?[{]/.test(pattern) ? new Bun.Glob(pattern).match(name) : pattern === name);
  return plain(cmd)
    .split(/[\s;&|<>()`=]+/)
    .some((w) => {
      const segs = w.split("/");
      return segs.some((s, i) => {
        // the folder by name, or a glob of it that starts with "." (a shell `*` never matches a dot-folder)
        if (!(s === base || (s.startsWith(".") && match(s, base)))) return false;
        const rest = segs.slice(i + 1);
        return rels.some((rel) => {
          const want = fold(rel).split("/");
          return want.every((part, j) => rest[j] !== undefined && match(rest[j] ?? "", part)) && !allow(rest);
        });
      });
    });
}

/** Overhand's own files and folders under its folder, as paths relative to it ("overhand.config.json", "control"…). */
const relsUnderOps = (self: readonly string[]): string[] =>
  self.filter((p) => under(p, OPS) && fold(p) !== fold(OPS)).map((p) => fold(p).slice(fold(OPS).length + 1));

/**
 * A command naming one of Overhand's own files (selfPaths): in any spelling, quoting or case, by a glob, by its own
 * folder's name from anywhere, or by a relative path from where the command has `cd`-ed to.
 */
const namesSelf = (cmd: string, self: readonly string[], cwd = ""): boolean =>
  self.flatMap(spellings).some((p) => plain(cmd).includes(p)) ||
  globReaches(cmd, self) ||
  shellPaths(cmd, cwd).some((p) => reaches(p, self)) ||
  changesOps(cmd, cwd) ||
  namesUnderOps(cmd, relsUnderOps(self));

/** Programs that only read and can run nothing (not rg --pre, bat --pager, less !, more !, file -C): plain reads only. */
const READERS = /^(cat|tail|head|grep|egrep|fgrep|ls|wc|stat|diff|jq|realpath|readlink)$/;

/** A shell command that only reads (`cat`, `tail -f`, `grep`…): nothing in it writes, moves or deletes a file. */
export function readOnly(cmd: string): boolean {
  // anything that runs more than its words say (a command substitution, a process substitution, a job in the
  // background) or writes (any redirect, tee) isn't a plain read, whatever program starts it
  if (/\$\(|`|<\(|>\(|>|(^|[^&])&(?!&)|\btee\b/.test(cmd)) return false;
  return plain(cmd)
    .split(/&&|\|\||[;\n|]/)
    .every((step) => READERS.test(step.trim().split(/\s+/)[0] ?? "") || !step.trim());
}

/** Overhand's leads' folders, one per lead: each questions file there carries the owner's answers to that lead. */
const LEADS = join(OPS, "leads");
const LEADS_WHY = "a lead writes only in its own folder under Overhand's leads, and nothing else writes there";

/** A path with its symlinks followed (a new file: its folder's); as given when nothing on the way exists. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** `p` is one of Overhand's own files (selfPaths) or inside one, as given and with symlinks followed on both sides. */
function insideSelf(p: string, self: readonly string[]): boolean {
  const paths = [resolve(p), realPath(resolve(p))];
  return self.some((r) => [r, realPath(r)].some((root) => paths.some((x) => under(x, root))));
}

/** The leads' folder as given and as the disk has it, each with the lead `run` is (`lead-<key>`) or "" for any other run. */
function leadRoots(run: string): { root: string; own: string }[] {
  const key = run.startsWith("lead-") ? run.slice("lead-".length) : "";
  const ok = /^[\w-]+$/.test(key);
  return [...new Set([LEADS, realPath(LEADS)])].map((root) => ({ root, own: ok ? join(root, key) : "" }));
}

/**
 * A file tool writing under the leads' folder outside the run's own lead folder: a lead writes only in its own, every
 * other run (a ticket run, a session you opened) nowhere there, so none can forge your answer in a lead's file.
 * Reading is allowed.
 */
function leadsWrite(tool: string, path: string, run: string): string | null {
  if (/^(Read|Glob|Grep|LS)$/.test(tool)) return null;
  const paths = [resolve(path), realPath(resolve(path))];
  for (const { root, own } of leadRoots(run)) for (const p of paths) if (under(p, root) && !(own && under(p, own))) return LEADS_WHY;
  return null;
}

/**
 * `leadsWrite` for a shell command, which can't be read for writes. Compared quoted or not and in any case (plain): a
 * command naming the leads' folder must name only the run's own lead folder, with no `..` and no moving about (`cd`,
 * `$PWD`, `dirname`); none may reach it from Overhand's folder or after a `cd` by a relative `leads/`, or by a glob.
 * Defence in depth: what a lead's file says never counts as yours unless Overhand wrote it (leads.ts authentic).
 */
function leadsCommand(raw: string, run: string, cwd = ""): string | null {
  const cmd = plain(raw);
  let named = false;
  for (const { root, own } of leadRoots(run))
    for (const s of spellings(root))
      for (let i = cmd.indexOf(s); i >= 0; i = cmd.indexOf(s, i + 1)) {
        named = true;
        if (!own || !new RegExp(`^/${fold(basename(own))}(?=[/\\s]|$)`).test(cmd.slice(i + s.length))) return LEADS_WHY;
      }
  if (named && /(^|[/\s])\.\.(?=[/\s]|$)|\b(cd|pushd|popd|dirname|realpath|readlink)\b|\$\{?(old)?pwd\b|`pwd`|\$\(pwd\)/.test(cmd))
    return LEADS_WHY;
  const relative = /(^|[\s=:])(\.\/)?leads\/\S/.test(cmd); // the folder's path, not the word
  // a relative leads/ is Overhand's only from Overhand's folder: the command names it, or its own dot-folder name
  const dotName = basename(OPS).startsWith(".") ? fold(basename(OPS)) : "";
  const fromOps = spellings(OPS).some((p) => cmd.includes(p)) || (dotName !== "" && cmd.includes(dotName));
  if (!named && relative && fromOps) return LEADS_WHY;
  if (globReaches(raw, [LEADS])) return LEADS_WHY;
  // where its words land once its `cd`s are followed, and Overhand's folder named by its own name from anywhere
  for (const { root, own } of leadRoots(run))
    for (const p of shellPaths(raw, cwd))
      if (reaches(p, [root]) && !(own && !/[*?[{]/.test(p) && (under(p, own) || under(realPath(p), own)) && !p.includes("..")))
        return LEADS_WHY;
  const key = run.startsWith("lead-") ? fold(run.slice("lead-".length)) : "";
  if (namesUnderOps(raw, ["leads"], (rest) => key !== "" && rest[1] === key && !rest.includes(".."))) return LEADS_WHY;
  return null;
}

/**
 * Returns why a tool call must be blocked, or null if it's allowed. `self` is Overhand's own files (selfPaths); `autonomy`
 * is the project's level (absent = act).
 */
export function check(
  tool: string,
  input: Record<string, unknown>,
  self = selfPaths(),
  autonomy = process.env.OVERHAND_AUTONOMY ?? "act",
  run = process.env.OVERHAND_RUN ?? "",
  push: readonly string[] = pushBranchesOf(run),
  cwd = "",
): string | null {
  // drafts stay in the owner's own Slack until they send them; a sent message is stamped "Sent using Claude" for clients
  if (/^mcp__.*slack/i.test(tool) && !/__slack_(search_|read_|send_message_draft$)/.test(tool))
    return "Slack is read-only for Overhand's agents; write a draft (slack_send_message_draft) for the owner to send";
  if (autonomy === "watch" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "this project is on watch: report, don't edit";
  // a memory a later run would read as its instructions (Gemini CLI's save_memory): the instructions are Overhand's
  if (tool === "save_memory") return "agents don't write memories that later runs would follow";
  if (tool === TOO_WIDE.tool) return "that read names more files than the guard can check one by one; name the files or a narrower pattern";
  if (tool === UNKNOWN_FILE.tool) return "the guard can't tell which file that edit changes, so it doesn't let it through";
  if (tool === "Bash") {
    const raw = typeof input.command === "string" ? input.command : "";
    // a governor wrap the agent was told to run: what it runs is checked, not Overhand's own path in front of it
    const inner = unwrapHeavy(raw, HEAVY_SELF);
    if (inner !== null) return check(tool, { command: inner }, self, autonomy, run, push, cwd);
    // the command as written and with gh's -R/--repo taken out: what the stripping drops (`x=gh cp -R ~/.ssh ./leak`) is
    // still judged as written, and what it reveals (`gh -R o/r pr merge 1`) as stripped
    const stripped = withoutGhRepo(raw);
    return bashRule(raw, self, autonomy, run, push, cwd) ?? (stripped === raw ? null : bashRule(stripped, self, autonomy, run, push, cwd));
  }
  const all = pathsOf(input);
  const path = all[0];
  // Glob and Grep: the folder searched (as a folder) and the file pattern inside it; Grep's own pattern is the text it
  // looks for, not a path, so a search for the word "password" in code carries on
  const files = tool === "Glob" ? input.pattern : tool === "Grep" ? input.glob : undefined;
  const paths = [
    ...all,
    path && /^(Glob|Grep)$/.test(tool) ? `${path}/` : undefined,
    typeof files === "string" ? join(path ?? "", files) : undefined,
  ];
  for (const p of paths) if (p) for (const [re, why] of PATH_RULES) if (re.test(p)) return why;
  for (const p of all) {
    const why = insideSelf(p, self) ? SELF : leadsWrite(tool, p, run);
    if (why) return why;
  }
  return null;
}

/**
 * Every path a file tool's call names: the usual fields, and a move or copy's source and destination and a list of
 * paths, which other CLIs' tools carry.
 */
function pathsOf(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.paths) ? input.paths : [];
  return [input.file_path, input.path, input.notebook_path, input.source, input.destination, input.target, ...list].filter(
    (p): p is string => typeof p === "string",
  );
}

/** A command that writes words others read: a commit message, a PR or issue title, body or comment. */
const OUTWARD_CMD = /\b(?:gh\s+(?:pr|issue)\s+(?:create|edit|comment|review)|git\s+(?:-C\s+\S+\s+)?commit)\b([\s\S]*)/;

/**
 * The words a tool call sends off the machine, and the project whose destination it is: a commit message or a PR's
 * text (the command after `git commit` / `gh pr create`), or a Slack draft (to the project its workspace belongs to).
 * Null when the call sends nothing. ponytail: `-F file` / `--body-file` contents aren't read; read them if agents use them.
 */
export function outwardOf(
  tool: string,
  input: Record<string, unknown>,
  project: string,
  slack: readonly { server: string; client: string }[] = CFG.slack,
): { text: string; project: string; dest: string } | null {
  if (tool === "Bash") {
    const text = (typeof input.command === "string" ? input.command : "").match(OUTWARD_CMD)?.[1]?.trim();
    return text ? { text, project, dest: project ? `${project}'s repository` : "a repository" } : null;
  }
  const draft = tool.match(/^mcp__(.+)__slack_send_message_draft$/);
  if (!draft) return null;
  const text = Object.values(input)
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  const owner = slack.find((s) => s.server === draft[1])?.client ?? project;
  return { text, project: owner, dest: owner ? `a Slack draft in ${owner}'s workspace` : "a Slack draft" };
}

/**
 * The outward firewall for an agent's own commands: why the call is blocked (it's held for you in Needs you too), or
 * null. Post anyway on its finding lets the same text through once.
 */
export function outwardBlock(tool: string, input: Record<string, unknown>, project: string, cfg: FirewallConfig = CFG): string | null {
  const out = outwardOf(tool, input, project);
  if (!out) return null;
  const hits = scanOutward(out.text, out.project ? [out.project] : [], cfg);
  if (!hits.length) return null;
  const title = tool === "Bash" ? "An agent's commit or PR text" : "An agent's Slack draft";
  try {
    if (cleared({ kind: "agent", project: out.project, dest: out.dest, title, text: out.text }, cfg)) return null;
  } catch {
    // a full disk: it couldn't be held, and it still doesn't go
  }
  const said = hits.map((h) => (h.why === "secret" ? "a secret" : `"${h.term}"${h.project ? ` (${h.project})` : ""}`));
  return `the outward firewall stopped ${[...new Set(said)].join(", ")} from going to ${out.dest}. Take it out and try again; it's held for the owner`;
}

/** The guardrail log under `root` (Overhand's folder, or a sandboxed run's outbox): one JSON line per block, append-only. */
export const guardLogAt = (root: string): string => join(root, "guardrails.jsonl");
export const GUARD_LOG = guardLogAt(OPS);

/**
 * Where this hook and the heavy-job wrap write heartbeats and blocks: Overhand's folder, or the outbox of a run the OS
 * sandbox holds (it can't write control/ there; the daemon takes the outbox in, ingestOutboxes). Set by trustIdentity
 * from Overhand's record of the run, never from the environment.
 */
let writeRoot = OPS;
/** writeRoot, as trustIdentity found it (OPS before it ran). */
export const guardWriteRoot = (): string => writeRoot;

/** What a blocked call tried, for the log: the command or path, secrets redacted, cut short. */
export function attempted(tool: string, input: Record<string, unknown>): string {
  const what = [input.command, input.file_path, input.path, input.notebook_path].find((v): v is string => typeof v === "string") ?? tool;
  return redactSecrets(what.replace(/\s+/g, " ").trim()).slice(0, 300);
}

/**
 * Appends one block to the guardrail log: when, which project and run (OVERHAND_PROJECT and OVERHAND_RUN, set on the
 * agent's environment by its runtime), what it tried and the rule. Never throws: the block stands either way.
 */
export function logBlock(tool: string, input: Record<string, unknown>, rule: string, env = process.env, file = GUARD_LOG): void {
  const row: GuardBlock = {
    at: Date.now(),
    project: env.OVERHAND_PROJECT ?? "",
    run: env.OVERHAND_RUN ?? "",
    tool,
    action: attempted(tool, input),
    rule,
  };
  try {
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // a full disk or a read-only home: the agent is still blocked
  }
}

/** Blocks logged at or after `since`, oldest first, the latest `max`. */
export function guardBlocks(since: number, max = 50, file = GUARD_LOG): GuardBlock[] {
  if (!existsSync(file)) return [];
  // ponytail: reads the whole log; rotate it if it ever grows past a few MB
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const r = GuardBlockSchema.safeParse(JSON.parse(l));
        return r.success && r.data.at >= since ? [r.data] : [];
      } catch {
        return [];
      }
    });
  return rows.slice(-max);
}

/**
 * Tells the CLI the call is blocked, in its own dialect, and exits 2 (every CLI's hook reads exit 2 as "block", with the
 * reason on stderr); Cursor also reads its `permission` answer on stdout.
 */
function deny(dialect: Dialect, message: string): never {
  if (dialect === "cursor") console.log(JSON.stringify({ permission: "deny", agent_message: message, user_message: message }));
  console.error(message);
  process.exit(2);
}

/** The run a process is judged as when its environment names a run Overhand has no record of. */
export const UNRECORDED_RUN = "unrecorded";

/**
 * Who this tool call's run is, from Overhand's record of the process trees it started (control.ts runOf), never from
 * the environment an agent can set: the hook's OVERHAND_RUN, OVERHAND_AUTONOMY and OVERHAND_PROJECT are replaced by the
 * recorded ones. With no recorded ancestor but a run named in the environment (a run that left its tree, say), it's
 * judged with the most care: watch, and a run that isn't any lead's. With nothing named, it's a session opened by hand.
 */
export function trustIdentity(chain: readonly number[] = ancestors(), env = process.env): "recorded" | "claimed" | "none" {
  const who = runOf(OPS, chain);
  writeRoot = who?.sandboxed ? outboxDir(OPS, who.run) : OPS;
  const claimed = !!env.OVERHAND_RUN;
  for (const k of ["OVERHAND_RUN", "OVERHAND_AUTONOMY", "OVERHAND_PROJECT"] as const) delete env[k];
  if (!who) {
    if (claimed) Object.assign(env, { OVERHAND_RUN: UNRECORDED_RUN, OVERHAND_AUTONOMY: "watch" });
    return claimed ? "claimed" : "none";
  }
  env.OVERHAND_RUN = who.run;
  env.OVERHAND_AUTONOMY = who.autonomy;
  if (who.project) env.OVERHAND_PROJECT = who.project;
  return "recorded";
}

/**
 * `overhand guard [hand | <dialect>]`: the hook itself. Exit 2 blocks the call (and logs it); a call it can't read is
 * blocked too. `hand` is your own Claude Code session; a dialect (guard-dialects.ts) is another agent CLI's hook.
 */
export async function guardHook(arg = ""): Promise<void> {
  const dialect = dialectOf(arg);
  // a run named but not recorded is never one of your own sessions: it gets the agent rules, on watch
  const identity = trustIdentity();
  const hand = arg === "hand" && identity !== "claimed";
  const run = process.env.OVERHAND_RUN ?? "";
  // a Overhand run inside a connected project: its own guard (from the agent home) already covers it
  if (hand && identity === "recorded") return; // only a run Overhand recorded, still the process it was, skips checks
  let why: string | null = null;
  let event: Event = { calls: [], cwd: process.cwd(), session: "", transcript: "", mode: "" };
  try {
    event = eventOf(dialect, JSON.parse(await Bun.stdin.text()));
    for (const c of event.calls) {
      why = hand
        ? handCheck(c.tool, c.input, undefined, event.cwd)
        : check(c.tool, c.input, undefined, undefined, undefined, undefined, event.cwd);
      if (why) {
        event.calls = [c]; // the call that was blocked is the one logged
        break;
      }
    }
  } catch (e) {
    if (hand) return; // your own session: a call the hook can't read goes through
    why = `couldn't read the tool call (${String(e)})`;
  }
  const { tool, input } = event.calls[0] ?? { tool: "", input: {} };
  const { cwd, transcript, mode } = event;
  // sessions, heartbeats and pauses are Claude Code's (the control room reads its transcripts)
  const session = dialect === "claude" ? event.session : "";
  const project = process.env.OVERHAND_PROJECT || projectAt(cwd);
  const env = { ...process.env, OVERHAND_PROJECT: project, OVERHAND_RUN: run || (session ? `hand-${session.slice(0, 8)}` : "hand") };
  const beat = session ? heartbeat({ session, tool, input, cwd, transcript }, run, project) : null;
  const paused = session ? loadHolds(OPS)[session] : undefined;
  if (!why && paused) why = `the owner paused this session (${paused.reason}). Stop here and report what you were doing; don't retry`;
  why ??= houseRule(tool, CFG.control);
  // Overhand's agents only: your own sessions write what you tell them to
  if (!why && !hand) why = outwardBlock(tool, input, project);
  let wrap = "";
  if (!why && tool === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    why = protectedHit(cmd, CFG.governor.protect);
    const v = why ? null : governed(cmd, cwd, process.env, { hand, session, project, plan: mode === "plan" });
    if (v && "wait" in v) {
      if (beat) saveBeat(writeRoot, beat);
      logBlock(tool, input, `waited: ${v.wait}`, env, guardLogAt(writeRoot));
      deny(dialect, `${v.wait}.`);
    }
    if (v && "block" in v) why = v.block;
    else if (v) wrap = v.wrap;
  }
  // only Claude Code's hook can rewrite a command: any other agent is told to run the wrap itself (check lets it through)
  if (!why && wrap && dialect !== "claude") {
    logBlock(tool, input, "waited: a heavy job runs in Overhand's shared slot", env, guardLogAt(writeRoot));
    deny(dialect, `Overhand runs heavy jobs in a shared slot so they can share the machine. Run exactly this instead: ${wrap}`);
  }
  if (why) {
    if (beat) saveBeat(writeRoot, beat);
    logBlock(tool, input, why, env, guardLogAt(writeRoot));
    deny(
      dialect,
      `Blocked by Overhand's guard: ${why}. ${hand ? "Find another way or ask the owner." : 'Find another way or return status "question".'}`,
    );
  }
  if (dialect === "cursor") console.log(JSON.stringify({ permission: "allow" }));
  if (dialect !== "claude") return;
  const context = beat ? handOver(beat) : "";
  // the heavy command runs inside `overhand heavy`, which holds its slot and stops it if it hangs; your own sessions
  // still see the rewritten command and approve it (unless they skip permissions anyway)
  const out = wrap
    ? { ...WRAP, ...(hand && mode !== "bypassPermissions" ? { permissionDecision: "ask" } : {}), updatedInput: { ...input, command: wrap } }
    : context
      ? { hookEventName: "PreToolUse" }
      : null;
  if (out) console.log(JSON.stringify({ hookSpecificOutput: { ...out, ...(context ? { additionalContext: context } : {}) } }));
}

/** How a session runs Overhand's CLI, for the lines it's handed (`overhand ack …`). */
const CLI = BUNDLED ? "overhand" : `bun ${join(SRC, "run.ts")}`;

/** The project a folder belongs to: a configured project's, else its repository's folder name. */
export function projectAt(cwd: string): string {
  return CLIENTS.find((c) => under(resolve(cwd), join(CODE, c.dir)))?.name ?? basename(repoOf(cwd) || cwd);
}

/** This call's heartbeat (not saved yet). Never throws: the guard's verdict stands either way. */
function heartbeat(
  call: { session: string; tool: string; input: Record<string, unknown>; cwd: string; transcript: string },
  run: string,
  project: string,
): Beat | null {
  try {
    return nextBeat(beatOf(writeRoot, call.session) ?? beatOf(OPS, call.session), call, { run, project }, claudePid, Date.now());
  } catch {
    return null;
  }
}

/**
 * What the session is handed with this call: the house rules when it hasn't seen this version, and requests waiting for
 * it. Saves the heartbeat with that recorded; never throws.
 */
function handOver(b: Beat): string {
  const parts: string[] = [];
  try {
    const version = rulesVersion(CFG.control, CFG.governor.protect);
    if (b.rulesSeen !== version) {
      const rules = rulesText(CFG.control, CFG.governor.protect);
      if (rules) parts.push(rules);
      b.rulesSeen = version;
    }
    const now = Date.now();
    const due = dueFor(loadRequests(OPS), b.id, now);
    if (due.length) {
      parts.push(...due.map((r) => requestText(r, CLI)));
      const ids = new Set(due.map((r) => r.id));
      if (writeRoot === OPS) editRequests(OPS, (rs) => rs.map((r) => (ids.has(r.id) ? { ...r, deliveredAt: now } : r)));
      else appendFileSync(join(writeRoot, "delivered.jsonl"), `${JSON.stringify({ session: b.id, ids: [...ids], at: now })}\n`);
    }
    saveBeat(writeRoot, b);
  } catch {
    // a full disk: the call goes ahead, the rules and requests come with a later one
  }
  return parts.join("\n\n");
}

/**
 * What a session you opened by hand may not do, besides the house rules: change Overhand itself (its config holds the
 * house rules), write in a lead's folder (where your answers live), or change Claude Code's settings files (where the
 * hook lives). Overhand's agent rules don't apply to it.
 */
export function handCheck(tool: string, input: Record<string, unknown>, self = selfPaths(), cwd = ""): string | null {
  if (tool === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (readOnly(cmd)) return null; // you may read Overhand's files and your leads' (cat, tail -f); only writes are stopped
    return namesSelf(cmd, self, cwd) ? SELF : leadsCommand(cmd, "", cwd);
  }
  for (const path of pathsOf(input)) {
    if (/\/\.claude[^/]*\/(settings(\.local)?\.json)$/i.test(path))
      return "Overhand's hook lives in Claude Code's settings; change them yourself";
    const why = insideSelf(path, self) ? SELF : leadsWrite(tool, path, "");
    if (why) return why;
  }
  return null;
}

/**
 * A hook can only change a command by approving the rewrite; the hard rules already passed it, deny rules still apply,
 * and `wrappable` keeps it to plain tool runs.
 */
const WRAP = {
  hookEventName: "PreToolUse",
  permissionDecision: "allow",
  permissionDecisionReason: "Overhand's governor runs heavy jobs in a shared slot",
};

/**
 * The governor's verdict on a shell command, with this machine's readings, the house rules and Overhand's own command
 * line. A watch run (plan mode) is only gated, never rewritten; an agent's package scripts are vetted against the hard
 * rules before any rewrite (your own sessions approve the rewrite themselves).
 */
function governed(
  cmd: string,
  cwd: string,
  env = process.env,
  who: { hand?: boolean; session?: string; project?: string; plan?: boolean } = {},
): Verdict {
  const self = HEAVY_SELF;
  const machine = () => readMachine(Math.min(freeGb(OPS), freeGb(CODE || OPS)));
  const readOnly = env.OVERHAND_AUTONOMY === "watch" || (who.hand === true && who.plan === true);
  const vet = (c: string) => riskyScript(c, scriptsAt(cwd, c), (body) => check("Bash", { command: body }));
  const project = who.project ?? env.OVERHAND_PROJECT ?? "";
  // the house rules' windows and the project's group's
  const control = { ...CFG.control, windows: windowsFor(CFG, project) };
  const hold = (kind: Heavy) => ruleHold(kind, control, { ops: OPS, project, session: who.session ?? "" });
  return govern(cmd, CFG.governor, { ops: OPS, machine, self, readOnly, vet: who.hand ? undefined : vet, hold, session: who.session });
}

/** The package.json scripts where a command runs: the hook's folder, after a leading `cd <dir> &&`. */
function scriptsAt(cwd: string, cmd: string): Record<string, string> {
  const dir = cmd.match(/^\s*cd\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*&&/);
  const at = resolve(cwd, (dir?.[1] ?? dir?.[2] ?? dir?.[3] ?? ".").replace(/^~(?=\/|$)/, HOME));
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
    const scripts = typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : null;
    if (typeof scripts !== "object" || scripts === null) return {};
    return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}
