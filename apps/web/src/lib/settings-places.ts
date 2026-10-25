import type { WordKey } from "@overhand/themes";

/** Settings' five sections, in order, each by its id and the word that names it. */
export const SECTIONS = [
  ["projects", "setProjects"],
  ["agents", "setAgents"],
  ["connections", "setConnections"],
  ["safety", "safetyTitle"],
  ["you", "setYou"],
] as const satisfies readonly (readonly [string, WordKey])[];
export type Section = (typeof SECTIONS)[number][0];

/** Advanced's groups, in order: everything Settings keeps that the five sections don't show. */
export const ADVANCED = [
  ["schedule", "setAdvSchedule"],
  ["labels", "setAdvLabels"],
  ["groups", "setAdvGroups"],
  ["project-agents", "setAdvAgents"],
  ["routing", "setAdvRouting"],
  ["approvals", "setAdvApprovals"],
  ["protect", "setAdvProtect"],
  ["updates", "setAdvUpdates"],
  ["plugins", "setAdvPlugins"],
  ["sandbox", "setAdvSandbox"],
  ["outward", "setAdvOutward"],
  ["addresses", "setAdvAddresses"],
  ["mcp", "setAdvMcp"],
  ["checks", "setAdvChecks"],
  ["cleanup", "setAdvCleanup"],
  ["config", "setAdvConfig"],
] as const satisfies readonly (readonly [string, WordKey])[];
export type AdvancedGroup = (typeof ADVANCED)[number][0];

/** Where the thirteen tabs from before the five sections (issue 101) went: old links, the daemon's messages, `?settings=phone`. */
const MOVED: Readonly<Record<string, string>> = {
  accounts: "agents",
  leads: "project-agents",
  rules: "safety",
  integrations: "connections",
  phone: "connections",
  team: "you",
  look: "you",
  system: "you",
  health: "checks",
  json: "config",
};

/** What a Settings `tab` opens: one of the sections, or Advanced with one group open. None or an unknown one: Projects. */
export function placeOf(tab = ""): { section: Section | "advanced"; group: AdvancedGroup | "" } {
  const t = MOVED[tab] ?? tab;
  const section = SECTIONS.find(([k]) => k === t)?.[0];
  if (section) return { section, group: "" };
  const group = ADVANCED.find(([k]) => k === t)?.[0];
  if (group) return { section: "advanced", group };
  return { section: t === "advanced" ? "advanced" : "projects", group: "" };
}
