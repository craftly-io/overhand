/**
 * Plugins: the manifest and findings they may write, the bridge's host allowlist, install from a pinned git commit or
 * tarball, approval bound to the files, and, inside the real sandbox (macOS sandbox-exec; Linux bubblewrap, as in CI),
 * that a plugin can't read outside its folder, reach the network on its own or an undeclared host through the bridge,
 * see a secret you didn't grant, or outlast its time and memory limits.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifestSchema } from "@overhand/contract";
import {
  BRIDGE_REFUSED,
  BRIDGE_URL,
  type BridgeSend,
  bridge,
  installPlugin,
  parseFindings,
  pluginStates,
  privateAddress,
  readPlugin,
  runNow,
  runPlugin,
  treeDigest,
} from "../src/plugins";
import { probeSandbox, real } from "../src/sandbox";

const works = probeSandbox().ok;
const mac = process.platform === "darwin";
const EXAMPLE = join(import.meta.dir, "..", "plugins", "site-answers");
const root = real(mkdtempSync(join(tmpdir(), "overhand-plugin-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// CI installs bubblewrap (ci.yml): there the sandboxed cases below must run, never skip quietly
test.skipIf(!process.env.CI)("in CI the sandbox runs, so the plugin sandbox tests aren't skipped", () => {
  expect(works).toBe(true);
});

const manifest = (o: Record<string, unknown> = {}) =>
  PluginManifestSchema.safeParse({ name: "p", version: "1", line: "x", kind: "check", entry: "main.ts", ...o });

describe("the manifest", () => {
  test("the example plugin's manifest is valid and declares only its host", () => {
    const { manifest: m } = readPlugin(EXAMPLE);
    expect(m.hosts).toEqual(["overhand.dev"]);
    expect(m.secrets).toEqual([]);
  });
  test("refuses IP addresses, localhost, local-network names and ports as hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "printer.local", "db.internal", "example.com:8080", "EXAMPLE.com"])
      expect(manifest({ hosts: [h] }).success).toBe(false);
    expect(manifest({ hosts: ["status.example.com"] }).success).toBe(true);
  });
  test("refuses an entry outside its folder, a reserved secret name and unknown fields", () => {
    expect(manifest({ entry: "../x.ts" }).success).toBe(false);
    expect(manifest({ entry: "/etc/x.ts" }).success).toBe(false);
    expect(manifest({ secrets: ["PATH"] }).success).toBe(false);
    expect(manifest({ secrets: ["OVERHAND_BRIDGE"] }).success).toBe(false);
    expect(manifest({ network: "all" }).success).toBe(false);
  });
});

describe("findings", () => {
  const f = { title: "t", line: "l", severity: "bad", fix: { kind: "rerun" } };
  test("each line is a finding with its fix", () => {
    const r = parseFindings(`${JSON.stringify(f)}\n\n${JSON.stringify({ ...f, fix: { kind: "link", url: "https://x.dev/" } })}\n`);
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(2);
  });
  test("any other line fails the run: a log line, a finding with no fix, a non-https link", () => {
    expect(parseFindings("hello\n").ok).toBe(false);
    expect(parseFindings(JSON.stringify({ title: "t", severity: "bad" })).ok).toBe(false);
    expect(parseFindings(JSON.stringify({ ...f, fix: { kind: "link", url: "javascript:alert(1)" } })).ok).toBe(false);
    expect(parseFindings(JSON.stringify({ ...f, fix: { kind: "link", url: "http://x.dev/" } })).ok).toBe(false);
  });
  test("more than 50 findings fails the run", () => {
    expect(parseFindings(Array(51).fill(JSON.stringify(f)).join("\n")).ok).toBe(false);
  });
});

describe("the bridge", () => {
  const sent: string[] = [];
  const send: BridgeSend = async (u) => {
    sent.push(u.href);
    return new Response("hi", { headers: { "content-encoding": "gzip" } });
  };
  const ask = (b: ReturnType<typeof bridge>, url: string) => b(new Request("http://bridge/", { headers: { [BRIDGE_URL]: url } }));
  test("fetches only from a declared host, on its usual port, with no login in the address", async () => {
    const b = bridge(["overhand.dev"], send);
    const ok = await ask(b, "https://overhand.dev/status");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hi");
    expect(ok.headers.get("content-encoding")).toBeNull();
    for (const url of [
      "https://example.com/",
      "https://overhand.dev.example.com/",
      "https://overhand.dev:8443/",
      "https://a:b@overhand.dev/",
      "file:///etc/passwd",
      "nonsense",
    ]) {
      const r = await ask(b, url);
      expect(r.status).toBe(403);
      expect(r.headers.get(BRIDGE_REFUSED)).toBe("1");
    }
    expect(sent).toEqual(["https://overhand.dev/status"]);
  });
  test("refuses after 50 requests in one run", async () => {
    const b = bridge(["overhand.dev"], send);
    for (let i = 0; i < 50; i++) expect((await ask(b, "https://overhand.dev/")).status).toBe(200);
    expect((await ask(b, "https://overhand.dev/")).status).toBe(403);
  });
  test("private and loopback addresses are never fetched", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.20.0.1",
      "169.254.169.254",
      "100.100.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ])
      expect(privateAddress(ip)).toBe(true);
    for (const ip of ["1.1.1.1", "104.16.0.1", "2606:4700::1111"]) expect(privateAddress(ip)).toBe(false);
  });
});

describe("files and approval", () => {
  test("the digest changes with any file, and a link in the folder is refused", () => {
    const d = join(root, "digest");
    cpSync(EXAMPLE, d, { recursive: true });
    const before = treeDigest(d);
    writeFileSync(join(d, "check.ts"), `${readFileSync(join(d, "check.ts"), "utf8")}\n`);
    expect(treeDigest(d)).not.toBe(before);
    symlinkSync("/etc/hosts", join(d, "hosts"));
    expect(() => treeDigest(d)).toThrow(/link/);
  });

  test("installs from a pinned git commit and a pinned tarball, waits for approval, and stops when its files change", async () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "plugins"), { recursive: true });
    cpSync(EXAMPLE, join(repo, "plugins", "site-answers"), { recursive: true });
    const git = (...a: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdout: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "plugin");
    const sha = git("rev-parse", "HEAD").stdout.toString().trim();
    const ops = join(root, "ops");
    await expect(installPlugin(repo, "0".repeat(40), "plugins/site-answers", [], ops)).rejects.toThrow();
    const { entry } = await installPlugin(repo, sha, "plugins/site-answers", [], ops);
    expect(entry).toMatchObject({ name: "site-answers", pin: sha, approved: "" });
    await expect(installPlugin(repo, sha, "plugins/site-answers", ["site-answers"], ops)).rejects.toThrow(/installed already/);
    expect(pluginStates({ plugins: [entry] }, ops)[0]?.state).toBe("waiting");
    const approved = { ...entry, approved: treeDigest(join(ops, "plugins", "site-answers")) };
    expect(pluginStates({ plugins: [approved] }, ops)[0]?.state).toBe("on");
    writeFileSync(join(ops, "plugins", "site-answers", "check.ts"), "console.log('changed')");
    expect(pluginStates({ plugins: [approved] }, ops)[0]?.state).toBe("changed");
    // a changed plugin doesn't run, even when asked
    expect(await runNow(approved, () => "", ops)).toBeNull();

    const tar = join(root, "p.tar.gz");
    Bun.spawnSync(["tar", "-czf", tar, "-C", EXAMPLE, "."]);
    const sum = new Bun.CryptoHasher("sha256").update(readFileSync(tar)).digest("hex");
    const ops2 = join(root, "ops2");
    await expect(installPlugin(tar, "f".repeat(64), "", [], ops2)).rejects.toThrow(/SHA-256/);
    expect((await installPlugin(tar, sum, "", [], ops2)).entry.name).toBe("site-answers");

    // a folder on the way that's a link (here, to the plugin outside the repo) is refused, as is one inside it
    symlinkSync(EXAMPLE, join(repo, "linked"));
    mkdirSync(join(repo, "inner"));
    cpSync(EXAMPLE, join(repo, "inner", "p"), { recursive: true });
    symlinkSync("/etc/hosts", join(repo, "inner", "p", "hosts"));
    git("add", ".");
    git("commit", "-qm", "links");
    const linked = git("rev-parse", "HEAD").stdout.toString().trim();
    await expect(installPlugin(repo, linked, "linked", [], join(root, "ops3"))).rejects.toThrow(/plain folder/);
    await expect(installPlugin(repo, linked, "inner/p", [], join(root, "ops3"))).rejects.toThrow(/link/);
    await expect(installPlugin(repo, linked, "../x", [], join(root, "ops3"))).rejects.toThrow(/inside the source/);
  });
});

describe.skipIf(!works)("inside its sandbox", () => {
  const m = (o: Record<string, unknown> = {}) =>
    PluginManifestSchema.parse({ name: "probe", version: "1", line: "x", kind: "check", entry: "main.ts", hosts: ["overhand.dev"], ...o });
  const plugin = (name: string, code: string): string => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "main.ts"), code);
    return d;
  };
  const ok: BridgeSend = async () => new Response("<h1>hi</h1>", { status: 200 });

  test("the example plugin reports its host answering, and not answering, through the bridge", async () => {
    const { manifest: em } = readPlugin(EXAMPLE);
    const up = await runPlugin(EXAMPLE, em, {}, { send: ok });
    expect(up).toMatchObject({ ok: true, findings: [{ title: "overhand.dev answers", severity: "info" }] });
    const down = await runPlugin(EXAMPLE, em, {}, { send: async () => new Response("no", { status: 503 }) });
    expect(down.findings[0]).toMatchObject({ title: "overhand.dev answers 503", severity: "bad" });
  });

  test("it can't read your files, reach the network itself or an undeclared host, write outside scratch, run programs or see an ungranted secret", async () => {
    const secretFile = join(root, "yours.txt");
    writeFileSync(secretFile, "your file");
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    process.env.OVERHAND_TEST_DAEMON_SECRET = "daemon only";
    const d = plugin(
      "hostile",
      `
const out = {};
const t = async (k, f) => { try { out[k] = String(await f()).slice(0, 20); } catch { out[k] = "blocked"; }  };
await t("own", () => Bun.file(import.meta.dir + "/main.ts").text().then((x) => x.length > 0));
await t("yours", () => Bun.file(${JSON.stringify(secretFile)}).text());
await t("hosts", () => Bun.file("/etc/hosts").text());
await t("tcp", () => new Promise((ok, no) => Bun.connect({ hostname: "127.0.0.1", port: ${tcp.port}, socket: { open: () => ok("connected"), connectError: no, data() {} } })));
await t("dns", () => Promise.race([Bun.dns.lookup("example.com").then((r) => r.length), Bun.sleep(3000).then(() => { throw new Error("no answer"); })]));
await t("undeclared", () => fetch("https://example.com/").then((r) => r.status));
await t("declared", () => fetch("https://overhand.dev/").then((r) => r.status));
await t("write", () => Bun.write(${JSON.stringify(join(root, "escaped.txt"))}, "x"));
await t("scratch", () => Bun.write(process.env.TMPDIR + "/x", "x"));
// macOS runs no other program in it; on Linux one runs inside the same sandbox, and sees no more than the plugin
await t("exec", () => Bun.spawnSync(["/bin/cat", ${JSON.stringify(secretFile)}]).stdout.toString() || "nothing");
out.granted = process.env.SITE_TOKEN ?? "none";
out.ungranted = process.env.OTHER_TOKEN ?? "none";
out.daemon = process.env.OVERHAND_TEST_DAEMON_SECRET ?? "none";
console.log(JSON.stringify({ title: "probe", line: JSON.stringify(out), severity: "info", fix: { kind: "rerun" } }));
// a refused DNS lookup goes on retrying on Linux: done is done
process.exit(0);
`,
    );
    const ops = join(root, "ops-hostile");
    mkdirSync(join(ops, "plugins"), { recursive: true });
    cpSync(d, join(ops, "plugins", "probe"), { recursive: true });
    writeFileSync(
      join(ops, "plugins", "probe", "overhand-plugin.json"),
      JSON.stringify({
        name: "probe",
        version: "1",
        line: "x",
        kind: "check",
        entry: "main.ts",
        hosts: ["overhand.dev"],
        secrets: ["SITE_TOKEN", "OTHER_TOKEN"],
      }),
    );
    const dir = join(ops, "plugins", "probe");
    const r = await runPlugin(dir, readPlugin(dir).manifest, { SITE_TOKEN: "granted" }, { send: ok });
    tcp.stop(true);
    delete process.env.OVERHAND_TEST_DAEMON_SECRET;
    expect(r.ok).toBe(true);
    // a write outside scratch fails (macOS) or lands in the sandbox's own empty /tmp (Linux): never on your disk
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    const { write: _, ...seen }: Record<string, string> = JSON.parse(r.findings[0]?.line ?? "{}");
    expect(seen).toEqual({
      own: "true",
      yours: "blocked",
      hosts: "blocked",
      tcp: "blocked",
      dns: "blocked",
      undeclared: "blocked",
      declared: "200",
      scratch: "1",
      exec: mac ? "blocked" : "nothing",
      granted: "granted",
      ungranted: "none",
      daemon: "none",
    });
  }, 30_000);

  test("runNow hands it only the secrets you granted", async () => {
    const ops = join(root, "ops-grant");
    const dir = join(ops, "plugins", "probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.ts"),
      `console.log(JSON.stringify({ title: "env", line: [process.env.SITE_TOKEN ?? "none", process.env.OTHER_TOKEN ?? "none"].join(","), severity: "info", fix: { kind: "rerun" } }));`,
    );
    writeFileSync(
      join(dir, "overhand-plugin.json"),
      JSON.stringify({ name: "probe", version: "1", line: "x", kind: "check", entry: "main.ts", secrets: ["SITE_TOKEN", "OTHER_TOKEN"] }),
    );
    const entry = {
      name: "probe",
      source: "/x",
      pin: "a".repeat(40),
      dir: "",
      approved: treeDigest(dir),
      grant: ["SITE_TOKEN"],
      paused: false,
    };
    const r = await runNow(entry, (n) => `value of ${n}`, ops);
    expect(r?.findings[0]?.line).toBe("value of SITE_TOKEN,none");
    expect(pluginStates({ plugins: [entry] }, ops)[0]?.findings[0]?.title).toBe("env");
  });

  test("it's stopped at its time limit and its memory limit", async () => {
    const slow = plugin("slow", "await Bun.sleep(60_000);");
    expect(await runPlugin(slow, m({ timeoutSec: 1 }), {})).toMatchObject({ ok: false, why: "it ran past its 1 s limit" });
    const big = plugin(
      "big",
      "const keep = []; for (let i = 0; i < 100; i++) { keep.push(new Uint8Array(10_000_000).fill(1)); await Bun.sleep(20); } console.log(keep.length);",
    );
    expect(await runPlugin(big, m({ memoryMb: 64, timeoutSec: 20 }), {})).toMatchObject({
      ok: false,
      why: "it used more than its 64 MB of memory",
    });
  });
});
