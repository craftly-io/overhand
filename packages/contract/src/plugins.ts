/**
 * Plugins (core/src/plugins.ts): small add-ons that run in a sandbox of their own, reach only the hosts they declare and
 * talk back only in findings. The manifest a plugin ships, the one line of output it may print per finding, what the
 * dashboard shows of each, and what the sandbox does and can't do, each said once, here.
 */
import { z } from "zod";

/** The manifest's file name, at the top of a plugin's folder. */
export const PLUGIN_FILE = "overhand-plugin.json";

/** What a plugin is for. Every kind runs on its schedule and reports findings; the kind is how the app labels it. */
export const PLUGIN_KINDS = ["check", "tracker", "notifier"] as const;

/** Environment names a plugin can't ask for: its sandbox sets these itself. */
const RESERVED = /^(PATH|HOME|TMPDIR|PWD|OVERHAND_.*|BUN_.*|NODE_.*)$/;

/**
 * A host a plugin may reach: a public DNS name, never an IP address, localhost or a local-network name. Lowercase, no
 * port (the bridge reaches only https's and http's own ports).
 */
const HostSchema = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host name such as status.example.com")
  .refine((h) => !/\.(local|localhost|internal|home|lan|arpa)$/.test(h), "a public host, not a local-network name");

/** A plugin's manifest (`overhand-plugin.json`), as its author writes it. Unknown fields are refused. */
export const PluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes"),
    version: z.string().min(1).max(40),
    /** What it does, in one plain line: shown before you approve it. */
    line: z.string().min(1).max(200),
    kind: z.enum(PLUGIN_KINDS),
    /** The file it starts from, inside its folder. */
    entry: z
      .string()
      .regex(/^[\w-][\w./-]*\.(ts|js|mjs)$/, "a .ts, .js or .mjs file in the plugin's folder")
      .refine((p) => !p.split("/").includes(".."), "inside the plugin's folder"),
    /** Every host it fetches from; the bridge refuses any other. */
    hosts: z.array(HostSchema).max(10).default([]),
    /** Secrets it asks for, by name: each reaches it as an environment variable only if you grant it. */
    secrets: z
      .array(
        z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{1,63}$/, "an upper-case name such as STATUS_TOKEN")
          .refine((n) => !RESERVED.test(n), "a name of its own"),
      )
      .max(5)
      .default([]),
    /** How often it runs, in minutes. */
    everyMin: z.number().int().min(15).max(1440).default(60),
    /** How long one run may take before it's stopped. */
    timeoutSec: z.number().int().min(1).max(120).default(30),
    /** How much memory one run may use before it's stopped. */
    memoryMb: z.number().int().min(64).max(1024).default(256),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * One finding, one line of a plugin's output (JSON). Its fix is always a button: open a page (https only) or run the
 * plugin again. Any other line fails the run.
 */
export const PluginFindingSchema = z
  .object({
    title: z.string().min(1).max(120),
    line: z.string().max(300).default(""),
    severity: z.enum(["info", "warn", "bad"]),
    fix: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("link"), url: z.url({ protocol: /^https$/ }) }).strict(),
      z.object({ kind: z.literal("rerun") }).strict(),
    ]),
  })
  .strict();
export type PluginFinding = z.infer<typeof PluginFindingSchema>;

/** At most this many findings in one run; more fails it. */
export const PLUGIN_MAX_FINDINGS = 50;

/**
 * A plugin as the dashboard shows it. `state`: waiting (installed, not approved yet), on, paused, changed (its files
 * differ from what you approved, so it doesn't run until you approve it again) or broken (`why`).
 */
export const PluginStateSchema = z.object({
  name: z.string(),
  version: z.string(),
  line: z.string(),
  kind: z.enum(PLUGIN_KINDS),
  hosts: z.array(z.string()),
  /** The secrets it asks for, and those you granted. */
  secrets: z.array(z.string()),
  granted: z.array(z.string()),
  /** Where it came from and its pin: a git commit, or the tarball's SHA-256. */
  source: z.string(),
  pin: z.string(),
  everyMin: z.number(),
  timeoutSec: z.number(),
  memoryMb: z.number(),
  state: z.enum(["waiting", "on", "paused", "changed", "broken"]),
  why: z.string(),
  last: z.object({ at: z.number(), ok: z.boolean(), why: z.string() }).nullable(),
  findings: z.array(PluginFindingSchema),
});
export type PluginState = z.infer<typeof PluginStateSchema>;

/** What a plugin's own sandbox enforces: said once, here. */
export const PLUGIN_STOPS =
  "A plugin runs only inside a sandbox of its own, never without it: of the files on your computer it reads only the system's own programs and libraries, its own folder and a scratch folder that's gone when it ends, and writes only that scratch folder. It has no network of its own: its only way out is Overhand's bridge, which fetches for it only from the hosts its manifest declares, on their usual ports, and refuses the rest. It gets no secret unless you grant that one by name, and runs on its schedule within its time and memory limits, stopped when it goes over. It talks back only in findings, one JSON line each, which Overhand checks before any reaches the app.";

/** What it can't stop, and where each platform's sandbox ends: said once, here. */
export const PLUGIN_LIMIT =
  "On macOS it's sandbox-exec with a profile that denies everything it doesn't allow; on Linux it's bubblewrap with its own empty network, process and file namespaces. A plugin can still send what it reads, including a secret you granted, to a host it declared, and the bridge checks each host's address before fetching but can't stop that host's DNS from changing right after. It can list the names, never the contents, of the folders above its own. On macOS it can't start another program, and the sandbox still lets it reach the system services Apple's own sandbox profile allows every program; on Linux it can start the system's own programs, inside the same sandbox with no more reach than its own, and write an empty /tmp of its own that's gone when it ends. Where neither sandbox runs, plugins don't run at all.";

/** The review a plugin gets, as it is today: said once, here. */
export const PLUGIN_REVIEW =
  "There's no plugin store and no review by us yet: the review is yours. Before a plugin runs, Settings shows what it does, its kind, the hosts it reaches, the secrets it asks for and its pin, and nothing runs until you approve it. Your approval holds that exact code: any change to its files stops it until you approve it again, and nothing updates on its own.";
