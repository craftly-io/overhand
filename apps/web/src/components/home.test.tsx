import { afterEach, beforeEach, expect, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import { useUi } from "@/app/ui";
import { render, withDom } from "./render.test-util";

/**
 * Now (issues 100 and 166): on a computer the field, with the sentence, Needs you, In progress and Today, and nothing
 * else; with the field off, the three blocks. No tabs for Work, Agents and Health, whose keys and links open their drawers.
 */
withDom();
beforeEach(() => {
  localStorage.clear();
  // a hidden tab: the whole App asks for nothing on return (fresh.ts), so this file leaves the shared ask gates as they were
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
});

test("on a computer Now is the field: the sentence, Needs you, In progress and Today, no tabs, no other pane", async () => {
  const { App } = await import("@/App");
  const body = await render(() => <App />);
  const main = body.querySelector("main");
  expect(main?.querySelector(".field-home canvas")).not.toBeNull();
  expect(main?.querySelector("#jump-now")).not.toBeNull();
  const panes = [...(main?.querySelectorAll("section.hud-pane") ?? [])].map((p) => p.getAttribute("data-id"));
  expect(panes.filter((id) => id !== "first-win")).toEqual(["needs", "in-progress"]);
  expect(main?.querySelector(`section[aria-label="${w.stripTitle}"] [role="slider"]`)).not.toBeNull();
  expect(main?.querySelector("[data-scene-window]")).toBeNull();
  expect(body.querySelector(`nav[aria-label="${w.places}"]`)).toBeNull();
  // the header keeps the Night report, Pause, the command bar and Settings
  const header = body.querySelector("header");
  for (const label of [w.quickSettings, w.askAnything, w.settings])
    expect(header?.querySelector(`button[aria-label="${label}"]`), label).not.toBeNull();
});

test("with the field off in Settings, Now is the plain lists under the sentence", async () => {
  localStorage.setItem("overhand-map", "off");
  const { App } = await import("@/App");
  const body = await render(() => <App />);
  const main = body.querySelector("main");
  expect(main?.querySelector(".field-home")).toBeNull();
  expect(main?.querySelector("#jump-now")?.textContent).toContain(w.briefMe);
  const panes = [...(main?.querySelectorAll("section.hud-pane") ?? [])].map((p) => p.getAttribute("data-id"));
  expect(panes.filter((id) => id !== "first-win")).toEqual(["needs", "in-progress"]);
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
