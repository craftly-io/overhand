# For agents working on Overhand

Overhand is built by agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, licences and the pull request checks.
What the product does, for any agent: <https://overhand.dev/llms-full.txt>, or [skills/overhand/SKILL.md](skills/overhand/SKILL.md).

## Where things live

How the parts connect, staging, releases and secrets: [docs/architecture.md](docs/architecture.md).

| Folder | What it holds |
| --- | --- |
| `run.ts` | The one entry point: `bun run.ts daemon`, and what the release binary compiles |
| `packages/core` | The daemon: config, agent runs, the guard and sandbox, the dashboard's server ([its own map](packages/core/AGENTS.md)) |
| `packages/contract` | The typed API between daemon and dashboard (Zod), shared facts, test fixtures |
| `packages/themes` | Colours, type, the brand mark, the hour's light, and every plain word (`src/words.ts`) |
| `apps/web` | The React dashboard, its demo data and the attention map |
| `apps/menubar` | The Mac menu bar item's helper (Swift): the mark, the count, and the dashboard's glance page in a popover |
| `apps/design` | The design catalog served at /docs/design/ |
| `site` | overhand.dev: pages, docs and the build; `site/get` is the installer worker |
| `relay` | The hosted relay worker behind app.overhand.dev (Access from anywhere, sign-in, billing, teams) |
| `release` | Packaging, the installer, the screenshot sweep, the leak check and repo-wide tests |
| `docs` | Design system, cleanup sources, leads, teams, and the specs code cites (`docs/specs`) |
| `skills` | The agent skill published with the docs |

## Commands

```sh
bun run test     # every test, in a scratch OVERHAND_HOME
bun run lint     # Biome, warnings fail
bun run check    # tsc over packages, relay, site and release; the dashboard: cd apps/web && bunx tsc --noEmit
bun run build    # the dashboard into apps/web/dist
bun run shots    # the responsive sweep (heavy: needs disk and a Chromium)
bun run brand    # redraws the favicons, icons and brand kit from packages/themes/src/brand.ts
bun run menubar  # builds the Mac menu bar helper (needs Xcode's Swift); the daemon starts it once it's built
```

## Rules

- **One source.** Every word, fact and piece of logic lives once; CI fails on a repeated sentence or copy-pasted code.
- **Agent-agnostic names.** Say "agent" in code, files and copy; name a tool only where the code is that tool's.
- **Every problem comes with its fix.** A card in Needs you carries a button that fixes it, or opens exactly where the
  fix is; `AlertTarget` (apps/web/src/lib/alerts.ts) has no kind without one. Never show a bare error line.
- **TypeScript strict.** No `any`, no non-null `!`, no double casts; Biome formats.
- **A change is done only when it shows everywhere.** [Done means everywhere](CONTRIBUTING.md#done-means-everywhere)
  lists what one pull request updates with it, and the check that fails when you forget.
