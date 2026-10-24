/**
 * The guard's conformance check: each hook-capable CLI's own hook payloads (its dialect, guard-dialects.ts) for a fixed
 * list of cases, fed to the hook command Overhand writes for that CLI, run the way the CLI runs it (the event on stdin,
 * through sh; OpenCode's from inside its plugin). The test suite holds every case true for every dialect
 * (test/guard-parity.test.ts); `bun run guard-check` prints it per installed CLI with its version (release/guard-check.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorHooks, geminiSettings, hookCommand, opencodePlugin } from "./agent-home";
import type { RuntimeId } from "./config";
import { forgetRun, recordRun } from "./control";
import { BUNDLED, SELF_EXEC, SRC } from "./env";
import { DIALECTS, type Dialect } from "./guard-dialects";
import { guardArgs } from "./runtimes/codex";

/** Every dialect with a hook: Claude Code's and the ones the guard translates. */
export const HOOKED: readonly Dialect[] = ["claude", ...DIALECTS];

/** A dialect's runtime id (runtimes/, the coverage table's keys). */
export const runtimeOf = (d: Dialect): RuntimeId => (d === "claude" ? "claude-code" : d);

/** One CLI's event for a shell command, a file read and a file edit, in its own hook dialect. */
interface Payloads {
  shell: (command: string) => object;
  read: (path: string) => object;
  edit: (path: string) => object;
}

const CWD = "/repo";

/** What each CLI sends its pre-tool hook (each CLI's hook docs; the dialects' sources are in guard-dialects.ts). */
export const PAYLOADS: Record<Dialect, Payloads> = {
  claude: {
    shell: (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: CWD }),
    read: (file_path) => ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path }, cwd: CWD }),
    edit: (file_path) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path, old_string: "a", new_string: "b" },
      cwd: CWD,
    }),
  },
  // Codex has no read tool: its agents read through the shell
  codex: {
    shell: (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: CWD }),
    read: (p) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `sed -n 1,20p ${p}` }, cwd: CWD }),
    edit: (p) => ({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n@@\n-a\n+b\n*** End Patch` },
      cwd: CWD,
    }),
  },
  gemini: {
    shell: (command) => ({ hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command }, cwd: CWD }),
    read: (file_path) => ({ hook_event_name: "BeforeTool", tool_name: "read_file", tool_input: { file_path }, cwd: CWD }),
    edit: (file_path) => ({
      hook_event_name: "BeforeTool",
      tool_name: "replace",
      tool_input: { file_path, old_string: "a", new_string: "b" },
      cwd: CWD,
    }),
  },
  cursor: {
    shell: (command) => ({ hook_event_name: "beforeShellExecution", command, cwd: CWD, workspace_roots: [CWD] }),
    read: (file_path) => ({ hook_event_name: "beforeReadFile", file_path, content: "", workspace_roots: [CWD] }),
    // Cursor's preToolUse names its edits Write (and Delete): cursor.com/docs/hooks
    edit: (file_path) => ({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path }, workspace_roots: [CWD] }),
  },
  // OpenCode's plugin (agent-home.ts) hands the guard its tool and args as they are
  opencode: {
    shell: (command) => ({ tool_name: "bash", tool_input: { command }, cwd: CWD }),
    read: (filePath) => ({ tool_name: "read", tool_input: { filePath }, cwd: CWD }),
    edit: (filePath) => ({ tool_name: "edit", tool_input: { filePath, oldString: "a", newString: "b" }, cwd: CWD }),
  },
};

/** One case: what the agent asks for, of which kind, on which autonomy level, and whether the guard must block it. */
export interface Case {
  name: string;
  kind: keyof Payloads;
  /** The command, or the file path; `home` is the scratch Overhand folder the check runs in. */
  arg: (home: string) => string;
  block: boolean;
  autonomy?: "act" | "watch";
}

/** The fixed list: what every agent's guard must block, and what it must let through. */
export const CASES: readonly Case[] = [
  { name: "merge a pull request", kind: "shell", arg: () => "gh pr merge 1 --squash", block: true },
  { name: "merge through the API", kind: "shell", arg: () => "gh api -X PUT repos/o/r/pulls/1/merge", block: true },
  { name: "force push", kind: "shell", arg: () => "git push --force origin feature", block: true },
  { name: "deploy", kind: "shell", arg: () => "npx wrangler deploy", block: true },
  { name: "read a key (shell)", kind: "shell", arg: () => "cat ~/.ssh/id_rsa", block: true },
  { name: "read a key", kind: "read", arg: () => "/Users/sam/.ssh/id_rsa", block: true },
  { name: "read production secrets", kind: "read", arg: () => `${CWD}/.env.production`, block: true },
  { name: "edit Overhand's config", kind: "edit", arg: (home) => join(home, "overhand.config.json"), block: true },
  { name: "edit an agent's settings", kind: "edit", arg: () => "/Users/sam/.claude/settings.json", block: true },
  { name: "edit on watch", kind: "edit", arg: () => `${CWD}/src/app.ts`, block: true, autonomy: "watch" },
  { name: "commit on watch", kind: "shell", arg: () => "git commit -m x", block: true, autonomy: "watch" },
  { name: "git status", kind: "shell", arg: () => "git status", block: false },
  { name: "run the tests", kind: "shell", arg: () => "bun test", block: false },
  { name: "read source", kind: "read", arg: () => `${CWD}/src/app.ts`, block: false },
  { name: "edit source", kind: "edit", arg: () => `${CWD}/src/app.ts`, block: false },
  { name: "git status on watch", kind: "shell", arg: () => "git status", block: false, autonomy: "watch" },
];

/** What the hook answered: its exit code and what it printed. */
export interface HookResult {
  code: number;
  out: string;
  err: string;
}

/** The guard command each CLI's generated config holds (OpenCode's is inside its plugin). */
function commandOf(d: Dialect, home: string): string {
  if (d === "claude") return hookCommand(BUNDLED, SELF_EXEC, SRC, "claude", home);
  if (d === "codex")
    return JSON.parse(
      guardArgs()
        .at(-1)
        ?.match(/command=("(?:[^"\\]|\\.)*")/)?.[1] ?? '""',
    ) as string;
  if (d === "gemini") return geminiSettings().hooks.BeforeTool[0]?.hooks[0]?.command ?? "";
  return cursorHooks().hooks.beforeShellExecution[0]?.command ?? "";
}

type Before = (input: object, output: object) => Promise<void>;

/** Runs one event through `d`'s hook as its CLI does, as run HONEY-1 on `autonomy`, logging into `home`. */
export async function runHook(d: Dialect, event: object, autonomy: string, home: string, before?: Before): Promise<HookResult> {
  // the run is who Overhand recorded for this process tree (this process is the hook's ancestor)
  recordRun(home, process.pid, { run: "HONEY-1", autonomy, project: "Honeycrust" });
  try {
    if (d === "opencode" && before) {
      const e = event as { tool_name: string; tool_input: object };
      const saved = process.env.OVERHAND_HOME;
      process.env.OVERHAND_HOME = home;
      try {
        await before({ tool: e.tool_name, sessionID: "s", callID: "c" }, { args: e.tool_input });
        return { code: 0, out: "", err: "" };
      } catch (err) {
        return { code: 2, out: "", err: String(err) };
      } finally {
        if (saved === undefined) delete process.env.OVERHAND_HOME;
        else process.env.OVERHAND_HOME = saved;
      }
    }
    const r = Bun.spawnSync(["sh", "-c", commandOf(d, home)], {
      stdin: Buffer.from(JSON.stringify(event)),
      env: { ...process.env, OVERHAND_HOME: home },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  } finally {
    forgetRun(home, process.pid);
  }
}

/** OpenCode's guard: the plugin written to its config folder, loaded as OpenCode loads it. */
async function opencodeBefore(home: string): Promise<Before | undefined> {
  const plugin = join(home, "opencode-guard.js");
  writeFileSync(plugin, opencodePlugin());
  const { OverhandGuard } = (await import(plugin)) as {
    OverhandGuard: (ctx: { directory: string }) => Promise<Record<string, Before>>;
  };
  return (await OverhandGuard({ directory: CWD }))["tool.execute.before"];
}

/** Whether the hook answered as the case wants: a block is exit 2 with the guard's words (Cursor's also a JSON deny). */
function passes(d: Dialect, c: Case, r: HookResult): boolean {
  if (!c.block) return r.code === 0 && (d !== "cursor" || r.out.includes('"allow"'));
  return r.code === 2 && r.err.includes("Blocked by Overhand's guard") && (d !== "cursor" || r.out.includes('"deny"'));
}

/** One case's outcome for one CLI. */
export interface Row {
  dialect: Dialect;
  case: string;
  pass: boolean;
  result: HookResult;
}

/** Every case for each of `dialects`, in the Overhand folder `home` (its config must exist; blocks are logged there). */
export async function conformance(home: string, dialects: readonly Dialect[] = HOOKED): Promise<Row[]> {
  const before = dialects.includes("opencode") ? await opencodeBefore(home) : undefined;
  const rows: Row[] = [];
  for (const d of dialects)
    for (const c of CASES) {
      const result = await runHook(d, PAYLOADS[d][c.kind](c.arg(home)), c.autonomy ?? "act", home, before);
      rows.push({ dialect: d, case: c.name, pass: passes(d, c, result), result });
    }
  return rows;
}
