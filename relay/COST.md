# Relay cost model

The owner's cap: **at most €100 a month of hosting, even at 10,000 concurrent users.** The design that makes this possible is that **dashboard traffic never flows through our servers**. A browser and its daemon talk peer to peer over WebRTC. The Worker and a hibernating Durable Object only sign people in and broker the connection, and Cloudflare TURN carries traffic only when NAT leaves no direct path.

The formulas live in [`src/cost.ts`](src/cost.ts). `test/relay.test.ts` keeps the 10k estimate under the cap. The numbers below come from that file, not from typing.

## Prices (checked 2026-10-20)

| Item | Price | Source |
| --- | --- | --- |
| Workers Paid | $5/month, includes 10M requests, then $0.30/M; 30M CPU-ms, then $0.02/M | developers.cloudflare.com/workers/platform/pricing |
| Durable Object requests | 1M/month included, then $0.15/M. Incoming WebSocket messages bill at 20:1; outgoing messages and protocol pings are free | developers.cloudflare.com/durable-objects/platform/pricing |
| Durable Object duration | 400,000 GB-s included, then $12.50 per million GB-s, at 128 MB per object. An object that is idle and can hibernate is **not billed, even before it hibernates**. `setWebSocketAutoResponse` replies "add no wall-clock time and are not charged" | same page |
| D1 | 25B rows read and 50M rows written included per month | Workers pricing page |
| Cloudflare TURN | $0.05/GB **egress only**; the first 1,000 GB each month are free | developers.cloudflare.com/realtime/turn/faq |
| WorkOS AuthKit | free up to 1,000,000 monthly active users | workos.com/pricing |
| Web Push | free: the daemon sends to the browser's push service directly, with no server of ours | RFC 8030/8291/8292 |

## Formulas

Let U be the number of concurrent daemons, S the dashboard opens per user per day, M the signalling messages per open, h the handler milliseconds, R the daemon reconnects per day, W the Worker requests per open, D the other daemon Worker requests per day, f the share of opens that need TURN, and B the MB per relayed open. A month is 30 days.

```
opens        = U · S · 30
connects     = opens + U · R · 30
Worker req   = opens · W + U · (R + D) · 30
DO requests  = connects + opens · M / 20
DO GB-s      = (connects + opens · M) · h/1000 · 0.125
TURN GB      = opens · f · B / 1000

$ = 5 + 0.30 · max(0, Worker req − 10M)/1M
      + 0.02 · max(0, Worker req · cpu − 30M)/1M
      + 0.15 · max(0, DO requests − 1M)/1M
      + 12.50 · ceil(max(0, DO GB-s − 400k)/1M)
      + 0.05 · max(0, TURN GB − 1000)
```

## 10,000 concurrent users

The inputs are deliberately generous:

- U = 10,000
- S = 20 opens a day
- M = 14 messages
- h = 5 ms
- R = 6 reconnects a day
- W = 3 requests per open
- D = 10 requests a day
- 2 ms of CPU per request
- f = 20% through TURN
- B = 0.6 MB per relayed open (state over the channel is gzipped)

| Line | Volume | USD/month |
| --- | --- | --- |
| Workers (base + requests) | 22.8M requests | 8.84 |
| Workers CPU | 45.6M ms | 0.31 |
| DO requests | 12.0M | 1.65 |
| DO duration | 57,375 GB-s (within 400k) | 0.00 |
| TURN | 720 GB (within 1,000 free) | 0.00 |
| D1, WorkOS, Web Push | | 0.00 |
| **Total** | | **≈ $10.80 ≈ €10.30** |

That is inside the €15–35 the issue estimated and well under the €100 cap.

## What moves it

TURN is the only line that grows fast. Everything else stays within single digits up to roughly 100k users.

| Scenario | USD/month |
| --- | --- |
| Base (above) | 10.80 |
| 50 opens a day per user | 62.28 |
| 30% TURN, 2 MB per relayed open | 140.80 ⚠ |
| No gzip on the channel (4 MB per relayed open) | 200.80 ⚠ |

These levers keep TURN inside the free 1,000 GB:

1. **Gzip on the data channel.** It is in place: JSON and event-stream frames are compressed, typically 5–10×.
2. **Direct paths first.** ICE prefers host and STUN candidates and uses TURN last. Most home routers allow a direct path, and IPv6 helps.
3. **If TURN egress ever approaches 1,000 GB a month:** throttle the state stream on relayed connections (one update per 10 s instead of per change), or give TURN credentials a monthly byte allowance per workspace.

Measure before launch. The Cloudflare dashboard shows TURN egress and DO usage per day; compare them with this model after the first week of staging traffic.

## Why the old plan didn't fit

Relaying the dashboard through a Durable Object kept it awake for as long as anyone was looking. At 128 MB, 10,000 viewers for 2 hours a day comes to 10,000 · 7,200 s · 0.125 GB · 30 = 270M GB-s, about **$3,370/month** in duration alone.

## Teams

Teams adds one hibernating WebSocket per member's daemon to the team's room (`src/room.ts`). It also adds one small
message per real change, never a stream. Presence needs no storage; durable events cost one D1 insert, and a trim
every 50th one. `monthlyCostWithTeams` in [`src/cost.ts`](src/cost.ts) adds these volumes to the relay's and then
applies the allowances once.

Inputs (`TEAM_TEN_K`), deliberately busy:

- every one of the 10,000 users is in a team of 5;
- per member per day: 150 presence changes, 20 events, 6 room reconnects (each reading 60 log rows) and 5 team Worker
  requests;
- 5 ms per message, plus 25 ms awake while D1 answers.

| Line | Teams' volume | USD/month |
| --- | --- | --- |
| DO requests | 1.8M connects + 17.28M seat checks (every 5 minutes per room) + 51M incoming messages ÷ 20 = 21.63M | +3.24 |
| DO duration | 122,175 GB-s (179,550 with the relay's, within 400k) | 0.00 |
| Workers | 3.3M requests | +0.99 |
| Workers CPU | | +0.13 |
| D1 | 24M rows written (within 50M), 259M read (within 25B) | 0.00 |
| **Relay with Teams at 10k** | | **15.17 ≈ €14.41** |

One active team of five costs about **$0.015 a month** at list prices, before any allowance. The line that would grow
is D1 writes: at 100 events per member per day the total is $86.36, still under the cap. Logging fewer kinds of events
comes first, before anything else changes. The test in `test/team.test.ts` keeps both cases under the cap.

## Hosted runs

Hosted runs (README, Hosted runs) are the one hosted feature whose cost grows with use, so customers pay for it,
with a margin: prepaid run minutes only, and no run starts without the minutes for its longest length. The numbers
live in [`src/cost.ts`](src/cost.ts):

- `RUN_INSTANCE`: one size, Cloudflare Containers' `standard-2` (1 vCPU, 6 GiB, 12 GB disk).
- `RUN_COST_PER_MIN_USD`: 60 s × (6 GiB × $0.0000025 + 1 vCPU × $0.000020 + 12 GB × $0.00000007) ≈ **$0.00215** a
  minute with the CPU busy the whole time. CPU is billed only while active, so a typical minute costs less.
- `RUN_MARGIN` = 2.5 and `RUN_PACKS`: €6 for 1,000 minutes and €28 for 5,000. `test/hosted.test.ts` fails if a pack,
  here or in the catalog, sells below cost × 2.5 (about €0.0051 a minute).
- The allowance that comes with a plan (Pro 300 minutes a month, Team 1,000 per seat) costs us at most $0.65 and $2.15
  a month per workspace.

The `Runner` Durable Object's socket hibernates, so an idle one costs nothing. Its keep-alive pings are auto-answered
and free, and only a computer with a paid plan and a project switched on opens one. What's billed is a few ms per
hand-off message, plus one awake wait through the 2-minute grace each time the socket closes. At 0.125 GB × 125 s ≈
16 GB-s per close and 6 closes a day, that's about 2,800 GB-s a month per daemon, $0.035 past the included 400,000.
The Pro or Team plan every such computer is on covers it many times over.
