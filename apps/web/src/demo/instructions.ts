/**
 * The sample projects' agent instruction files, made up, run through the same parser and checks as the daemon's. Online shop's
 * CLAUDE.md and AGENTS.md disagree on the package manager; Mobile app runs Codex but only has a CLAUDE.md; Booking app's
 * Copilot file hasn't moved since spring.
 */
import { type ProjectInstructions, projectInstructions, type RepoInput, type RuleSuggestion, ruleSuggestions } from "@overhand/contract";
import { sampleUrl } from "./links";

const DAY = 864e5;
const NOW = new Date(2026, 9, 20, 8, 30).getTime();

const repo = (name: string, files: [path: string, daysAgo: number, text: string][]): RepoInput => ({
  name: name.split("/")[1] ?? name,
  lastCommit: NOW - DAY,
  aiderConf: "",
  files: files.map(([path, daysAgo, text]) => ({
    path,
    text,
    changedAt: NOW - daysAgo * DAY,
    tracked: true,
    url: sampleUrl(name, "blob/HEAD", path),
  })),
});

const SHOP_CLAUDE = `# Shop

A bakery's online ordering: menu, basket, payment and pickup slots. Next.js app router, Stripe, Postgres through Drizzle.

## Tooling

- Use bun for everything: \`bun install\`, \`bun run dev\`, \`bun test\`.
- Format with Biome (\`bunx biome check --write\`); never add Prettier.
- Run \`bun test\` before you push.

## Code

- TypeScript strict. No \`any\`, no non-null assertions.
- Money is integer cents everywhere; format only at the edge with \`formatMoney\`.
- Prefer server actions over new API routes.
- Never log card data, tokens or full email addresses.
- Every payment path needs a test that covers a declined card.

## Pull requests

- One ticket per PR, title starts with the ticket key.
- Keep PRs under 400 lines; split otherwise.
`;

const SHOP_AGENTS = `# Agent notes

Written for Codex when the repo moved over in spring.

- Install with \`npm install\` and start with \`npm run dev\`.
- Run tests with \`npm test\`.
- Don't touch \`migrations/\` by hand; generate them with Drizzle.
- Keep PRs small.
`;

const BOOKING_CLAUDE = `# Booking app

The clinic's booking API, behind the website and the front-desk app. Go 1.24, chi, sqlc.

## Build and test

1. \`make generate\` after any change to \`queries/\`.
2. Run \`go test ./...\` before every commit.
3. \`make lint\` must pass; it runs golangci-lint.

## Rules

- Handlers stay thin: parse, call a service, write the response.
- Return errors with \`fmt.Errorf("…: %w", err)\`; never panic in a handler.
- Every new endpoint gets an entry in \`openapi.yaml\` in the same PR.
- Never change a public response field's type. Add a new field instead.
- Webhook payloads are versioned; bump the version for any breaking change.
`;

const BOOKING_RULES = `---
description: Database access
globs: internal/store/**
alwaysApply: false
---
- Write SQL in \`queries/*.sql\` and let sqlc generate the Go.
- Use transactions for anything that writes to more than one table.
- Add an index with every new lookup column.
`;

const BOOKING_COPILOT = `Use Go 1.21 idioms.
Prefer gorilla/mux for routing.
Write table-driven tests.
`;

const WEBSITE_CLAUDE = `# Website

A travel company's website: trips, bookings and the staff area. React 19, Vite, TanStack Query, pnpm workspaces.

## Workflow

- Use pnpm; the lockfile is \`pnpm-lock.yaml\`.
- Run \`pnpm test\` and \`pnpm typecheck\` before opening a PR.
- Draft pull requests: a person marks them ready.

## UI

- Use the components in \`packages/ui\`; don't add a new component library.
- Every screen works at 360px wide.
- Copy is sentence case. No exclamation marks.
- Forms validate with Zod schemas shared with the API.
`;

const WEBSITE_LEGACY = `# Old staff area

This folder is the old staff area, frozen until Google sign-in lands.

- Only fix bugs here; no new features.
- Don't upgrade its dependencies.
`;

const APP_CLAUDE = `# Mobile app

Sam's side project: plan a dinner party, invite friends, share who brings what. React Native (Expo SDK 55).

## Rules

- Use bun; run \`bun test\` before pushing.
- Test on both iOS and Android simulators for any UI change.
- Keep offline mode working: every write goes through the sync queue.
- Never store tokens outside SecureStore.
- Use \`expo-router\` file routes; no new navigators.
- Release notes go in \`CHANGELOG.md\` under Unreleased.
`;

/** The four sample projects' instructions, as the Instructions drawer shows them. */
export const INSTRUCTIONS: ProjectInstructions[] = [
  projectInstructions(
    "Online shop",
    ["claude-code"],
    [
      repo("example/shop", [
        ["CLAUDE.md", 12, SHOP_CLAUDE],
        ["AGENTS.md", 160, SHOP_AGENTS],
      ]),
    ],
    NOW,
  ),
  projectInstructions(
    "Booking app",
    ["claude-code"],
    [
      repo("example/booking", [
        ["CLAUDE.md", 30, BOOKING_CLAUDE],
        [".cursor/rules/database.mdc", 48, BOOKING_RULES],
        [".github/copilot-instructions.md", 240, BOOKING_COPILOT],
      ]),
    ],
    NOW,
  ),
  projectInstructions(
    "Company website",
    ["claude-code"],
    [
      repo("example/website", [
        ["CLAUDE.md", 6, WEBSITE_CLAUDE],
        ["apps/old-staff/CLAUDE.md", 90, WEBSITE_LEGACY],
      ]),
    ],
    NOW,
  ),
  projectInstructions("Mobile app", ["codex"], [repo("sam/mobile-app", [["CLAUDE.md", 21, APP_CLAUDE]])], NOW),
];

/**
 * Review remarks from two PRs each: Booking app's ask isn't in its CLAUDE.md yet, so it's offered; Online shop's is already
 * there (never log card data), so it isn't. Found by the same clustering and coverage check as the daemon's.
 */
export const RULES: RuleSuggestion[] = ruleSuggestions(
  [
    { project: "Booking app", repo: "booking", key: "BOOK-81", rule: "Log the request id with every handler error", at: NOW - 9 * DAY },
    { project: "Booking app", repo: "booking", key: "BOOK-88", rule: "Log the request ID with handler errors", at: NOW - DAY },
    { project: "Online shop", repo: "shop", key: "SHOP-139", rule: "Don't log card data", at: NOW - 4 * DAY },
    { project: "Online shop", repo: "shop", key: "SHOP-142", rule: "Never log card data", at: NOW - DAY },
  ],
  INSTRUCTIONS,
  [],
  NOW,
);
