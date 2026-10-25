import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Frame, newKeyPair, parseFrame, signingKey, signToken, unb64url } from "@overhand/contract";
import { newPairing, redeem } from "../src/devices";
import { OPS, UI_PORT } from "../src/env";
import { channelServer, finishLink, hostedActive, linkUrl, refreshEntitlement, relayOrigins, shouldConnect, unlink } from "../src/relay";
import { handle } from "../src/server";
import { addSubscription, encryptPush, vapidAuth, vapidPublicKey } from "../src/webpush";
import { localRequest } from "./local";

const APP = "http://localhost:8787";
const relayKeys = await newKeyPair();
const LOCAL = `http://127.0.0.1:${UI_PORT}`;
const files = [".relay.json", ".devices.json", ".push.json", ".request-plan"];

beforeAll(() => {
  process.env.OVERHAND_RELAY_URL = APP;
  process.env.OVERHAND_RELAY_KEY = relayKeys.pub;
  for (const f of files) rmSync(join(OPS, f), { force: true });
});
afterAll(() => {
  for (const f of files) rmSync(join(OPS, f), { force: true });
  delete process.env.OVERHAND_RELAY_URL;
  delete process.env.OVERHAND_RELAY_KEY;
});

/** Runs one request through a channel server wired to the real handler, decoding the frames back into a response. */
async function overChannel(method: string, path: string, headers: Record<string, string> = {}, body?: object) {
  const frames: Frame[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const ch = channelServer(
    handle,
    (raw) => {
      const f = parseFrame(raw);
      if (f) frames.push(f);
      if (f?.t === "end") done();
    },
    APP,
  );
  ch.onMessage(JSON.stringify({ t: "req", id: 1, method, path, headers }));
  if (body) ch.onMessage(JSON.stringify({ t: "body", id: 1, d: Buffer.from(JSON.stringify(body)).toString("base64url") }));
  ch.onMessage(JSON.stringify({ t: "end", id: 1 }));
  await finished;
  const head = frames.find((f) => f.t === "res");
  const bytes = frames.flatMap((f) => (f.t === "body" ? [f.z ? Bun.gunzipSync(unb64url(f.d)) : unb64url(f.d)] : []));
  const text = Buffer.concat(bytes).toString("utf8");
  return {
    status: head?.t === "res" ? head.status : 0,
    headers: head?.t === "res" ? head.headers : {},
    text,
    zipped: frames.some((f) => f.t === "body" && f.z),
  };
}

describe("the data channel runs the server's own handler, with the same auth", () => {
  beforeAll(() => {
    // Access from anywhere on and linked, so the hosted origin is one the server accepts
    writeFileSync(join(OPS, ".relay.json"), JSON.stringify({ enabled: true, priv: "", pub: "", cert: "test-cert", email: "e", ent: "" }));
  });

  test("an unpaired browser gets 401, even claiming to be local", async () => {
    expect(relayOrigins()).toEqual([APP]);
    const r = await overChannel("GET", "/api/devices", { host: `127.0.0.1:${UI_PORT}`, origin: LOCAL, "x-forwarded-for": "" });
    expect(r.status).toBe(401);
  });

  test("a paired device's session works, POSTs pass the Origin check, gzipped JSON comes back", async () => {
    const { code } = newPairing();
    const paired = redeem(code, "Mozilla/5.0 (iPhone)");
    if ("error" in paired) throw new Error(paired.error);
    const cookie = `other=1; overhand_session=${paired.token}`;
    const list = await overChannel("GET", "/api/devices", { cookie });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text)).toMatchObject({ local: false });
    const act = await overChannel("POST", "/api/request/plan", { cookie, "content-type": "application/json" }, {});
    expect(act.status).toBe(200);
    expect(existsSync(join(OPS, ".request-plan"))).toBe(true);
    // a remote peer is never local: the computer-only routes refuse it
    expect((await overChannel("POST", "/api/devices/pair", { cookie, "content-type": "application/json" }, {})).status).toBe(403);
    expect((await overChannel("POST", "/api/relay/link", { cookie, "content-type": "application/json" }, {})).status).toBe(403);
    const big = await overChannel("GET", "/api/relay", { cookie });
    expect(big.status).toBe(200);
  });

  test("only API paths are served over the channel", async () => {
    expect((await overChannel("GET", "/index.html")).status).toBe(404);
  });

  test("the pairing route over the channel hands back the session cookie for the browser to keep", async () => {
    const { code } = newPairing();
    const r = await overChannel("POST", "/api/pair", { "content-type": "application/json", "user-agent": "x" }, { code });
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]).toContain("overhand_session=");
  });
});

describe("gating: payment gates hosted features only", () => {
  test("no entitlement: no relay connection, no hosted push, every local route still works", async () => {
    writeFileSync(join(OPS, ".relay.json"), JSON.stringify({ enabled: true, cert: "c", ent: "" }));
    expect(hostedActive()).toBe(false);
    expect(shouldConnect()).toBe(false);
    const local = (path: string, body?: object) =>
      handle(
        localRequest(`${LOCAL}${path}`, {
          method: body ? "POST" : "GET",
          headers: body ? { origin: LOCAL, "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
    expect((await local("/api/devices")).status).toBe(200);
    expect((await local("/api/request/plan", {})).status).toBe(200);
    expect((await local("/api/push/test", {})).status).toBe(402);
  });

  test("an unreachable relay never throws and keeps the last token (the offline grace)", async () => {
    process.env.OVERHAND_RELAY_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    writeFileSync(
      join(OPS, ".relay.json"),
      JSON.stringify({ enabled: true, cert: "c", ent: "kept-token", priv: (await newKeyPair()).priv }),
    );
    await refreshEntitlement();
    expect(await Bun.file(join(OPS, ".relay.json")).json()).toMatchObject({ ent: "kept-token" });
    expect((await handle(localRequest(`${LOCAL}/api/devices`))).status).toBe(200);
    process.env.OVERHAND_RELAY_URL = APP;
  });

  test("each refresh keeps the relay's renewed certificate when it's for this key, and never signs one timestamp twice", async () => {
    const dk = await newKeyPair();
    const k = await signingKey(relayKeys.priv);
    const link = (pub: string, iat: number) => signToken(k, { typ: "link", ws: "w", email: "e", pub, name: "Mac", iat, exp: iat + 1 });
    const answers = [await link(dk.pub, 1), await link((await newKeyPair()).pub, 2)];
    const ts: string[] = [];
    const stand = Bun.serve({
      port: 0,
      fetch(req) {
        ts.push(req.headers.get("x-overhand-ts") ?? "");
        return Response.json({ error: "no paid plan", cert: answers[ts.length - 1] }, { status: 402 });
      },
    });
    process.env.OVERHAND_RELAY_URL = `http://127.0.0.1:${stand.port}`;
    try {
      writeFileSync(join(OPS, ".relay.json"), JSON.stringify({ enabled: false, cert: "old", ent: "", ...dk }));
      await Promise.all([refreshEntitlement(), refreshEntitlement()]);
      expect(new Set(ts).size).toBe(2);
      // one answer renewed this key's certificate, the other was for a key that isn't this one and was ignored
      expect(((await Bun.file(join(OPS, ".relay.json")).json()) as { cert: string }).cert).toBe(answers[0] ?? "");
    } finally {
      stand.stop(true);
      process.env.OVERHAND_RELAY_URL = APP;
    }
  });
});

describe("linking", () => {
  test("only a certificate for this daemon's key, with a nonce it made, once", async () => {
    rmSync(join(OPS, ".relay.json"), { force: true });
    const url = new URL(await linkUrl(UI_PORT));
    const pub = url.searchParams.get("pub") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    const k = await signingKey(relayKeys.priv);
    const forOther = await signToken(k, { typ: "link", ws: "w", email: "e", pub: (await newKeyPair()).pub, name: "x", iat: 0 });
    expect(await finishLink(nonce, forOther)).toMatchObject({ error: expect.any(String) });
    // the nonce was spent by that attempt
    const good = await signToken(k, { typ: "link", ws: "w", email: "me@x", pub, name: "Mac", iat: 0 });
    expect(await finishLink(nonce, good)).toMatchObject({ error: expect.stringContaining("expired") });
    const again = new URL(await linkUrl(UI_PORT)).searchParams.get("nonce") ?? "";
    const rogue = await signToken(await signingKey((await newKeyPair()).priv), {
      typ: "link",
      ws: "w",
      email: "e",
      pub,
      name: "x",
      iat: 0,
    });
    expect(await finishLink(again, rogue)).toMatchObject({ error: expect.any(String) });
    const third = new URL(await linkUrl(UI_PORT)).searchParams.get("nonce") ?? "";
    expect(await finishLink(third, good)).toEqual({ ok: true });
    expect(await Bun.file(join(OPS, ".relay.json")).json()).toMatchObject({ email: "me@x", enabled: true });
  });

  test("unlinking revokes the key at the relay, signed, then forgets the link and the key", async () => {
    const seen: { path: string; cert: string; sig: string }[] = [];
    const stand = Bun.serve({
      port: 0,
      fetch(req) {
        const h = req.headers;
        seen.push({ path: new URL(req.url).pathname, cert: h.get("x-overhand-cert") ?? "", sig: h.get("x-overhand-sig") ?? "" });
        return Response.json({ ok: true });
      },
    });
    process.env.OVERHAND_RELAY_URL = `http://127.0.0.1:${stand.port}`;
    try {
      const before = (await Bun.file(join(OPS, ".relay.json")).json()) as { pub: string; cert: string };
      expect(before.cert).not.toBe("");
      await unlink();
      expect(seen.find((s) => s.path === "/relay/unlink")).toMatchObject({ cert: before.cert, sig: expect.stringMatching(/.{40,}/) });
      expect(await Bun.file(join(OPS, ".relay.json")).json()).toMatchObject({ cert: "", priv: "", pub: "", enabled: false });
      // linking again makes a new key, so the revoked one never comes back
      expect(new URL(await linkUrl(UI_PORT)).searchParams.get("pub")).not.toBe(before.pub);
    } finally {
      stand.stop(true);
      process.env.OVERHAND_RELAY_URL = APP;
    }
  });
});

describe("web push", () => {
  const b = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

  test("RFC 8291 Appendix A: the exact encrypted body", () => {
    const body = encryptPush(
      b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      b("BTBZMqHH6r4Tts7J_aSIgg"),
      { salt: b("DGv6ra1nlYgDCS1FRnbzlw"), senderPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    );
    expect(Buffer.from(body).toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  test("a fresh message decrypts with the browser's keys", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = new Uint8Array(16).fill(7);
    const body = encryptPush(new TextEncoder().encode("hello"), new Uint8Array(ua.getPublicKey()), auth);
    const salt = body.slice(0, 16);
    const asPub = body.slice(21, 86);
    const secret = ua.computeSecret(asPub);
    const h = (k: Uint8Array | Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
    const ikm = h(h(auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub, Buffer.from([1])]));
    const prk = h(salt, ikm);
    const cek = h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const ct = body.slice(86);
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(ct.slice(-16));
    expect(Buffer.concat([d.update(ct.slice(0, -16)), d.final()]).toString()).toBe("hello\u0002");
  });

  test("VAPID: a 65-byte public key and an ES256 token for the push service's origin", () => {
    expect(unb64url(vapidPublicKey()).length).toBe(65);
    const h = vapidAuth("https://push.example.net/send/abc");
    const jwt = /^vapid t=([^,]+), k=(.+)$/.exec(h)?.[1] ?? "";
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(addSubscription({ endpoint: "http://insecure", keys: { p256dh: "x", auth: "y" } })).toBe(false);
  });
});
