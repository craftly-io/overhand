import { expect, test } from "bun:test";
import type { DashboardState, Lead } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { STATE_KEY } from "@/app/data";
import { MORNING } from "@/demo/moments";
import { nightAt } from "@/demo/night";
import { fmt } from "@/lib/format";
import { render, withDom } from "../render.test-util";

/**
 * The lead drawer as a conversation, on the sample morning: the online shop's lead has Sam's message and its reply; the
 * mobile app's lead has a question open. The box is always there: it messages a lead with nothing open and answers one
 * that asks, and says when the lead reads a message.
 */
withDom();

const button = (el: HTMLElement, name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === name);
const HEARS = [w.leadHearsNow, w.leadHearsAfterRun, w.leadHearsStarts];

async function drawer(leadKey: string, state: DashboardState = nightAt(MORNING)) {
  const { LeadDrawer } = await import("./LeadDrawer");
  return render((m) => <LeadDrawer m={m} leadKey={leadKey} />, false, true, [[STATE_KEY, state]]);
}

/** The sample morning with the shop lead changed. */
function shop(patch: Partial<Lead>): DashboardState {
  const s = nightAt(MORNING);
  return { ...s, godmode: s.godmode.map((g) => (g.key === "shop" ? { ...g, ...patch } : g)) };
}

test("with nothing open the conversation reads oldest first, and the box messages the lead and says when it reads that", async () => {
  const el = await drawer("shop");
  const entries = [...el.querySelectorAll(`ol[aria-label="${w.leadThread}"] > li`)].map((li) => li.textContent ?? "");
  expect(entries).toHaveLength(2);
  expect(entries[0]).toStartWith(w.threadYou);
  expect(entries[0]).toContain("Leave the payments module alone this week");
  expect(entries[1]).toContain(w.threadReply);
  expect(entries[1]).toContain("I won't touch the payments module this week.");
  expect(el.textContent).toContain(fmt(w.messageLead, { lead: "Keep checks green · Online shop" }));
  expect(el.textContent).toContain(w.leadHearsStarts);
  expect(el.textContent).toContain(w.messageLimits);
  expect(button(el, w.sendMessage)?.disabled).toBe(true);
  expect(button(el, w.sendAnswer)).toBeUndefined();
});

test("with a question open the same box answers it, and says nothing about when a message is read", async () => {
  const el = await drawer("mobile");
  expect(el.textContent).toContain(w.yourAnswer);
  expect(button(el, w.sendAnswer)).toBeDefined();
  for (const line of HEARS) expect(el.textContent).not.toContain(line);
});

test("a running lead's line says when it reads the message; a lead that's off says nothing; a reply stays plain text", async () => {
  expect((await drawer("shop", shop({ running: true, hears: "now" }))).textContent).toContain(w.leadHearsNow);
  expect((await drawer("shop", shop({ running: true, hears: "after-run" }))).textContent).toContain(w.leadHearsAfterRun);
  const off = await drawer("shop", shop({ supervised: false, running: false }));
  for (const line of HEARS) expect(off.textContent).not.toContain(line);
  const reply = "## Reply (2026-10-23 07:00)\n\nDone. See [this](https://evil.example) and https://evil.example/now";
  const el = await drawer("shop", shop({ inbox: { text: reply, at: Date.now(), open: false } }));
  const thread = el.querySelector(`ol[aria-label="${w.leadThread}"]`);
  expect(thread?.textContent).toContain("https://evil.example/now");
  expect(thread?.querySelectorAll("a, button")).toHaveLength(0);
});
