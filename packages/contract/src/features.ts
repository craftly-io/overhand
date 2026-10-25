/**
 * The feature registry: every built feature worth telling people about, written once. The home page's "Also in
 * Overhand" (site/build.ts `{{also}}`), the docs' Everything Overhand does (`{{everything}}`), the app's What's new and
 * its tips about new features all read this list, so a
 * feature is announced in the same words everywhere, and only once it's built. What isn't built has one place: the docs'
 * What's next page (site/pages/docs/next.html), never here.
 */
import { GUARD_BLOCKS_CLAIM, QUIET_CLAIM } from "./guard";

/** Which part of the product a feature belongs to, for listing features by area. */
export type FeatureArea = "agents" | "machine" | "team" | "reports" | "safety" | "overhand";

/** The areas, in the order the docs' Everything Overhand does lists them, with their headings. */
export const AREAS: Record<FeatureArea, string> = {
  agents: "Your agents",
  safety: "Safety",
  machine: "Your machine",
  reports: "Your reports",
  team: "Your team",
  overhand: "Overhand itself",
};

/** One built feature. */
export interface Feature {
  id: string;
  /** Its plain name, the label on the home page and in What's new. */
  name: string;
  /** What it does for you, in one line of plain words, true as stated. */
  line: string;
  area: FeatureArea;
  /** The day it shipped (YYYY-MM-DD), from the merge that built it. */
  since: string;
  /** The file that implements it, so each entry can be checked against the code. */
  source: string;
  /** One of the few the home page's "Also in Overhand" names; every feature is on the docs' Everything Overhand does. */
  home?: true;
  /** Where the site explains it: a page under site/pages and an anchor on it ("docs/cleanup.html#quiet"). */
  docs: `${string}.html#${string}`;
  /** A quiet line in the app, beside the control `where` names (a FeatureTip's `at`), while the feature is new. */
  tip?: { text: string; where: string };
}

/** The day of the public beta: a browser with no record of what it's seen counts everything from then as seen. */
export const FEATURES_FROM = "2026-10-22";

/** Every built feature people should hear about, grouped by area; within a day, in the order to tell them. */
export const FEATURES: readonly Feature[] = [
  {
    id: "everyone",
    name: "Everyone's agents",
    line: "On every machine, side by side.",
    area: "team",
    since: "2026-10-22",
    source: "apps/web/src/components/team/TeamView.tsx",
    docs: "docs/teams.html#together",
  },
  {
    id: "owners",
    name: "Questions to owners",
    line: "Each one goes to whoever owns its project.",
    area: "team",
    since: "2026-10-22",
    source: "packages/contract/src/team.ts",
    docs: "docs/teams.html#questions",
  },
  {
    id: "status-not-code",
    name: "Status, not code",
    line: "The team never shares code or keys.",
    area: "team",
    since: "2026-10-22",
    source: "packages/contract/src/team.ts",
    docs: "under-the-hood.html#relay",
  },
  {
    id: "chat-updates",
    name: "Chat updates",
    line: "To Discord, Slack or Teams, only where you set them up.",
    area: "team",
    since: "2026-10-22",
    source: "apps/web/src/components/drawers/SettingsUpdates.tsx",
    docs: "docs/everyday.html#updates",
  },
  {
    id: "quiet",
    name: "Quiet mode",
    line: QUIET_CLAIM,
    area: "machine",
    since: "2026-10-22",
    source: "packages/core/src/governor.ts",
    home: true,
    docs: "docs/cleanup.html#quiet",
  },
  {
    id: "cleanup",
    name: "Cleanup",
    line: "Frees disk space: only what you tick, or what's safe to go on a schedule you turn on.",
    area: "machine",
    since: "2026-10-22",
    source: "packages/core/src/cleanup.ts",
    docs: "docs/cleanup.html#cleanup",
  },
  {
    id: "phone",
    name: "From your phone",
    line: "Over your own Tailscale, free; from anywhere with Pro.",
    area: "machine",
    since: "2026-10-22",
    source: "apps/web/src/components/Phone.tsx",
    home: true,
    docs: "docs/anywhere.html#tailscale",
  },
  {
    id: "server",
    name: "On a server",
    line: "A Linux server or Docker, reached over SSH or Tailscale.",
    area: "machine",
    since: "2026-10-23",
    source: "Dockerfile",
    docs: "docs/server.html#linux",
  },
  {
    id: "cleanup-tools",
    name: "Cleanup for agent tools",
    line: "Also finds old local models, agent history and forgotten agent worktrees.",
    area: "machine",
    since: "2026-10-23",
    source: "packages/core/src/cleanup-sources.ts",
    docs: "docs/cleanup.html#cleanup",
    tip: { text: "Now also finds old local models, agent history and forgotten worktrees.", where: "menu-sweep" },
  },
  {
    id: "sentence",
    name: "Start from a sentence",
    line: "It plans before it builds.",
    area: "agents",
    since: "2026-10-22",
    source: "apps/web/src/components/Palette.tsx",
    home: true,
    docs: "for/makers.html#hook",
  },
  {
    id: "checkup",
    name: "A check-up first",
    line: "A read-only look at each project you add.",
    area: "agents",
    since: "2026-10-22",
    source: "apps/web/src/components/Checkup.tsx",
    docs: "for/makers.html#p2",
  },
  {
    id: "preview",
    name: "Review on the preview",
    line: "Point at the page, not the diff.",
    area: "agents",
    since: "2026-10-22",
    source: "apps/web/src/components/drawers/PreviewReview.tsx",
    home: true,
    docs: "for/makers.html#p1",
  },
  {
    id: "upkeep-leads",
    name: "Upkeep leads",
    line: "Ready-made leads for current dependencies, untested code and TODO notes.",
    area: "agents",
    since: "2026-10-23",
    source: "packages/contract/src/leads.ts",
    docs: "docs/leads.html#ready",
    tip: { text: "New ready-made leads: dependencies, untested code and TODOs.", where: "lead-suggested" },
  },
  {
    id: "first-win",
    name: "Your first win",
    line: "Right after setup, one small, safe task as a draft pull request, its steps ticking over while it runs.",
    area: "agents",
    since: "2026-10-22",
    source: "apps/web/src/components/now/FirstWin.tsx",
    docs: "docs/first-project.html#win",
  },
  {
    id: "connect",
    name: "Your own sessions",
    line: "Claude Code sessions you start yourself can join and follow the house rules.",
    area: "agents",
    since: "2026-10-22",
    source: "packages/core/src/daemon.ts",
    docs: "docs/cli.html#commands",
  },
  {
    id: "brief",
    name: "Night report",
    line: "Each morning, what happened overnight: on your computer, and on your phone through ntfy.",
    area: "reports",
    since: "2026-10-22",
    source: "packages/core/src/brief.ts",
    docs: "docs/everyday.html#night-report",
  },
  {
    id: "reports",
    name: "Work reports",
    line: "Per project, for any dates, weekly if you like.",
    area: "reports",
    since: "2026-10-22",
    source: "apps/web/src/components/health/Reports.tsx",
    docs: "for/studios.html#p3",
  },
  {
    id: "share",
    name: "Share cards",
    line: "A picture of the night, the day or the week, ready to post.",
    area: "reports",
    since: "2026-10-22",
    source: "apps/web/src/components/share/ShareDrawer.tsx",
    docs: "docs/everyday.html#share",
  },
  {
    id: "focus",
    name: "Focus",
    line: "Outcomes only, across every agent; the steps fold away until you open them.",
    area: "reports",
    since: "2026-10-23",
    source: "apps/web/src/app/focus.ts",
    docs: "docs/everyday.html#focus",
    tip: { text: "New: Focus keeps outcomes only. Press F any time.", where: "quick-focus" },
  },
  {
    id: "brief-stop",
    name: "Stop the night report",
    line: "While the night report reads aloud, its button turns into Stop; Esc stops it too.",
    area: "reports",
    since: "2026-10-23",
    source: "apps/web/src/lib/voice.ts",
    docs: "docs/everyday.html#night-report",
    tip: { text: "New: Stop or Esc ends the night report mid-sentence.", where: "menu-brief" },
  },
  {
    id: "modes",
    name: "Modes",
    line: "Per project, agents only look, draft, open or ship their pull requests.",
    area: "safety",
    since: "2026-10-22",
    source: "packages/contract/src/autonomy.ts",
    docs: "docs/modes.html#levels",
  },
  {
    id: "guard",
    name: "The guard",
    line: GUARD_BLOCKS_CLAIM,
    area: "safety",
    since: "2026-10-22",
    source: "packages/core/src/guard.ts",
    docs: "docs/guard.html#what",
  },
  {
    id: "ship",
    name: "Ship",
    line: "Pull requests whose required checks pass can merge through GitHub's own auto-merge, per project.",
    area: "safety",
    since: "2026-10-23",
    source: "packages/core/src/ship.ts",
    docs: "docs/modes.html#ship",
  },
  {
    id: "ship-leads",
    name: "Ship for leads",
    line: "A lead's pull requests go through the same Ship rules as a ticket's.",
    area: "safety",
    since: "2026-10-23",
    source: "packages/core/src/ship.ts",
    docs: "docs/modes.html#ship",
  },
  {
    id: "feedback",
    name: "Suggest or report",
    line: "An idea or a bug, as a public GitHub issue you preview and send yourself.",
    area: "overhand",
    since: "2026-10-23",
    source: "apps/web/src/components/drawers/FeedbackDrawer.tsx",
    docs: "docs/everyday.html#feedback",
    tip: { text: "New: tell us an idea or a bug, previewed before it goes.", where: "menu-feedback" },
  },
  {
    id: "whats-new",
    name: "What's new",
    line: "Every feature in one list, newest first, with a quiet tip beside what's new.",
    area: "overhand",
    since: "2026-10-23",
    source: "apps/web/src/app/tips.ts",
    docs: "docs/everyday.html#new",
  },
  {
    id: "os-sandbox",
    name: "OS sandbox",
    line: "On by default where your computer can run it: each agent run can write only its own folder, never your other files.",
    area: "safety",
    since: "2026-10-25",
    source: "packages/core/src/sandbox.ts",
    docs: "docs/guard.html#limit",
    tip: { text: "New: an OS sandbox around each agent run, on wherever this computer can run it.", where: "settings-sandbox" },
  },
  {
    id: "guard-only",
    name: "Guard only, per project",
    line: "A project whose tools can't run inside the sandbox, such as Xcode, runs on the guard alone, and Needs you says so.",
    area: "safety",
    since: "2026-10-25",
    source: "packages/contract/src/sandbox.ts",
    docs: "docs/guard.html#limit",
  },
  {
    id: "signin-in-app",
    name: "Sign in from the app",
    line: "Claude Code, Codex and Cursor Agent sign in from Settings, in your browser, with no terminal.",
    area: "agents",
    since: "2026-10-24",
    source: "packages/core/src/signin.ts",
    docs: "docs/agents.html#signin",
    tip: { text: "New: add an account and sign in right here, no terminal.", where: "add-account" },
  },
  {
    id: "usage-bench",
    name: "Out of usage",
    line: "An account that runs out of usage waits for its reset, and Settings shows until when.",
    area: "agents",
    since: "2026-10-24",
    source: "packages/core/src/limits.ts",
    docs: "docs/agents.html#billing",
  },
  {
    id: "looks",
    name: "Looks",
    line: "Five looks for the app, each in light and dark: new art, colour and motion, the same words and controls.",
    area: "overhand",
    since: "2026-10-25",
    source: "packages/themes/src/index.ts",
    docs: "docs/everyday.html#looks",
    tip: { text: "New: pick a look for the app. Every word and control stays put.", where: "settings-look" },
  },
  {
    id: "mcp-server",
    name: "Overhand over MCP",
    line: "Your agents ask what's running and what needs you, answer leads and hand on requests; a run does only what its key allows.",
    area: "agents",
    since: "2026-10-25",
    source: "packages/core/src/mcp-server.ts",
    docs: "docs/runs.html#mcp",
  },
  {
    id: "talk-to-leads",
    name: "Message a lead",
    line: "Ask a lead anything or tell it what to do, any time, from the app or your phone; its reply comes back in the same conversation.",
    area: "agents",
    since: "2026-10-25",
    source: "apps/web/src/components/drawers/LeadDrawer.tsx",
    docs: "docs/leads.html#talk",
    tip: { text: "New: message a lead any time, not only when it asks.", where: "lead-message" },
  },
  {
    id: "plugins",
    name: "Plugins",
    line: "Small checks, trackers and notifiers in a sandbox of their own, reaching only the hosts they declare.",
    area: "safety",
    since: "2026-10-25",
    source: "packages/core/src/plugins.ts",
    docs: "docs/plugins.html#plugins",
  },
];

/** The features newest first; within a day, in the registry's order. */
export const newestFirst = (list: readonly Feature[] = FEATURES): Feature[] =>
  list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => b.f.since.localeCompare(a.f.since) || a.i - b.i)
    .map(({ f }) => f);
