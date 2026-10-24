# Set up Overhand

You are a coding agent setting up Overhand for the person you work with. Overhand runs on their machine and runs the
coding agents they already use across their projects, by their rules. Follow these steps in order. This page lists
only what the installer and Overhand really do today ({{name}} is in beta, so it changes every week).

## What you must not do

- Never ask the person to paste a password, token or API key into this chat. Every sign-in happens in Overhand's own
  screens in their browser, or in a tool's own sign-in (for example `gh auth login`), by them.
- Ask before adding any project, and before signing in to anything.
- Change nothing outside Overhand's own folders (`~/.overhand`, `~/.local/bin/overhand`) and the projects the person
  confirmed. Don't edit their shell's startup file without asking.
- Never merge a pull request and never push to a protected branch.

## 1. Install

macOS or Linux (arm64 or x64):

```sh
curl -fsSL {{get}} | sh
```

The installer downloads the package for this machine from the latest release, checks it against the release's
`SHA256SUMS` and stops if it doesn't match, unpacks it into `~/.overhand/app`, links `~/.local/bin/overhand` and starts
Overhand. When it's done it prints `Overhand is running → http://127.0.0.1:4317`.

- If it says `~/.local/bin` isn't on the PATH, it prints the exact line to add and the file to add it to. Show the
  person that line and ask before adding it.
- If it says `git` or `gh` isn't installed, tell the person; the setup page in Overhand shows how to get them.

## 2. Check it's running

- `overhand status` says whether it's running, its port and version. If `~/.local/bin` isn't on the PATH yet, run it
  by its full path: `~/.local/bin/overhand status`.
- `overhand doctor` checks what Overhand needs on this machine.
- `overhand start` starts it again (at every login too) and opens it in the browser.

## 3. Reuse what's already signed in

Overhand reuses the sign-ins already on this machine: GitHub through `gh`, and each coding agent's own login. Check
GitHub with `gh auth status`. If it isn't signed in, ask the person to run `gh auth login` themselves.

## 4. Finish in the browser, with the person

Open http://127.0.0.1:4317 (`overhand start` opens it). Overhand looks at this machine and says what it found: where
the code is, the projects (one per GitHub owner), the agents installed and signed in, and the model. Go through it with
the person: they untick any project they don't want and press Start Overhand. Every sign-in it asks for is their click.
More agent accounts are added in Settings → Agent accounts: the agent's own sign-in opens in their browser and, when it
asks, they paste the code back there. Nothing for you to run, except OpenCode, whose sign-in still opens in a terminal.

## 5. Safe rules for the first day

Suggest these to the person, and set them only with their yes, in Overhand:

- Each project on **{{modePropose}}**: agents open draft pull requests and stop; the person reviews them.
- Merging stays with the person on the first day: leave every project off **{{modeShip}}**.
- The **daily cap**: it counts only money an account is billed for (an API key, a paid gateway, a cloud account), and
  any account whose billing isn't known yet. Overhand sets one when it's installed, unless the first account is a local
  model. Show the person what it is (Settings) and ask whether it suits them; don't add another. Once today's count
  reaches it, pay-per-use and cloud agents (and any not known yet) wait until tomorrow; accounts known to be on a plan
  carry on, since they aren't charged per run and follow their plan's usage limits. If Overhand asks whether an account
  is billed per use or part of a plan, ask the person; don't answer for them.

## If something goes wrong

- `overhand logs` shows Overhand's log (`overhand logs -f` keeps following it).
- `overhand stop` stops it and keeps it from starting at login.
- `overhand update` updates to the latest release.
- `overhand uninstall` stops it and removes the program; it keeps `~/.overhand` unless the person asks to delete it
  too (`--remove-data`). `--dry-run` lists what it would remove and keep.
