/** `overhand uninstall`: stops the login service and removes the program; the state folder only when asked twice. */
import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "./control-api";
import { HOME, INSTALL, type InstallKind, OPS, SRC } from "./env";
import { SECRET_STORE, uninstallService } from "./platform";

/** Where this copy lives, for uninstallPlan; the defaults are the running copy, the arguments are for tests. */
export interface Where {
  home: string;
  ops: string;
  kind: InstallKind;
  src: string;
}

/**
 * What `overhand uninstall` removes (the program's files that exist) and what it keeps, each in words. The ~/.local/bin
 * link only when it leads into ~/.overhand, so a different `overhand` there stays. `data` adds the state folder, never
 * for a checkout, whose state folder is the checkout itself.
 */
export function uninstallPlan(data: boolean, w: Where): { remove: string[]; keep: string[] } {
  const own = join(w.home, ".overhand");
  const link = join(w.home, ".local", "bin", "overhand");
  const remove = [join(own, "app"), join(own, "releases"), join(own, "npm")].filter((p) => existsSync(p) || isLink(p));
  if (isLink(link) && readlinkSync(link).startsWith(`${own}/`)) remove.unshift(link);
  const checkout = w.kind === "checkout";
  if (data && !checkout) remove.push(w.ops);
  const keep = [
    ...(data && !checkout
      ? []
      : [`Your settings, history and logs in ${w.ops}${checkout ? "" : " (overhand uninstall --remove-data removes them)"}`]),
    `Secrets in ${SECRET_STORE}: their names start with the account they belong to (for example anthropic-key-...)`,
    "The hooks overhand connect wrote into projects' .claude/settings.local.json: run overhand disconnect <folder> in each first",
    ...(w.kind === "brew" ? ["The Homebrew package: brew uninstall overhand"] : []),
    ...(checkout ? [`The checkout at ${w.src}`] : []),
  ];
  return { remove, keep };
}

/** True when `p` is a symbolic link (existsSync follows links, so a dangling one would be missed). */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * `overhand uninstall [--dry-run] [--remove-data [--yes]]`: stops the login service and removes its plist or unit file,
 * the ~/.local/bin link and the program, then says what it kept. `--remove-data` also deletes the state folder, after a
 * question (or --yes). `--dry-run` only prints the plan. The exit code.
 */
export async function uninstallCli(args: readonly string[], w: Where = { home: HOME, ops: OPS, kind: INSTALL, src: SRC }): Promise<number> {
  const dry = args.includes("--dry-run");
  const data = args.includes("--remove-data");
  const { remove, keep } = uninstallPlan(data, w);
  const lines = ["The login service, so it doesn't start again", ...remove];
  if (dry) {
    console.log(["overhand uninstall would remove:", ...lines.map((l) => `  ${l}`), "and keep:", ...keep.map((k) => `  ${k}`)].join("\n"));
    return 0;
  }
  if (
    data &&
    !args.includes("--yes") &&
    !(await confirm(`This deletes ${w.ops}: your settings, history, logs and transcripts, which can't be brought back. Delete it?`))
  ) {
    console.log("Nothing removed.");
    return 1;
  }
  const r = uninstallService(w.home, join(w.ops, "logs"));
  if (!r.ok) {
    console.error(`Couldn't stop the login service: ${r.err}. Nothing else was removed.`);
    return 1;
  }
  for (const p of remove) rmSync(p, { recursive: true, force: true });
  console.log(["Removed:", ...lines.map((l) => `  ${l}`), "Kept:", ...keep.map((k) => `  ${k}`)].join("\n"));
  return 0;
}
