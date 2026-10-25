import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProjectSandbox, QuickSettingSchema } from "@overhand/contract";
import { AGENT_HOMES } from "../src/agent-home";
import { blankConfig, type Config, parseConfig, withQuick } from "../src/config";
import { applyConfig, CFG } from "../src/env";
import { hostTool, projectSandbox, projectTools, real, SANDBOX_TOOL, sandboxAuto, sandboxSpawn, sandboxState } from "../src/sandbox";

const before = structuredClone(CFG);
afterAll(() => applyConfig(before));

const fine = () => ({ ok: true, why: "" });
const broken = () => ({ ok: false, why: "no" });

test("a project set to off runs on the guard only while the sandbox is on, never past a required one", () => {
  for (const project of [undefined, "inherit", "off", "keep"] as const)
    for (const mode of ["off", "log", "enforce"] as const)
      for (const required of [false, true]) {
        const st = sandboxState({ mode, required, project }, "darwin", fine);
        const out = project === "off" && mode !== "off" && !required;
        expect(st.guardOnly === true, `${project} ${mode} ${required}`).toBe(out);
        expect(st.effective, `${project} ${mode} ${required}`).toBe(out ? "off" : mode);
      }
  // required and the sandbox can't run: the project set to off still doesn't start
  expect(sandboxState({ mode: "enforce", required: true, project: "off" }, "linux", broken)).toMatchObject({ refuse: true });
  // not required: it runs on the guard only without even probing
  expect(sandboxState({ mode: "enforce", required: false, project: "off" }, "darwin", broken)).toMatchObject({
    refuse: false,
    guardOnly: true,
  });
});

test("Xcode, Swift packages and firebase-tools are found at a project's top or two folders down; nothing else is", () => {
  const dir = (files: string[]) => {
    const root = real(mkdtempSync(join(tmpdir(), "overhand-host-")));
    for (const f of files) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      if (f.endsWith(".xcodeproj")) mkdirSync(join(root, f));
      else writeFileSync(join(root, f), "");
    }
    return root;
  };
  expect(hostTool(dir(["Package.swift"]))).toBe("Xcode");
  expect(hostTool(dir(["app/ios/App.xcodeproj"]))).toBe("Xcode");
  expect(hostTool(dir(["web/firebase.json"]))).toBe("firebase-tools");
  expect(hostTool(dir(["package.json", "node_modules/x/Package.swift", ".build/a/Package.swift"]))).toBe("");
  expect(hostTool(dir(["a/b/c/Package.swift"]))).toBe("");
  expect(hostTool(join(tmpdir(), "overhand-no-such-dir"))).toBe("");
});

test("under enforce, a project set to off spawns without the sandbox while another project still gets it", () => {
  const cwd = real(mkdtempSync(join(tmpdir(), "overhand-sbp-")));
  const ops = join(cwd, "ops");
  const s = {
    cwd,
    runtime: "claude-code" as const,
    configDir: join(AGENT_HOMES, "claude-code"),
    run: "T-2",
    readOnly: false,
    argv: ["claude", "-p", "hi"],
    env: { PATH: "/usr/bin" },
  };
  const off = sandboxSpawn(s, sandboxState({ mode: "enforce", required: false, project: "off" }, "darwin", fine), () => "", ops);
  expect(off).toMatchObject({ argv: s.argv, sandboxed: false, guardOnly: true });
  const on = sandboxSpawn(s, sandboxState({ mode: "enforce", required: false, project: "inherit" }, "darwin", fine), () => "", ops);
  expect(on).toMatchObject({ sandboxed: true, guardOnly: false });
  if (process.platform === "darwin") expect(on.argv[0]).toBe(SANDBOX_TOOL.darwin ?? "");
  expect(on.argv.slice(-3)).toEqual(s.argv);
  on.done(Date.now());
  off.done(Date.now());
});

test("each spawn site asks by project name: the config's setting for that project decides", () => {
  const client: Config["clients"][number] = {
    name: "Mac app",
    dir: "mac-app",
    prefix: "MAC",
    host: "github",
    aliases: [],
    sandbox: "off",
    status: { vercelSecrets: [], sentrySecrets: [] },
  };
  applyConfig({ ...CFG, sandbox: { mode: "enforce", required: false }, clients: [...CFG.clients, client] });
  expect(projectSandbox("Mac app")).toMatchObject({ effective: "off", guardOnly: true });
  applyConfig({ ...CFG, sandbox: { mode: "enforce", required: true } });
  expect(projectSandbox("Mac app").guardOnly).toBeUndefined();
});

test("a new install's config has the sandbox on; a config that sets its mode keeps it", () => {
  const base = { owner: { name: "Sam", keychainAccount: "Sam" }, accounts: [], clients: [] };
  expect(blankConfig("Sam").sandbox).toEqual({ mode: "enforce", required: false });
  for (const mode of ["off", "log", "enforce"] as const) expect(parseConfig({ ...base, sandbox: { mode } }).sandbox.mode).toBe(mode);
  // where it can't run, the default means the guard only, not refused runs (macOS, where a failing probe is a bug, aside)
  expect(sandboxState(blankConfig("Sam").sandbox, "linux", broken)).toMatchObject({ effective: "off", ok: false, refuse: false });
});

test("on enforce, Overhand itself runs a project holding a tool that can't run inside it on the guard only; keep holds it in", () => {
  const auto = (project: ProjectSandbox | undefined, mode: "off" | "log" | "enforce" = "enforce", required = false) =>
    sandboxState({ mode, required, project, tool: "Xcode" }, "darwin", fine);
  expect(auto(undefined)).toMatchObject({ effective: "off", guardOnly: true, tool: "Xcode" });
  expect(auto("inherit")).toMatchObject({ effective: "off", guardOnly: true, tool: "Xcode" });
  // set to off by you: guard only, but not Overhand's doing
  expect(auto("off")).toMatchObject({ guardOnly: true });
  expect(auto("off").tool).toBeUndefined();
  expect(auto("keep")).toMatchObject({ effective: "enforce" });
  expect(auto("keep").guardOnly).toBeUndefined();
  // log only blocks nothing, and a required sandbox holds every project
  expect(auto(undefined, "log").effective).toBe("log");
  expect(auto(undefined, "enforce", true).effective).toBe("enforce");
  // no tool, no change
  expect(sandboxState({ mode: "enforce", required: false, tool: "" }, "darwin", fine).effective).toBe("enforce");
});

test("a project with a Package.swift runs on the guard only, Needs you lists it, and Keep it in the sandbox puts it back", () => {
  const code = real(mkdtempSync(join(tmpdir(), "overhand-code-")));
  mkdirSync(join(code, "swift-app"));
  writeFileSync(join(code, "swift-app", "Package.swift"), "");
  mkdirSync(join(code, "web"));
  const client = (name: string, dir: string): Config["clients"][number] => ({
    name,
    dir,
    prefix: name.slice(0, 3).toUpperCase(),
    host: "github",
    aliases: [],
    status: { vercelSecrets: [], sentrySecrets: [] },
  });
  const cfg: Config = {
    ...CFG,
    codeRoot: code,
    sandbox: { mode: "enforce", required: false },
    clients: [client("Swift app", "swift-app"), client("Web", "web")],
  };
  applyConfig(cfg);
  expect(projectSandbox("Swift app")).toMatchObject({ effective: "off", guardOnly: true, tool: "Xcode" });
  expect(projectSandbox("Web").guardOnly).toBeUndefined();
  expect(projectTools()).toEqual({ "Swift app": "Xcode" });
  // Needs you's card shows only while the machine's sandbox is enforced here
  expect(sandboxAuto()).toEqual(sandboxState(cfg.sandbox).effective === "enforce" ? { "Swift app": "Xcode" } : {});
  applyConfig(withQuick(cfg, { project: "Swift app", sandbox: "keep" }));
  expect(CFG.clients[0]?.sandbox).toBe("keep");
  expect(projectSandbox("Swift app").guardOnly).toBeUndefined();
  expect(sandboxAuto()).toEqual({});
  // only "keep" comes by the quick path: it can only hold a run tighter
  expect(QuickSettingSchema.safeParse({ project: "Swift app", sandbox: "off" }).success).toBe(false);
});
