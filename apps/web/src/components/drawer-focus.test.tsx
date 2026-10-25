import { expect, test } from "bun:test";
import { withDom } from "./render.test-util";

/** Closing a drawer hands keyboard focus back to the control it opened from, never to the page. */
withDom();

const button = (inside: HTMLElement = document.body) => {
  const b = document.createElement("button");
  inside.append(b);
  return b;
};

test("closing a drawer puts focus back on the button that opened it, even after one drawer opened another", async () => {
  const { noteOpener, returnFocus } = await import("@/app/ui");
  document.body.replaceChildren();
  const settings = button();
  settings.focus();
  noteOpener();
  // inside the open drawer, a link to another drawer: the first opener still stands
  const sheet = document.createElement("div");
  sheet.dataset.slot = "sheet-content";
  document.body.append(sheet);
  button(sheet).focus();
  noteOpener();
  sheet.remove();
  expect(returnFocus()).toBe(true);
  expect(document.activeElement).toBe(settings);
  // spent: the next close has nothing to return to
  expect(returnFocus()).toBe(false);
});

test("an opener that left the page (the command bar's input) leaves focus to the drawer's own default", async () => {
  const { noteOpener, returnFocus } = await import("@/app/ui");
  document.body.replaceChildren();
  const input = button();
  input.focus();
  noteOpener();
  input.remove();
  expect(returnFocus()).toBe(false);
});
