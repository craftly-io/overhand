# Overhand

**Stop babysitting your coding agents.**

Overhand is a program on your computer that runs the coding agents you already use across all your projects. They
work through tickets, red builds, review comments and upkeep, and every change comes back as a pull request with the
checks it ran and, for screen changes, screenshots. You only see the decisions. It runs Aider, Claude Code, Codex,
Cursor Agent, Gemini CLI and OpenCode, on Claude, your own cloud, a gateway or a local model.

## Why

- **You stop watching terminals.** Agents pick up tickets, red builds, review fixes, errors and dependency upgrades.
- **Every change is a pull request.** Merging is yours, unless you turn on Ship for a project; then GitHub's own
  auto-merge merges once the required checks pass.
- **One screen.** What got done, what's running, and what waits on you.
- **It stays on your machine.** Overhand keeps your code, keys and tokens on your computer, and no server of ours sees them; your agents talk to their model and GitHub as they always do.
- **A guard checks every step first.** It stops merges, force pushes, deploys and secret files before they run.
  Confirmed blocking in a real run: Claude Code, Codex and OpenCode. Aider has no pre-tool hook: it runs no shell
  commands (confirmed), and the OS sandbox, when on, holds its writes to the run's folder as it does every agent's. Set
  up to each agent's documented pre-tool hook, not yet confirmed in a real run: Cursor Agent and Gemini CLI.

See a sample night: <https://overhand.dev>

## Install

macOS or Linux. **Run the command**, which installs, starts and opens Overhand:

```sh
curl -fsSL https://get.overhand.dev | sh
```

**Or paste this into your coding agent:**

```text
Set up Overhand from overhand.dev/setup.md. Ask me before each step.
```

You also need `git`, the GitHub CLI and one signed-in agent. `overhand doctor` says what's missing.

## Your first night

- **Setup is one screen.** Pick projects, an agent and its model. Every sign-in is your click.
- **A first win.** An agent takes one small, safe task and opens a draft pull request.
- **Give it work.** Label a GitHub issue `agent`, or press *Plan the day*. Projects start on Draft pull requests,
  under a $10 daily cap.
- **The night report.** Each morning: what merged and opened overnight, and what waits on you. Needs you holds the
  pull requests to review and the questions agents asked.

## Learn more

[Docs](https://overhand.dev/docs/):
[Install](https://overhand.dev/docs/install.html),
[Servers](https://overhand.dev/docs/server.html),
[First project](https://overhand.dev/docs/first-project.html),
[Agents](https://overhand.dev/docs/agents.html),
[Modes](https://overhand.dev/docs/modes.html),
[Leads](https://overhand.dev/docs/leads.html),
[Guard](https://overhand.dev/docs/guard.html),
[Runs](https://overhand.dev/docs/runs.html),
[Phone](https://overhand.dev/docs/anywhere.html),
[Teams](https://overhand.dev/docs/teams.html),
[Cleanup](https://overhand.dev/docs/cleanup.html),
[Day to day](https://overhand.dev/docs/everyday.html),
[Privacy](https://overhand.dev/docs/privacy.html),
[Troubleshooting](https://overhand.dev/docs/troubleshooting.html),
[Commands](https://overhand.dev/docs/cli.html),
[What's next](https://overhand.dev/docs/next.html).

**For agents:** [llms.txt](https://overhand.dev/llms.txt), [llms-full.txt](https://overhand.dev/llms-full.txt), any
docs page as `.md`, and the skill [skills/overhand/SKILL.md](skills/overhand/SKILL.md).

## Develop

Bun and TypeScript: the daemon in `packages/core`, the dashboard in `apps/web`, the site in `site/`. Run `bun install`,
then `bun run test`. [CONTRIBUTING.md](CONTRIBUTING.md) has setup and checks; agents start at [AGENTS.md](AGENTS.md).

## License

**Code:** [FSL-1.1-ALv2](LICENSE.md), fair source. Use, change and share it for anything except a competing product or
service; each release becomes [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) after two years. For competing
or embedded commercial use, ask us for a licence (an issue or email). `packages/contract`, `packages/themes` and
releases up to v0.2.1 are Apache-2.0.

**Docs:** this README, the docs, the agent skill and the llms files are [CC0 1.0](LICENSE-docs).
