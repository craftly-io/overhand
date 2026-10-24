# Security

Overhand runs coding agents on your machine with your credentials, so security reports matter to us.

## Reporting a vulnerability

Please report privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Don't open a
public issue. We aim to reply within three working days and to ship a fix, or a clear mitigation, before any details
are public.

## What Overhand does to stay safe

- Everything runs locally; no Overhand server sees your code, tokens or keys. What leaves the machine: what your agents
  send to the model backend you chose, calls to the services you connect (GitHub, Linear, Sentry and so on), phone
  notifications to your ntfy topic when you set one, and a daily check for a new release on GitHub.
- Overhand never handles Claude.ai subscription credentials: it doesn't ask for, read, store or route a Claude
  subscription login or token. A Claude account either signs in to Claude Code itself, in a config folder of its own
  that Claude Code alone reads, or uses an Anthropic API key you provide (docs: Agents and accounts).
- Secrets are stored in the macOS Keychain or the Linux keyring, never in config files or logs. On a Linux server
  without a keyring, saving a secret fails unless you opt in to a file with `OVERHAND_SECRETS_FILE` (mode 0600).
- The dashboard listens on 127.0.0.1 only and accepts actions only from its own origin and the addresses you add.
- On the computer itself, every call needs the install's local key (a random key in Overhand's control folder, mode
  0600): the CLI reads the file, and a browser gets a cookie made from it (not the key itself; HttpOnly, SameSite=Lax so a sign-in elsewhere can send it back, while every action also needs the dashboard's own Origin) by opening the one-time
  link `overhand start` and `overhand open` open, which works once, for two minutes; neither gives a link inside a run
  Overhand started, and `overhand open --reset` makes a new key, which signs every browser out. Another program or a web
  page on the computer gets 401 like an unpaired device. An agent isn't stopped unless the OS sandbox is on (below): it
  runs as you, so it can read the key file (the guard blocks naming the control folder, not every way of reading it).
  Under the sandbox a run gets its own key instead, which opens only `overhand ask`, `ack` and `answer`, as that run.
  Any other device (a phone through `tailscale serve`) is paired once with a one-time code from Settings → Phone and
  then carries a random session cookie (HttpOnly, SameSite=Strict, Secure over https); only its hash is stored, and Settings lists and removes devices. Without one, every page and API answers
  401. Answer buttons in a phone notification carry their own token, which allows only the replies it offered, once,
  within 24 hours.
- New installs start every project on Draft pull requests, with a $10 daily budget cap on billed spend
  (and on accounts whose billing isn't known yet) unless the first account is a local model.
- Agents work on branches and open pull requests, and are told never to merge, force-push, deploy or touch production
  data. A guard hook (`overhand guard`) is set up to enforce this on every tool call in every agent CLI that has hooks (Claude
  Code, Codex, Gemini CLI, Cursor Agent, OpenCode), and also blocks reading secrets and credential files and changing
  Overhand itself; Aider has no hooks, so it runs with no shell commands and the secret files ignored. The guard fails
  closed when it can't start. Its limit: it judges the command an agent asks for, not what a script that command runs
  does next, so give agent accounts credentials without admin or deploy rights all the same. Confirmed blocking in a real run: Claude Code, Codex and OpenCode. Aider has no pre-tool hook: it runs no shell commands (confirmed), and the OS sandbox, when on, holds its writes to the run's folder as it does every agent's. Set up to each agent's documented pre-tool hook, not yet confirmed in a real run: Cursor Agent and Gemini CLI. See the
  guard page in the docs (overhand.dev/docs/guard.html).
- The OS sandbox (Settings, Agent accounts; off by default, or log only first): With the OS sandbox on, each agent run
  Overhand starts, and each check Overhand itself runs in a project's own files (its package manager, lint script or
  virtualenv), can write only its own folder, the git data its commits need, its own temp folder (gone when it ends),
  its project's package caches and its agent's own state in a folder of Overhand's: never Overhand's files, another
  project, your own agent config, your shell startup files, LaunchAgents, git config, hooks and where git finds the
  repository, or the settings, hooks, plugins and extensions that steer an agent, however the command is spelled. It
  can't read cloud credentials, browser profiles or Overhand's local key. It doesn't filter the network: a run can
  send what it can read to any site, and can read your GitHub and SSH logins, which agents use to push. It doesn't
  stop what a run writes into its own project from running later when you run it, or a program that asks a service
  outside it to act, such as a database or a server on a local port: tmux, screen and Docker's sockets are closed to
  it, other local sockets aren't, and on macOS neither is another app, through osascript or open. A lead can't make
  git worktrees in its own checkout under it: no lead needs one, since Overhand makes the worktrees runs work in. On Plan
  and warn only, Codex's commands can reach the network under it (Codex's own sandbox, which kept them off it, can't nest
  inside Overhand's). With it off, Overhand's own checks run a project's files as you, as before. Leads and tasks
  start your own MCP servers, handed over by Overhand and no others, since they need them for your trackers; a run on Plan and
  warn only starts none of yours. State a tool or plugin keeps in your home, outside the run's folders, its caches and its
  agent's own, stays closed to it (a plugin's database in its own folder in your home, or firebase-tools' login and
  log): such a tool fails under it until it can be pointed at a folder the run writes. On macOS, Xcode builds don't run
  under it: xcodebuild writes macOS's shared temp and cache folders, and Swift packages start a sandbox of their own,
  which can't nest. macOS Keychain items stay reachable, since the agents' logins live there. It
  runs on macOS and on Linux with bubblewrap and user namespaces; elsewhere, including most Docker setups, runs have
  the guard only. A project that needs Xcode, Swift packages or firebase-tools can run without the OS sandbox: set its
  sandbox to off (Settings, Projects, or sandbox: off on the project in the config). Its runs, and the checks Overhand
  runs in its files, then have the guard only, and Settings says so. With Refuse runs without it on, the project stays
  inside the sandbox. Overhand suggests it when a project has an Xcode project or workspace, a Package.swift or a
  firebase.json, and never switches it for you.
- The installer and the npm launcher verify each package's SHA-256 before installing it.

## Access from anywhere (Pro and Team): the relay's trust model

The relay (`relay/`, a Cloudflare Worker) is off unless you turn it on in Settings → Phone. It signs you in, links your
computer to your account, brokers WebRTC connections and sells the plan. It never carries or sees the dashboard: that
flows browser ↔ daemon over WebRTC (DTLS), through Cloudflare TURN only when NAT requires it, still encrypted end to end.

- **Accounts:** WorkOS AuthKit sign-in; the relay's own session cookie (Ed25519-signed, 7 days, HttpOnly, Secure,
  SameSite=Lax). Every state-changing browser request and every browser WebSocket must come from the hosted origin
  (Origin checked), which stops CSRF and cross-site WebSocket hijacking. Sign-in returns only to a path on the site.
  `/relay/dev-login` exists only with `DEV_LOGIN=1` and only on localhost.
- **Your computer's identity:** an Ed25519 device key made on your computer (`.relay.json`, 0600; the private half never
  leaves it). Linking needs a signed-in browser, an explicit confirmation showing the computer's name and key
  fingerprint, and a single-use nonce the daemon made; the relay's certificate comes back only to `127.0.0.1`, and the
  daemon accepts it only for its own key. A certificate is useless without the device key. Every daemon request to the
  relay is signed over method, path and a timestamp (2-minute window).
- **Pairing only within a workspace:** the Worker authenticates each socket (daemon by key and certificate, browser by
  session), checks the workspace has a paid plan, and routes it to that workspace's Durable Object by name. The object
  only ever forwards between sockets it holds, accepts only offers and candidates from browsers and answers and
  candidates from the daemon, and drops anything malformed or over 32 KiB.
- **A malicious or compromised relay can't drive your computer.** The daemon signs its WebRTC answer, which carries its
  DTLS fingerprint, with its device key; the hosted page pins that key (from the pairing QR's `#k=`, otherwise on first
  use) and refuses an answer it didn't sign, showing a warning if the key changes. Over the channel, the daemon runs the
  dashboard's own request handler: a channel request is always remote (never "local"), needs a paired device's session
  exactly like a phone on your tailnet, and passes the same Origin check. Computer-only actions (adding devices, linking,
  setup) refuse it. Weak point, stated plainly: first use without the pairing link trusts the key the relay reports;
  compare the fingerprint in Settings → Phone if that matters to you.
- **On the hosted page** the paired device's session token lives in localStorage on the hosted origin (a data channel
  carries no cookies), so an XSS on that origin could read it; the page loads no third-party script, and Paddle.js runs
  only on the separate `/relay/billing` page (strict CSP with a nonce, never cross-origin isolated).
- **Entitlements:** Paddle webhooks are accepted only from the addresses Paddle publishes for the environment (its
  `/ips` endpoint, re-read hourly; the last good list if that fails, and 503 so Paddle retries if there has never been
  one), then verified with the `Paddle-Signature` HMAC-SHA256 over the raw body, within 5
  seconds of their timestamp; each event id is recorded in the same transaction as its update (replays are no-ops) and
  an older event never overwrites a newer one. The workspace in a subscription's custom data is set by the Worker when it
  creates the checkout transaction, never by the browser. The daemon's entitlement token is Ed25519-signed, lasts 24
  hours, and keeps working for a 7-day grace period offline.
- **Payment gates hosted features only.** Nothing local checks an entitlement; an unpaid, revoked or unreachable relay
  only means the hosted page can't connect and hosted push stops after the grace period.
- **Web Push** is sent by your computer with VAPID keys made there (`.push.json`, 0600), encrypted for each browser
  (RFC 8291), straight to the browser's push service. A notification's tap opens only the hosted origin.
- **Secrets** (signing key, WorkOS, TURN and Paddle API keys, Paddle webhook secret) are Worker secrets, never in the
  repository. The Paddle client token is public by design. Only `PADDLE_ENV=production` reaches Paddle's live API.
- **Revocation:** "Sign out everywhere" on the billing page voids every session issued before it, checked on each request.
  It also closes the workspace's open browser sockets. "Unlink this computer" in its Settings → Phone revokes its key at the
  relay, checked on every daemon request, then deletes the key. A WebRTC connection already open survives both; the
  daemon's device pairing still guards it, so remove the device too if one was lost.
- **TURN budget:** TURN credentials are handed out at most `TURN_MONTHLY_GRANTS` times per workspace per month (300 by
  default), then STUN only.
- **Teams** (docs/teams.md) share metadata only: who is here, project owners, project status, questions and answers,
  results, hand-offs, claims and comments. Code, diffs, keys, tokens and agent transcripts have no field to travel in.
  - **The feed is an allowlist.** Every message is a strict schema (an unknown field fails it whole), every text is
    short, and text that looks like code, a diff or a secret is refused. Your daemon checks this before sending, and the
    team's room checks it again. The room stamps the sender from the authenticated socket and drops anything else.
  - **PR links** in results are off unless you turn them on in Settings → Team.
  - **Who may do what.** Every team route reads membership and role from D1 on each request:
    - members read the team;
    - admins invite, remove members and set project owners;
    - only the owner changes or removes an admin;
    - only a member's daemon, holding a seat, joins the room.
  - **Invites** are single-use links for one email address, valid 7 days. Only the hash of the link's secret is
    stored.
  - **Removing a member** (or a member leaving) deletes the membership and their project ownership, closes their room
    socket at once, and ends hosted access that came with the seat at their next entitlement refresh.
  - **Hand-offs** only ever arrive as an item on the recipient's machine, which runs nothing until they press Assign an
    agent. A compromised relay could forge or drop feed messages, but the feed carries no commands.
  - **Retention.** At most 500 events per team stay in D1 for catch-up. Presence is never stored.
- **Known limits:** a link certificate revoked while the relay was unreachable stays valid there. The daemon says so and
  deletes the key anyway, so only an existing copy of the key could use it. A Durable Object usage spike is bounded by
  Cloudflare's billing, not by the relay (see relay/COST.md). A member who loses their seat when the over-seats grace
  ends keeps a room socket that is already open until it reconnects (at most a day).
