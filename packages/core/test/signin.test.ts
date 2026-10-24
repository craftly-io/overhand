import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asksForCode,
  opencodeKey,
  SIGNIN_GONE,
  SIGNIN_NO_LINK,
  SIGNIN_TIMED_OUT,
  SIGNIN_UNFINISHED,
  sendSignInCode,
  shownCode,
  signInState,
  signInUrl,
  startSignIn,
} from "../src/signin";

const dir = mkdtempSync(join(tmpdir(), "oh-signin-"));
const SECRET = "secret-token-printed-by-the-cli";

/** A fake agent CLI: prints a link (as an OSC 8 terminal link), asks for a code, and signs in only on "good". */
const fake = join(dir, "fake-login");
writeFileSync(
  fake,
  [
    "#!/bin/sh",
    `printf 'Opening browser\\nvisit: \\033]8;;https://example.test/auth?code=true&state=abc\\033\\\\link\\033]8;;\\033\\\\\\n'`,
    `printf '${SECRET}\\nPaste code here if prompted > '`,
    "read code",
    `[ "$code" = good ] && touch "$OUT/ok" && exit 0`,
    "exit 1",
  ].join("\n"),
);
chmodSync(fake, 0o755);
const ok = join(dir, "ok");

const until = async (f: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end && !f(); ) await Bun.sleep(25);
};
const start = (argv = [fake], more: { ms?: number; urlMs?: number } = {}) =>
  startSignIn({ key: "acct", by: "local", argv, env: { OUT: dir }, verify: async () => existsSync(ok), ...more });

afterEach(() => {
  if (existsSync(ok)) Bun.spawnSync(["rm", ok]);
});

test("the link, a code to enter and a prompt for one are read from what the CLI prints", () => {
  expect(signInUrl("visit: \u001b]8;;https://a.test/x?y=1\u001b\\link")).toBe("https://a.test/x?y=1");
  expect(shownCode("1. Open https://auth.test/device?s=ABCD-EFGH\n2. Enter this one-time code\n   AB12-CD345\n")).toBe("AB12-CD345");
  expect(shownCode("https://a.test/?state=ABCD-EFGH")).toBe("");
  expect(asksForCode("Paste code here if prompted > ")).toBe(true);
  expect(asksForCode("Waiting for browser authentication...")).toBe(false);
});

test("a CLI that prints a link and reads a code signs in through the app, and nothing it printed is logged", async () => {
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
    expect(r.asks).toBe(true);
    expect(r.code).toBe("");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(signInState(r.id, "a-phone")).toBeNull(); // only who started it
    expect(sendSignInCode(r.id, "a-phone", "good")).toEqual({ error: SIGNIN_GONE });
    expect(sendSignInCode(r.id, "local", "good")).toEqual({ ok: true });
    await until(() => signInState(r.id, "local")?.state !== "waiting");
    expect(signInState(r.id, "local")).toEqual({ state: "done", why: "" });
    expect(sendSignInCode(r.id, "local", "again")).toEqual({ error: SIGNIN_GONE });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(said.join("\n")).not.toContain(SECRET);
  expect(said.join("\n")).not.toContain("example.test");
});

test("a wrong code ends in one plain line, checked by the CLI's own status", async () => {
  const r = await start();
  if ("error" in r) throw new Error(r.error);
  sendSignInCode(r.id, "local", "wrong");
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
  sendSignInCode(b.id, "local", "good");
  await until(() => signInState(b.id, "local")?.state !== "waiting");
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
