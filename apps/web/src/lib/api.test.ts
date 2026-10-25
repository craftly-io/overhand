import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { get } from "./api";

afterEach(() => mock.restore());

test("a read a frozen Overhand never answers fails after its timeout, so the page can say it can't reach Overhand", async () => {
  // a daemon that's asleep or stuck: the request is accepted and never answered
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }));
  await expect(get("/api/state", z.object({}), 50)).rejects.toThrow("/api/state: no answer");
});

test("a read that's answered in time is validated as before", async () => {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response(JSON.stringify({ ok: true })), { preconnect: fetch.preconnect }),
  );
  expect(await get("/api/x", z.object({ ok: z.boolean() }), 1000)).toEqual({ ok: true });
});
