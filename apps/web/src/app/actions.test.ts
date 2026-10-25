import { expect, test } from "bun:test";
import { plainWords } from "@overhand/themes";
import { placeOf } from "@/lib/settings-places";
import { settingsPlace } from "./actions";

test("an error that names where its fix is in Settings opens it there; one that names none has no button", () => {
  expect(settingsPlace(plainWords.pairExpired)).toBe("connections");
  expect(settingsPlace("Name your ntfy topic's secret first (Settings → Advanced).")).toBe("advanced");
  expect(settingsPlace("app is running: change it in Settings → Projects to confirm")).toBe("projects");
  expect(settingsPlace("that agent isn't switched on: turn it on in Settings → Project agents")).toBe("project-agents");
  expect(settingsPlace("Linear sign-in expired: connect it again in Settings")).toBe("");
  expect(settingsPlace("git pull failed: conflict")).toBeNull();
});

test("a message from before the five sections still opens where its tab went", () => {
  expect(placeOf(settingsPlace("Settings, Integrations") ?? "")).toEqual({ section: "connections", group: "" });
  expect(placeOf(settingsPlace("Settings, Leads") ?? "")).toEqual({ section: "advanced", group: "project-agents" });
  expect(placeOf(settingsPlace("Settings → Agent accounts") ?? "")).toEqual({ section: "agents", group: "" });
});
