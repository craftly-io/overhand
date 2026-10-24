# Contributing

Thanks for helping. Overhand is TypeScript end to end, run with [Bun](https://bun.sh).

## From clone to green tests

You need git and [Bun](https://bun.sh) 1.3 or newer (`curl -fsSL https://bun.sh/install | bash`). No accounts or keys.

```sh
git clone https://github.com/craftly-io/overhand && cd overhand
bun install
bunx playwright-core install chromium-headless-shell   # once, about 200 MB: some tests drive a real headless browser
bun run test                                           # about a minute and a half
```

The tests give themselves a scratch home, so they never touch your own Overhand. They print error lines and stack
traces on the way: those are tests checking failure paths. Only the summary at the end counts (`0 fail`).

## Run Overhand from your checkout

```sh
bun run build                                       # the dashboard
export OVERHAND_HOME=$(mktemp -d) OVERHAND_PORT=4320
bun run.ts daemon                                   # serves http://127.0.0.1:4320
```

Then, in a second terminal with the same two `export`s, `bun run.ts open` signs your browser in. A browser that isn't
signed in sees "Pair this device" instead of the dashboard. Without the two variables the daemon uses port 4317 and
keeps its config and state in the checkout, which clashes with an Overhand you have installed.

## Before a pull request

These are the checks CI runs on every pull request; each takes seconds except the tests:

```sh
bunx tsc --noEmit && (cd apps/web && bunx tsc --noEmit)
bun run lint
bunx jscpd@4.0.5 --config .jscpd.json   # no copy-pasted code
bun run test
bash release/smoke.sh    # builds the release binary and pokes a daemon on a free port with a scratch home
```

If you changed the guard or how an agent's hook reaches it, also run `bun run guard-check`: it feeds each installed
agent's own hook messages through the guard and prints pass or fail per case, with each agent's version. With `--live`
it also runs each installed agent headless in a scratch home, asked to merge, and checks the guardrail log caught it: one
short model call each, signed in by an API key in your environment (`CURSOR_API_KEY`, `GEMINI_API_KEY`), since a
scratch home has no login. A real run that blocks is what lets a row in `packages/contract/src/guard.ts` say `verified`.

If you changed anything in `packages/themes`, also run `bun run brand` and commit what it changes.

For a change to the dashboard or the landing page, also run the responsive sweep:

```sh
bun run shots            # builds the web app, then every screen × 16 sizes (320px phone to 5120px ultra-wide) × 5 themes
bun run shots --viewports 390x844,1440x900 --themes observatory --screens now,work --no-build   # a quick subset
```

It serves the landing page and the demo locally, screenshots each frame and checks the DOM: the page scrolling
sideways, controls overlapping and, on the site (swept in light and dark), text under WCAG AA contrast are hard
failures (exit 1); clipped text, tap targets under 32px on touch sizes,
text under 11px, reading lines over about 95 characters and badly used ultra-wide width are listed as soft findings. Open
`release/out/shots/index.html` for the contact sheet; `report.json` has every finding. It uses `playwright-core` (a dev
dependency) and the Chromium installed above, or the one `PLAYWRIGHT_BROWSERS_PATH` points at. The release
preflight runs it and blocks on hard failures.

- One change per pull request, with a test for any logic it adds.
- TypeScript strict: no `any`, no non-null `!`, no double casts.
- Commit messages follow Conventional Commits: `feat(scope): …`, `fix(scope): …`.
- Every dashboard label comes from the plain words (`packages/themes/src/words.ts`); worlds don't reword them.

## The contributor licence agreement

In short: you keep the copyright in what you write, and you let Craftly Oy ship it with Overhand under any of its
licences. Overhand is fair source ([FSL-1.1-ALv2](LICENSE.md)) and also sold under a commercial licence, so a
contribution has to be usable under both. `packages/contract` and `packages/themes` are Apache-2.0. The full text is
short: [CLA.md](CLA.md). Opening a pull request means you agree to it; tick the box in the pull request template to
say so. Nothing to sign. The docs, the agent skill and the llms files are [CC0 1.0](LICENSE-docs).

## Where to help

- Issues labelled [good first issue](https://github.com/craftly-io/overhand/labels/good%20first%20issue) and
  [help wanted](https://github.com/craftly-io/overhand/labels/help%20wanted).
- Docs (`site/pages/docs`): anything unclear, wrong or missing.
- A new theme (see [Themes](#themes) below).
- Running Overhand on Linux and telling us what broke.

Found a bug or have an idea? Use "Send feedback" in the dashboard: it drafts a public issue with a diagnostics summary
that you read before it goes. Or open an issue here with the bug report or feedback form.

## Layout

`packages/contract` is the typed API between daemon and dashboard, `packages/core` the daemon, `packages/themes` every
theme's colours, type and words, `apps/web` the React dashboard, `apps/menubar` the Mac menu bar item, `site/` the
public site and docs, and `release/` the packages and the installer.

What connects to what, and how a release goes out: [docs/architecture.md](docs/architecture.md).

## Done means everywhere

Overhand is built by agents, so nothing may go stale. A change ships in one pull request with every place it shows:

| Update | Where | What fails when it's stale |
| :-- | :-- | :-- |
| The app | `apps/web`, its words in `packages/themes/src/words.ts` | `bunx tsc --noEmit`, `bun run test` |
| Demo data | `apps/web/src/demo` (the sample night and month) | `bun run test`: every minute of the night is a valid dashboard state |
| Site pages | `site/pages`, claims through `site/site.ts` slots | `bun run test` (`site/build.test.ts`), `bun run brand` + `git diff --exit-code` in CI |
| Site colours, light and dark | `packages/themes/src/system.ts` only (the site follows the computer; pages read `var(--…)`) | `site/build.test.ts`, `packages/themes/test/one-source.test.ts`, `bun run shots` (site in both, contrast) |
| Docs | `site/pages/docs`; controls as `{{w.key}}`, defaults as `{{cfg.path}}`, commands and messages as the code has them | `site/build.test.ts`: unknown slots, commands the CLI lacks, `<samp>` messages the code doesn't print, broken links |
| Setup guide | `site/pages/setup.md` | `site/build.test.ts`: only commands the CLI has |
| Features | `packages/contract/src/features.ts` | `site/build.test.ts`: each feature built, its docs anchor real |
| Claims | `packages/contract/src/guard.ts` and the other `CLAIMS` sources | `packages/core/test/guard-parity.test.ts`, `site/build.test.ts` |
| llms files and Markdown pages | built by `site/build.ts` from the docs | `site/build.test.ts`: each `.md` page matches its HTML page |
| The agent skill | `skills/overhand/SKILL.md` | `site/build.test.ts`: frontmatter, install command and every command it names |
| Words said once | everything above | `release/dupes.test.ts`: no sentence of 8+ words twice |

## Themes

A theme is a `defineTheme()` in `packages/themes/src/<id>/`: colours (each text colour must reach WCAG AA, which the
tests check), fonts, the scene it draws the world as and, at most, its own greeting and flavour lines
(`FLAVOUR_KEYS`); every other word is the house's. Copy `observatory` to start, and add its world to `apps/web/src/map/worlds`.

## Releasing

Maintainers only. Bump `version` in the root `package.json` in a pull request, merge it, then on an up-to-date `main`:

```sh
bun release/launch.ts --dry-run   # reads state and prints every step; changes nothing
bun release/launch.ts
```

It runs preflight (the repo and `origin` are `craftly-io/overhand`, on `main`, clean tree, CI green on HEAD, leakcheck, tests, version not yet tagged, the tap repo, wrangler signed in, the responsive sweep has no hard failures), then: makes the repo public if it isn't yet, tags `vX.Y.Z` and waits for the
release workflow (which builds the packages and, from a public repo, publishes the `overhand` npm launcher in
`release/npm`), deploys the site and the installer, installs from `get.overhand.dev` into a scratch HOME and
checks the version, checks `npx overhand@X.Y.Z`, writes the Homebrew formula from the release's `SHA256SUMS`
(`release/formula.ts`) and pushes it to `craftly-io/homebrew-tap`, and prints the announcement. Each step skips itself
once done, so after a failure, fix the cause and run it again.

The first release is the same command. The installer and the landing page need no edit for it: both check whether the
latest release downloads without a login (the installer on every request, the landing page's `live.css` on every
deploy), and show "not public yet" until it does.

No npm token: the release workflow publishes through npm's trusted publishing, which takes the workflow's own GitHub
identity. It's set once on npmjs.com (the `overhand` package → Settings → Trusted publishing: GitHub Actions,
`craftly-io/overhand`, workflow `release.yml`, and `npm-publish.yml` for a manual publish).
