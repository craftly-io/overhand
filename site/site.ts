import {
  GUARD_BLOCKS_CLAIM,
  GUARD_LIMIT,
  GUARD_REACH,
  NO_MERGE_CLAIM,
  QUIET_CLAIM,
  SANDBOX_LIMIT,
  SANDBOX_PROJECT_OFF,
  SANDBOX_STOPS,
} from "@overhand/contract";
import { APP, COMPANY, EMAIL, INSTALLER, REPO_URL, SITE as SITE_URL } from "@overhand/contract/links";

/**
 * The public site's name and addresses. Every page, the link preview and the meta tags read these through
 * `{{name}}`-style slots (site/build.ts). The addresses come from packages/contract/src/links.ts, so a domain switch is
 * that file and a rebuild.
 */
export const SITE = {
  name: "Overhand",
  tagline: "Stop babysitting your coding agents.",
  // what it does, in two short sentences: the home hero, the meta descriptions and every llms file open with it
  lede: "Your agents work through tickets, failed checks and review comments in every project. Each change arrives as a pull request with proof; you make the calls.",
  url: SITE_URL,
  get: INSTALLER,
  repo: REPO_URL,
  releases: `${REPO_URL}/releases`,
  email: EMAIL,
  // who makes Overhand: named once in the footer, and where the law needs it (terms, privacy, refund)
  company: COMPANY,
  // the hosted relay that serves prices, sign-in and checkout; the staging build points at staging's relay
  app: process.env.OVERHAND_APP ?? APP,
} as const;

/**
 * Claims more than one page makes, each written once and true as stated: pages read them as
 * `{{noMerge}}`-style slots (site/build.ts). The no-merge rule is the guard's (packages/core/src/guard.ts), and how far
 * it reaches in each agent CLI is the coverage table's (packages/contract/src/guard.ts); Ship's merge is the daemon's own
 * step through GitHub's auto-merge (packages/core/src/ship.ts).
 */
export const CLAIMS = {
  noMerge: NO_MERGE_CLAIM,
  guardLimit: GUARD_LIMIT,
  guardReach: GUARD_REACH,
  guardBlocks: GUARD_BLOCKS_CLAIM,
  quietMode: QUIET_CLAIM,
  sandboxStops: SANDBOX_STOPS,
  sandboxLimit: SANDBOX_LIMIT,
  sandboxProjectOff: SANDBOX_PROJECT_OFF,
} as const;

/**
 * Who Overhand is made for: one page each under /for/ (site/pages/for/<slug>.html). The header's "Made for" menu, every
 * footer and each page's own kicker read these through `{{madeFor}}`, `{{forName}}` and `{{forLine}}` (site/build.ts).
 */
export const MADE_FOR = [
  { slug: "solo", name: "Solo", line: "For one developer with many projects" },
  { slug: "studios", name: "Studios", line: "For freelancers and studios doing client work" },
  { slug: "teams", name: "Teams", line: "For a small team sharing agents" },
  { slug: "makers", name: "Makers", line: "For product people and designers building with agents" },
] as const;

/**
 * The docs, one page each at site/pages/docs/<slug>.html, in reading order. The docs index, each page's heading and
 * its row of the others, and /llms.txt read these (site/build.ts). `next` is the one page that names what isn't built.
 */
export const DOCS = [
  { slug: "install", title: "Install", line: "On macOS or Linux: one command, Homebrew, or npx and bunx." },
  { slug: "server", title: "Run Overhand on a server", line: "Linux or Docker, reached through an SSH tunnel or your tailnet." },
  { slug: "first-project", title: "First project and first win", line: "From setup to your first draft pull request." },
  { slug: "agents", title: "Agents and accounts", line: "Sign-ins, API keys, how each account is paid for, and the daily cap." },
  { slug: "modes", title: "Modes", line: "How far agents may go on each project, from watching to shipping." },
  { slug: "leads", title: "Leads", line: "Long-running agents that look after a whole project." },
  { slug: "guard", title: "The guard", line: "What it stops before it runs, and how it reaches each agent." },
  { slug: "runs", title: "How agents run", line: "Each agent's flags, what every run is told, and the scorecard." },
  {
    slug: "anywhere",
    title: "Phone and Access from anywhere",
    line: "Your Overhand on your phone: free over Tailscale, from anywhere on Pro and Team.",
  },
  { slug: "teams", title: "Teams", line: "Each person's agents side by side, and questions that find the right person." },
  { slug: "cleanup", title: "Cleanup and quiet mode", line: "Disk space back, and your laptop back when you need it." },
  {
    slug: "everyday",
    title: "Day to day",
    line: "Focus, the menu bar item, the night report, share cards, updates, feedback and what's new.",
  },
  { slug: "privacy", title: "Privacy and what leaves your machine", line: "What stays on your computer, and the little that doesn't." },
  { slug: "troubleshooting", title: "Troubleshooting", line: "What to run, and what the messages mean." },
  { slug: "cli", title: "Command reference", line: "Every overhand command, from its own help." },
  { slug: "next", title: "What's next", line: "What isn't built yet." },
] as const;
