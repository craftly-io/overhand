/**
 * The sample projects' onboarding guides, made up, run through the same drift check as the daemon's. Booking app's guide
 * matches its repo; Online shop's was written in spring, before the shop moved from npm to bun and folded `server/` into
 * the app, so it's flagged. Company website and Mobile app have none yet.
 */
import { type Guide, guideDrift, type RepoFacts } from "@overhand/contract";
import { sampleUrl } from "./links";

const DAY = 864e5;
const NOW = new Date(2026, 9, 20, 8, 30).getTime();

const BOOKING_GUIDE = `# Booking app

The clinic's booking API, behind the website and the front-desk app. Patients book, move and cancel appointments; the
front desk sees the day's schedule. Go 1.24 with chi for routing and sqlc for queries on Postgres.

## Layout

- \`cmd/api/\`: the server's entry point and wiring.
- \`internal/\`: handlers, services and the store, one package per area.
- \`queries/\`: the SQL that sqlc turns into Go; never edit the generated code by hand.
- \`migrations/\`: schema changes, applied in order.

## Install and run

You need Go 1.24 and Docker (for Postgres).

\`\`\`sh
docker compose up -d db
make generate
make run
\`\`\`

The API listens on \`localhost:8080\`. Copy \`.env.example\` to \`.env\` first.

## Test

\`\`\`sh
go test ./...
make lint
\`\`\`

CI runs both on every push, plus \`make generate\` with a check that nothing changed.

## Conventions

- Handlers stay thin: parse, call a service, write the response.
- Wrap errors with \`fmt.Errorf("…: %w", err)\`; never panic in a handler.
- Every new endpoint gets an entry in \`openapi.yaml\` in the same pull request.
- Conventional commits with the issue key, e.g. \`fix(slots): skip holidays (BOOK-84)\`.

## Where to start

Read \`internal/booking/service.go\` first: most issues land there. A good first change is a small validation rule
with its table test next to it.

## Gotchas

- Times are stored in UTC and shown in the clinic's zone; tests pin \`TZ=Europe/Helsinki\`.
- Webhook payloads are versioned. Bump the version for any breaking change.
`;

const SHOP_GUIDE = `# Online shop

A bakery's online ordering: menu, basket, payment and pickup slots. Next.js with Stripe and Postgres.

## Layout

- \`app/\`: pages and server actions.
- \`server/api/\`: the order and payment endpoints.
- \`lib/\`: money, slots and shared helpers.

## Install and run

\`\`\`sh
npm install
npm run dev
\`\`\`

Open http://localhost:3000. You'll need a Stripe test key in \`.env.local\`; ask in #shop.

## Test

Run \`npm test\` before you push, and \`npm run e2e\` for the checkout flow.

## Conventions

- TypeScript strict; money is integer cents everywhere.
- One issue per pull request, title starts with the issue key.

## Where to start

\`lib/money.ts\` and \`app/basket/page.tsx\`.

## Gotchas

- Never log card data, tokens or full email addresses.
`;

const BOOK_REPO: RepoFacts = {
  dirs: ["cmd", "internal", "queries", "migrations"],
  files: ["go.mod", "go.sum", "Makefile", "openapi.yaml", "README.md", "ONBOARDING.md"],
  scripts: null,
  makeTargets: ["generate", "run", "lint", "build"],
};
const SHOP_REPO: RepoFacts = {
  dirs: ["app", "lib", "migrations", "public"],
  files: ["package.json", "bun.lock", "next.config.ts", "README.md", "ONBOARDING.md"],
  scripts: { dev: "next dev", build: "next build", test: "bun test", lint: "biome check ." },
  makeTargets: null,
};

const guide = (project: string, repo: string, text: string, facts: RepoFacts, daysAgo: number): Guide => ({
  project,
  repo: repo.split("/")[1] ?? repo,
  source: "default",
  text,
  branch: "main",
  share: sampleUrl(repo, "blob/HEAD/ONBOARDING.md"),
  prKey: "",
  run: "idle",
  message: "",
  at: NOW - daysAgo * DAY,
  drift: guideDrift(text, facts),
});

const none = (project: string, repo: string): Guide => ({
  project,
  repo,
  source: "",
  text: "",
  branch: "",
  share: "",
  prKey: "",
  run: "idle",
  message: "",
  at: 0,
  drift: [],
});

/** Every sample project's guide, in the demo's project order. */
export const GUIDES: Guide[] = [
  guide("Online shop", "example/shop", SHOP_GUIDE, SHOP_REPO, 190),
  guide("Booking app", "example/booking", BOOKING_GUIDE, BOOK_REPO, 6),
  none("Company website", "site"),
  none("Mobile app", "mobile"),
];
