import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { state } from "@overhand/contract/fixtures/state";
import { CFG } from "../src/env";
import {
  browserArgs,
  findBrowser,
  oncePerStart,
  redactPrivate,
  renderCheck,
  runSelfCheck,
  type SelfCheckDeps,
  schemaCheck,
  writeDiagnostic,
} from "../src/selfcheck";

const scratch = mkdtempSync(join(tmpdir(), "overhand-selfcheck-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A built dashboard: an index that loads one script, and the script when `withAsset`. */
function dist(withAsset: boolean): string {
  const d = mkdtempSync(join(scratch, "dist-"));
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), '<script type="module" src="/assets/index-abc.js"></script><link href="/assets/index-abc.css">');
  writeFileSync(join(d, "assets", "index-abc.css"), "");
  if (withAsset) writeFileSync(join(d, "assets", "index-abc.js"), "");
  return d;
}

const STATE = state();

test("the cheap check: the state parses with the contract and every file the page loads is there", () => {
  expect(schemaCheck(STATE, dist(true))).toBe("");
  expect(schemaCheck(STATE, dist(false))).toBe("Overhand's assets/index-abc.js is missing");
  expect(schemaCheck(STATE, join(scratch, "nowhere"))).toContain("index.html is missing");
  expect(schemaCheck({ ...STATE, now: "soon" }, dist(true))).toStartWith("the state doesn't match the dashboard's contract: now");
});

/** Fake surroundings that record what the check did. */
function deps(over: Partial<SelfCheckDeps> = {}) {
  const did = { render: 0, released: 0, notified: [] as string[] };
  const d: SelfCheckDeps = {
    state: async () => STATE,
    browser: () => "/fake/chrome",
    hold: () => null,
    slot: () => () => {
      did.released++;
    },
    render: async () => {
      did.render++;
      return "";
    },
    notify: (title, body) => void did.notified.push(`${title}: ${body}`),
    ...over,
  };
  return { d, did };
}

test("headless only with a browser, room on the machine and a free browser slot; the slot is always given back", async () => {
  const url = "http://127.0.0.1:1/";
  const built = dist(true);
  const none = deps({ browser: () => "" });
  expect(await runSelfCheck(none.d, url, built)).toEqual({ ok: true, at: expect.any(Number), mode: "schema", error: "" });
  expect(none.did.render).toBe(0);
  const quiet = deps({ hold: () => "quiet mode is on until 18:00" });
  expect((await runSelfCheck(quiet.d, url, built)).mode).toBe("schema");
  expect([quiet.did.render, quiet.did.released]).toEqual([0, 0]);
  const busy = deps({ slot: () => null });
  expect((await runSelfCheck(busy.d, url, built)).mode).toBe("schema");
  expect(busy.did.render).toBe(0);
  const ok = deps();
  expect(await runSelfCheck(ok.d, url, built)).toMatchObject({ ok: true, mode: "browser" });
  expect([ok.did.render, ok.did.released]).toEqual([1, 1]);
  // a render that throws still gives the slot back
  const boom = deps({
    render: async () => {
      throw new Error("crashed");
    },
  });
  expect((await runSelfCheck(boom.d, url, built)).error).toContain("crashed");
  expect(boom.did.released).toBe(1);
});

test("the headless browser opens once per start: after a passing render only the cheap check runs, until the next start", async () => {
  const url = "http://127.0.0.1:1/";
  const built = dist(true);
  let renders = 0;
  let fail = true;
  const live = oncePerStart(
    () => "/fake/chrome",
    async () => {
      renders++;
      return fail ? "a page error: boom" : "";
    },
  );
  const d = deps(live).d;
  expect((await runSelfCheck(d, url, built)).mode).toBe("browser"); // a failing render: looked at again next time
  fail = false;
  expect((await runSelfCheck(d, url, built)).mode).toBe("browser");
  expect(await runSelfCheck(d, url, built)).toMatchObject({ ok: true, mode: "schema" });
  expect(await runSelfCheck(d, url, built)).toMatchObject({ ok: true, mode: "schema" });
  expect(renders).toBe(2);
  // a new start (another set of deps) renders again
  expect(
    (
      await runSelfCheck(
        deps(
          oncePerStart(
            () => "/fake/chrome",
            async () => "",
          ),
        ).d,
        url,
        built,
      )
    ).mode,
  ).toBe("browser");
});

test("a failure is kept with its error and notified once, until it passes again", async () => {
  const url = "http://127.0.0.1:1/";
  await runSelfCheck(deps().d, url, dist(true)); // passing first: the failure is news
  const broken = deps({ state: async () => ({ ...STATE, clients: "x" }) });
  const r = await runSelfCheck(broken.d, url);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("clients");
  expect(broken.did.notified).toHaveLength(1);
  await runSelfCheck(broken.d, url);
  expect(broken.did.notified).toHaveLength(1);
  const thrown = deps({
    state: async () => {
      throw new Error("no state");
    },
  });
  expect((await runSelfCheck(thrown.d, url)).error).toBe("the state couldn't be built: no state");
});

test("Report: the diagnostic has the error without project names or secrets, and no state values", async () => {
  const token = ["sk-ant-", "api03-", "abcdefghijklmnopqrstuvwxyz"].join("");
  expect(redactPrivate(`TypeError in Fernway pane, HONEY-4, key ${token}`)).toBe("TypeError in [private] pane, [private], key [redacted]");
  const failing = deps({ render: async () => `a page error: TypeError at Honeycrust ${token}` });
  await runSelfCheck(failing.d, "http://127.0.0.1:1/", dist(true));
  const ops = mkdtempSync(join(scratch, "overhand-"));
  const file = writeDiagnostic({ ...STATE, clients: [{ name: "Honeycrust" }] }, ops, 0);
  expect(file).toStartWith(join(ops, "diagnostics"));
  const text = readFileSync(file, "utf8");
  for (const c of CFG.clients) expect(text).not.toContain(c.name);
  expect(text).not.toContain(token);
  expect(JSON.parse(text).selfCheck.error).toBe("a page error: TypeError at [private] [redacted]");
  expect(readdirSync(join(ops, "diagnostics"))).toHaveLength(1);
});

test("a browser is looked for where it's installed, OVERHAND_BROWSER first", () => {
  expect(findBrowser({ OVERHAND_BROWSER: "/opt/chrome" }, (p) => p === "/opt/chrome")).toBe("/opt/chrome");
  expect(findBrowser({}, () => false)).toBe("");
});

test("the headless browser opens no DevTools port: it's driven over a pipe only another program can't reach", async () => {
  const args = browserArgs("/tmp/p");
  expect(args).toContain("--remote-debugging-pipe");
  expect(args.some((a) => a.startsWith("--remote-debugging-port") || a.startsWith("--remote-debugging-address"))).toBe(false);
  // a browser that isn't there fails the check at once, it doesn't hang
  expect(await renderCheck("http://127.0.0.1:1/", "/nonexistent/browser", 5000)).toContain("the headless");
});

// One real headless render, muted, against a page on this machine. Opt-in: it starts a browser.
test.skipIf(!process.env.OVERHAND_BROWSER_TESTS || !findBrowser())(
  "a real headless render: the page shows, and a page error fails it",
  async () => {
    const page = (body: string) =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body, { headers: { "content-type": "text/html" } }) });
    const good = page('<main id="main"><section>Now</section></main><script>speechSynthesis.speak({})</script>');
    const bad = page('<main id="main"></main><script>throw new TypeError("boom")</script>');
    try {
      expect(await renderCheck(`http://127.0.0.1:${good.port}/`, findBrowser(), 20_000)).toBe("");
      expect(await renderCheck(`http://127.0.0.1:${bad.port}/`, findBrowser(), 20_000)).toContain("boom");
    } finally {
      good.stop(true);
      bad.stop(true);
    }
  },
  60_000,
);
