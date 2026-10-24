import { expect, test } from "bun:test";
import { openLink } from "../src/devices";
import { menubarHelper, openTarget } from "../src/menubar";
import { handle } from "../src/server";

const LOCAL = "http://127.0.0.1:4317";

test("the menu bar item is a Mac's alone, and only where its helper is built or shipped", () => {
  expect(menubarHelper("linux")).toBe("");
  expect(menubarHelper("darwin", "/nowhere", true)).toBe("");
  expect(menubarHelper("darwin", "/nowhere", false)).toBe("");
});

test("the helper's open keeps only a drawer and the Night report, and refuses a line that isn't a query", () => {
  expect(openTarget('?drawer={"kind":"alerts"}&evil=1', LOCAL)).toBe(`${LOCAL}/?drawer=%7B%22kind%22%3A%22alerts%22%7D`);
  expect(openTarget("?run=brief", LOCAL)).toBe(`${LOCAL}/?run=brief`);
  expect(openTarget("?", LOCAL)).toBe(`${LOCAL}/`);
  expect(openTarget("https://example.com/?drawer=x", LOCAL)).toBeNull();
});

test("an open link to a page with a query lands on that page with its query, the spent link gone", async () => {
  const link = openLink(`${LOCAL}/glance.html`);
  expect(new URL(link).pathname).toBe("/glance.html");
  const r = await handle(new Request(link));
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/glance.html");
  // a link's code is its time's: one made in the same millisecond would be the spent one
  const deep = await handle(new Request(openLink(`${LOCAL}/?run=brief`, Date.now() - 1000)));
  expect(deep.headers.get("location")).toBe("/?run=brief");
});
