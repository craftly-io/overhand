import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSecret,
  desktopNotify,
  hasDisplay,
  installService,
  isLoginService,
  launchdPlist,
  lingerNote,
  openBrowser,
  openTerminal,
  readSecret,
  SERVICE,
  serviceEnv,
  startAgainCommand,
  systemdUnitFile,
  uninstallService,
  writeSecret,
} from "../src/platform";

test("secrets go through this platform's store, and on Linux the value never appears in argv", () => {
  // fake security (macOS) and secret-tool (Linux): log argv and stdin, answer lookups, store nothing
  const bin = mkdtempSync(join(tmpdir(), "overhand-platform-"));
  const log = join(bin, "log");
  const fake = `#!/bin/sh\necho "argv: $*" >> ${log}\ncase "$1" in find-generic-password|lookup) echo s3cret ;; store) echo "stdin: $(cat)" >> ${log} ;; esac\n`;
  for (const name of ["security", "secret-tool"]) {
    writeFileSync(join(bin, name), fake);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(":");
  try {
    expect(readSecret("overhand-linear-honeycrust", "sam")).toBe("s3cret");
    expect(writeSecret("overhand-linear-honeycrust", "sam", "v@lue").ok).toBe(true);
    const lines = readFileSync(log, "utf8");
    expect(lines).toContain("overhand-linear-honeycrust");
    expect(lines).toContain("sam");
    if (process.platform === "linux") {
      expect(lines).toContain("stdin: v@lue");
      expect(lines).not.toMatch(/argv: .*v@lue/);
    } else expect(lines).toMatch(/argv: .*-w v@lue/);
  } finally {
    process.env.PATH = path;
  }
});

test("OVERHAND_SECRETS_FILE keeps secrets in a file only this user can read, and never clobbers one it can't parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "overhand-secrets-"));
  const file = join(dir, "sub", "secrets.json");
  const was = process.env.OVERHAND_SECRETS_FILE;
  process.env.OVERHAND_SECRETS_FILE = file;
  try {
    expect(readSecret("overhand-linear-honeycrust", "sam")).toBeNull();
    expect(writeSecret("overhand-linear-honeycrust", "sam", "v@lue").ok).toBe(true);
    expect(writeSecret("overhand-jira-honeycrust", "sam", "j").ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecret("overhand-linear-honeycrust", "sam")).toBe("v@lue");
    expect(readSecret("overhand-linear-honeycrust")).toBe("v@lue"); // any account
    expect(readSecret("overhand-linear-honeycrust", "other")).toBeNull();
    expect(deleteSecret("overhand-linear-honeycrust", "sam")).toBe(true);
    expect(readSecret("overhand-linear-honeycrust", "sam")).toBeNull();
    expect(readSecret("overhand-jira-honeycrust", "sam")).toBe("j");
    writeFileSync(file, "{ not json");
    expect(writeSecret("overhand-linear-honeycrust", "sam", "x").ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  } finally {
    if (was === undefined) delete process.env.OVERHAND_SECRETS_FILE;
    else process.env.OVERHAND_SECRETS_FILE = was;
  }
});

test.skipIf(process.platform !== "linux")(
  "without a systemd user session the daemon runs in a restarting background loop that stop ends",
  async () => {
    // a systemctl that always fails stands in for plain Docker or WSL; the daemon is a sleep that logs its environment
    const dir = mkdtempSync(join(tmpdir(), "overhand-loop-"));
    writeFileSync(join(dir, "systemctl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "systemctl"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = [dir, path].join(":");
    try {
      const r = installService(["sh", "-c", 'echo "loop=$OVERHAND_LOOP"; exec sleep 30'], dir, join(dir, "logs"));
      expect(r.ok).toBe(true);
      expect(r.note).toContain("until this machine restarts");
      const pid = Number(readFileSync(join(dir, "logs", "daemon.pid"), "utf8"));
      for (let i = 0; i < 40 && !existsSync(join(dir, "logs", "daemon.log")); i++) await Bun.sleep(50);
      await Bun.sleep(100);
      expect(readFileSync(join(dir, "logs", "daemon.log"), "utf8")).toContain("loop=1");
      expect(uninstallService(dir, join(dir, "logs")).ok).toBe(true);
      await Bun.sleep(100);
      // a killed child stays in /proc as a zombie until its parent (this test) reaps it: gone or zombie both mean stopped
      const stat = `/proc/${pid}/stat`;
      expect(!existsSync(stat) || readFileSync(stat, "utf8").split(") ")[1]?.startsWith("Z")).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  },
);

test("the systemd unit restarts ops on exit without killing the leads it started", () => {
  const unit = systemdUnitFile("/home/n/code/_ops", ["/home/n/.bun/bin/bun", "run.ts", "daemon"], { PATH: "/usr/bin:/home/n/.local/bin" });
  expect(unit).toContain('ExecStart="/home/n/.bun/bin/bun" "run.ts" "daemon"');
  expect(unit).toContain("WorkingDirectory=/home/n/code/_ops");
  expect(unit).toContain("Restart=always"); // a self-update exits 0, which Restart=on-failure would leave stopped
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain('Environment="PATH=/usr/bin:/home/n/.local/bin"');
});

test("with linger off it prints the command that keeps the service running after logout; otherwise nothing", () => {
  // a fake loginctl answering what $LINGER says, failing when it's empty (no logind)
  const bin = mkdtempSync(join(tmpdir(), "overhand-linger-"));
  writeFileSync(join(bin, "loginctl"), '#!/bin/sh\n[ -n "$LINGER" ] || exit 1\necho "$LINGER"\n');
  chmodSync(join(bin, "loginctl"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = [bin, path].join(":");
  try {
    process.env.LINGER = "no";
    expect(lingerNote("sam")).toContain("sudo loginctl enable-linger sam");
    process.env.LINGER = "yes";
    expect(lingerNote("sam")).toBe("");
    process.env.LINGER = "";
    expect(lingerNote("sam")).toBe("");
  } finally {
    process.env.PATH = path;
    delete process.env.LINGER;
  }
});

test("the service keeps the port and state folder it was started with, and paths with spaces", () => {
  const env = serviceEnv({ PATH: "/bin", OVERHAND_PORT: "4491", OVERHAND_HOME: "/Users/n/My Ops", OTHER: "x" });
  expect(env).toEqual({ PATH: "/bin", OVERHAND_PORT: "4491", OVERHAND_HOME: "/Users/n/My Ops" });
  expect(serviceEnv({ PATH: "/bin", OVERHAND_SECRETS_FILE: "/s.json" })).toEqual({ PATH: "/bin", OVERHAND_SECRETS_FILE: "/s.json" });
  expect(serviceEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  const unit = systemdUnitFile("/home/n/My Apps", ["/home/n/My Apps/overhand", "daemon"], env, "/home/n/.overhand/logs/daemon.log");
  expect(unit).toContain('ExecStart="/home/n/My Apps/overhand" "daemon"');
  expect(unit).toContain('Environment="OVERHAND_HOME=/Users/n/My Ops"');
  expect(unit).toContain('Environment="OVERHAND_PORT=4491"');
  expect(unit).toContain("StandardOutput=append:/home/n/.overhand/logs/daemon.log");
  const plist = launchdPlist(["/Users/n/My Apps/overhand", "daemon"], env, "/tmp/d.log");
  expect(plist).toContain(
    "<string>/usr/bin/caffeinate</string><string>-s</string><string>/Users/n/My Apps/overhand</string><string>daemon</string>",
  );
  expect(plist).toContain("<key>OVERHAND_PORT</key><string>4491</string>");
  expect(plist).toContain("<key>OVERHAND_HOME</key><string>/Users/n/My Ops</string>");
});

test("after Turn off, the start-again command fits how it runs: the service, the installed binary or a checkout", () => {
  expect(startAgainCommand("overhand start", "", "overhand.service")).toBe("systemctl --user start overhand.service");
  expect(startAgainCommand("npx overhand start", "", "")).toBe("npx overhand start");
});

test("hasDisplay: X11 or Wayland on Linux, always on macOS", () => {
  const mac = process.platform === "darwin";
  expect(hasDisplay({})).toBe(mac);
  expect(hasDisplay({ DISPLAY: ":0" })).toBe(true);
  expect(hasDisplay({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
});

test.skipIf(process.platform !== "linux")("without a desktop session nothing tries to open a browser or a terminal", () => {
  // a fake xdg-open that records being called, standing in for one that would start lynx over SSH
  const bin = mkdtempSync(join(tmpdir(), "overhand-display-"));
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$@" >> "${bin}/calls"\n`);
  chmodSync(join(bin, "xdg-open"), 0o755);
  const saved = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  process.env.PATH = [bin, saved.PATH].join(":");
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    expect(openBrowser("http://127.0.0.1:4490")).toBe(false);
    expect(openTerminal("true")).toBe(false);
    expect(existsSync(join(bin, "calls"))).toBe(false);
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(openBrowser("http://127.0.0.1:4490")).toBe(true);
    expect(readFileSync(join(bin, "calls"), "utf8")).toContain("http://127.0.0.1:4490");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test.skipIf(process.platform !== "linux")(
  "a Linux notification's Open button opens the dashboard; an old notify-send still shows it",
  async () => {
    // fake notify-send: MODE=new answers the Open action, MODE=old rejects -A like notify-send before 0.7.9
    const bin = mkdtempSync(join(tmpdir(), "overhand-notify-"));
    const log = join(bin, "calls");
    writeFileSync(
      join(bin, "notify-send"),
      `#!/bin/sh\necho "notify $*" >> "${log}"\ncase "$*" in *"-A open=Open"*) [ "$MODE" = new ] || exit 1; echo open ;; esac\n`,
    );
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "open $*" >> "${log}"\n`);
    for (const f of ["notify-send", "xdg-open"]) chmodSync(join(bin, f), 0o755);
    /** The calls so far, once there are `n` of them (or after 2 s). */
    const calls = async (n: number): Promise<string> => {
      const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
      for (let i = 0; i < 40 && read().split("\n").filter(Boolean).length < n; i++) await Bun.sleep(50);
      return read();
    };
    const path = process.env.PATH;
    process.env.PATH = [bin, path].join(":");
    try {
      process.env.MODE = "new";
      desktopNotify("Lead done", "PR ready", "http://127.0.0.1:4317");
      expect(await calls(2)).toContain("open http://127.0.0.1:4317");
      writeFileSync(log, "");
      process.env.MODE = "old";
      desktopNotify("Lead done", "PR ready", "http://127.0.0.1:4317");
      const out = await calls(2);
      expect(out).toContain("notify -a Overhand -- Lead done PR ready");
      expect(out).not.toContain("open http");
    } finally {
      process.env.PATH = path;
      delete process.env.MODE;
    }
  },
);

test("only Overhand's own login service counts as it: a terminal, a test or the release's checks don't", () => {
  expect(isLoginService(SERVICE, "")).toBe(true);
  expect(isLoginService("", SERVICE)).toBe(true);
  expect(isLoginService("application.com.apple.Terminal.1234", "")).toBe(false);
  expect(isLoginService("", "")).toBe(false);
  expect(isLoginService("", "user@501.service")).toBe(false);
});
