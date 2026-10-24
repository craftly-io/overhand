# Relay

This is the hosted side of Overhand Pro and Team (issues #68 and #69): one Cloudflare Worker on one origin, `app.overhand.dev`.

- **Static files** are the dashboard build. They never run the Worker, so they cost nothing.
- **`/relay/*`** covers:
  - sign-in on its own page, through WorkOS (GitHub, Google, email codes, passkeys)
  - linking a daemon to an account
  - WebRTC signalling: a hibernating Durable Object per workspace (`src/signal.ts`)
  - Cloudflare TURN credentials
  - entitlement tokens
  - Paddle billing: the `/relay/billing` page, checkout, portal, seats, webhooks (`src/billing.ts`, `src/paddle.ts`)

Dashboard traffic never passes through here. It flows browser ↔ daemon over WebRTC. See [COST.md](COST.md) for the cost model.

## Flow

1. **Link.** In Settings → Phone → Access from anywhere → *Set it up*, the daemon makes an Ed25519 device key (`.relay.json`, 0600). It opens `/relay/link?pub&name&port&nonce` in your browser.
   - You sign in, then confirm the computer's name and key fingerprint.
   - The relay signs a **link certificate** `{ws, email, pub}` and sends the browser back to `http://127.0.0.1:<port>/api/relay/linked` with it.
   - The daemon accepts the certificate only with its own single-use nonce, and only for its own key.
   - Signed in without a plan, `/` sends you to `/relay/home` (`src/home.ts`). With no computer linked it shows the install line and the prompt for your agent (both from `packages/contract/src/links.ts`, as the site shows them), how to link, and a line that polls `/relay/me` (`linked`) until it says Linked. Once linked, it offers Pro and Team.
2. **Entitlement.** The daemon POSTs `/relay/entitlement`, signed with its device key over method, path and timestamp, and carrying the certificate.
   - Its key goes into `links` for the workspace, plan or not, so the hosted home knows a computer is linked (an unlinked key is in `revoked_links` too, and doesn't count).
   - With an active subscription, it gets a 24-hour Ed25519 token.
   - It refreshes every 6 hours. If the relay can't be reached, the last token keeps hosted features on for a 7-day grace period.
   - Payment gates hosted features only.
3. **Signalling.** The daemon keeps one WebSocket to `/relay/ws`. Browsers open the hosted page, sign in, and connect to the same workspace's Durable Object.
   - The object pairs only sockets it holds. Those sockets are all one workspace's, because the Worker authenticated each one and routed it by `idFromName(workspace)`.
   - Keep-alive `ping`s get an auto-response without waking the object.
4. **WebRTC.**
   - The browser offers.
   - The daemon answers using werift (pure-TS WebRTC) and **signs the answer SDP** with its device key.
   - The browser verifies the signature against the key it pinned: from the pairing link's `#k=`, else on first use.
   - The API then runs over the `api` data channel through the server's own handler. Device pairing, the Origin check and every permission rule apply, and the peer is never local. JSON frames are gzipped.
5. **Push.** The daemon has its own VAPID keys (`.push.json`). A browser on the hosted page subscribes over the data channel, and the daemon encrypts (RFC 8291) and posts to the browser's push service itself.

## Teams

The whole design is in [docs/teams.md](../docs/teams.md).

- **Data.**
  - A team is a WorkOS organisation. D1 holds the membership, roles, invites, project owners and backups, and a
    bounded event log (`schema.sql`).
  - `src/team.ts` serves the routes, and `src/room.ts` is the `TeamRoom` Durable Object, one per team.
- **Routes.** Each one reads membership and role from D1 on every request.
  - Members: `GET /relay/team` (the roster).
  - Admins: `POST /relay/team/{invite,invite/revoke,role,project}`.
  - Everyone, with role checks: `POST /relay/team/create` and `POST /relay/team/remove` (leaving or removing).
  - A member's daemon only: `GET /relay/team/ws`, the room socket.
  - The invite link: `GET`/`POST /relay/join`.
- **The room.**
  - It fans members' metadata out to the others. Every message is checked against the contract's strict allowlist,
    the sender is stamped from the socket, and each member may send 60 messages a minute.
  - Presence lives on the socket's attachment, so it costs no writes.
  - Questions, answers, results, hand-offs and comments go to `team_events`, which keeps the newest 500 per team. A
    reconnect gets one `hello` with what it missed, at most 200 events.
- **Seats.** A Team plan's Paddle quantity is its seat count, and a seated member gets hosted access too
  (`access()`). When members exceed the seats, everyone keeps working for 7 days, then the newest members stop.
- **Cost.** See [COST.md](COST.md#teams).

## Revocation and the TURN budget

- **Sign out everywhere** (the billing page, under Security): `POST /relay/signout-all` sets the workspace's `session_epochs.not_before`. Every session cookie carries `iat`, and one issued before that is refused on every request. The workspace's open browser sockets are closed (code 4001), and the hosted page reloads to the sign-in card.
- **Unlink this computer** (Settings → Phone on that computer): the daemon sends a signed `POST /relay/unlink`. Its key goes into `revoked_links`, every daemon request checks that table, and its open socket is closed. Then the daemon drops its key, so linking again makes a new one. A WebRTC connection that is already open isn't torn down by either action. The daemon's own device pairing still guards it: remove the device in Settings → Phone.
- **TURN budget:** each `/relay/ice` call counts one grant in `turn_grants` for the workspace and month. Past `TURN_MONTHLY_GRANTS` (default 300), the call returns STUN only (`turn: false`) and doesn't ask Cloudflare. Direct connections keep working; a connection that only TURN could make fails until the next month.

## Migrations

Every statement in [`schema.sql`](schema.sql) is `CREATE TABLE IF NOT EXISTS`, so re-running the whole file is the migration: `bunx wrangler@4.151.1 d1 execute overhand-relay --remote --file schema.sql`. Only additive changes go in; anything else needs its own script.

- 2026-10-20: added `session_epochs`, `revoked_links` and `turn_grants`. Applied to staging.
- 2026-10-20: added `teams`, `team_members`, `team_invites`, `team_projects` and `team_events` (Teams). The Worker's
  `migrations` gained `v2` for the `TeamRoom` Durable Object class, applied by `wrangler deploy`.
- 2026-10-23: `entitlements` gained `scheduled_change` and `scheduled_at` (a cancel or pause at the period's end), by
  [`migrations/2026-10-23-scheduled-change.sql`](migrations/2026-10-23-scheduled-change.sql): run once per database.
- 2026-10-24: added `links` (computers linked to a workspace). Re-run `schema.sql` on staging and production; until
  then the home page treats every account as not linked yet, and entitlements work as before.

## Why D1 and not KV for entitlements

Webhooks need these properties:

- **Read-modify-write in order.** An older event must never overwrite a newer one, because Paddle doesn't promise delivery order.
- **Atomic replay protection.** The event id is recorded in the same transaction as the update.
- **Read-your-write.** After checkout, the billing page polls for the new plan.

D1 gives a transactional `batch` and `ON CONFLICT … WHERE excluded.occurred_at > …`. KV gives none of these. It is eventually consistent ("up to 60 seconds or more" to be visible elsewhere), allows 1 write/s per key, and has no conditional writes. The volume, a few writes per subscription per month, is nothing for D1's free tier.

## Owner setup

Two relays run, each with its own D1 database and Paddle environment: production on app.overhand.dev, on live Paddle (`PADDLE_ENV: "production"`), and staging on staging-app.overhand.dev, on Paddle's sandbox (`--env staging`, `PADDLE_ENV: "sandbox"`), as [`wrangler.jsonc`](wrangler.jsonc) sets them. Each step below is done once per relay; a secret goes to staging with `--env staging`. [`.env.example`](.env.example) lists every var and secret the Worker reads.

1. **Signing key.** Run `bun relay/keygen.ts`.
   - Put the private half in `bunx wrangler@4.151.1 secret put SIGNING_KEY`.
   - Paste the public half into `RELAY_PUBLIC_KEY` in `packages/contract/src/links.ts` and ship a daemon release. Until then, daemons show "not available in this build".
2. **D1.** Run `cd relay && bunx wrangler@4.151.1 d1 create overhand-relay`. Put the id in `wrangler.jsonc`, then run `bunx wrangler@4.151.1 d1 execute overhand-relay --remote --file schema.sql`.
3. **WorkOS** (AuthKit, free up to 1,000,000 MAU, workos.com/pricing). Sign-in is Overhand's own page at `/relay/login`; WorkOS does the checking behind it:
   - Create an environment.
   - Add the redirect URI `https://app.overhand.dev/relay/callback` (Redirects). OAuth and passkeys come back there.
   - Set `WORKOS_CLIENT_ID` in `wrangler.jsonc` vars.
   - Run `secret put WORKOS_API_KEY`.
   - **Email codes:** under Authentication, turn on Magic Auth. The page sends a 6-digit code through it (`POST /user_management/magic_auth`) and signs in with that code. Codes last 10 minutes. A new email becomes a new account only while sign-up is enabled in WorkOS; with it off, only existing users can sign in this way.
   - **GitHub:** create an OAuth app at github.com/settings/developers. Its callback URL is the one WorkOS shows under Authentication → GitHub OAuth (`https://api.workos.com/sso/oauth/github/callback` or your custom auth domain). Paste its client ID and secret into WorkOS and turn it on.
   - **Google:** in Google Cloud → APIs & Services → Credentials, create an OAuth client (Web application). Its authorised redirect URI is the one WorkOS shows under Authentication → Google OAuth. Paste its client ID and secret into WorkOS and turn it on.
   - Set `SIGN_IN_PROVIDERS` in vars to the ones turned on, by WorkOS name: `GitHubOAuth,GoogleOAuth`. A button shows only when its provider is listed, so list one only after WorkOS has it working; confirm `GoogleOAuth` on staging before it is ever listed in production. Empty means email and passkey only. At launch it stays empty: no GitHub or Google sign-in (owner decision).
   - Passkeys and SSO stay on WorkOS's hosted AuthKit page, behind the "Use a passkey or single sign-on" link: turn passkeys on there.
4. **TURN.** In Cloudflare dashboard → Realtime → TURN, create a key.
   - Set `TURN_KEY_ID` in vars.
   - Run `secret put TURN_KEY_API_TOKEN`.
5. **Paddle** (live for production; sandbox for staging, in Paddle's sandbox dashboard, its tokens `test_…`):
   - In Developer tools → Authentication, create a client-side token and set it as `PADDLE_CLIENT_TOKEN` in that environment's vars (it's public). Create an API key with prices read, transactions write, customers/portal and subscriptions write, then run `secret put PADDLE_API_KEY`.
   - In Developer tools → Notifications, create a destination at that relay's `/relay/paddle/webhook` (`https://app.overhand.dev/…` or `https://staging-app.overhand.dev/…`) with the `subscription.*` events. Run `secret put PADDLE_WEBHOOK_SECRET` with its secret key. The Worker only accepts webhooks from the `CF-Connecting-IP` addresses Paddle lists at `/ips` for the environment, so a webhook sent from anywhere else (your own machine included) gets 403.
   - Under Checkout settings, set the default payment link to that relay's `/relay/billing`. Transaction checkouts need an approved default link, and live Paddle needs the domain approved.
   - `PADDLE_ENV` is `production` for app.overhand.dev and `sandbox` for staging. Only the literal `production` reaches the live API, so never set production back to sandbox.
6. **Deploy.** Staging first, `cd relay && bunx wrangler@4.151.1 deploy --env staging`, then production with `bunx wrangler@4.151.1 deploy`. The build copies the dashboard into `relay/public`.

Test cards (staging, on sandbox): `4242 4242 4242 4242`, any future date, any CVC; `4000 0038 0000 0446` for 3-D Secure.

## Local end to end

- `bun test ./relay` covers signalling, auth, entitlements, webhooks (valid, invalid, replayed, stale), price selection, checkout and the cost model.
- `bun test packages/core/test/relay-e2e.test.ts` runs the real daemon client and a second real WebRTC peer through a stand-in relay.
- `(cd apps/web && bun run build) && bun relay/e2e.ts` runs headless Chrome as the hosted page, plus a scratch daemon (its own `OVERHAND_HOME`, port 4399) and a stand-in relay on 8790.
- **With the real Worker:**
  - Put `DEV_LOGIN=1` and a `SIGNING_KEY` from `keygen.ts` in `relay/.dev.vars` (gitignored).
  - Run `cd relay && bunx wrangler@4.151.1 d1 execute overhand-relay --local --file schema.sql`.
  - Insert an active entitlement for `dev-workspace`: `bunx wrangler@4.151.1 d1 execute overhand-relay --local --command "INSERT INTO entitlements VALUES ('dev-workspace','pro','month',1,'active','sub_1','ctm_1','pri_1',NULL,'2026-01-01T00:00:00Z',NULL,NULL)"`.
  - Copy the dashboard build into `relay/public`.
  - Run `bunx wrangler@4.151.1 dev --local` (port 8790), then `bun relay/e2e.ts --wrangler`.
