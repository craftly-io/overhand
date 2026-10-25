import { expect, spyOn, test } from "bun:test";
import { ANTHROPIC_TERMS } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { render, withDom } from "./render.test-util";

/** Add an agent account says whose accounts belong there, and on Claude Code what a plan's limits are for. */
withDom();

const CLAUDE = {
  id: "claude-code",
  label: "Claude Code",
  installed: true,
  signedIn: false,
  suggested: "claude",
  login: true,
  ownFolder: true,
  key: true,
  shared: "",
};

test("only your own accounts, and on Claude Code Anthropic's own words with its terms", async () => {
  const { act } = await import("react");
  const { AddAccount } = await import("./AddAccount");
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request) =>
        String(url).endsWith("/api/accounts/options")
          ? Promise.resolve(Response.json({ agents: [CLAUDE] }))
          : new Promise<Response>(() => {}),
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const el = await render(() => <AddAccount />);
    await act(() => Bun.sleep(20));
    expect(el.textContent).toContain(w.addAccountYours);
    expect(el.textContent).not.toContain(w.planUseNote);
    const pick = [...el.querySelectorAll("button")].find((b) => b.textContent === "Claude Code");
    await act(async () => pick?.click());
    expect(el.textContent).toContain(w.planUseNote);
    const terms = [...el.querySelectorAll("a")].find((a) => a.textContent === w.planUseTerms);
    expect(terms?.getAttribute("href")).toBe(ANTHROPIC_TERMS);
  } finally {
    spy.mockRestore();
  }
});
