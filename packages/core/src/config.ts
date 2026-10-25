import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Autonomy,
  AutonomySchema,
  BillingSchema,
  type GroupRules,
  GroupRulesSchema,
  HoldWindowSchema,
  LEAD_WORK,
  type LeadScope,
  LeadScopeSchema,
  type QuickSetting,
  RoutingModeSchema,
  UpdateChannelSchema,
} from "@overhand/contract";
import { z } from "zod";
import { buildDirs, sourceCommands } from "./cleanup-sources";

/**
 * Linear and Jira are read through Overhand's own MCP sign-in when it's connected (Settings → Integrations); `secret`
 * names a secret store item holding an API token, the fallback when it isn't. Empty: no token.
 */
const Linear = z.object({ kind: z.literal("linear"), secret: z.string().default("") });
const Jira = z.object({
  kind: z.literal("jira"),
  secret: z.string().default(""),
  site: z.string().min(1),
  email: z.string().default(""),
  project: z.string().min(1),
});

/** GitHub Issues through the signed-in `gh` CLI; no token needed. */
const GitHubIssues = z.object({ kind: z.literal("github"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name") });

const JenkinsSchema = z.object({
  url: z.string(),
  user: z.string(),
  secret: z.string(),
  /** Organization folder holding one multibranch job per repo; this project's Bitbucket repos build here. */
  orgFolder: z.string(),
  /** Plain folders whose jobs are shown as-is (e.g. app store builds). */
  jobFolders: z.array(z.string()).default([]),
});

/** Model pins shared by the non-Claude backends; empty keeps Claude Code's own default for that backend. */
const Models = {
  /** Every run uses this model (ANTHROPIC_MODEL and the opus/sonnet aliases); empty = the backend's default. */
  model: z.string().default(""),
  /** Background and `haiku` runs (ANTHROPIC_DEFAULT_HAIKU_MODEL); empty = `model`. */
  smallModel: z.string().default(""),
};

/**
 * The model backend an account's Claude Code runs talk to. `claude`: Anthropic, signed in one of two ways (`auth`):
 * `login`, Claude Code's own sign-in in the account's own config folder (Overhand never sees the credential), or `key`,
 * an Anthropic API key from the secret store (anthropic-key-<account>). `bedrock` / `vertex`: the cloud's own credentials
 * (AWS / gcloud) already on this machine. `gateway`: any Anthropic-compatible endpoint (Ollama, LiteLLM, OpenRouter, ...).
 */
const ProviderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude"),
    auth: z.enum(["login", "key"]).default("login"),
    /**
     * On `login`: runs use the Claude Code sign-in you already had instead of a folder of the account's own. The
     * CLAUDE_CONFIG_DIR it lives in, or "" for Claude Code's default (~/.claude, the variable left unset: Claude Code keys
     * its Keychain item to whether the variable is set, so setting it to ~/.claude would miss that login).
     */
    existing: z.string().optional(),
    /**
     * With `existing`: when the account's own folder had a valid sign-in, so its runs moved there (agent-home.ts
     * runHome); until then they stay on `existing`, and pause under the enforced sandbox.
     */
    movedAt: z.number().optional(),
    /** With `existing`: the Slack inbox's MCP sign-in is done in the account's own folder too, so the inbox moved as well. */
    slackMoved: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("bedrock"), region: z.string().min(1), profile: z.string().default(""), ...Models }),
  z.object({ kind: z.literal("vertex"), region: z.string().min(1), project: z.string().min(1), ...Models }),
  z.object({
    kind: z.literal("gateway"),
    baseUrl: z.url(),
    /** Secret store item sent as ANTHROPIC_AUTH_TOKEN; empty = a placeholder, for local servers that accept any token. */
    secret: z.string().default(""),
    ...Models,
  }),
]);

/** The agent CLIs ops can drive (packages/core/src/runtimes). */
export const RUNTIME_IDS = ["claude-code", "codex", "gemini", "cursor", "opencode", "aider"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

const RuntimeSchema = z.object({
  kind: z.enum(RUNTIME_IDS),
  /** The CLI's own model flag (codex -m, gemini -m, cursor --model, opencode -m provider/model, aider --model); empty = its default. Claude Code takes its model from `providers`. */
  model: z.string().default(""),
  /**
   * The CLI signs in in a folder of this account's own (agent-home/accounts/<label>) instead of using this computer's
   * login, so two accounts of one CLI keep separate logins. Only CLIs whose login can move (Codex, by CODEX_HOME).
   */
  ownLogin: z.boolean().optional(),
  // Per-agent tuning (Settings → Agent accounts). Each is passed only to CLIs that take it (runtimes/tune.ts); every
  // field is optional so a config that never set one stays as it was.
  /** Effort or reasoning level: Claude Code --effort, Codex model_reasoning_effort, Cursor's model [effort=…], Aider --reasoning-effort, OpenCode --variant. */
  effort: z.string().optional(),
  /** Claude Code --fallback-model, tried when the model is overloaded. */
  fallbackModel: z.string().optional(),
  /** Claude Code --max-budget-usd for one ticket run; 0 or absent = no cap. */
  maxRunUsd: z.number().min(0).optional(),
  /** This account's task timeout in minutes; absent = limits.taskTimeoutMin. */
  timeoutMin: z.number().int().min(5).optional(),
  /** Tools the agent may not use (Claude Code --disallowedTools, e.g. WebFetch or mcp__slack). Only ever narrows. */
  blockedTools: z.array(z.string()).optional(),
  /** The only MCP servers the agent may use (Gemini CLI --allowed-mcp-server-names); absent = all. */
  mcpServers: z.array(z.string()).optional(),
  /** false: no skills or slash commands in runs (Claude Code --disable-slash-commands). */
  skills: z.boolean().optional(),
  /** Runs inside the CLI's own sandbox (Gemini CLI --sandbox, Cursor --sandbox enabled), on top of Overhand's guard. */
  sandbox: z.boolean().optional(),
  /** Extra flags for the CLI; a flag that would loosen the guard or override what Overhand sets is refused (`deniedFlags`). */
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Flags an account's `extraArgs` may not carry, per CLI: anything that skips approvals or the sandbox, changes the
 * permission mode, loads other settings or hooks, widens the folders it may touch, or overrides a flag Overhand sets
 * itself (output format, schema, prompt). Checked by name, before any `=value`.
 */
const DENIED_FLAGS: Record<RuntimeId, string[]> = {
  "claude-code": [
    "-p",
    "--print",
    "--permission-mode",
    "--permission-prompts",
    "--permission-prompt-tool",
    "--settings",
    "--setting-sources",
    "--bare",
    "--allowedTools",
    "--allowed-tools",
    "--add-dir",
    "--mcp-config",
    "--strict-mcp-config",
    "--plugin-dir",
    "--plugin-url",
    "--agents",
    "--system-prompt",
    "--system-prompt-file",
    "--append-system-prompt",
    "--append-system-prompt-file",
    "--output-format",
    "--json-schema",
    "--model",
  ],
  codex: [
    "-s",
    "--sandbox",
    "-c",
    "--config",
    "-a",
    "--ask-for-approval",
    "--full-auto",
    "-p",
    "--profile",
    "--add-dir",
    "--cd",
    "-C",
    "--oss",
    "--output-schema",
    "--json",
    "--disable",
    "-m",
    "--model",
  ],
  gemini: ["-y", "--approval-mode", "--allowed-tools", "--include-directories", "-p", "--prompt", "-o", "--output-format", "-m", "--model"],
  cursor: [
    "-f",
    "--force",
    "--sandbox",
    "--approve-mcps",
    "--trust",
    "--workspace",
    "--add-dir",
    "--mode",
    "--plan",
    "-p",
    "--print",
    "--output-format",
    "--api-key",
    "-e",
    "--endpoint",
    "-H",
    "--header",
    "-w",
    "--worktree",
    "--plugin-dir",
    "--model",
  ],
  opencode: ["--auto", "--agent", "--format", "--attach", "--dir", "-p", "--password", "-u", "--username", "--port", "-m", "--model"],
  aider: [
    "--yes-always",
    "--message",
    "-m",
    "--msg",
    "--chat-mode",
    "--auto-commits",
    "--suggest-shell-commands",
    "--aiderignore",
    "-c",
    "--config",
    "--env-file",
    "--auto-test",
    "--test-cmd",
    "--auto-lint",
    "--lint-cmd",
    "--no-git",
    "--openai-api-base",
    "--input-history-file",
    "--chat-history-file",
    "--model",
  ],
};

/** The extra flags of `args` a CLI may not be given (empty = all fine): DENIED_FLAGS, and anything named dangerous, bypass or yolo. */
export function deniedFlags(kind: RuntimeId, args: readonly string[]): string[] {
  const denied = new Set(DENIED_FLAGS[kind]);
  return args.filter((a) => {
    if (!a.startsWith("-")) return false;
    const name = a.split("=")[0] ?? a;
    return denied.has(name) || /dangerous|bypass|yolo|skip-permissions/i.test(name);
  });
}

const ClientSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  prefix: z.string().regex(/^[A-Z][A-Z0-9]+$/, "uppercase letters and digits, e.g. HONEY"),
  host: z.enum(["github", "bitbucket"]),
  /** Where its tickets live; none = no ticket queue (agents still take work from the dashboard and Slack). */
  tracker: z.discriminatedUnion("kind", [Linear, Jira, GitHubIssues]).optional(),
  /** Lowercase org logins and words that identify this client in repo, project and job names. */
  aliases: z.array(z.string()).default([]),
  /**
   * Words private to this project (people, product names, hosts): the outward firewall holds any text carrying one bound
   * for ANOTHER project's repo, tracker or channel. Its name, aliases and ticket keys are covered without listing them.
   */
  private: z.array(z.string().min(1)).optional(),
  // The rules below may be left out: the project then follows its group's (config `groups`), else the default. Set here,
  // they override the group for this project alone (effectiveClients in packages/core/src/groups.ts).
  /** The account this project runs on (the first listed); empty = the first account. */
  accounts: z.array(z.string()).optional(),
  /** When the preferred accounts are all at their limit, carry on with any other account. */
  fallbackToAll: z.boolean().optional(),
  /**
   * How far agents and leads may go here: `watch` (investigate and report, no code, no PRs), `propose` (draft PRs a person
   * marks ready), `act` (PRs ready for review) or `ship` (as `act`, then Overhand turns on GitHub's auto-merge, so the PR
   * merges once every required check passes). A config written before this existed keeps acting as it did; new projects
   * start on `propose`. `ship` is set per project, never for a group, and only on GitHub; Overhand turns it on only where
   * the base branch has a required status check (packages/core/src/ship.ts). Agents merge nowhere else.
   */
  autonomy: AutonomySchema.optional(),
  /** On a `ship` project: what stops a PR from merging by itself. Left out: the defaults in packages/core/src/ship.ts. */
  ship: z
    .object({
      /** Paths a self-merging PR may not touch; one that does waits for your merge. "dir/" = everything under it, else a glob. */
      protect: z.array(z.string().min(1)).optional(),
      /** PRs a day that may merge by themselves here; the rest wait for your merge. */
      perDay: z.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * How far a ticket goes when you assign an agent to it yourself on a `watch` or `propose` project: `act` (a PR ready for
   * review) or `propose` (a draft PR). Only that ticket; everything else on the project keeps `autonomy`. That PR waits
   * for your merge.
   */
  assignedAutonomy: AutonomySchema.exclude(["watch", "ship"]).optional(),
  /**
   * How to render this project for before/after screenshots on PRs that change UI: a shell command run in the repo that
   * serves it (e.g. `bun install && bun run storybook --ci -p 6106`) and the URL to open once it answers. Unset = no
   * screenshots. Governor-gated: skipped while the machine is busy.
   */
  preview: z.object({ command: z.string().default(""), url: z.string().default("") }).optional(),
  /**
   * "off": with `sandbox.mode` on, this project's runs and checks start without the OS sandbox, on the guard only (Xcode,
   * Swift packages and firebase-tools can't run inside it). `sandbox.required` still holds it. Left out: "inherit".
   */
  sandbox: z.enum(["inherit", "off"]).optional(),
  /**
   * "Run here when my computer is off" (hosted.ts): while this computer is away, its queued tickets run on Overhand's
   * machines, on an API key of yours, from your run minutes. Off when left out; GitHub projects only.
   */
  hosted: z.boolean().optional(),
  /** This project's CI, deploy and error sources; whatever they return is shown under this project. GitHub Actions needs nothing here. */
  status: z
    .object({
      jenkins: JenkinsSchema.optional(),
      /** Keychain items holding Vercel tokens. */
      vercelSecrets: z.array(z.string()).default([]),
      /** Keychain items holding Sentry tokens. */
      sentrySecrets: z.array(z.string()).default([]),
    })
    .prefault({}),
});

/**
 * A group of projects (one client, one org, your side projects): rules set once for every member. Nothing on disk moves;
 * a project in no group is its own group, as before groups existed.
 */
export const GroupSchema = z.object({
  name: z.string().min(1),
  /** Project (client) names; a project belongs to at most one group. */
  members: z.array(z.string().min(1)).default([]),
  rules: GroupRulesSchema.prefault({}),
  /** The lead scope last applied from Settings or onboarding; absent = never chosen. */
  lead: LeadScopeSchema.optional(),
});

/**
 * An account label. It names secret store items and keys `providers` and `runtimes`, which Settings edits by dotted
 * path: a dot would split the path and a label of only digits would read as an array index.
 */
const AccountLabel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ (e.g. work-max)")
  .refine((s) => !/^\d+$/.test(s), "not only digits (e.g. acct-2)");

/**
 * The daily budget setup writes into a new install whose first account is, or may be, billed (pay per use, cloud, or a
 * sign-in not yet known to be a plan); a local model gets none. Existing configs keep theirs.
 */
export const FIRST_DAY_BUDGET_USD = 10;

const ConfigSchema = z.object({
  owner: z.object({
    name: z.string().min(1),
    keychainAccount: z.string().min(1),
    /**
     * Your GitHub login. On a watch project, an issue counts as assigned to an agent only when this login added the queue
     * label; empty = the login `gh` is signed in as.
     */
    githubLogin: z.string().default(""),
  }),
  // none yet is fine during first-run setup; agents simply don't start until one is added
  accounts: z.array(AccountLabel),
  /** Model backend per account label; an account not listed here uses `claude`. */
  providers: z.record(z.string(), ProviderSchema).default({}),
  /** Agent CLI per account label; an account not listed here runs Claude Code. */
  runtimes: z.record(z.string(), RuntimeSchema).default({}),
  /**
   * How each account is paid for (plan, pay-per-use, cloud, local), where the person set it (Settings asks when its sign-in
   * can't tell); an account not listed here has the billing its setup points to (`detectBilling`). Only pay-per-use and
   * cloud runs are billed, and only they count toward the daily budget.
   */
  billing: z.record(z.string(), BillingSchema).default({}),
  // none yet is fine: the dashboard welcomes you and walks you through adding the first project
  clients: z.array(ClientSchema),
  /** Groups of projects with shared rules; empty = every project stands alone, as before groups. */
  groups: z.array(GroupSchema).default([]),
  /**
   * Which account a new ticket runs on, from the scorecard. `off`: today's order. `suggest` (the default): Needs you says
   * when another configured combo merges clearly more often on a project; nothing changes by itself. `auto`: each new
   * ticket goes to the project's allowed account (`accounts`, else all) that scores best, today's order while samples are
   * thin, and on to the next allowed account when one is cooling down or its CLI or gateway doesn't answer. Auto never
   * spreads work over two accounts of the same CLI and backend.
   */
  routing: z.object({ mode: RoutingModeSchema.default("suggest") }).prefault({}),
  /** The folder that holds your projects; empty = the folder ops sits in (a checkout) or ~/Code (an installed binary). */
  codeRoot: z.string().default(""),
  /**
   * Where Overhand clones the repos you pick from GitHub or paste, one folder per owner; empty = the code root (a
   * checkout) or ~/Overhand/projects (an installed binary).
   */
  projectsDir: z.string().default(""),
  /** GitHub org logins that are not tracked clients, mapped to a display name. */
  otherOrgs: z.record(z.string(), z.string()).default({}),
  labels: z
    .object({
      queue: z.string().default("agent"),
      working: z.string().default("agent-working"),
      review: z.string().default("agent-review"),
      blocked: z.string().default("needs-owner"),
      fromSlack: z.string().default("from-slack"),
    })
    .prefault({}),
  schedule: z
    .object({
      /** Hour (0–23) from which the daily plan is written. */
      planFromHour: z.number().int().min(0).max(23).default(7),
      /** When the night report is pushed (local hour); -1 turns it off. */
      briefAtHour: z.number().int().min(-1).max(23).default(8),
      /** Which half of the world the scenes' seasons follow; auto reads it from the time zone. */
      hemisphere: z.enum(["auto", "north", "south"]).default("auto"),
      /** Slack is read only between these hours. */
      inboxFromHour: z.number().int().min(0).max(23).default(7),
      inboxToHour: z.number().int().min(1).max(24).default(21),
      inboxEveryMin: z.number().int().min(5).default(30),
      /** Minutes between work passes after a pass that did / didn't start an agent. */
      busyPollMin: z.number().min(0.5).default(1),
      idlePollMin: z.number().min(0.5).default(3),
    })
    .prefault({}),
  limits: z
    .object({
      maxTasksPerRun: z.number().int().min(1).default(4),
      /** Agent runs at once, never two for the same client. */
      maxParallel: z.number().int().min(1).default(2),
      taskTimeoutMin: z.number().int().min(5).default(75),
      maxAttempts: z.number().int().min(1).default(2),
      maxFixes: z.number().int().min(0).default(3),
      cooldownMin: z.number().int().min(1).default(60),
      /** Slack work items wait this long before becoming tickets, so you can veto them. */
      slackVetoMin: z.number().int().min(0).default(30),
      /** Repos without a commit for this long are ignored. */
      dormantDays: z.number().int().min(1).default(180),
      /**
       * Stops pay-per-use and cloud accounts' new agents and leads once their estimated billed spend today reaches this many
       * dollars, until the next day; plan and local accounts aren't charged per run and never count. 0 = no cap. A new
       * install with a billed account starts at FIRST_DAY_BUDGET_USD.
       */
      dailyBudgetUsd: z.number().min(0).default(0),
      /**
       * Pace each Claude account's weekly window: no new work on an account that has used more of its week than has
       * passed, until the week catches up, so it isn't spent by Wednesday. Off = run until the window is full.
       */
      paceWeekly: z.boolean().default(false),
    })
    .prefault({}),
  /** The menu bar item on a Mac (menubar.ts): what needs you, what's running, quiet mode, one click from anywhere. */
  menubar: z.boolean().default(true),
  /** The look last picked in the dashboard (packages/themes ids), so the menu bar item draws in it too. */
  look: z.string().default("overhand"),
  bitbucket: z.object({ email: z.string(), workspace: z.string(), secret: z.string() }).optional(),
  slack: z.array(z.object({ server: z.string(), client: z.string() })).default([]),
  /** Keychain items for status sources shared across projects; items are matched to projects by name and aliases. */
  status: z
    .object({
      vercelSecrets: z.array(z.string()).default([]),
      sentrySecrets: z.array(z.string()).default([]),
      icalSecret: z.string().default(""),
    })
    .prefault({}),
  /** What clients see in their repos and trackers. */
  outward: z
    .object({
      /** Prefix for agent branches; empty = just the ticket key (e.g. EW-670). */
      branchPrefix: z.string().default(""),
      /** Let Claude Code add its "Generated with Claude Code" PR line and Co-Authored-By commit trailer. */
      aiAttribution: z.boolean().default(false),
      /** Post one comment on an agent PR listing corners its diff may have cut, once per new finding (GitHub). */
      cornerComment: z.boolean().default(false), // off until you choose it: it posts in the project's repo, which clients may see
      /** Words that never leave this machine through Overhand or its agents, anywhere: private emails, hosts, names. */
      deny: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  /**
   * What disk cleanup may remove, one switch per category. A category that's off is listed in the preview but never
   * cleaned. Paths starting with ~ are under your home folder.
   */
  cleanup: z.preprocess(
    legacyCleanup,
    z
      .object({
        categories: z
          .object({
            /** Agent worktrees: merged or closed branches, and clean, fully pushed ones idle this many days. Branches are kept. */
            worktrees: z
              .object({
                enabled: z.boolean().default(true),
                staleDays: z.number().int().min(1).default(21),
                /** node_modules and test artifacts (screenshots, reports) in agent worktrees idle this many days; reinstalled on next use. */
                depsIdleDays: z.number().int().min(1).default(5),
              })
              .prefault({}),
            /** Old agent CLI versions beyond the newest `keep`; the version in use is never touched. */
            versions: z.object({ enabled: z.boolean().default(true), keep: z.number().int().min(1).default(2) }).prefault({}),
            /**
             * Caches the known tools keep (packages/core/src/cleanup-sources.ts), plus your own `paths` whose contents rebuild themselves and
             * tools' own cleanup `commands` (each skipped when missing).
             */
            caches: z
              .object({
                enabled: z.boolean().default(true),
                paths: z.array(z.string()).default(() => []),
                commands: z.array(z.string()).default(sourceCommands),
              })
              .prefault({}),
            /** Git-ignored dependency and build folders in projects under the Code root untouched this many days. */
            builds: z
              .object({
                enabled: z.boolean().default(false),
                idleDays: z.number().int().min(1).default(30),
                dirs: z.array(z.string().regex(/^[\w.-]+$/, "a folder name")).default(buildDirs),
              })
              .prefault({}),
            /** Stopped containers, dangling images and build cache. Volumes only with `volumes` on: they hold data. */
            docker: z.object({ enabled: z.boolean().default(false), volumes: z.boolean().default(false) }).prefault({}),
            /** iOS simulators Xcode can no longer run; `all` deletes every simulator. */
            simulators: z.object({ enabled: z.boolean().default(true), all: z.boolean().default(false) }).prefault({}),
            /** Second full clones of a repo already cloned elsewhere: listed unticked, removed only clean and fully pushed. */
            clones: z.object({ enabled: z.boolean().default(true) }).prefault({}),
            /** Agents' transcripts and history (yours, and Overhand reads them): offered unticked once unused 90 days. */
            history: z.object({ enabled: z.boolean().default(true) }).prefault({}),
            /** Local AI models (Ollama, LM Studio, Hugging Face) unused 90 days: offered unticked, never unattended. */
            models: z.object({ enabled: z.boolean().default(true) }).prefault({}),
            /** Agent CLIs no account uses and unused 90 days: offered unticked, removed by their package manager. */
            tools: z.object({ enabled: z.boolean().default(true) }).prefault({}),
            /** Overhand's scratch folders and known tools' caches in the temp folder, a day old. */
            temp: z.object({ enabled: z.boolean().default(true) }).prefault({}),
            /** Overhand's own logs/ and runs/ older than this many days. */
            logs: z.object({ enabled: z.boolean().default(true), days: z.number().int().min(1).default(14) }).prefault({}),
          })
          .prefault({}),
        /** Unattended cleanup of the safe categories, only while no agent or lead runs. */
        auto: z
          .object({
            schedule: z.enum(["off", "weekly", "daily"]).default("off"),
            /** With a schedule set, also clean early when free disk drops below this many GB. */
            belowFreeGb: z.number().min(0).default(20),
          })
          .prefault({}),
        /** Below this many GB free, new agents and leads don't start and Needs you asks for a cleanup. */
        minFreeGb: z.number().min(0).default(3),
      })
      .prefault({}),
  ),
  /**
   * The OS sandbox around every agent run Overhand starts (core/src/sandbox.ts): "off" runs as before; "log" runs as
   * before and records what it would deny (macOS); "enforce" lets a run write only its own folder, caches and its CLI's
   * state. A change applies to runs started after it. `required`: where the sandbox can't run (Linux without user
   * namespaces, most Docker setups), refuse to start runs instead of running them on the guard alone.
   */
  sandbox: z
    .object({
      mode: z.enum(["off", "log", "enforce"]).default("off"),
      required: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Plugins (core/src/plugins.ts), each installed from `source` at `pin` (a git commit, or a tarball's SHA-256), `dir`
   * its folder inside that. `approved`: the digest of the files you approved ("" until you do); a plugin runs only
   * while its files still match it. `grant`: the secrets it asked for that you gave it. Never updated on its own.
   */
  plugins: z
    .array(
      z.object({
        name: z.string(),
        source: z.string().min(1),
        pin: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "a 40-character git commit or a 64-character SHA-256"),
        dir: z.string().default(""),
        approved: z.string().default(""),
        grant: z.array(z.string()).default([]),
        paused: z.boolean().default(false),
      }),
    )
    .default([]),
  /**
   * The machine governor: heavy jobs Overhand's agents and leads start (headless browsers, full test suites, builds,
   * simulators, dev servers) share these slots across every run on this machine, and only start while the machine has
   * room. The guard hook enforces it; `overhand quiet 3h` or the dashboard holds them all off.
   */
  governor: z
    .object({
      enabled: z.boolean().default(true),
      /** How many of each kind may run at once across every agent and lead. */
      slots: z
        .object({
          browser: z.number().int().min(0).default(1),
          suite: z.number().int().min(0).default(1),
          simulator: z.number().int().min(0).default(1),
          build: z.number().int().min(0).default(2),
          devserver: z.number().int().min(0).default(2),
        })
        .prefault({}),
      /** No heavy job starts while the 1-minute load average per CPU core is above this. */
      maxLoadPerCore: z.number().min(0.1).default(1.5),
      /** On battery below this percent, no heavy job starts; 0 = ignore the battery. */
      minBatteryPct: z.number().min(0).max(100).default(30),
      /** Hold heavy jobs while the machine reports thermal throttling (macOS). */
      thermal: z.boolean().default(true),
      /** Below this many GB free, heavy jobs wait; Needs you warns below `warnFreeGb`. `cleanup.minFreeGb` stops agents. */
      pauseHeavyBelowGb: z.number().min(0).default(8),
      warnFreeGb: z.number().min(0).default(15),
      /** Wall-clock limit per heavy job, in minutes, by kind; the job's whole process tree is killed past it. */
      timeoutMin: z
        .object({
          browser: z.number().min(1).default(20),
          suite: z.number().min(1).default(30),
          simulator: z.number().min(1).default(45),
          build: z.number().min(1).default(30),
          devserver: z.number().min(1).default(240),
        })
        .prefault({}),
      /** A heavy job (not a dev server) that prints nothing for this many minutes is taken as hung and killed. */
      silentMin: z.number().min(1).default(10),
      /** What agents must never stop or restart: listening ports, process names, Docker container name prefixes. */
      protect: z
        .object({
          ports: z.array(z.number().int().min(1).max(65535)).default(() => [4317]),
          names: z.array(z.string().min(1)).default([]),
          containerPrefixes: z.array(z.string().min(1)).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * The control room: house rules the guard applies to every connected session on this machine (Overhand's agents and
   * leads, and Claude Code sessions you opened by hand in a project you connected with `overhand connect`), and the
   * standing approvals that let Overhand act on an action card without asking. This file is Overhand's own: agents can't
   * edit it.
   */
  control: z
    .object({
      /**
       * Daily hold windows, "HH:MM" local time: inside one, heavy jobs of these kinds wait (empty kinds = every kind). A
       * quiet window is one with no kinds; "no browsers before 19:00" is { from: "00:00", to: "19:00", kinds: ["browser"] }.
       */
      windows: z.array(HoldWindowSchema).default([]),
      /** Slack: every connected session may only search, read and write drafts; sending is yours. */
      slackDraftsOnly: z.boolean().default(true),
      /** Rules in your words, handed to every connected session once (and again after a change). */
      notes: z.array(z.string().min(1)).default([]),
      /**
       * What Overhand does without asking, per kind of action card and project ("*" = every project): the action
       * happens and is reported instead of asked. `allow-heavy-in-quiet` instead exempts a project from quiet mode.
       */
      approvals: z
        .array(
          z.object({
            action: z.enum([
              "stop-heavy-in-quiet",
              "one-at-a-time",
              "close-foreign-pr",
              "pause-same-files",
              "stop-silent",
              "allow-heavy-in-quiet",
            ]),
            project: z.string().min(1).default("*"),
            at: z.number().default(0),
          }),
        )
        .default([]),
    })
    .prefault({}),
  /**
   * Team status updates: each posts a summary of its projects to a Slack, Teams or Discord incoming webhook (the URL is in
   * the secret store as status-update-<id>), on a schedule or from the dashboard.
   */
  updates: z.array(UpdateChannelSchema).default([]),
  /**
   * Per-project work reports: on `weekly`, each project's report on the past 7 days is written on `weekday` at `hour`
   * (0 Sunday … 6 Saturday) to reports/work/, and posted to the status update `channels` listed here (by id; each gets
   * only its own projects, through the outward firewall). Any range is on demand from Health either way.
   */
  reports: z
    .object({
      weekly: z.boolean().default(false),
      weekday: z.number().int().min(0).max(6).default(1),
      hour: z.number().int().min(0).max(23).default(9),
      channels: z.array(z.string()).default([]),
      /** Put the cost in posted reports (off: a client channel shouldn't see it). Exports always have it. */
      cost: z.boolean().default(false),
    })
    .prefault({}),
  /** Extra origins (e.g. a `tailscale serve` URL) allowed to trigger dashboard actions; the first opens from phone notifications. */
  dashboardOrigins: z.array(z.url()).default([]),
  /** Keychain item holding an ntfy topic URL (e.g. https://ntfy.sh/<random>); every notification is pushed there too. Empty = Mac only. */
  ntfySecret: z.string().default(""),
  /** Leads ("godmode"): long-running Claude sessions ops keeps alive per project. `dir` is relative to the Code root. */
  godmode: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
        label: z.string().min(1),
        /** The character name the dashboard tells its story with (e.g. "Wren"); empty = one from the theme's cast. */
        name: z.string().default(""),
        dir: z.string().min(1),
        /** The project this lead belongs to (a client name), or the group it leads (a group name). */
        project: z.string().default(""),
        /** What the lead works toward; used by ops' generic lead instructions. */
        goal: z.string().default(""),
        /** First instruction; empty = ops' generic lead (e.g. "godmode" when the repo ships its own lead skill). */
        prompt: z.string().default(""),
        /** On: ops keeps one lead running here and restarts it when it exits. Off: the lead isn't run. */
        supervised: z.boolean().default(false),
        /** With On: the lead sleeps until ops finds work for the project (red build, new error, review feedback, armed ticket). */
        onDemand: z.boolean().default(false),
        /** With onDemand: only these kinds of work wake it (a ready-made lead's own, LEAD_WORK); empty = any. */
        watch: z.array(z.enum(LEAD_WORK)).optional(),
        /** Account to try first when supervised; empty = any account. `accounts` takes over when set. */
        account: z.string().default(""),
        /** The accounts it may run on, in order; with fallbackToAll off it never runs on another. Empty: `account`. */
        accounts: z.array(z.string()).optional(),
        /** When that account is at its limit, carry on with any other account. */
        fallbackToAll: z.boolean().default(true),
        /** Lock the session holds (relative to the Code root), JSON {"pid","heartbeat" ms}; a live pid with a fresh heartbeat means a lead is running. */
        lockFile: z.string().default(""),
        lockStaleMin: z.number().int().min(5).default(45),
        /** Questions the session leaves for you (relative to the Code root); shown on the dashboard, notified on change. */
        inboxFile: z.string().default(""),
        restartAfterMin: z.number().min(0).default(5),
        /** Stop restarting after this many failed exits within an hour. */
        maxCrashesPerHour: z.number().int().min(1).default(3),
        /** Hours an open question waits for you before Overhand answers it with the lead's stated default; 0 = wait forever. */
        answerWaitHours: z.number().min(0).default(4),
        /**
         * Protected branches this lead may push to (e.g. develop, main); empty = only its own branches. Force push stays
         * blocked. Left out: its group's `pushBranches`, else none.
         */
        pushBranches: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
/** A project as saved: rules it leaves out follow its group. */
export type StoredClient = z.infer<typeof ClientSchema>;
/** A project with its effective rules: its own, else its group's, else the defaults (effectiveClients). */
export type Client = StoredClient & {
  autonomy: Autonomy;
  assignedAutonomy: Exclude<Autonomy, "watch" | "ship">;
  accounts: string[];
  fallbackToAll: boolean;
};
export type Group = z.infer<typeof GroupSchema>;
export type { GroupRules, LeadScope };
export type Provider = z.infer<typeof ProviderSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;

/** Moves the old top-level `jenkins` (one per install, naming its project) into that project's `status`. */
function migrate(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.jenkins)) return raw;
  const { jenkins, ...rest } = raw;
  const { client, ...source } = jenkins;
  if (!Array.isArray(rest.clients) || !rest.clients.some((x) => isRecord(x) && x.name === client))
    throw new Error(`Jenkins names unknown project ${String(client)}`);
  rest.clients = rest.clients.map((x) =>
    isRecord(x) && x.name === client ? { ...x, status: { ...(isRecord(x.status) ? x.status : {}), jenkins: source } } : x,
  );
  return rest;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Validates raw config data, including cross-references the schema can't express. Throws a readable error. */
export function parseConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(migrate(raw));
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  const c = parsed.data;
  const names = new Set(c.clients.map((x) => x.name));
  const problems: string[] = [];
  if (names.size !== c.clients.length) problems.push("two projects share a name");
  if (new Set(c.clients.map((x) => x.prefix)).size !== c.clients.length) problems.push("two projects share a ticket prefix");
  if (new Set(c.godmode.map((g) => g.key)).size !== c.godmode.length) problems.push("two godmode sessions share a key");
  const groupNames = new Set(c.groups.map((g) => g.name));
  if (groupNames.size !== c.groups.length) problems.push("two groups share a name");
  const grouped = new Set<string>();
  for (const g of c.groups) {
    for (const m of g.members) {
      if (!names.has(m)) problems.push(`group ${g.name} lists unknown project ${m}`);
      if (grouped.has(m)) problems.push(`project ${m} is in two groups`);
      grouped.add(m);
    }
    const unknown = (g.rules.accounts ?? []).filter((a) => !c.accounts.includes(a));
    if (unknown.length) problems.push(`group ${g.name} lists unknown accounts ${unknown.join(", ")}`);
  }
  for (const g of c.godmode) {
    if (g.account && !c.accounts.includes(g.account)) problems.push(`lead ${g.key} uses unknown account ${g.account}`);
    if (g.project && !names.has(g.project) && !groupNames.has(g.project)) problems.push(`lead ${g.key} names unknown project ${g.project}`);
  }
  for (const a of Object.keys(c.providers)) if (!c.accounts.includes(a)) problems.push(`provider set for unknown account ${a}`);
  for (const a of Object.keys(c.runtimes)) if (!c.accounts.includes(a)) problems.push(`runtime set for unknown account ${a}`);
  for (const [a, r] of Object.entries(c.runtimes)) {
    const denied = deniedFlags(r.kind, r.extraArgs ?? []);
    if (denied.length) problems.push(`account ${a}: extra flags ${denied.join(", ")} would loosen the guard or override Overhand's own`);
  }
  for (const s of c.slack) if (!names.has(s.client)) problems.push(`Slack server ${s.server} names unknown project ${s.client}`);
  if (new Set(c.updates.map((u) => u.id)).size !== c.updates.length) problems.push("two status update channels share an id");
  for (const u of c.updates)
    for (const p of u.projects) if (!names.has(p)) problems.push(`status update ${u.name} names unknown project ${p}`);
  for (const id of c.reports.channels)
    if (!c.updates.some((u) => u.id === id)) problems.push(`work reports name unknown status update channel ${id}`);
  for (const x of c.clients) {
    const unknown = (x.accounts ?? []).filter((a) => !c.accounts.includes(a));
    if (unknown.length) problems.push(`project ${x.name} lists unknown accounts ${unknown.join(", ")}`);
    if (x.autonomy === "ship" && x.host !== "github") problems.push(`project ${x.name}: Ship needs GitHub's auto-merge`);
    if (x.hosted && x.host !== "github") problems.push(`project ${x.name}: hosted runs are for GitHub projects`);
  }
  for (const g of c.groups)
    if (g.rules.autonomy === "ship") problems.push(`group ${g.name}: Ship is turned on per project, never for a group`);
  if (problems.length) throw new Error(problems.map((p) => `✖ ${p}`).join("\n"));
  return c;
}

/** The config before setup has run: no projects, no accounts, every default. */
export function blankConfig(owner: string): Config {
  return parseConfig({ owner: { name: owner, keychainAccount: owner }, accounts: [], clients: [] });
}

/** A missing or broken overhand.config.json: the entry points name it in one plain line (startOrExplain). */
export class ConfigError extends Error {}

/**
 * Runs an entry point (the daemon, setup) whose imports load the config, so a broken config is one plain line on stderr
 * and exit 1, never a stack trace. Any other error is thrown on unchanged.
 */
export async function startOrExplain(start: () => Promise<unknown>): Promise<void> {
  try {
    await start();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message.replace(/\s*\n\s*/g, " "));
    process.exit(1);
  }
}

/** Loads and validates overhand.config.json from the ops folder; throws a ConfigError when it is missing or wrong. */
export function loadConfig(dir: string): Config {
  const file = join(dir, "overhand.config.json");
  if (!existsSync(file)) throw new ConfigError(`Missing ${file}. Run bun run setup.`);
  try {
    return parseConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw new ConfigError(`overhand.config.json is invalid:\n${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Validates and writes overhand.config.json atomically (temp file + rename), so a crash never leaves half a config. */
export function saveConfig(dir: string, raw: unknown): Config {
  const c = parseConfig(raw);
  const file = join(dir, "overhand.config.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return c;
}

/** The config with one Quick settings switch applied (`QuickSettingSchema`); an unknown project is an error. */
export function withQuick(c: Config, q: QuickSetting): Config {
  if ("budgetUsd" in q) return { ...c, limits: { ...c.limits, dailyBudgetUsd: q.budgetUsd } };
  if ("paceWeekly" in q) return { ...c, limits: { ...c.limits, paceWeekly: q.paceWeekly } };
  if ("menubar" in q) return { ...c, menubar: q.menubar };
  if ("look" in q) return { ...c, look: q.look };
  if (!c.clients.some((x) => x.name === q.project)) throw new Error(`no project ${q.project}`);
  const set = "hosted" in q ? { hosted: q.hosted } : { autonomy: q.autonomy };
  return { ...c, clients: c.clients.map((x) => (x.name === q.project ? { ...x, ...set } : x)) };
}

/** Maps an older config's flat cleanup settings onto categories; its docker and simulator commands became categories. */
function legacyCleanup(raw: unknown): unknown {
  if (raw === undefined) return {};
  if (!isRecord(raw) || "categories" in raw) return raw;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  return {
    categories: {
      worktrees: { staleDays: raw.staleWorktreeDays },
      versions: { keep: raw.keepClaudeVersions },
      caches: {
        paths: strings(raw.caches),
        commands: [...new Set([...sourceCommands(), ...strings(raw.commands)])].filter((c) => !/^(docker|xcrun simctl)\b/.test(c)),
      },
      logs: { days: raw.opsLogDays },
    },
  };
}
