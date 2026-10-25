import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opencodeKey,
  SIGNIN_GONE,
  SIGNIN_NO_LINK,
  SIGNIN_TIMED_OUT,
  SIGNIN_UNFINISHED,
  shownCode,
  signInState,
  signInUrl,
  startSignIn,
  watchSignIn,
} from "../src/signin";

const dir = mkdtempSync(join(tmpdir(), "oh-signin-"));
const SECRET = "secret-token-printed-by-the-cli";

/** A fake agent CLI: prints a link (as an OSC 8 terminal link), then waits for the browser to approve it or deny it. */
const fake = join(dir, "fake-login");
writeFileSync(
  fake,
  [
    "#!/bin/sh",
    `printf 'Opening browser\\nvisit: \\033]8;;https://example.test/auth?code=true&state=abc\\033\\\\link\\033]8;;\\033\\\\\\n'`,
    `printf '${SECRET}\\nWaiting for the browser…\\n'`,
    'while [ ! -e "$OUT/approved" ] && [ ! -e "$OUT/denied" ]; do sleep 0.05; done',
    '[ -e "$OUT/approved" ] && touch "$OUT/ok" && exit 0',
    "exit 1",
  ].join("\n"),
);
chmodSync(fake, 0o755);
const ok = join(dir, "ok");
const approve = () => writeFileSync(join(dir, "approved"), "");

const until = async (f: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end && !f(); ) await Bun.sleep(25);
};
const start = (argv = [fake], more: { ms?: number; urlMs?: number } = {}) =>
  startSignIn({ key: "acct", by: "local", argv, env: { OUT: dir }, verify: async () => existsSync(ok), ...more });

afterEach(() => {
  for (const f of ["ok", "approved", "denied"]) rmSync(join(dir, f), { force: true });
});

test("the link and a code to enter are read from what the CLI prints", () => {
  expect(signInUrl("visit: \u001b]8;;https://a.test/x?y=1\u001b\\link")).toBe("https://a.test/x?y=1");
  expect(shownCode("1. Open https://auth.test/device?s=ABCD-EFGH\n2. Enter this one-time code\n   AB12-CD345\n")).toBe("AB12-CD345");
  expect(shownCode("https://a.test/?state=ABCD-EFGH")).toBe("");
});

test("a CLI that prints a link signs in through the app, and nothing it printed is logged", async () => {
  const said: string[] = [];
  const spies = [
    spyOn(console, "log").mockImplementation((...a) => void said.push(a.join(" "))),
    spyOn(console, "error").mockImplementation((...a) => void said.push(a.join(" "))),
    spyOn(console, "warn").mockImplementation((...a) => void said.push(a.join(" "))),
  ];
  try {
    const r = await start();
    if ("error" in r) throw new Error(r.error);
    expect(r.url).toBe("https://example.test/auth?code=true&state=abc");
    expect(r.code).toBe("");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(signInState(r.id, "a-phone")).toBeNull(); // only who started it
    approve();
    await until(() => signInState(r.id, "local")?.state !== "waiting");
    expect(signInState(r.id, "local")).toEqual({ state: "done", why: "" });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(said.join("\n")).not.toContain(SECRET);
  expect(said.join("\n")).not.toContain("example.test");
});

test("a sign-in that ends without signing in says so in one plain line, checked by the CLI's own status", async () => {
  const r = await start();
  if ("error" in r) throw new Error(r.error);
  writeFileSync(join(dir, "denied"), "");
  await until(() => signInState(r.id, "local")?.state !== "waiting");
  expect(signInState(r.id, "local")).toEqual({ state: "failed", why: SIGNIN_UNFINISHED });
});

test("a sign-in left waiting is stopped, its CLI killed", async () => {
  const r = await start([fake], { ms: 1500 });
  if ("error" in r) throw new Error(r.error);
  await until(() => signInState(r.id, "local")?.state !== "waiting");
  expect(signInState(r.id, "local")).toEqual({ state: "failed", why: SIGNIN_TIMED_OUT });
});

test("a CLI that never shows a link, or exits first, says so", async () => {
  expect(await start(["sh", "-c", "sleep 5"], { urlMs: 200 })).toEqual({ error: "The sign-in didn't show a link in time." });
  expect(await start(["sh", "-c", "echo nope; exit 1"])).toEqual({ error: SIGNIN_NO_LINK });
  expect(await start([join(dir, "missing")])).toEqual({ error: SIGNIN_NO_LINK });
});

test("starting again stops the sign-in before it", async () => {
  const a = await start();
  const b = await start();
  if ("error" in a || "error" in b) throw new Error("no link");
  expect(signInState(a.id, "local")).toEqual({ state: "failed", why: SIGNIN_GONE });
  expect(signInState(b.id, "local")?.state).toBe("waiting");
  approve();
  await until(() => signInState(b.id, "local")?.state !== "waiting");
});

test("a sign-in you run yourself (Claude Code's) is only watched: its status check, until it says signed in", async () => {
  let looks = 0;
  let signedIn = false;
  const verify = async () => {
    looks++;
    return signedIn;
  };
  const id = watchSignIn({ key: "claude", by: "local", verify, everyMs: 20 });
  expect(signInState(id, "a-phone")).toBeNull(); // only who started it
  await until(() => looks >= 2);
  expect(signInState(id, "local")).toEqual({ state: "waiting", why: "" });
  signedIn = true; // you ran the command in your terminal and signed in
  await until(() => signInState(id, "local")?.state !== "waiting");
  expect(signInState(id, "local")).toEqual({ state: "done", why: "" });
  const after = looks;
  await Bun.sleep(80);
  expect(looks).toBe(after); // done: no more looks
  // one left waiting stops after its time, and a new one for the same account stops the one before
  const slow = watchSignIn({ key: "claude", by: "local", verify: async () => false, everyMs: 20, ms: 100 });
  await until(() => signInState(slow, "local")?.state !== "waiting");
  expect(signInState(slow, "local")).toEqual({ state: "failed", why: SIGNIN_TIMED_OUT });
  const first = watchSignIn({ key: "claude", by: "local", verify: async () => false });
  watchSignIn({ key: "claude", by: "local", verify: async () => false, ms: 50 });
  expect(signInState(first, "local")).toEqual({ state: "failed", why: SIGNIN_GONE });
});

test("GitHub's sign-in runs on pipes: its one-time code and page come back, and gh's own status says when it's done", async () => {
  // stand-in for `gh auth login --web` with no terminal (gh 2.86): the code and the page on stderr, then it waits for
  // GitHub, here a file; with a terminal it would ask about Git first, so this one exits 1 when stdin is one
  const gh = join(dir, "fake-gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      "[ -t 0 ] && exit 1",
      "printf '\\n! First copy your one-time code: 6445-CEDD\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2",
      'while [ ! -e "$OUT/approved" ]; do sleep 0.05; done',
      'touch "$OUT/ok"',
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const r = await startSignIn({
    key: "github",
    by: "local",
    argv: [gh],
    env: { OUT: dir },
    pipes: true,
    verify: async () => existsSync(ok),
  });
  if ("error" in r) throw new Error(r.error);
  expect([r.url, r.code]).toEqual(["https://github.com/login/device", "6445-CEDD"]);
  expect(signInState(r.id, "local")?.state).toBe("waiting");
  writeFileSync(join(dir, "approved"), ""); // you entered the code on GitHub
  await until(() => signInState(r.id, "local")?.state !== "waiting");
  expect(signInState(r.id, "local")).toEqual({ state: "done", why: "" });
});

test("OpenCode's key goes in by its prompt, ending on a carriage return, and only a key it takes counts", async () => {
  // stand-in for `opencode auth login -p <provider>`: reads one line ended by \r, keeps it, and exits 0 only on a key
  const oc = join(dir, "fake-opencode");
  writeFileSync(
    oc,
    [
      "#!/bin/sh",
      "IFS= read -r -d $(printf '\\r') k 2>/dev/null || k=$(cat)",
      '[ -n "$k" ] && [ "$k" != bad ] && printf %s "$k" > "$OUT/key" && exit 0',
      "exit 1",
    ].join("\n"),
  );
  chmodSync(oc, 0o755);
  expect(await opencodeKey(["/bin/bash", oc, "auth", "login", "-p", "groq"], { OUT: dir }, "gsk-test")).toBe(true);
  expect(Bun.file(join(dir, "key")).text()).resolves.toBe("gsk-test");
  expect(await opencodeKey(["/bin/bash", oc], { OUT: dir }, "bad")).toBe(false);
  expect(await opencodeKey([join(dir, "no-such-cli")], {}, "x")).toBe(false);
});
