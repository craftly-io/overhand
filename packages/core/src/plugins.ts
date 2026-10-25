/**
 * Plugins: small add-ons (a check, a tracker, a notifier) that run in a sandbox of their own, reach only the hosts they
 * declare, and talk back only in findings (contract/src/plugins.ts says what each enforces, once).
 *
 * - Installed from a pinned version (a git commit, or a tarball's SHA-256) into `<OPS>/plugins/<name>`, approved once by
 *   the digest of its files; any change to them stops it until approved again. Nothing here ever updates one.
 * - Each run copies its files into a fresh folder in /tmp and starts it with bun under `sandbox-exec`
 *   (macOS, a deny-everything profile) or bubblewrap (Linux, empty network, process and file namespaces). Its only way
 *   out is a unix socket into the bridge here, which fetches only from its declared hosts.
 * - Its output is JSON lines, each a finding (PluginFindingSchema); anything else fails the run.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  PLUGIN_FILE,
  PLUGIN_MAX_FINDINGS,
  type PluginFinding,
  PluginFindingSchema,
  type PluginManifest,
  PluginManifestSchema,
  type PluginState,
} from "@overhand/contract";
import { z } from "zod";
import { type Config, saveConfig } from "./config";
import { writeAtomic } from "./control";
import { applyConfig, BUNDLED, CFG, OPS, secret } from "./env";
import { report } from "./notify";
import { real, SANDBOX_TOOL } from "./sandbox";

/** One plugin as the config keeps it. */
export type PluginEntry = Config["plugins"][number];

/** Where installed plugins live, one folder each, written only by the daemon. */
export const pluginsDir = (ops = OPS): string => join(ops, "plugins");

/** A plugin's folder can hold at most this many files and bytes: it's an add-on, not an app. */
const MAX_FILES = 500;
const MAX_BYTES = 10_000_000;

/**
 * The digest of a plugin's files: every regular file's path and contents, in order. Throws on a symlink or anything
 * that isn't a plain file or folder (a symlink could point the copy at your files), or past the size limits.
 */
export function treeDigest(root: string): string {
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files.push(p);
        bytes += st.size;
      } else throw new Error(`${relative(root, p)} is a link or a special file, which a plugin can't hold`);
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error("the plugin is too big (500 files or 10 MB at most)");
    }
  };
  walk(root);
  const h = createHash("sha256");
  for (const f of files) {
    const data = readFileSync(f);
    h.update(`${relative(root, f).split(sep).join("/")}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest("hex");
}

/** A plugin's manifest and digest from its folder; throws with the reason in plain words. */
export function readPlugin(dir: string): { manifest: PluginManifest; digest: string } {
  const digest = treeDigest(dir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, PLUGIN_FILE), "utf8"));
  } catch {
    throw new Error(`it has no readable ${PLUGIN_FILE}`);
  }
  const m = PluginManifestSchema.safeParse(raw);
  if (!m.success) {
    const i = m.error.issues[0];
    throw new Error(`its ${PLUGIN_FILE} is wrong at ${i?.path.join(".") || "the top"}: ${i?.message ?? "invalid"}`);
  }
  if (!existsSync(join(dir, m.data.entry))) throw new Error(`its entry file ${m.data.entry} is missing`);
  return { manifest: m.data, digest };
}

/** git with no config of yours (no hooks, filters or credential helpers), https and local repositories only. */
const GIT = [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.file.allow=always",
];
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString().trim().split("\n").pop() ?? ""}`);
  return r.stdout.toString().trim();
}

/** A source Overhand fetches from: an https address, or an absolute path on this computer. */
const okSource = (s: string): boolean => /^https:\/\/[^\s]+$/.test(s) || /^\/[^\0]*$/.test(s);

/**
 * Fetches `source` at `pin` into `into`: a git commit (40 hex characters), checked out and checked, or a tarball whose
 * SHA-256 must be `pin` before it's unpacked. Throws with the reason.
 */
export async function fetchSource(source: string, pin: string, into: string): Promise<void> {
  if (!okSource(source)) throw new Error("the source must be an https address or a full path on this computer");
  mkdirSync(into, { recursive: true });
  if (pin.length === 40) {
    run([...GIT, "init", "-q"], into);
    run([...GIT, "fetch", "-q", "--depth", "1", "--", source, pin], into);
    run([...GIT, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"], into);
    if (run([...GIT, "rev-parse", "HEAD"], into) !== pin) throw new Error("the commit fetched isn't the one pinned");
    rmSync(join(into, ".git"), { recursive: true, force: true });
    return;
  }
  const bytes = source.startsWith("/") ? readFileSync(source) : await download(source);
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== pin) throw new Error(`the tarball's SHA-256 is ${sum}, not the one pinned`);
  const file = join(into, "..", `${pin}.tar`);
  writeFileSync(file, bytes, { mode: 0o600 });
  try {
    // tar refuses absolute paths and .. by default; a link it unpacks fails the digest after (treeDigest)
    run(["tar", "-xf", file, "-C", into], into);
  } finally {
    rmSync(file, { force: true });
  }
}

/** An https download, 20 MB at most. */
async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > 20_000_000) throw new Error("the tarball is over 20 MB");
  return b;
}

/**
 * Installs a plugin: fetches its pinned source, takes its folder `dir` inside that, checks its manifest and files, and
 * puts it in `<ops>/plugins/<name>`. It isn't approved: it waits for you. Returns the config entry to add.
 */
export async function installPlugin(
  source: string,
  pin: string,
  dir: string,
  taken: readonly string[],
  ops = OPS,
): Promise<{ entry: PluginEntry; manifest: PluginManifest }> {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(pin)) throw new Error("the pin must be a full git commit (40 characters) or a SHA-256 (64)");
  if (dir.startsWith("/") || dir.split("/").includes("..")) throw new Error("the folder must be inside the source");
  const base = pluginsDir(ops);
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, ".fetch-"));
  try {
    const got = join(work, "src");
    await fetchSource(source, pin, got);
    const root = join(got, dir);
    // no folder on the way to it may be a link (one could point the copy at your files); inside it, readPlugin checks
    for (let at = root; at !== got; at = dirname(at))
      if (!lstatSync(at).isDirectory()) throw new Error(`${relative(got, at)} isn't a plain folder in the source`);
    const { manifest } = readPlugin(root);
    if (taken.includes(manifest.name)) throw new Error(`a plugin named ${manifest.name} is installed already`);
    const dest = join(base, manifest.name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(root, dest, { recursive: true });
    report(`🧩 plugin ${manifest.name} ${manifest.version} installed from ${source}, waiting for your approval`);
    return { entry: { name: manifest.name, source, pin, dir, approved: "", grant: [], paused: false }, manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Removes a plugin's files and its last results. */
export function removePluginFiles(name: string, ops = OPS): void {
  rmSync(join(pluginsDir(ops), name), { recursive: true, force: true });
  const r = loadResults(ops);
  delete r[name];
  saveResults(r, ops);
}

// ---------- the sandbox ----------

/** One run's places, all absolute with symlinks resolved. */
export interface PluginPlaces {
  /** The run's copy of the plugin's files (read-only to it). */
  code: string;
  /** Its scratch folder (writable), which holds the bridge's socket. */
  scratch: string;
  /** The bun that runs it (the Overhand binary itself when bundled). */
  bun: string;
  /** The preload that routes fetch through the bridge. */
  preload: string;
}

/** Every folder above `p`, up to `/`: bun lists them looking for its config, and without them it starts with no environment. */
const ancestors = (p: string): string[] => {
  const out: string[] = [];
  for (let a = dirname(p); ; a = dirname(a)) {
    out.push(a);
    if (a === dirname(a)) return out;
  }
};

const lit = (s: string): string => JSON.stringify(s);

/**
 * The macOS profile: everything denied but what the run needs. Reads: its code, scratch, bun, the system's libraries and
 * a few devices, and the listings of the folders above its own. Writes: scratch. Programs: bun only. Network: the
 * bridge's socket only (so no DNS either: macOS resolves names through a socket this denies).
 */
export function pluginProfile(p: PluginPlaces): string {
  const sock = join(p.scratch, BRIDGE_SOCK);
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    `(allow process-exec (literal ${lit(p.bun)}))`,
    `(allow file-read* (subpath ${lit(p.code)}) (subpath ${lit(p.scratch)}) (literal ${lit(p.bun)}) (literal ${lit(p.preload)}) (subpath "/usr/lib") (subpath "/System") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    `(allow file-read-data ${[...new Set([...ancestors(p.code), ...ancestors(p.scratch)])].map((a) => `(literal ${lit(a)})`).join(" ")})`,
    `(allow file-write* (subpath ${lit(p.scratch)}) (literal "/dev/null"))`,
    `(allow network-outbound (remote unix-socket (path-literal ${lit(sock)})))`,
    "(allow sysctl-read)",
  ].join("\n");
}

/** The system folders a Linux run sees, read-only: programs and libraries, nothing of yours. */
const LINUX_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/**
 * The Linux bubblewrap arguments: new namespaces for everything (its network is empty but for loopback), a root of its
 * own with only the system folders, bun, its code (read-only) and scratch; no /home, /etc, /run or /tmp of yours.
 */
export function pluginBwrap(p: PluginPlaces): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const d of LINUX_SYSTEM) {
    try {
      const st = lstatSync(d);
      // /bin is a link to usr/bin on most systems now: the same link inside, else the folder itself
      if (st.isSymbolicLink()) args.push("--symlink", readlinkSync(d), d);
      else if (st.isDirectory()) args.push("--ro-bind", d, d);
    } catch {
      // not on this system
    }
  }
  args.push("--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache");
  args.push("--ro-bind", p.bun, p.bun, "--ro-bind", p.preload, p.preload, "--ro-bind", p.code, p.code, "--bind", p.scratch, p.scratch);
  args.push("--chdir", p.code);
  return args;
}

/** The command that runs a plugin's entry in its sandbox, or null where there's none (then it doesn't run). */
export function pluginArgv(p: PluginPlaces, entry: string, platform: NodeJS.Platform = process.platform): string[] | null {
  const bunArgs = [p.bun, "--no-install", "--preload", p.preload, join(p.code, entry)];
  if (platform === "darwin") return [SANDBOX_TOOL.darwin ?? "", "-p", pluginProfile(p), ...bunArgs];
  if (platform === "linux") {
    const bwrap = Bun.which("bwrap");
    return bwrap ? [bwrap, ...pluginBwrap(p), "--", ...bunArgs] : null;
  }
  return null;
}

// ---------- the bridge ----------

/** The bridge's socket, in the run's scratch folder: a short name, since a socket's path has a length limit. */
export const BRIDGE_SOCK = "b.sock";
/** The header the preload puts the real address in. */
export const BRIDGE_URL = "x-overhand-url";
/** On a refusal: the bridge said no (not the host). */
export const BRIDGE_REFUSED = "x-overhand-refused";

/** Routes fetch through the bridge; runs inside the plugin before its own code (as a string: see PRELOAD). */
function preload(): void {
  const sock = process.env.OVERHAND_BRIDGE ?? "";
  const send = globalThis.fetch;
  const bridged = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const first = new Request(input, init);
    let url = first.url;
    let method = first.method;
    let body: ArrayBuffer | undefined = method === "GET" || method === "HEAD" ? undefined : await first.arrayBuffer();
    for (let hop = 0; hop < 6; hop++) {
      const headers = new Headers(first.headers);
      headers.set("x-overhand-url", url);
      const r = await send("http://bridge/", { unix: sock, method, headers, body, redirect: "manual" });
      if (r.headers.get("x-overhand-refused")) throw new TypeError(`Overhand's bridge refused ${url}: ${await r.text()}`);
      const to = r.headers.get("location");
      if (r.status < 300 || r.status > 399 || !to || first.redirect === "manual") return r;
      url = new URL(to, url).href;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
    throw new TypeError("too many redirects");
  };
  Object.assign(globalThis, { fetch: Object.assign(bridged, { preconnect: () => {} }) });
}
/** The preload file's text: the function above, called. It uses only globals, so it survives bundling. */
const PRELOAD = `(${preload.toString()})();\n`;

/** An address on this computer or a private network: the bridge never fetches from one. */
export function privateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  return l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l);
}

/** How the bridge reaches a host once it's allowed: a fetch, refusing any host whose address is private. */
export type BridgeSend = (url: URL, init: RequestInit) => Promise<Response>;

const publicFetch: BridgeSend = async (url, init) => {
  const ips = await Bun.dns.lookup(url.hostname).catch(() => []);
  if (!ips.length) throw new Error(`${url.hostname} doesn't resolve`);
  if (ips.some((r) => privateAddress(r.address))) throw new Error(`${url.hostname} points at a private address`);
  return fetch(url, init);
};

/** Requests and bytes one run may take through the bridge. */
const BRIDGE_REQUESTS = 50;
const BRIDGE_BYTES = 2_000_000;

const refuse = (why: string): Response => new Response(why, { status: 403, headers: { [BRIDGE_REFUSED]: "1" } });

/**
 * The bridge for one run: each request the plugin makes arrives here with its real address in a header, and goes out
 * only to a declared host, on its usual port, without redirects followed (the preload follows them back through here).
 */
export function bridge(hosts: readonly string[], send: BridgeSend = publicFetch): (req: Request) => Promise<Response> {
  let used = 0;
  return async (req) => {
    let u: URL;
    try {
      u = new URL(req.headers.get(BRIDGE_URL) ?? "");
    } catch {
      return refuse("that isn't a web address");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return refuse("only http and https");
    if (u.username || u.password || u.port || !hosts.includes(u.hostname.toLowerCase()))
      return refuse(`${u.host} isn't one of the hosts this plugin declared`);
    if (++used > BRIDGE_REQUESTS) return refuse(`more than ${BRIDGE_REQUESTS} requests in one run`);
    const headers = new Headers(req.headers);
    for (const h of [BRIDGE_URL, "host", "connection", "content-length"]) headers.delete(h);
    try {
      const r = await send(u, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const body = new Uint8Array(await r.arrayBuffer());
      if (body.length > BRIDGE_BYTES) return refuse("the answer is over 2 MB");
      const out = new Headers(r.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection", BRIDGE_REFUSED]) out.delete(h);
      return new Response([101, 204, 205, 304].includes(r.status) ? null : body, { status: r.status, headers: out });
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
  };
}

// ---------- a run ----------

/** One run's outcome: its findings, or why it failed. */
export interface PluginRun {
  ok: boolean;
  why: string;
  findings: PluginFinding[];
}

/** The findings in a run's output: every non-empty line one, or the run fails. */
export function parseFindings(out: string): PluginRun {
  const findings: PluginFinding[] = [];
  const lines = out.split("\n").filter((l) => l.trim());
  for (const [i, l] of lines.entries()) {
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      return { ok: false, why: `line ${i + 1} of its output isn't JSON`, findings: [] };
    }
    const f = PluginFindingSchema.safeParse(v);
    if (!f.success) return { ok: false, why: `line ${i + 1} of its output isn't a finding Overhand reads`, findings: [] };
    findings.push(f.data);
  }
  if (findings.length > PLUGIN_MAX_FINDINGS)
    return { ok: false, why: `it reported more than ${PLUGIN_MAX_FINDINGS} findings`, findings: [] };
  return { ok: true, why: "", findings };
}

/** The memory a process and everything it started use now, in MB (from ps, on macOS and Linux alike). */
function treeMb(pid: number): number {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss="], { stdout: "pipe", stderr: "ignore" });
  const rows = r.stdout
    .toString()
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const tree = new Set([pid]);
  let kb = 0;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p = 0, pp = 0] of rows) {
      if (!tree.has(pp) || tree.has(p)) continue;
      tree.add(p);
      grew = true;
    }
  }
  for (const [p = 0, , rss = 0] of rows) if (tree.has(p)) kb += rss;
  return kb / 1024;
}

/** Output a run may print: more stops it. */
const MAX_OUT = 256_000;

/**
 * Runs one plugin from its installed folder, in its sandbox: a fresh copy of its files, a scratch folder, the bridge, its
 * granted secrets and nothing else in its environment. Stops it at its time or memory limit. Never throws.
 */
export async function runPlugin(
  dir: string,
  m: PluginManifest,
  secrets: Record<string, string>,
  opts: { send?: BridgeSend; platform?: NodeJS.Platform } = {},
): Promise<PluginRun> {
  const fail = (why: string): PluginRun => ({ ok: false, why, findings: [] });
  // in /tmp, not the temp folder: a socket's path has a length limit, and a temp folder's can be long
  const root = real(mkdtempSync("/tmp/overhand-plugin-"));
  const places: PluginPlaces = {
    code: join(root, "code"),
    scratch: join(root, "scratch"),
    bun: real(process.execPath),
    preload: join(root, "preload.js"),
  };
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    cpSync(dir, places.code, { recursive: true });
    mkdirSync(places.scratch);
    writeFileSync(places.preload, PRELOAD);
    const argv = pluginArgv(places, m.entry, opts.platform);
    if (!argv) return fail("there's no sandbox for plugins on this computer, so it doesn't run");
    const sock = join(places.scratch, BRIDGE_SOCK);
    if (sock.length > 100) return fail("the temp folder's path is too long for the bridge's socket");
    server = Bun.serve({ unix: sock, fetch: bridge(m.hosts, opts.send) });
    const env: Record<string, string> = {
      ...secrets,
      PATH: "/usr/bin:/bin",
      HOME: places.scratch,
      TMPDIR: places.scratch,
      OVERHAND_BRIDGE: sock,
      ...(BUNDLED ? { BUN_BE_BUN: "1" } : {}),
    };
    const proc = Bun.spawn(argv, { cwd: places.code, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let stopped = "";
    const stop = (why: string) => {
      stopped ||= why;
      proc.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(`it ran past its ${m.timeoutSec} s limit`), m.timeoutSec * 1000);
    const watch = setInterval(() => {
      if (treeMb(proc.pid) > m.memoryMb) stop(`it used more than its ${m.memoryMb} MB of memory`);
    }, 250);
    let out = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      out += dec.decode(chunk, { stream: true });
      if (out.length > MAX_OUT) stop("it printed more than 256 KB");
    }
    const code = await proc.exited;
    clearTimeout(timer);
    clearInterval(watch);
    if (stopped) return fail(stopped);
    if (code !== 0) return fail(`it exited with code ${code}`);
    return parseFindings(out);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    void server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- results and the schedule ----------

/** A plugin's last run, kept across restarts. */
const ResultSchema = z.object({ at: z.number(), ok: z.boolean(), why: z.string(), findings: z.array(PluginFindingSchema) });
type Result = z.infer<typeof ResultSchema>;

const resultsFile = (ops: string) => join(pluginsDir(ops), ".results.json");

function loadResults(ops = OPS): Record<string, Result> {
  try {
    return z.record(z.string(), ResultSchema).parse(JSON.parse(readFileSync(resultsFile(ops), "utf8")));
  } catch {
    return {};
  }
}

function saveResults(r: Record<string, Result>, ops = OPS): void {
  writeAtomic(resultsFile(ops), JSON.stringify(r));
}

/** Each file's path, size and change time under `dir`: what readCached compares before hashing again. */
function stamp(dir: string): string {
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .sort()
      .map((p) => {
        const st = lstatSync(join(dir, p));
        return `${p}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * readPlugin for the dashboard, whose state is built every few seconds: the files are hashed again only when one's
 * size or change time moved. A run always hashes them afresh (runNow).
 */
const readAt = new Map<string, { stamp: string; read: ReturnType<typeof readPlugin> | Error }>();
function readCached(dir: string): ReturnType<typeof readPlugin> {
  const now = stamp(dir);
  let hit = readAt.get(dir);
  if (!hit || hit.stamp !== now) {
    try {
      hit = { stamp: now, read: readPlugin(dir) };
    } catch (e) {
      hit = { stamp: now, read: e instanceof Error ? e : new Error(String(e)) };
    }
    readAt.set(dir, hit);
  }
  if (hit.read instanceof Error) throw hit.read;
  return hit.read;
}

/** Each plugin in the config as the dashboard shows it: read from its files, with its last run. */
export function pluginStates(cfg: Pick<Config, "plugins">, ops = OPS): PluginState[] {
  const results = loadResults(ops);
  return cfg.plugins.map((e) => {
    const last = results[e.name];
    const base = {
      name: e.name,
      source: e.source,
      pin: e.pin,
      granted: e.grant,
      last: last ? { at: last.at, ok: last.ok, why: last.why } : null,
      findings: last?.findings ?? [],
    };
    try {
      const { manifest: m, digest } = readCached(join(pluginsDir(ops), e.name));
      const state = !e.approved ? "waiting" : digest !== e.approved ? "changed" : e.paused ? "paused" : "on";
      const shown = { version: m.version, line: m.line, kind: m.kind, hosts: m.hosts, secrets: m.secrets };
      return { ...base, ...shown, everyMin: m.everyMin, timeoutSec: m.timeoutSec, memoryMb: m.memoryMb, state, why: "" };
    } catch (err) {
      return {
        ...base,
        version: "",
        line: "",
        kind: "check" as const,
        hosts: [],
        secrets: [],
        everyMin: 60,
        timeoutSec: 30,
        memoryMb: 256,
        state: "broken" as const,
        why: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

const running = new Set<string>();

/**
 * Runs one approved plugin now and keeps its result: only while its files still match what you approved, with only the
 * secrets you granted it (`read` reads one from the secret store). Returns the result, or null when it can't run.
 */
export async function runNow(e: PluginEntry, read: (name: string) => string, ops = OPS): Promise<Result | null> {
  if (running.has(e.name)) return null;
  const dir = join(pluginsDir(ops), e.name);
  let m: PluginManifest;
  try {
    const p = readPlugin(dir);
    if (!e.approved || p.digest !== e.approved) return null;
    m = p.manifest;
  } catch {
    return null;
  }
  running.add(e.name);
  try {
    const secrets: Record<string, string> = {};
    const missing: string[] = [];
    for (const s of e.grant.filter((g) => m.secrets.includes(g))) {
      try {
        secrets[s] = read(s);
      } catch {
        missing.push(s);
      }
    }
    const r: PluginRun = missing.length
      ? { ok: false, why: `the secret ${missing.join(", ")} isn't in the secret store`, findings: [] }
      : await runPlugin(dir, m, secrets);
    const result = { at: Date.now(), ...r };
    const all = loadResults(ops);
    all[e.name] = result;
    saveResults(all, ops);
    if (!r.ok) report(`🧩 plugin ${e.name} failed: ${r.why}`);
    return result;
  } finally {
    running.delete(e.name);
  }
}

/** Runs every approved, unpaused plugin whose turn has come (its `everyMin` since its last run). */
export async function tickPlugins(
  cfg: Pick<Config, "plugins">,
  read: (name: string) => string,
  now = Date.now(),
  ops = OPS,
): Promise<void> {
  const results = loadResults(ops);
  for (const s of pluginStates(cfg, ops)) {
    const e = cfg.plugins.find((p) => p.name === s.name);
    if (!e || s.state !== "on") continue;
    if (now - (results[s.name]?.at ?? 0) < s.everyMin * 60_000) continue;
    await runNow(e, read, ops);
  }
}

// ---------- what the dashboard asks ----------

const ActionSchema = z.discriminatedUnion("do", [
  z.object({
    do: z.literal("add"),
    source: z.string().trim().min(1),
    pin: z.string().trim().toLowerCase(),
    dir: z.string().trim().default(""),
  }),
  z.object({ do: z.literal("approve"), name: z.string(), grant: z.array(z.string()).default([]) }),
  z.object({ do: z.literal("pause"), name: z.string(), paused: z.boolean() }),
  z.object({ do: z.literal("remove"), name: z.string() }),
  z.object({ do: z.literal("run"), name: z.string() }),
]);

/**
 * Settings' plugin actions (`POST /api/plugin/<do>`): add (installs it, waiting for approval), approve (its files as
 * they are now, with the secrets you grant; it runs at once), pause or resume, remove, run now. Throws with the reason.
 */
export async function pluginAction(action: string, body: unknown, ops = OPS): Promise<{ ok: true }> {
  const parsed = ActionSchema.safeParse({ ...(typeof body === "object" && body !== null ? body : {}), do: action });
  if (!parsed.success) throw new Error("that isn't a plugin action Overhand knows");
  const a = parsed.data;
  const save = (plugins: PluginEntry[]) => applyConfig(saveConfig(ops, { ...CFG, plugins }));
  if (a.do === "add") {
    const { entry } = await installPlugin(
      a.source,
      a.pin,
      a.dir,
      CFG.plugins.map((p) => p.name),
      ops,
    );
    save([...CFG.plugins, entry]);
    return { ok: true };
  }
  const e = CFG.plugins.find((p) => p.name === a.name);
  if (!e) throw new Error(`no plugin named ${a.name}`);
  if (a.do === "remove") {
    removePluginFiles(e.name, ops);
    save(CFG.plugins.filter((p) => p !== e));
    report(`🧩 plugin ${e.name} removed`);
  } else if (a.do === "pause") save(CFG.plugins.map((p) => (p === e ? { ...p, paused: a.paused } : p)));
  else if (a.do === "approve") {
    const { manifest, digest } = readPlugin(join(pluginsDir(ops), e.name));
    const approved = { ...e, approved: digest, grant: a.grant.filter((g) => manifest.secrets.includes(g)), paused: false };
    save(CFG.plugins.map((p) => (p === e ? approved : p)));
    report(`🧩 plugin ${e.name} ${manifest.version} approved${approved.grant.length ? `, with ${approved.grant.join(", ")}` : ""}`);
    void runNow(approved, secret, ops);
  } else if (!(await runNow(e, secret, ops))) throw new Error("it isn't approved as its files are now, or it's running already");
  return { ok: true };
}
