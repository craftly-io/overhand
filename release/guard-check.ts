/**
 * `bun run guard-check [--live]`: the guard's conformance check (packages/core/src/guard-conformance.ts) for each agent
 * CLI installed here, with its version, as one table. Everything runs in a scratch Overhand folder and, with --live, a
 * scratch HOME too: never your own Overhand or your CLIs' own config.
 *
 * --live also runs each installed CLI headless, built exactly as Overhand runs it (its runtime's argv and environment,
 * the guard configs written into the scratch folder), asked to run one blocked command, and checks the block landed in
 * the guardrail log. It costs one short model call per CLI on whatever the CLI signs in with: an API key in your
 * environment (CURSOR_API_KEY, GEMINI_API_KEY, ...), since a scratch HOME holds no login. It exits 1 on any failure.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "overhand-guard-check-"));
// before any of Overhand's modules load: they read OVERHAND_HOME once
process.env.OVERHAND_HOME = join(scratch, "overhand");
mkdirSync(process.env.OVERHAND_HOME);
// the governor off: a full test run is ordinary work here (it holds heavy jobs, which isn't the guard's job)
const config = { owner: { name: "check", keychainAccount: "check" }, accounts: [], clients: [], governor: { enabled: false } };
writeFileSync(join(process.env.OVERHAND_HOME, "overhand.config.json"), JSON.stringify(config));

const { CASES, conformance, HOOKED, runtimeOf } = await import("../packages/core/src/guard-conformance");
const { RUNTIMES } = await import("../packages/core/src/runtimes");
const { writeGuardConfigs } = await import("../packages/core/src/agent-home");
const { guardLogAt } = await import("../packages/core/src/guard");
const { safeCmd } = await import("../packages/core/src/runtimes/runtime");
const home = process.env.OVERHAND_HOME;

/** The installed CLI's version line, or null when it isn't on PATH. */
function versionOf(bin: string): string | null {
  if (!Bun.which(bin)) return null;
  const r = Bun.spawnSync([bin, "--version"], { timeout: 15_000 });
  return `${r.stdout.toString()}${r.stderr.toString()}`.trim().split("\n")[0] || "unknown version";
}

const installed = HOOKED.flatMap((d) => {
  const rt = RUNTIMES[runtimeOf(d)];
  const version = rt ? versionOf(rt.bin) : null;
  return rt && version ? [{ d, rt, version }] : [];
});
const missing = Object.values(RUNTIMES).filter((rt) => !installed.some((i) => i.rt.id === rt.id));

const rows = await conformance(
  home,
  installed.map((i) => i.d),
);
const cell = (s: string, w: number) => s.padEnd(w);
const w = Math.max(...CASES.map((c) => c.name.length)) + 2;
const cols = installed.map((i) => Math.max(i.rt.label.length, 4) + 2);
console.log(`\nGuard conformance, hook payloads (${CASES.length} cases)\n`);
console.log([cell("", w + 6), ...installed.map((i, n) => cell(i.rt.label, cols[n] ?? 0))].join(""));
for (const c of CASES)
  console.log(
    [
      cell(`${c.block ? "block" : "allow"} ${c.name}`, w + 6),
      ...installed.map((i, n) => cell(rows.find((r) => r.dialect === i.d && r.case === c.name)?.pass ? "pass" : "FAIL", cols[n] ?? 0)),
    ].join(""),
  );
console.log("");
for (const i of installed) console.log(`${i.rt.label}: ${i.version}`);
for (const rt of missing) console.log(`${rt.label}: not installed, skipped`);
if (RUNTIMES.aider) console.log(`${RUNTIMES.aider.label} has no pre-tool hook: it runs with no shell commands, not checked here.`);

let failed = rows.filter((r) => !r.pass).length;

if (process.argv.includes("--live")) {
  console.log("\nLive: each installed CLI asked to run `gh pr merge 1 --squash`\n");
  writeGuardConfigs();
  const log = guardLogAt(home);
  for (const { rt } of installed) {
    const cwd = join(scratch, `${rt.id}-repo`);
    mkdirSync(cwd);
    Bun.spawnSync(safeCmd(["git", "init", "-q", cwd]));
    const userHome = join(scratch, `${rt.id}-home`);
    mkdirSync(userHome);
    const run = `GUARD-${rt.id}`;
    let task: { argv: string[]; env: Record<string, string>; files: Record<string, string> };
    try {
      task = rt.task({
        account: "check",
        cwd,
        prompt: "Run exactly this shell command and nothing else, then report what it printed: gh pr merge 1 --squash",
        schema: "",
        schemaFile: join(scratch, `${rt.id}-schema.json`),
        alias: "",
        provider: { kind: "claude", auth: "login" },
        model: "",
        attribution: false,
        args: [],
        configDir: join(userHome, ".claude"),
        instructions: "",
        // a secret store item (`cursor-key-check`) from its API key variable (CURSOR_API_KEY), if you set one
        read: (item) => process.env[`${item.split("-key-")[0]?.toUpperCase()}_API_KEY`] ?? null,
        run,
        project: "guard-check",
      });
    } catch (e) {
      console.log(`${rt.label}: can't start (${String(e)})`);
      failed++;
      continue;
    }
    for (const [path, text] of Object.entries(task.files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const before = existsSync(log) ? readFileSync(log, "utf8").length : 0;
    const r = Bun.spawnSync(task.argv, {
      cwd,
      env: { ...task.env, HOME: userHome, OVERHAND_HOME: home, OVERHAND_RUN: run },
      timeout: 300_000,
    });
    const logged = existsSync(log) && readFileSync(log, "utf8").slice(before).includes("gh pr merge");
    const said = `${r.stdout.toString()}${r.stderr.toString()}`.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    console.log(`${rt.label}: ${logged ? "blocked, in the guardrail log" : `NOT confirmed (exit ${r.exitCode}): ${said}`}`);
    if (!logged) failed++;
  }
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
