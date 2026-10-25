import { expect, spyOn, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import { render, withDom } from "./render.test-util";

/** Claude Code's sign-in is Anthropic's own flow: the card shows its command to run yourself, and turns green by itself. */
withDom();

const COMMAND = "CLAUDE_CONFIG_DIR=/x/agent-home/accounts/claude claude auth login";

/** Renders an account's sign-in with the daemon answering the start with `started` and each look with `state`. */
async function signIn(started: unknown, state: string, onSignedIn = () => {}): Promise<HTMLElement> {
  const { act } = await import("react");
  const { SignIn } = await import("./SignIn");
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/api/accounts/login") && init?.method === "POST") return Promise.resolve(Response.json(started));
        if (u.includes("/api/accounts/login?id=")) return Promise.resolve(Response.json({ state, why: "" }));
        return new Promise<Response>(() => {});
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const el = await render(() => <SignIn account="claude" tool="Claude Code" tab={null} onSignedIn={onSignedIn} />);
    await act(() => Bun.sleep(20));
    return el;
  } finally {
    spy.mockRestore();
  }
}

test("on this computer the card shows the exact command with Copy, and takes no code", async () => {
  const el = await signIn({ ok: true, id: "w1", command: COMMAND, local: true }, "waiting");
  expect(el.querySelector("code")?.textContent).toBe(COMMAND);
  expect(el.textContent).toContain(w.signInYourTerminal);
  expect([...el.querySelectorAll("button")].some((b) => b.textContent === w.hostedCopy)).toBe(true);
  expect(el.querySelector("input")).toBeNull();
});

test("on a phone it says to finish on the computer", async () => {
  const el = await signIn({ ok: true, id: "w1", command: COMMAND, local: false }, "waiting");
  expect(el.textContent).toContain(w.signInOnComputer);
  expect(el.textContent).not.toContain(w.signInYourTerminal);
});

test("once Claude Code's own status says signed in, it turns green and the test call runs", async () => {
  let told = 0;
  const el = await signIn({ ok: true, id: "w1", command: COMMAND, local: true }, "done", () => told++);
  expect(el.textContent).toContain(w.signInDone);
  expect(told).toBe(1);
});
