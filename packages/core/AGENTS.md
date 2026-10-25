# packages/core: the daemon

`src/index.ts` is what `run.ts` imports; `src/daemon.ts` holds the main loop and the CLI. Tests live in `test/`, one
file per module, and run in a scratch `OVERHAND_HOME`.

## Folders

| Folder | What it holds |
| --- | --- |
| `src/runtimes/` | One file per agent CLI (`claude-code.ts`, `codex.ts`, …); `runtime.ts` is what each provides, `index.ts` the list |
| `src/trackers/` | Ticket adapters (GitHub, Jira, Linear, Bitbucket, MCP) behind one interface in `types.ts` |
| `src/status/` | Background status sources (CI, deploys, Sentry, calendar, upkeep), refreshed into one cache |

## Main files

| File | What it owns |
| --- | --- |
| `env.ts` | Paths (`OPS` for config and state, `SRC` for the code), the live config, the shell helpers |
| `config.ts` | The config file's schema, defaults, loading and saving |
| `setup-cli.ts`, `setup.ts` | `bun run setup`: the first-run questions and the checks |
| `server.ts` | The dashboard's HTTP server and the actions it posts; `dashboard.ts` builds `/api/state` |
| `claude.ts` | Headless agent runs on accounts: order, cooldowns, usage probes |
| `agent.ts` | The ticket agent: repo routing, worktrees, pull requests and their fix rounds |
| `plan.ts` | The daily plan and its armed items |
| `leads.ts` | Supervised leads and their processes |
| `guard.ts`, `sandbox.ts` | What an agent may run, and the OS sandbox every run starts in |
| `broker.ts` | A lead's git push, fetch and gh, run by the daemon with your sign-in the lead never has |
| `plugins.ts` | Plugins: install from a pin, approval by digest, their own sandbox, the host bridge, findings (example in `plugins/`) |
| `cleanup.ts`, `cleanup-sources.ts` | Disk cleanup and the caches it knows (printed to `docs/cleanup-sources.md`) |
| `usage.ts` | Reading agent spend and usage limits from their output |
| `relay.ts`, `team.ts` | The daemon's side of the hosted relay and of teams |
| `hosted.ts`, `hosted-run.ts` | Hosted runs: handing queued tickets to the relay, taking results in, and the run inside the container |
| `state.ts` | `state.json` and the JSON file helpers |
