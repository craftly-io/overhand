import { expect, test } from "bun:test";
import { drawerParam } from "./ui";

test("a ?drawer= link opens only the drawers the menu bar's popover may open, each with what it needs", () => {
  const p = (d: unknown) => drawerParam(JSON.stringify(d));
  expect(p({ kind: "alerts" })).toEqual({ kind: "alerts" });
  expect(p({ kind: "ticket", key: "EW-12" })).toEqual({ kind: "ticket", key: "EW-12" });
  expect(p({ kind: "settings", tab: "phone" })).toEqual({ kind: "settings", tab: "phone" });
  expect(p({ kind: "ticket" })).toBeNull(); // a ticket needs its key
  expect(p({ kind: "brief", text: "anything" })).toBeNull(); // the report is made here, never read from a link
  expect(drawerParam("not json")).toBeNull();
  expect(drawerParam(null)).toBeNull();
});
