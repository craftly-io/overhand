/**
 * The demo's organising: Sam's three client projects in one group (Company website keeps drafts of its own), Mobile app on its own,
 * and two suggestions as decision cards.
 */
import type { Brief, GroupView, Organise } from "@overhand/contract";

const member = (name: string, dir: string, own: GroupView["members"][number]["own"] = {}): GroupView["members"][number] => ({
  name,
  dir,
  own,
  effective: {
    autonomy: own.autonomy ?? "act",
    assignedAutonomy: "act",
    accounts: ["Sam"],
    fallbackToAll: true,
  },
});

/** `GET /api/organise` in the demo. */
const DEMO_ORGANISE: Organise = {
  groups: [
    {
      name: "Clients",
      members: [
        member("Online shop", "shop"),
        member("Booking app", "booking"),
        member("Company website", "website", { autonomy: "propose" }),
      ],
      rules: { autonomy: "act", accounts: ["Sam"], private: ["Orchard Lane"], windows: [{ from: "09:00", to: "11:00", kinds: [] }] },
      lead: "repo",
      advice: { scope: "repo", reason: "2 busy projects: each gets its own agent so none waits on another", confidence: "medium" },
      leads: [
        { key: "shop", label: "Online shop agent", project: "Online shop", running: true },
        { key: "booking", label: "Booking app agent", project: "Booking app", running: false },
      ],
    },
  ],
  loose: [member("Mobile app", "mobile")],
  proposal: [
    {
      name: "Clients",
      members: ["Online shop", "Booking app", "Company website"],
      reason: "All 3 share the clients Slack workspace",
      confidence: 0.8,
      signals: [{ kind: "slack", value: "clients" }],
    },
    {
      name: "Sam",
      members: ["Mobile app"],
      reason: "Shares no org, tracker, chat or folder with anything else: it stands alone",
      confidence: 0.6,
      signals: [{ kind: "owner", value: "sam" }],
    },
  ],
};

const card = (id: string, b: Omit<Brief, "id" | "kind" | "source" | "hash" | "at" | "pending">): Brief => ({
  id: `organise:${id}`,
  kind: "organise",
  source: "facts",
  hash: "demo",
  at: Date.parse("2026-10-20T08:00:00Z"),
  pending: false,
  ...b,
});

const DEMO_SUGGESTIONS: Brief[] = [
  card("dedupe-clones:github.com/example/booking", {
    project: "github.com/example/booking",
    what: "2 full clones of github.com/example/booking",
    why: "Each full clone keeps its own history and dependencies; worktrees of one clone share them",
    recommend: { option: "apply", reason: "The extra clones are clean and fully pushed, and nothing works in them", confidence: "medium" },
    evidence: [
      { text: "keep ~/Code/example/booking", url: "" },
      { text: "~/Projects/booking → a worktree of ~/Code/example/booking (the old folder kept for undo)", url: "" },
    ],
    options: [
      {
        id: "apply",
        do: "organise",
        suggestion: "dedupe-clones:github.com/example/booking",
        action: "apply",
        label: "Keep one, make the rest worktrees",
      },
      { id: "dismiss", do: "organise", suggestion: "dedupe-clones:github.com/example/booking", action: "dismiss", label: "Leave it" },
    ],
    ifNothing: { text: "Nothing changes; the clones keep their disk", at: 0 },
  }),
  card("ungrouped:Mobile app", {
    project: "Mobile app",
    what: "Mobile app isn't in a group",
    why: "It follows only its own rules; nothing ties it to your other projects",
    recommend: { option: "dismiss", reason: "Nothing it shares points at a group: leaving it on its own is fine", confidence: "medium" },
    evidence: [{ text: "Mobile app → Mobile app (keeps its own rules where they differ)", url: "" }],
    options: [
      { id: "apply", do: "organise", suggestion: "ungrouped:Mobile app", action: "apply", label: "Make a group of its own" },
      { id: "dismiss", do: "organise", suggestion: "ungrouped:Mobile app", action: "dismiss", label: "Leave it" },
    ],
    ifNothing: { text: "It keeps its own rules", at: 0 },
  }),
];

/** The demo's answer for an organise route or an organise decision card; undefined for anything else. */
export function demoOrganise(path: string, id = ""): unknown {
  if (path === "/api/organise") return DEMO_ORGANISE;
  if (path === "/api/organise/suggestions") return { suggestions: DEMO_SUGGESTIONS };
  if (path === "/api/organise/undo") return { logs: [] };
  if (path === "/api/brief" && id.startsWith("organise:")) return DEMO_SUGGESTIONS.find((b) => b.id === id);
  return undefined;
}
