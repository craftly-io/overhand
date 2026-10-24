# Teams

A team is a small group of people who each run their own Overhand and want to see each other's crews. Teams works like
Figma or Miro presence: you see who is here, what they own, what they are on, and what waits on you. It stays quiet
and costs almost nothing to run.

Three rules hold everywhere:

- **Code, keys and tokens never leave a member's machine.** The team shares metadata only.
- **Dashboard traffic stays peer to peer.** The relay only signals and fans out small messages.
- **Hosting stays at or under €100 a month at 10,000 users** (see "Cost").

## The model

- **Workspace = team = a WorkOS organisation.** The relay creates the organisation when the owner creates the team, and
  its id is the team's id. Each membership is mirrored to WorkOS, so SSO and directory sync can attach later. D1 decides
  who belongs and what they may do, and every request reads it.
- **One team per person.** You leave a team before you join another one.
- **Roles:**

  | Role | Can |
  | --- | --- |
  | owner | everything an admin can; change or remove an admin. The owner holds the Team plan, so they can't be removed or demoted |
  | admin | invite and withdraw invites; remove members; make a member an admin; set each project's owner and backup |
  | member | see the team, publish their own feed, answer questions, claim, comment, hand off, leave |

- **Per-project owner and backup.** Projects match by name across members' machines (the name in each member's config).
  Ceiling: two members who name the same repository differently show as two projects. Upgrade path: match by git
  remote.

### Shared and never shared

| Shared (metadata) | Never shared |
| --- | --- |
| who is in the team, roles, invites (admins only) | code, files, diffs |
| each member's projects with a status (working, needs, idle, red) and agent count | keys, tokens, secrets, config |
| presence: online, agents running, quiet mode, what their dashboard has open ("PR #418"), claims | agent transcripts, logs, prompts |
| questions an agent asks on a project, and their answers (400 characters) | ticket bodies and tracker content |
| results: title, project, merged / opened / failed | PR links, unless the member turns on sharing PR links |
| hand-offs: project, title, ticket key, a note you write | the finding or report behind a hand-off |
| comments on items, with @mentions | |

**Enforced by a schema allowlist, not by convention** (`packages/contract/src/team.ts`). Every message is a strict zod
object, so an unknown field (`diff`, `transcript`, `env`) fails the whole message. Every text is short. Text that looks
like code, a diff or a secret is refused: code fences, diff headers, provider key and token prefixes, private key
blocks, JWTs, and any 32+ character run of mixed letters and digits. The daemon builds messages from its state with
this schema. The relay checks every message against the same schema before logging or fanning it out, so a modified
daemon can't push other fields through. A test feeds code, keys and transcripts in and checks that nothing gets out.

## How it feels

Modelled on Figma and Miro: present, never overbearing.

1. **Who's here.** A facepile in the header shows who is online. Click a person to **Follow** them: Now shows their
   map the way they see it (their projects, rings and status), until you click Stop following.
2. **Quiet presence.** A static dot with an initial marks an item a teammate has open or is handling ("Ana is on PR
   #418"). There's no animation and no cursor.
3. **"I'm on it".** You can claim any item (a question, a failure, a finding, a PR). The claim shows your initial, so
   nobody handles it twice. It lives in your presence, so it goes when you go offline. It also lapses after 30 minutes
   with no activity from you.
4. **Hand-off.** Drag an item onto a teammate's hub, or use the item's "Hand off to…" menu, which does the same and
   works with a keyboard. On their machine it lands as an "Assign an agent" item, and their project's autonomy decides
   what happens: on watch and propose projects it waits for them; nothing builds before they press Assign an agent.
5. **Comments and @mentions** on items. Only the people mentioned are notified; nobody else is pinged.
6. **Live cursors only in Pair mode.** Pair is opt-in between two people and off by default. Cursors go peer to peer
   over WebRTC between the two browsers, never through our servers. *Status: designed, not built in this pass.*
   Signalling would use the team room (as with the dashboard). Cursors would use a data channel of their own.
7. **Only what waits on YOU is orange:** questions routed to you, hand-offs to you, mentions of you. Teammates' alerts,
   failures and claims are neutral.

**Team view.** A Me / Team switch sits on Now. In Team, each person is a hub: a larger dial with their own rings
(needs, working, idle). The projects they own sit between hubs, linked to their owner and backup. The team brief sits
on top, with what waits on you.

**Settings → Team.** Here you manage members and roles, invites, project owners and backups, seats, and sharing PR
links.

## Sync design

```
member A's daemon ──signed WebSocket──▶ Team room (Durable Object, one per team) ──▶ member B's daemon ──▶ B's dashboard
                                          │  checks schema, stamps who/when
                                          └─▶ D1 team_events (durable kinds only, last 500)
```

- **Feed.** Each member's daemon holds one hibernating WebSocket to `/relay/team/ws`. It signs that WebSocket like the
  signalling one: the link certificate plus a device-key signature over method, path and timestamp. It is a second
  socket, so signalling stays untouched, and a hibernating socket costs nothing while idle. Browsers never connect to
  the room; they read the team from their own daemon (locally or over WebRTC).
- **Messages.** A member sends one small message (under 1 KiB, capped at 2 KiB) per real change:
  - `presence` (agents, quiet, viewing, claims, project statuses) replaces their last one;
  - `question`, `answer`, `result`, `handoff` and `comment` are events.

  The room stamps `by` (from the authenticated socket, never the client) and `at`. It fans each message out to the
  other online members; outgoing messages are free. There is no polling, and cursors are never streamed.
- **Presence costs no writes.** It is stored on the member's socket attachment, which survives hibernation and
  disappears when the socket closes. So going offline releases presence and claims with no cleanup job.
- **Offline catch-up.** Events go to a bounded D1 log (`team_events`): the newest 500 per team, trimmed every 50th
  event. On connect the daemon sends its last sequence number. The room answers with one `hello` summary: who is online
  with their presence, plus at most 200 events since that number (`truncated` says when more were missed).
- **Keep-alive.** A `ping` every 50 seconds gets the runtime's auto-response and never wakes the object.
- **Question routing.** Each question goes first to its project's owner. After 30 minutes it goes to the backup too.
  With no owner it goes to the backup, and with neither to anyone. This is a pure function of the question's time and
  the roster (`routeQuestion`), so every dashboard agrees without a server timer or an alarm. An answer from any
  member goes back through the feed. The asking daemon writes it into the agent's inbox as "Answer from <name>", and
  the agent resumes.
- **Hand-off.** It arrives at the recipient's daemon, which holds it as a finding from the team, with the sender's
  note. It runs only when they press Assign an agent, at the project's `assignedAutonomy`. A project that acts on its
  own still shows the item first, so a teammate never starts work on your machine.
- **Mentions.** Only the mentioned member's daemon notifies (desktop, phone push), once per comment.
- **The client stays light.**
  - The Team view is event-driven: it re-renders only when the daemon's state changes.
  - There are no animation loops for presence.
  - A hidden tab does nothing: it stops reporting what it views, and the view renders nothing new.
  - A test holds the Team view's render to a CPU budget.

## Security

- **Every relay route checks membership and role in D1** on each request (`relay/src/team.ts`):
  - reading the roster: members;
  - inviting, withdrawing invites, roles and project ownership: admins;
  - changing or removing an admin: the owner;
  - the room socket: a member's daemon with a seat. The room checks this again every 5 minutes and on every plan or
    seat change from Paddle, and closes a socket that no longer qualifies (code 4001, like a removal). The daemon then
    reads its roster and shows why.

  Browsers authenticate by session, and their writes must come from the hosted origin. Daemons authenticate by device
  key.
- **Invites** are links holding a 192-bit secret. Only its SHA-256 is stored, and a link lasts 7 days. Joining needs
  sign-in as the invited email address, and a free seat. A pending invite holds a seat, so accepting can't overflow
  the plan. We send no email: the admin shares the link. WorkOS invitation emails can replace this later.
- **Removal and leaving.**
  - The membership and their project ownerships are deleted in one batch.
  - Their room socket is closed at once (code 4001).
  - Every later request is refused, because D1 is read each time.
  - Hosted access that came through the team stops at their next entitlement refresh: the 24-hour token, then the
    usual offline grace.
  - What they already received stays on their machine; it was metadata only.
- **Who can see what.**
  - Members see the roster and the feed.
  - Only admins and the owner see invites.
  - Nothing in the feed lets anyone act on another member's machine. A hand-off only offers an item; the recipient
    decides.
- **A compromised relay** could forge or drop feed messages, but it can never reach anyone's code. The feed carries no
  commands, and a hand-off still needs the recipient's click.
- **Known limits.**
  - Comments and questions are retained in D1 for up to 500 events per team.

## Billing

- The Team plan (€8 per seat a month, from 2 seats) is the owner's Paddle subscription. Its quantity is the seat count,
  kept in `entitlements.seats` by the webhook.
- **Seats are enforced at the relay.**
  - An invite needs a free seat (members plus pending invites below seats).
  - A join needs a free seat.
  - Only seated members get the room and hosted access (Access from anywhere comes with a seat).
- **Grace.** When members exceed the seats (seats reduced in Billing, or the plan lapsed), everyone keeps working for
  7 days from that moment. After that, only the first members by seat order (the owner first, then by joining date)
  stay seated. The others see "more members than seats" until seats are added or someone is removed. A plan that's
  past due counts as active, as everywhere else.

## Cost

From `relay/src/cost.ts` (`monthlyCostWithTeams`, `TEAM_TEN_K`), which a test keeps under the cap. The inputs are
deliberately busy:

- every relay user in a team of 5;
- 150 presence changes and 20 events per member per day;
- 6 reconnects a day, each reading 60 log rows;
- 5 team Worker requests per member per day;
- 5 ms per message, plus 25 ms awake while D1 answers.

| Line | Volume per month | USD |
| --- | --- | --- |
| Room connects | 1.8M | in DO requests |
| Presence messages (no I/O, no writes) | 45M incoming (billed 20:1) | in DO requests |
| Events (logged) | 6M incoming, 24M D1 rows written | D1: within 50M included |
| Worker requests (teams) | 3.3M | in Workers |
| Seat checks (every 5 minutes per room) | 17.28M | in DO requests |
| DO requests (teams) | 21.63M | +3.24 |
| DO duration (teams) | 122,175 GB-s | within 400k included |
| D1 reads | 259M rows | within 25B included |
| **Relay alone at 10k** | | **10.80** |
| **Relay with Teams at 10k** | | **15.17 ≈ €14.41** |
| **One active team of 5, marginal at list prices** | | **≈ $0.015 ≈ €0.014 / month** |

What moves it: D1 writes. At 100 events per member per day (5× the busy case), D1 writes pass the included 50M
($70), for a total of $86.36, still under the cap. The levers, in order:

1. Log only questions, answers and hand-offs (results become presence).
2. Trim less often.
3. Batch a member's events.

Presence has no write cost at any volume.

## What's built

- **Contract** (`packages/contract/src/team.ts`): the schemas, routing, waiting-on-you, claims and the brief.
- **Relay:**
  - D1 tables (`relay/schema.sql`);
  - routes (`relay/src/team.ts`);
  - the room (`relay/src/room.ts`);
  - seat-aware hosted access;
  - cost.
- **Daemon** (`packages/core/src/team.ts`):
  - the roster;
  - the room socket;
  - publishing presence, questions and results;
  - handling answers, hand-offs and mentions;
  - the dashboard's team API.
- **Dashboard:**
  - the Me / Team switch;
  - the Team view (`apps/web/src/components/team/`), kept apart so the visual pass can restyle it;
  - the header facepile with Follow;
  - Settings → Team.
