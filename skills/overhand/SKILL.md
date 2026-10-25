---
name: overhand
description: Install and work with Overhand, the program on a person's computer that runs their coding agents across their projects and calls them only when it matters. Use when they ask to set up Overhand, check that it runs, answer a question one of its leads asked, hold its heavy jobs, or look up how any part of it works.
---

# Overhand

Overhand is a local daemon. It runs coding agents (Aider, Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode) headless on
the person's projects and serves a dashboard at http://127.0.0.1:4317. State lives in `~/.overhand`.

## Ground rules

- Sign-ins are the person's. Never take a key, token or password in chat.
- Ask before you add a project or change a setting.
- Don't merge pull requests, and don't push to protected branches.

## Install

Follow https://overhand.dev/setup.md step by step, asking the person before each step. The core of it:

```sh
curl -fsSL https://get.overhand.dev | sh
```

## Check it

- `overhand status`: running or not, port, version, agents at work, free disk.
- `overhand doctor`: what's missing on this machine, with the fix for each.
- `overhand logs` (`-f` to follow): the daemon's log.
- `overhand start` / `overhand stop` / `overhand update`: start at login, stop, update.
- `overhand uninstall`: stop it and remove the program, keeping `~/.overhand`. `--remove-data` deletes that too; run it
  only when the person asks for it, and `--dry-run` first to show them what goes.
- `overhand open`: the dashboard in the browser, signed in.

## Answer what it asks

- A lead's open question shows in the dashboard under Needs you. With the person's answer, run
  `overhand answer <lead> "<answer>"`, or `overhand answer <lead> --default` to accept the default the question gave.
- With no question open, `overhand answer <lead> "<text>"` sends the lead a message from the person instead; its reply
  shows in the lead's conversation in the dashboard. Send one only when the person asked you to.
- A request handed to your session: `overhand ack <id> done`, or `overhand ack <id> refuse "<why>"`.
- Over MCP instead: `overhand mcp` is a stdio MCP server with the same answers and requests as tools, plus `status`
  (what's running and what needs you). Add it with `claude mcp add overhand -- overhand mcp` or your agent's own way.
- The person needs the laptop: `overhand quiet 3h` (or `90m`, `off`) holds builds, suites and browsers.
- Disk is short: `overhand cleanup plan` lists what could go. Removing it is the person's call.

## Find details

- `overhand help`: every command.
- https://overhand.dev/llms-full.txt: every docs page in one file.
- https://overhand.dev/llms.txt: the index, with each page as Markdown (`/docs/<page>.md`).

These instructions are CC0 1.0.
