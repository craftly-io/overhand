import { expect, test } from "bun:test";
import { SettingsSchema } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import { demoGet } from "@/demo/fixtures";
import { ADVANCED, placeOf, SECTIONS } from "@/lib/settings-places";
import { render, withDom } from "../render.test-util";
import type { SettingsForm } from "./SettingsFields";

/**
 * Settings in five sections plus Advanced (issue 101): on the demo's four projects, about 25 controls show outside Advanced
 * and More, each control has one home, and every tab from before still opens where its controls went.
 */
withDom();

const settings = SettingsSchema.parse(demoGet("/api/settings"));
/** What a person can change: fields, switches and pickers. Buttons are actions, not settings. */
const CONTROLS = 'input:not([type="hidden"]), textarea, select, [role="switch"], [role="combobox"]';

async function open(tab: string): Promise<HTMLElement> {
  const { SettingsDrawer } = await import("./SettingsDrawer");
  return render(() => <SettingsDrawer tab={tab} />, false, true, [[["settings"], settings]]);
}

/** The controls a section shows before anything is unfolded: none inside a closed More, Team or Advanced group. */
const shown = (el: HTMLElement) =>
  [...el.querySelectorAll(CONTROLS)].filter((c) => c.getAttribute("aria-hidden") !== "true" && !c.closest("details:not([open])"));

test("about 25 controls show across the five sections with the demo's four projects", async () => {
  const counts: Record<string, number> = {};
  for (const [id] of SECTIONS) counts[id] = shown(await open(id)).length;
  // Projects: name, what agents may do, tracker and keep an agent on it, for each of 4; Safety: the sandbox, house
  // rules, Slack drafts only, private words, quiet hours and the budget; You: name, the Night report hour, Focus,
  // sound and tips; Agents and Connections: none until an account needs asking or a service its Connect
  expect(counts).toEqual({ projects: 16, agents: 0, connections: 0, safety: 6, you: 5 });
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(27);
});

test("each control has one home: the budget only in Safety, how far agents go only on each project", async () => {
  const labels = async (tab: string) => {
    const el = await open(tab);
    for (const d of el.querySelectorAll("details")) d.setAttribute("open", "");
    return [...el.querySelectorAll("label, legend")].map((l) => l.textContent ?? "");
  };
  const all: (readonly [string, string[]])[] = [];
  for (const id of [...SECTIONS.map(([k]) => k), "advanced"]) all.push([id, await labels(id)]);
  const homes = (label: string) => all.flatMap(([id, ls]) => ls.filter((l) => l === label).map(() => id));
  expect(homes(w.setBudget)).toEqual(["safety"]);
  expect(homes(w.autonomyLabel)).toEqual(["projects", "projects", "projects", "projects"]);
  expect(homes(w.sandboxSwitch)).toEqual(["safety"]);
  expect(homes(w.setBriefHour)).toEqual(["you"]);
});

test("Advanced is one link under the sections, and opens every group folded, a linked one open", async () => {
  const el = await open("projects");
  expect([...el.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(SECTIONS.map(([, k]) => w[k]));
  expect([...el.querySelectorAll("button")].some((b) => b.textContent === w.setAdvancedOpen)).toBe(true);
  const adv = await open("plugins");
  const groups = [...adv.querySelectorAll("details[id^=set-adv-]")];
  expect(groups.map((d) => d.id)).toEqual(ADVANCED.map(([id]) => `set-adv-${id}`));
  expect(groups.filter((d) => d.hasAttribute("open")).map((d) => d.id)).toEqual(["set-adv-plugins"]);
});

test("every tab from before the five sections opens where its controls went", () => {
  const was = [
    "projects",
    "accounts",
    "leads",
    "schedule",
    "rules",
    "integrations",
    "plugins",
    "phone",
    "team",
    "look",
    "health",
    "system",
    "json",
  ];
  expect(Object.fromEntries(was.map((t) => [t, placeOf(t)]))).toEqual({
    projects: { section: "projects", group: "" },
    accounts: { section: "agents", group: "" },
    leads: { section: "advanced", group: "project-agents" },
    schedule: { section: "advanced", group: "schedule" },
    rules: { section: "safety", group: "" },
    integrations: { section: "connections", group: "" },
    plugins: { section: "advanced", group: "plugins" },
    phone: { section: "connections", group: "" },
    team: { section: "you", group: "" },
    look: { section: "you", group: "" },
    health: { section: "advanced", group: "checks" },
    system: { section: "you", group: "" },
    json: { section: "advanced", group: "config" },
  });
  expect(placeOf()).toEqual({ section: "projects", group: "" });
  expect(placeOf("advanced")).toEqual({ section: "advanced", group: "" });
});

test("groups save like the rest of Settings: a move goes into the draft, and nothing is sent until Save", async () => {
  const { act } = await import("react");
  const { FormCtx } = await import("./SettingsFields");
  const { GroupsBoard } = await import("@/components/organise/GroupsBoard");
  const sets: [string, unknown][] = [];
  const form: Omit<SettingsForm, "set"> = {
    draft: {
      clients: [{ name: "Shop" }, { name: "Site", autonomy: "watch" }],
      groups: [{ name: "Acme", members: ["Shop"], rules: { autonomy: "propose" } }],
      godmode: [],
    },
    version: 0,
    folders: [],
    store: "",
    slackMcp: "",
    local: true,
    conflicts: new Set<string>(),
  };
  const fetched = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  const posts = () => fetched.mock.calls.filter(([, init]) => JSON.stringify(init ?? {}).includes("POST")).length;
  const before = posts();
  const el = await render(() => (
    <FormCtx value={{ ...form, set: (path, v) => void sets.push([path, v]) }}>
      <GroupsBoard />
    </FormCtx>
  ));
  // the chips say whose level is a project's own and whose is its group's
  expect(el.textContent).toContain(w.orgOwn.replace("{value}", w.autonomyWatchName));
  const site = el.querySelector<HTMLSelectElement>(`select[aria-label="${w.orgMoveTo.replace("{project}", "Site")}"]`);
  expect(site).not.toBeNull();
  await act(async () => {
    if (!site) return;
    site.value = "Acme";
    site.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(sets).toEqual([["groups", [{ name: "Acme", members: ["Shop", "Site"], rules: { autonomy: "propose" } }]]]);
  expect(posts()).toBe(before);
});
