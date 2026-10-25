import { expect, spyOn, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import { render, withDom } from "../render.test-util";

/** Health's sources that couldn't be read each come with their fix: GitHub's sign-in, else Connect (Settings, Integrations). */
withDom();

test("a source Health couldn't read has its fix beside it", async () => {
  const { HealthPane } = await import("./HealthPane");
  const el = await render((m) => (
    <HealthPane
      m={{
        ...m,
        s: {
          ...m.s,
          status: {
            ...m.s.status,
            sentry: "Connect Sentry in Settings to show production errors",
            errors: ["GitHub PRs: gh: not logged in"],
          },
        },
      }}
    />
  ));
  const rowOf = (text: string) => [...el.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent === text);
  expect(rowOf("Connect Sentry in Settings to show production errors")?.querySelector("button")?.textContent).toBe(w.connectButton);
  expect(rowOf("GitHub PRs: gh: not logged in")?.querySelector("button")?.textContent).toBe(w.setupGhSignIn);
});

/** Renders GitHub's fix with the daemon answering its sign-in with `answer`, and presses Sign in to GitHub. */
async function signInWith(answer: Response): Promise<HTMLElement> {
  const { act } = await import("react");
  const { GithubFix } = await import("../Connections");
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request) =>
        String(url).endsWith("/api/github/signin") ? Promise.resolve(answer) : new Promise<Response>(() => {}),
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const el = await render(() => <GithubFix />);
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === w.setupGhSignIn);
    await act(async () => button?.click());
    await act(() => Bun.sleep(10));
    return el;
  } finally {
    spy.mockRestore();
  }
}

// no terminal: the page shows GitHub's one-time code, and the one button opens GitHub's page for it
test("GitHub's sign-in shows its one-time code and an Open GitHub button", async () => {
  const started = { ok: true, id: "s1", url: "https://github.com/login/device", code: "6445-CEDD", asks: false };
  const el = await signInWith(Response.json(started));
  expect(el.querySelector("code")?.textContent).toBe("6445-CEDD");
  const open = [...el.querySelectorAll("a")].find((a) => a.textContent === w.signInOpenTool.replace("{tool}", "GitHub"));
  expect(open?.getAttribute("href")).toBe("https://github.com/login/device");
});

// it couldn't start on the daemon's machine: the command to run there shows, not a toast
test("GitHub's sign-in shows the command to run when it can't start", async () => {
  const command = "gh auth login --web --git-protocol https --hostname github.com";
  const el = await signInWith(Response.json({ error: "The sign-in stopped before it showed a link.", command }, { status: 502 }));
  expect(el.querySelector("code")?.textContent).toBe(command);
});
