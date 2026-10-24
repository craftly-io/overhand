import { expect, test } from "bun:test";
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
