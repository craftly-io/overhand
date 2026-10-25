# Leads

A lead is a long-running agent session that runs a whole project. Start a ready-made one from the project's own view
in Crew, or add your own in Settings → Advanced → Project agent details. Ready-made leads are suggested from the project's own work, each with the
count behind it: *Answer review comments* (your open PRs with changes requested), *Keep CI green* (red builds, failing
checks, failed production deploys), *Fix new errors* (new Sentry errors; it asks you to connect Sentry first), *Keep
dependencies safe* (open GitHub Dependabot alerts, read with your signed-in `gh`; offered only where alerts are on and
some are open), *Keep dependencies current* (direct dependencies with patch or minor updates, from the repo's own
`bun outdated`, `pnpm outdated`, `npm outdated` or a virtualenv's `pip list --outdated`, nothing installed; read once a
week, so one batched PR a week at most; majors are listed in it, never applied), *Test what's untested* (of the 20
source files changed most in the last 30 days, the ones no test file is named after or mentions, in repos that already
have tests), *Clear the TODOs* (files with TODO, FIXME, HACK or XXX notes, counted as the check-up counts them; small
ones done, the rest filed as tickets or listed in the PR) and *Work the backlog* (tickets labelled for agents). The
three repo reads are kept in `.upkeep.json` (updates for a week, the rest for a day) and run in the background. A click
previews what it watches, what it does, how far it goes (the project's mode), how often it wakes and its first run;
*Start this lead* is the second click. Each sleeps until its own kind of work shows up (config `watch`) and works only
on that. Every lead's prompt, ready-made, generic or your own skill, carries one shared way of working
(`WAY_OF_WORKING` in `packages/contract/src/leads.ts`, shown on the docs page): the repo's own rules first, the smallest
root-cause change, one tested PR per change, the project's own checks, nothing skipped or forced, and a question for
product decisions.
While it's **On**, Overhand:

- keeps one lead running per entry
- restarts it *Restart after (min)* after it exits
- stops after *Give up after crashes/hour* failed exits
- waits when its account hits its usage limit, and resumes when it frees up
- waits when today's spend cap holds every billed account it may use, and says so; it resumes tomorrow, or as soon as
  you raise the cap
- shows the lead's output and questions on the dashboard

The lead keeps to the project's autonomy level (see the README's Autonomy section): on propose it opens draft pull
requests, which Overhand's guard enforces on Claude Code and the other agent CLIs are told to do. On Ship its pull
requests go through the same auto-merge step as a ticket's: after its run, Overhand takes in each PR the run opened with
a plain `gh pr create`, once GitHub confirms it's the lead's own (in one of the project's repos, by the account `gh` is
signed in as, from a branch of that repo, opened during that run). It puts the checks from the run's transcript on it
as its proof and hands it to GitHub's auto-merge only for the commit that proof covers, and only while none of the
project's leads is running. Before a lead starts, auto-merge goes off again and the proof is cleared: a later run that
pushes that branch by name brings a fresh one. Anything Overhand can't confirm (a PR opened another way, on a CLI whose
transcript it can't read, or commits no lead run vouches for) waits for your merge.

**Only when Overhand finds work** (on demand): the lead sleeps instead of restarting. Overhand wakes it with a short
brief when its project has a red default-branch build, a new Sentry error, a PR with requested changes, an open
security advisory, or a ticket labelled for agents. It wakes again only when that list changes. A lead without a project has no signals, so keep it
always on.

Paths you set in Settings are relative to your code folder.

## Option 1: the generic lead (nothing to add to the project)

Leave **Own instruction** empty. Overhand starts the lead with a generic brief:

- work the project's open issues and PRs in priority order
- keep notes in `leads/<key>/notes.md` in Overhand's own folder (`~/.overhand`, or the checkout when run from one)
- ask you questions in `leads/<key>/questions.md` in the same folder

Leave **Lock file** and **Questions file** empty too. Nothing lands in the project's repo. You answer from the lead's
card on the dashboard.

## Option 2: the project's own lead skill

Set **Own instruction** to whatever starts your skill (for example `/lead`). For Overhand to supervise it safely, the
skill has to keep the two files below.

### Lock file: one lead at a time

The lock file is JSON, `{"pid": <the lead's agent pid>, "heartbeat": <epoch ms>}`.

Overhand treats the lead as running while:
- that pid is alive, and
- the heartbeat is younger than **Lock stale after (min)**.

While that holds, Overhand starts nothing. This also covers a lead you started yourself in a terminal.

The skill must:
1. **On start:** if the lock exists with a live pid and a fresh heartbeat, stop: another lead is running. Otherwise
   write your own lock.
2. **While working:** refresh `heartbeat` more often than the stale limit, for example on every status check.
3. **On a clean finish:** delete the lock.

### Questions file: asking you things

The questions file is plain markdown. The lead appends each question under its own `## ` heading and leaves the file
empty when nothing is open, because Overhand shows any text in it.

Overhand:
- shows the last 4,000 characters on the dashboard
- notifies you whenever the file changes

When you answer on the dashboard, Overhand appends the block below to the same file. The lead should read these blocks
at every start, act on them, and remove the questions it has handled.

```
## Answer from <your name> (YYYY-MM-DD HH:MM)

<your answer>
```

With phone notifications (ntfy) and a dashboard address your phone can reach (Settings → Connections), the push carries
answer buttons: the two choices of a question that ends with a line `Options: <first> | <second>`, else "Go with your
recommendation" when the question makes one, plus Open. Each push's buttons share one random token that works once,
for 24 hours, and only while the question is unchanged; Overhand writes only the reply it offered.

A question counts as open until an `## Answer from` block is the newest heading in the file. If the lead exits while
one is open, Overhand holds it instead of restarting it into the same unanswered question. The lead resumes as soon as
you answer or press **Start**. Overhand watches the questions file, so an answer written by any route (dashboard,
phone, `overhand answer`, an editor) resumes the lead within seconds.

### Every question states a default

End each question with one line saying what the lead does if nobody answers:

```
## Which issue next?

Both #12 and #13 are ready. I recommend #12: it unblocks the release.

If there's no answer: I start #12 next run
```

*Needs you* shows that default and when Overhand goes with it ("Goes with its default at 10:30: I start #12 next
run"). The wait starts when Overhand first sees the question, not when it was written, and Overhand sends one
heads-up then ("<lead> goes with its default at 10:30 unless you answer"), so a question that was already old (say,
when you upgrade) still gets the whole wait. If it's still unanswered after **Go with its default after (h)** (Settings
→ Leads, 4 by default), Overhand answers for you, notifies you once ("<lead> went with its default") and resumes the
lead:

```
## Answer from Overhand (no reply in 4 h, YYYY-MM-DD HH:MM)

Go with your default: I start #12 next run
```

Set it to 0 to always wait for you. A question with no `If there's no answer:` line waits for you, and *Needs you*
says so.

### Answering from somewhere else

- **I answered elsewhere** (on the lead and its *Needs you* item): you settled it outside Overhand, for example in a
  terminal session Overhand can't see. Add one line of what you decided, or leave it empty. Overhand writes
  `## Answer from <you> (given outside Overhand, …)` with your line, or "Answered outside Overhand: re-read the current
  state before continuing.", and resumes the lead.
- **From a terminal** (yours or an agent's): `overhand answer <lead> "<your answer>"`, or
  `overhand answer <lead> --default` to go with the question's default. `<lead>` is its key or label. It goes through
  the running daemon and writes the same `## Answer from <you>` block as the dashboard.
- **Dismiss question:** a question older than a day, or one naming an issue or PR (`#12`, `owner/repo#12`, a GitHub
  URL) that Overhand's cached status has seen close or merge since it was asked, is marked *may be out of date* with
  the reason ("#12 closed since"). Dismiss writes `## Answer from <you>` with "Dismissed: this no longer applies;
  re-read the current state." and resumes the lead.

### Snippet for the skill

Paste this into the skill and fill in the two paths. It's written for Claude Code, where the agent's pid is `$PPID` in
any Bash call; on another agent CLI, use that CLI's process id.

```markdown
## One lead at a time
`<lock path>` holds `{"pid": <your agent pid>, "heartbeat": <epoch ms>}`; Overhand reads it. Your pid is `$PPID`
in any Bash call. At start: if the file exists, its pid is alive (`kill -0 <pid>`) and its heartbeat is under
<stale minutes> minutes old, another lead runs: stop and say so. Otherwise write your own. Refresh the heartbeat on
every status check, and delete the file when you finish.

## Questions for the owner
Nobody reads the chat of a headless lead. Append each question under its own `## ` heading to `<questions path>`,
end it with a line `If there's no answer: <what you'll do>`, and carry on with other work. Leave the file empty when
nothing is open. Answers arrive in the same file under `## Answer from <owner>` (or `## Answer from Overhand` when it
went with your default after a wait): read them at every start, act on them, and remove the questions you've handled.
```

Then, in Settings, set **Lock file** and **Questions file** to the same two paths, and turn the lead **On**.
