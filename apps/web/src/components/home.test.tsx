import { beforeEach, expect, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import { useUi } from "@/app/ui";
import { render, withDom } from "./render.test-util";

/**
 * Now in three blocks (issue 100): the sentence with the Night report, Needs you and In progress, and nothing else; no
 * tabs for Work, Agents and Health, whose keys and links open their drawers; the map only when it's switched on.
 */
withDom();
beforeEach(() => localStorage.clear());

test("Now is the sentence, Needs you and In progress: no map, no tabs, no other pane", async () => {
  const { App } = await import("@/App");
  const body = await render(() => <App />);
  const main = body.querySelector("main");
  expect(main?.querySelector("#jump-now")?.textContent).toContain(w.briefMe);
  const panes = [...(main?.querySelectorAll("section.hud-pane") ?? [])].map((p) => p.getAttribute("data-id"));
  expect(panes.filter((id) => id !== "first-win")).toEqual(["needs", "in-progress"]);
  expect(main?.querySelector("[data-scene-window]")).toBeNull();
  expect(body.querySelector(`nav[aria-label="${w.places}"]`)).toBeNull();
  // the header keeps the Night report, Pause, the command bar and Settings
  const header = body.querySelector("header");
  for (const label of [w.quickSettings, w.askAnything, w.settings])
    expect(header?.querySelector(`button[aria-label="${label}"]`), label).not.toBeNull();
});

test("the map is a look: switched on in Settings, it shows on Now", async () => {
  localStorage.setItem("overhand-map", "still");
  const { App } = await import("@/App");
  const body = await render(() => <App />);
  expect(body.querySelector("main [data-scene-window]")).not.toBeNull();
});

/** What drawer is open, as text, for the keys below. */
function Open() {
  return <output>{useUi().drawer?.kind ?? "none"}</output>;
}

test("W, A and H still open Work, Agents and Health, now as drawers", async () => {
  const { Palette } = await import("./Palette");
  const body = await render((m) => (
    <>
      <Palette m={m} />
      <Open />
    </>
  ));
  const { act } = await import("react");
  for (const [key, kind] of [
    ["w", "work"],
    ["a", "crew"],
    ["h", "health"],
  ] as const) {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect(body.querySelector("output")?.textContent).toBe(kind);
  }
});
