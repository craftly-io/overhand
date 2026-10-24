/**
 * Everything that differs between macOS and Linux: the secret store, desktop notifications, opening a terminal,
 * keeping the machine awake, a process's folder and the service manager. macOS uses Keychain, terminal-notifier or
 * osascript, Terminal, caffeinate, lsof and launchd; Linux uses libsecret's secret-tool, notify-send, a desktop
 * terminal, systemd-inhibit, /proc and a systemd user unit. No imports from env.ts, so setup.ts can use it too.
 */
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

const MAC = process.platform === "darwin";

type Libproc = { proc_pidinfo: (pid: number, flavor: number, arg: bigint, buf: Pointer, size: number) => number };
let libproc: Libproc | null | undefined;
/** proc_pidinfo's PROC_PIDTBSDINFO: struct proc_bsdinfo, 136 bytes; pbi_ppid at 16, pbi_start_tvsec at 120. */
const BSDINFO = { flavor: 3, size: 136, ppid: 16, startSec: 120 } as const;

/**
 * A process's parent and start time (seconds) on macOS, from libproc, with no process spawned: inside the OS sandbox
 * `ps` can't run (it's setuid root, which a sandboxed process may never exec), and the guard needs both. Null for a
 * process that's gone or another user's (root's launchd at the top of every chain), and off macOS.
 */
export function procInfo(pid: number): { ppid: number; startSec: number } | null {
  if (!MAC || !(pid > 0)) return null;
  if (libproc === undefined) {
    try {
      const lib = dlopen("/usr/lib/libproc.dylib", {
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      });
      libproc = lib.symbols;
    } catch {
      libproc = null;
    }
  }
  if (!libproc) return null;
  const buf = new Uint8Array(BSDINFO.size);
  if (libproc.proc_pidinfo(pid, BSDINFO.flavor, 0n, ptr(buf), BSDINFO.size) !== BSDINFO.size) return null;
  const v = new DataView(buf.buffer);
  return { ppid: v.getUint32(BSDINFO.ppid, true), startSec: Number(v.getBigUint64(BSDINFO.startSec, true)) };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/**
 * A start time in `ps -o lstart=`'s layout ("Sat Oct  4 23:18:31 2026"), always in UTC: the daemon records it and the
 * guard compares it from different processes, so no time zone either one was given may change it.
 */
export function lstart(sec: number): string {
  const d = new Date(sec * 1000);
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()}`;
}

/** Runs a command; never throws. env so a PATH set at runtime (tests' fake binaries) picks the binary. */
function run(cmd: string[], stdin?: string): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(cmd, { env: process.env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), timeout: 30_000 });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) }; // binary not installed
  }
}

/**
 * A server without a desktop has no keyring (no Secret Service on D-Bus), so secret-tool fails there. Overhand never
 * falls back to plaintext on its own: it refuses and says how to opt in. OVERHAND_SECRETS_FILE names a JSON file, mode 0600,
 * that then holds every secret instead (on any OS), as gh and claude do on such machines. Read per call, so tests can set it.
 */
const secretsFile = (): string => process.env.OVERHAND_SECRETS_FILE ?? "";
const fileKey = (service: string, account: string): string => [service, account].join("\t");

/** The secrets file's items: {} when it doesn't exist yet, null when it can't be read (so a write never clobbers it). */
function fileSecrets(): Record<string, string> | null {
  if (!existsSync(secretsFile())) return {};
  try {
    const v: unknown = JSON.parse(readFileSync(secretsFile(), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return null;
  }
}

/** Saves the secrets file, readable and writable by this user only. */
function saveFileSecrets(items: Record<string, string>): { ok: boolean; err: string } {
  try {
    mkdirSync(dirname(secretsFile()), { recursive: true, mode: 0o700 });
    writeFileSync(secretsFile(), `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
    chmodSync(secretsFile(), 0o600); // the mode above only applies when the file is created
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** How to fix a Linux keyring that can't be reached. */
const NO_KEYRING =
  "no keyring reachable (a server without a desktop has none). Install and unlock gnome-keyring, or opt in to a file only you can read: set OVERHAND_SECRETS_FILE=~/.overhand/secrets.json and restart Overhand";

/** The name of the secret store, for messages. */
export const SECRET_STORE = secretsFile() || (MAC ? "Keychain" : "the keyring");

/** A secret's value, or null when it's missing. Without an account it matches the item under any account. */
export function readSecret(service: string, account?: string): string | null {
  if (secretsFile()) {
    const items = Object.entries(fileSecrets() ?? {});
    return items.find(([k]) => (account ? k === fileKey(service, account) : k.startsWith(fileKey(service, ""))))?.[1] || null;
  }
  const r = MAC
    ? run(["security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"])
    : run(["secret-tool", "lookup", "service", service, ...(account ? ["account", account] : [])]);
  return r.ok && r.out ? r.out : null;
}

/** Stores (or replaces) a secret. */
export function writeSecret(service: string, account: string, value: string): { ok: boolean; err: string } {
  if (secretsFile()) {
    const items = fileSecrets();
    if (!items) return { ok: false, err: `${secretsFile()} isn't a JSON object; fix or remove it` };
    return saveFileSecrets({ ...items, [fileKey(service, account)]: value });
  }
  // ponytail: on macOS the value is briefly visible to local `ps` as an argument; security(1) has no stdin mode for -w
  if (MAC) return run(["security", "add-generic-password", "-U", "-a", account, "-s", service, "-w", value]);
  const r = run(["secret-tool", "store", `--label=${service}`, "service", service, "account", account], value);
  return r.ok ? r : { ok: false, err: [r.err, NO_KEYRING].filter(Boolean).join(": ") };
}

/** Removes a secret; true when it's gone (or was never there). */
export function deleteSecret(service: string, account: string): boolean {
  if (secretsFile()) {
    const items = fileSecrets();
    if (!items) return false;
    delete items[fileKey(service, account)];
    return saveFileSecrets(items).ok;
  }
  if (MAC) return run(["security", "delete-generic-password", "-s", service, "-a", account]).ok || readSecret(service, account) === null;
  return run(["secret-tool", "clear", "service", service, "account", account]).ok;
}

/** The shell command that stores a secret by hand (it prompts for the value). */
export function secretCommand(service: string, account: string): string {
  if (secretsFile()) return `add "${service}\\t${account}": "<value>" to ${secretsFile()}`;
  return MAC
    ? `security add-generic-password -a ${account} -s ${service} -w`
    : `secret-tool store --label=${service} service ${service} account ${account}`;
}

/** Tools this platform needs on PATH besides claude, git and gh, each with how to install it. */
export const PLATFORM_TOOLS: { bin: string; fix: string }[] =
  MAC || secretsFile()
    ? []
    : [
        {
          bin: "secret-tool",
          fix: "sudo apt install libsecret-tools (or your distro's libsecret package); on a server without a desktop, set OVERHAND_SECRETS_FILE instead (see the README)",
        },
      ];

// launchd's PATH lacks Homebrew, so look there too
const NOTIFIER =
  Bun.which("terminal-notifier") ?? (existsSync("/opt/homebrew/bin/terminal-notifier") ? "/opt/homebrew/bin/terminal-notifier" : "");

/**
 * A desktop notification; on macOS clicking it opens `url`. Plain osascript can't set a click action: macOS opens
 * whichever app claims the posting script (Xcode on some Macs), so it's only the fallback.
 */
export function desktopNotify(title: string, body: string, url: string): void {
  if (!MAC) {
    // an "Open" button that opens `url`: notify-send 0.7.9+ prints the clicked action and waits until the popup closes,
    // so it runs detached; an older notify-send rejects -A, and then a plain popup goes out
    if (!Bun.which("notify-send", { PATH: process.env.PATH ?? "" })) return;
    const sh = [
      'a=$(notify-send -a Overhand -A open=Open -- "$1" "$2" 2>/dev/null) || exec notify-send -a Overhand -- "$1" "$2"',
      '[ "$a" = open ] && exec xdg-open "$3"',
    ].join("; ");
    Bun.spawn(["sh", "-c", sh, "sh", title, body || title, url], {
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    }).unref();
    return;
  }
  // terminal-notifier fails until it's allowed in System Settings → Notifications
  const sent = NOTIFIER && run([NOTIFIER, "-title", title, "-message", body || title, "-open", url, "-group", `overhand-${title}`]).ok;
  if (!sent) run(["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
}

/** Opens a terminal window running a shell command; false when none could be opened. */
export function openTerminal(cmd: string): boolean {
  if (MAC) {
    const script = [
      "on run argv",
      'tell application "Terminal" to do script (item 1 of argv)',
      'tell application "Terminal" to activate',
      "end run",
    ];
    return run(["osascript", ...script.flatMap((l) => ["-e", l]), "--", cmd]).ok;
  }
  if (!hasDisplay()) return false; // over SSH a window would open nowhere; the caller shows the command instead
  // a shell afterwards keeps the window open, so what the command printed stays readable
  const shell = ["sh", "-c", `${cmd}; exec "\${SHELL:-sh}"`];
  for (const [bin, flag] of [
    ["x-terminal-emulator", "-e"], // Debian and Ubuntu: the user's chosen terminal
    ["gnome-terminal", "--"],
    ["konsole", "-e"],
    ["xterm", "-e"],
  ] as const) {
    if (!Bun.which(bin)) continue;
    Bun.spawn([bin, flag, ...shell], { stdout: "ignore", stderr: "ignore", detached: true }).unref();
    return true;
  }
  return false;
}

/** Keeps the machine from sleeping while `pid` lives; the helper exits on its own after it. */
export function keepAwakeWhile(pid: number): void {
  const cmd = MAC
    ? ["caffeinate", "-i", "-w", String(pid)]
    : ["systemd-inhibit", "--what=idle:sleep", "--who=Overhand", "--why=a lead is working", "tail", `--pid=${pid}`, "-f", "/dev/null"];
  if (!Bun.which(cmd[0] ?? "")) return;
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", detached: true }).unref();
}

/** A process's working folder, or "" when it can't be read. */
export function cwdOf(pid: number): string {
  if (!MAC) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return "";
    }
  }
  return (
    run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      .out.split("\n")
      .find((l) => l.startsWith("n"))
      ?.slice(1) ?? ""
  );
}

/** The systemd unit running this process (e.g. ops.service), or "" when started by hand. */
function systemdUnit(): string {
  if (!process.env.INVOCATION_ID) return ""; // systemd sets it for every unit it starts
  try {
    const last = readFileSync("/proc/self/cgroup", "utf8").trim().split("/").pop() ?? "";
    return last.endsWith(".service") && !last.startsWith("user@") ? last : "";
  } catch {
    return "";
  }
}

// The service manager names the job in the environment or cgroup, so the label is never hard-coded; empty when run by hand
const LAUNCHD = MAC && process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0" ? process.env.XPC_SERVICE_NAME : "";
const UNIT = MAC ? "" : systemdUnit();
const UID = process.getuid?.() ?? 501;

/** Whether this process is Overhand's own login service (launchd or systemd), not a copy started by hand, a test or a script. */
export const isLoginService = (launchd = LAUNCHD, unit = UNIT): boolean => launchd === SERVICE || unit === SERVICE;

/** The command that starts ops again after a shutdown. */
export function startAgainCommand(src: string, bundled = import.meta.dir.startsWith("/$bunfs"), launchd = LAUNCHD, unit = UNIT): string {
  if (launchd) return `launchctl bootstrap gui/${UID} ~/Library/LaunchAgents/${launchd}.plist`;
  if (unit) return `systemctl --user start ${unit}`;
  // the installed binary without a service manager (the background loop on Linux): its own start; a checkout runs from source
  return bundled ? "overhand start" : `cd ${src} && bun run.ts daemon`;
}

/** Stops the service so it isn't restarted; without one a plain exit is enough. */
export function stopService(): void {
  if (LAUNCHD) run(["launchctl", "bootout", `gui/${UID}/${LAUNCHD}`]);
  else if (UNIT) run(["systemctl", "--user", "stop", UNIT]);
  // the background loop leads our process group; once it's gone ppid is 1, and kill(-1) would hit every process we own
  else if (process.env.OVERHAND_LOOP && process.ppid > 1) process.kill(-process.ppid, "SIGTERM");
  else process.exit(0);
}

/** One systemd argument or assignment, double-quoted so a path with spaces stays one word (systemd.syntax(7)). */
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/**
 * A systemd user unit that runs `cmd` with `env`, logging to `log` when given. KillMode=process: a restart stops only ops, not the leads it started
 * detached (systemd would otherwise kill the whole cgroup). PATH comes in `env`, since user units start with a bare one.
 */
export function systemdUnitFile(dir: string, cmd: readonly string[], env: Record<string, string>, log = ""): string {
  return [
    "[Unit]",
    "Description=Overhand daemon",
    "After=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${dir}`,
    `ExecStart=${cmd.map(sdQuote).join(" ")}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    // the same log file as on macOS, so `overhand logs` reads one place (systemd 240+; the journal before that)
    ...(log ? [`StandardOutput=append:${log}`, `StandardError=append:${log}`] : []),
    "Restart=always",
    "RestartSec=5",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The login service that keeps Overhand running: its launchd label on macOS, its systemd user unit on Linux. */
export const SERVICE = MAC ? "dev.overhand.daemon" : "overhand.service";
/** A launchd agent that runs `cmd` with `env` at login and restarts it if it dies, logging to `log`. */
export function launchdPlist(cmd: readonly string[], env: Record<string, string>, log: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vars = Object.entries(env).map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${SERVICE}</string>`,
    // caffeinate -s keeps the Mac from sleeping while it's on power, so agents keep working with the lid closed overnight
    // ponytail: awake whenever plugged in; hold the assertion only while a run is live if users want sleep when idle
    `<key>ProgramArguments</key><array>${["/usr/bin/caffeinate", "-s", ...cmd].map((c) => `<string>${esc(c)}</string>`).join("")}</array>`,
    `<key>EnvironmentVariables</key><dict>${vars.join("")}</dict>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><true/>",
    // a lead is started detached; without this, launchd would stop it with the daemon on every restart
    "<key>AbandonProcessGroup</key><true/>",
    `<key>StandardOutPath</key><string>${esc(log)}</string>`,
    `<key>StandardErrorPath</key><string>${esc(log)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

/**
 * What the service runs with: today's PATH (services start with a bare one, and agents need claude, git and gh), plus
 * OVERHAND_PORT and OVERHAND_HOME when set, so the service serves the same port and state as the shell that installed it.
 */
export function serviceEnv(from: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: from.PATH ?? "/usr/bin:/bin" };
  for (const k of ["OVERHAND_PORT", "OVERHAND_HOME", "OVERHAND_SECRETS_FILE"]) {
    const v = from[k];
    if (v) env[k] = v;
  }
  return env;
}

/** The daemon's log file, where the login service writes the daemon's output. */
export const daemonLog = (logDir: string): string => join(logDir, "daemon.log");

/** A systemd user manager to talk to; plain Docker, WSL without systemd and some SSH sessions have none. */
const systemdUser = (): boolean => run(["systemctl", "--user", "show-environment"]).ok;

/** The pid file of the background loop that stands in for a service manager. */
const loopPidFile = (logDir: string): string => join(logDir, "daemon.pid");

/**
 * Without a service manager: a detached shell loop restarts `cmd` like Restart=always (a self-update exits to restart),
 * logging to the same file. It leads its own process group, so stopping it stops the daemon, but not the leads it started
 * detached. OVERHAND_LOOP tells the daemon a dashboard shutdown must stop the loop too.
 */
function startLoop(cmd: readonly string[], env: Record<string, string>, logDir: string): { ok: boolean; err: string; note: string } {
  stopLoop(logDir); // an older one, if one runs
  const loop = 'while :; do "$@" >>"$OVERHAND_LOG" 2>&1; sleep 5; done';
  try {
    const p = Bun.spawn(["sh", "-c", loop, "sh", ...cmd], {
      env: { ...process.env, ...env, OVERHAND_LOG: daemonLog(logDir), OVERHAND_LOOP: "1" },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    p.unref();
    writeFileSync(loopPidFile(logDir), String(p.pid));
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e), note: "" };
  }
  // ponytail: nothing brings the loop back after a reboot; a systemd user session (or `loginctl enable-linger`) does
  const note =
    "No systemd user session here, so Overhand runs in the background until this machine restarts; run overhand start after a reboot.";
  return { ok: true, err: "", note };
}

/** Stops the background loop, when one runs. */
function stopLoop(logDir: string): void {
  const pid = Number(existsSync(loopPidFile(logDir)) ? readFileSync(loopPidFile(logDir), "utf8") : 0);
  rmSync(loopPidFile(logDir), { force: true });
  // only our loop: the pid may have been reused since
  const cmdline = `/proc/${pid}/cmdline`;
  if (pid > 1 && existsSync(cmdline) && readFileSync(cmdline, "utf8").includes("while :; do")) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {} // it exited meanwhile
  }
}

/**
 * Installs and starts the login service running `cmd` (replacing an older one), so Overhand survives logouts and restarts.
 * On Linux without a systemd user session it starts a background loop instead, and `note` says what that means; with
 * one, `note` gives the linger command when the service would stop at logout.
 */
export function installService(cmd: readonly string[], home: string, logDir: string): { ok: boolean; err: string; note: string } {
  const env = serviceEnv();
  mkdirSync(logDir, { recursive: true });
  if (MAC) {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SERVICE}.plist`);
    writeFileSync(file, launchdPlist(cmd, env, daemonLog(logDir)));
    run(["launchctl", "bootout", `gui/${UID}/${SERVICE}`]); // an older version, if one runs
    return { ...run(["launchctl", "bootstrap", `gui/${UID}`, file]), note: "" };
  }
  if (!systemdUser()) return startLoop(cmd, env, logDir);
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SERVICE), systemdUnitFile(dirname(cmd[0] ?? ""), cmd, env, daemonLog(logDir)));
  run(["systemctl", "--user", "daemon-reload"]);
  return { ...run(["systemctl", "--user", "enable", "--now", SERVICE]), note: lingerNote() };
}

/**
 * Without linger, systemd stops a user's services at their last logout and starts them only at the next login, so on a
 * server Overhand would die with the SSH session. Returns the command that fixes it (it needs root, so Overhand only
 * prints it), or "" when linger is on or logind can't say.
 */
export function lingerNote(user = userInfo().username): string {
  if (run(["loginctl", "show-user", user, "-p", "Linger", "--value"]).out !== "no") return "";
  return `Linger is off, so Overhand stops when you log out and waits for your next login after a reboot. To keep it running: sudo loginctl enable-linger ${user}`;
}

/** The unit `bun run setup` wrote on Linux checkouts before they used `overhand start`'s; stop removes it too. */
const OLD_UNIT = "ops.service";

/**
 * Stops the login service (or the background loop standing in for it) and removes its plist or unit file, so it doesn't
 * start at the next login. ok while it's no longer running, including when it wasn't installed.
 */
export function uninstallService(home: string, logDir: string): { ok: boolean; err: string } {
  if (MAC) {
    const r = run(["launchctl", "bootout", `gui/${UID}/${SERVICE}`]);
    rmSync(join(home, "Library", "LaunchAgents", `${SERVICE}.plist`), { force: true });
    return run(["launchctl", "print", `gui/${UID}/${SERVICE}`]).ok
      ? { ok: false, err: r.err || "it's still loaded" }
      : { ok: true, err: "" };
  }
  stopLoop(logDir);
  if (!systemdUser()) return { ok: true, err: "" };
  const dir = join(home, ".config", "systemd", "user");
  const r = run(["systemctl", "--user", "disable", "--now", SERVICE]);
  if (existsSync(join(dir, OLD_UNIT))) run(["systemctl", "--user", "disable", "--now", OLD_UNIT]);
  for (const unit of [SERVICE, OLD_UNIT]) rmSync(join(dir, unit), { force: true });
  run(["systemctl", "--user", "daemon-reload"]);
  return run(["systemctl", "--user", "is-active", "--quiet", SERVICE]).ok
    ? { ok: false, err: r.err || "it's still running" }
    : { ok: true, err: "" };
}

/**
 * Whether a graphical session is reachable (always on macOS). Without one xdg-open falls back to a text browser such as
 * lynx, which would take over the terminal, and a terminal window would open nowhere.
 */
export const hasDisplay = (env: Record<string, string | undefined> = process.env): boolean =>
  MAC || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);

/** Opens a URL (or a file, in its default app); false when there's no way to (a server without a desktop). */
export function openBrowser(url: string): boolean {
  return hasDisplay() && run([MAC ? "open" : "xdg-open", url]).ok;
}
