import { expect, test } from "bun:test";
import { settingsPlace } from "./actions";

test("an error that names where its fix is in Settings opens it there; one that names none has no button", () => {
  expect(settingsPlace("That code has expired. Make a new one on the Mac: Settings, Phone, Add a device.")).toBe("phone");
  expect(settingsPlace("Name your ntfy topic's secret first (Settings, Integrations).")).toBe("integrations");
  expect(settingsPlace("app is running: change it in Settings → Projects to confirm")).toBe("projects");
  expect(settingsPlace("that lead isn't switched on: turn it on in Settings, Leads")).toBe("leads");
  expect(settingsPlace("Linear sign-in expired: connect it again in Settings")).toBe("");
  expect(settingsPlace("git pull failed: conflict")).toBeNull();
});
