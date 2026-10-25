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

// on a server or in a container no terminal window opens: the daemon answers with the command, and it shows, not a toast
test("GitHub's sign-in shows the command to run where no terminal opens", async () => {
  const { act } = await import("react");
  const { GithubFix } = await import("../Connections");
  const command = "gh auth login --hostname github.com";
  const refused = Response.json({ error: "No terminal window opens on this machine.", command }, { status: 500 });
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request) =>
        String(url).endsWith("/api/github/signin") ? Promise.resolve(refused) : new Promise<Response>(() => {}),
      {
        preconnect: fetch.preconnect,
      },
    ),
  );
  const el = await render(() => <GithubFix />);
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent === w.setupGhSignIn);
  await act(async () => button?.click());
  expect(el.querySelector("code")?.textContent).toBe(command);
});
