/**
 * Hosted runs (issue #15): a project switched to "Run here when my computer is off" hands its queued tickets to the
 * relay while the computer is on; when the computer goes away, the relay runs them in a container it starts for that one
 * run and destroys after. Prepaid only: a run starts only when the workspace's minutes cover its longest length.
 * What the daemon, the relay and the container agree on. The design and the owner's steps: relay/README.md (Hosted runs).
 */
import { z } from "zod";
import { AutonomySchema } from "./autonomy";
import type { Plan } from "./relay";

/** Run minutes each plan includes every month, per workspace (a Team plan's seated member is one workspace each). */
export const HOSTED_ALLOWANCE: { readonly [P in Plan]: number } = { pro: 300, team: 1000 };

/** The longest one hosted run may take, in minutes, when the relay sets none (`HOSTED_RUN_MAX_MIN`). */
export const HOSTED_RUN_MAX_MIN = 60;

/** Tickets one daemon may hand over at once. */
export const HOSTED_MAX_JOBS = 5;

/** The agents a hosted run can drive, each with the API key variable it reads: own API keys only, never a sign-in. */
export const HOSTED_RUNTIMES = { "claude-code": "ANTHROPIC_API_KEY", codex: "CODEX_API_KEY" } as const;
export type HostedRuntime = keyof typeof HOSTED_RUNTIMES;

/** One ticket handed to the relay, with the API key its run uses. The key stays in memory only, for that run. */
export const HostedJobSchema = z.object({
  /** The ticket key (HONEY-12): the daemon's own name for the run and its PR. */
  key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  project: z.string().min(1).max(120),
  /** GitHub repository, owner/name. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /** The branch the PR targets. */
  base: z.string().min(1).max(200),
  title: z.string().max(400),
  /** The ticket's description and comments, as the run's prompt reads them. */
  brief: z.string().max(20_000),
  autonomy: AutonomySchema,
  runtime: z.enum(["claude-code", "codex"]),
  model: z.string().max(100).default(""),
  apiKey: z.string().min(1).max(400),
});
export type HostedJob = z.infer<typeof HostedJobSchema>;

/** A hosted run's outcome, the plain way the app shows a local run's: one sentence, and the PR when there is one. */
export const HOSTED_STATUSES = ["done", "report", "failed", "no-minutes", "not-started"] as const;
export const HostedResultSchema = z.object({
  key: z.string(),
  project: z.string(),
  status: z.enum(HOSTED_STATUSES),
  /** The PR it opened, when it opened one. */
  pr: z.string().default(""),
  /** The branch it pushed, when it pushed one. */
  branch: z.string().default(""),
  draft: z.boolean().default(false),
  /** One plain sentence: what it did or why it stopped. Never the run's log. */
  summary: z.string().max(600),
  /** Minutes the container ran, charged to the workspace. */
  minutes: z.number().int().min(0),
  at: z.number(),
});
export type HostedResult = z.infer<typeof HostedResultSchema>;

/** What the daemon sends on its hand-off socket: the tickets to run if the computer goes away (all of them, each time). */
export const HostedHandSchema = z.object({ type: z.literal("hand"), jobs: z.array(HostedJobSchema).max(HOSTED_MAX_JOBS) });
/** What the relay answers: the tickets a hosted run has taken, which the computer must not start itself. */
export const HostedTakenSchema = z.object({ type: z.literal("taken"), keys: z.array(z.string()) });

/** `GET /relay/hosted/runs`: finished hosted runs the daemon hasn't taken in yet. */
export const HostedRunsSchema = z.object({ runs: z.array(HostedResultSchema) });

/** What a container's run is asked (POST /run on its port): the job, and the repository token Overhand pushes with. */
export const HostedRunRequestSchema = z.object({ job: HostedJobSchema, token: z.string().min(1), maxMin: z.number().int().min(1) });
/** What the container answers. */
export const HostedRunAnswerSchema = HostedResultSchema.pick({ status: true, pr: true, branch: true, draft: true, summary: true });
export type HostedRunAnswer = z.infer<typeof HostedRunAnswerSchema>;

/** The container's port for the run request. */
export const HOSTED_PORT = 8080;

/**
 * Whether hosted runs are switched on in this build: off in production until the owner's setup is done (relay/README.md,
 * Hosted runs). `OVERHAND_HOSTED_RUNS=1` turns the daemon's side on for staging and tests; the relay has its own switch.
 */
export const hostedRunsOn = (env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): boolean =>
  env.OVERHAND_HOSTED_RUNS === "1";
