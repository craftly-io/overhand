# Set up Overhand

You are a coding agent setting up Overhand for the person you work with. Overhand runs on their machine and runs the
coding agents they already use across their projects, by their rules. Follow these steps in order. This page lists
only what the installer and Overhand really do today ({{name}} is in beta, so it changes every week).

## What you must not do

- Never ask the person to paste a password, token or API key into this chat. Every sign-in happens in Overhand's own
  screens in their browser, or in a tool's own sign-in (for example `gh auth login`), by them.
- Ask before adding any project, and before signing in to anything.
- Change nothing outside Overhand's own folders (`~/.overhand`, `~/.local/bin/overhand`) and the projects the person
  confirmed, beyond what the installer itself does (below). Don't edit their shell's startup file yourself.
- Never merge a pull request and never push to a protected branch.

## 1. Install

macOS or Linux (arm64 or x64):

```sh
{{install}}
```

The installer downloads the package for this machine from the latest release, checks it against the release's
`SHA256SUMS` and stops if it doesn't match, unpacks it into `~/.overhand/app`, links `~/.local/bin/overhand` and starts
Overhand, which opens the dashboard in the browser on a desktop. When it's done it prints
`Overhand is running → http://127.0.0.1:4317`.

- When GitHub's command tool (`gh`) is missing it installs it: Homebrew on a Mac that has it, else GitHub's own build
  into `~/.local/bin`; GitHub's apt or dnf repository on Linux, through `sudo` only when it asks for no password.
  Otherwise it prints the one command to run; show it to the person and let them run it.
- When `~/.local/bin` isn't on the PATH it adds one line, marked `# added by Overhand`, to the shell's startup file
  (`~/.zshrc`, `~/.bash_profile` on a Mac or `~/.bashrc` on Linux, fish's `config.fish`, else `~/.profile`) and says
  so. Tell the person before you run it; if they'd rather add it themselves, run the installer with
  `OVERHAND_NO_PATH=1` and it prints the line instead. The terminal it ran in keeps its old PATH, so run
  `~/.local/bin/overhand` by its full path there.
- If it says `git` isn't installed, tell the person; the setup page in Overhand shows how to get it.

## 2. Check it's running

- `overhand status` says whether it's running, its port and version. If `~/.local/bin` isn't on the PATH yet, run it
  by its full path: `~/.local/bin/overhand status`.
- `overhand doctor` checks what Overhand needs on this machine.
- `overhand start` starts it again (at every login too) and opens it in the browser.

## 3. Reuse what's already signed in

Overhand reuses the sign-ins already on this machine: GitHub through `gh`, and each coding agent's own login. Check
GitHub with `gh auth status`. If it isn't signed in, the setup page's Sign in to GitHub shows GitHub's one-time code
and an Open GitHub button; the person enters the code on GitHub, and the page turns green by itself.

## 4. Finish in the browser, with the person

Open http://127.0.0.1:4317 (`overhand start` opens it). Overhand looks at this machine and says what it found: where
the code is, the projects (one per repo, or one per GitHub owner for several of its repos), the agents installed and
signed in, and the model. Go through it with the person: they keep at least one project, untick any they don't want and
press Start Overhand. Every sign-in it asks for is their click.
More agent accounts are added in Settings → Agents: the agent's own sign-in opens in their browser. A Claude
Code account shows a command instead (`CLAUDE_CONFIG_DIR=… claude auth login`): the person runs it in their own terminal
on this computer, since Anthropic's terms want its sign-in to go through Anthropic's own flow, and the card turns green
by itself. Don't run it for them. OpenCode's sign-in still opens in a terminal.

## 5. Safe rules for the first day

Suggest these to the person, and set them only with their yes, in Overhand:

- Each project on **{{modePropose}}**: agents open draft pull requests and stop; the person reviews them.
- Merging stays with the person on the first day: leave every project off **{{modeShip}}**.
- The **daily cap**: it counts only money an account is billed for (an API key, a paid gateway, a cloud account), and
  any account whose billing isn't known yet. Overhand sets one when it's installed, unless the first account is a local
  model. Show the person what it is (Settings → Safety) and ask whether it suits them; don't add another. Once today's count
  reaches it, pay-per-use and cloud agents (and any not known yet) wait until tomorrow; accounts known to be on a plan
  carry on, since they aren't charged per run and follow their plan's usage limits. If Overhand asks whether an account
  is billed per use or part of a plan, ask the person; don't answer for them.
- On a Claude plan: {{w.planUseNote}} Settings keeps a plan account paced through its week.
- Tell the person how work reaches agents: {{w.workStory}}

## If something goes wrong

- `overhand logs` shows Overhand's log (`overhand logs -f` keeps following it).
- `overhand stop` stops it and keeps it from starting at login.
- `overhand update` updates to the latest release.
- `overhand uninstall` stops it and removes the program; it keeps `~/.overhand` unless the person asks to delete it
  too (`--remove-data`). `--dry-run` lists what it would remove and keep.
