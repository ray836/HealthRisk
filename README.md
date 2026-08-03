# Exercise Risk

Exercise Risk is a daily multiplayer strategy game where health goals earn
reinforcements.

## Database modes

Local development persists to embedded PGlite in `./.data`:

```powershell
npm.cmd run serve
```

A hosted deployment uses Postgres:

```text
NODE_ENV=production
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/healthrisk?sslmode=require
```

Production startup fails if `DATABASE_URL` is missing, preventing an accidental
deployment with instance-local storage. Schema migrations run automatically and
are recorded in `er_schema_migrations`. Connection logs never include database
credentials.

Copy `.env.example` for the available local and hosted database settings.

## Daily turn scheduling

The daily schedule and current player deadline are persisted with the game
session. A late invocation advances from those planned timestamps rather than
granting extra time, so it can safely catch up multiple missed windows.

- Local PGlite development uses lightweight in-process timers and startup
  recovery.
- A permanent Postgres process can use `pg-boss` workers.
- Vercel uses request-safe reconciliation because a serverless function cannot
  own resident timers. Loading a game or submitting a game mutation first
  catches up that game. An authenticated Vercel Cron at `04:00 UTC` reconciles
  idle games once per day as a backstop that fits the Hobby plan.

Every scheduled transition and browser mutation takes the same logical
per-game lock. Postgres uses a transaction-scoped advisory lock, so separate
Vercel invocations cannot resolve one player window twice. Duplicate and
superseded deliveries remain safe no-ops.

Before deploying the cron route, create a high-entropy, single-line secret and
set it as `CRON_SECRET` in the Vercel Production environment. Vercel sends it
to the route as `Authorization: Bearer <CRON_SECRET>`; missing or incorrect
credentials receive `401`.

The Hobby cron is only an idle-game backstop. Player requests enforce due
deadlines immediately. If idle games must advance close to the exact deadline,
use a more frequent Vercel cron plan or an external scheduler to call the same
signed endpoint; no game-logic changes are required.

## Sessions

Browser sessions use a 30-day `HttpOnly`, `SameSite=Lax` cookie. Native clients
can use the opaque bearer token returned by signup/login. Only a SHA-256 digest
of that token is stored in the database, and expired sessions are rejected and
removed.

Migration 3 intentionally revokes sessions created by older builds because
those tokens were stored in plaintext and never expired. Players sign in again
once after that migration; game membership and game state are unaffected.

## Shared API client

The browser and future native clients share the build-free client in
`public/api-client.js`. It provides:

- a configurable API base URL;
- cookie sessions for the web app or bearer-token sessions for native clients;
- normalized `ApiError` values for network, authentication, and stale-game
  failures;
- automatic revision attachment for concurrency-safe game mutations.

Serializable request and response contracts live in
`src/client/apiTypes.ts`, with declarations for the JavaScript client in
`public/api-client.d.ts`.

Mutating requests accept an `Idempotency-Key` header. The server stores a
request fingerprint and successful response for 24 hours, so a SwiftUI client
can safely retry a move or health log after a timeout without applying it
twice. Reusing a key with a different body is rejected. Every response also
includes `X-Request-Id`, and JSON errors include `requestId` and `retryable`.

The hosted API can be selected in a client with:

```js
import { createApiClient } from './api-client.js';

const api = createApiClient({
  baseUrl: 'https://health-risk-ecru.vercel.app',
  token: nativeSessionToken,
});
```

The current browser remains same-origin by default. Its API origin can be
overridden with the `healthrisk-api-base-url` meta tag in `public/index.html`
when a separate frontend host is introduced.

## Native iOS readiness

The server remains authoritative; a SwiftUI app should never write Postgres or
reimplement turn validation. Native clients use the bearer token returned by
signup/login and can discover supported behavior at `GET /api/meta`. The
OpenAPI 3.1 contract at `/openapi.json` can drive Swift model/client generation.

Account and game lifecycle endpoints include:

- `GET /api/games` for waiting, active, practice, completed, and cancelled games;
- new multiplayer waiting rooms support up to 10 joined players and may start once at least 2 have joined;
- `POST /api/games/:id/leave` to leave a lobby or forfeit an active game;
- `DELETE /api/games/:id/members/:playerId` for creator lobby moderation;
- `DELETE /api/account` with `{ "password": "..." }` for in-app account deletion.

### Notifications

`POST /api/devices` registers an APNs token and `GET /api/notifications` returns
the durable notification inbox. Lobby joins/removals, game starts, turns, chat,
and game completion create inbox records. If Apple credentials are configured,
the same events are delivered through APNs. The iOS client should schedule a
local deadline reminder from `game.schedule.moveDeadlineAt`; APNs delivery is a
prompt to refresh, never the source of truth.

Configure `PUBLIC_APP_URL`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `APNS_KEY_ID`, and
`APNS_PRIVATE_KEY` in Vercel when the Apple identifiers exist. Until then the
notification inbox works and APNs delivery remains safely disabled.

### Universal links

Invitations use `/join/:gameId` and existing games use `/game/:gameId`. Both
paths fall back to the web app. The server publishes
`/.well-known/apple-app-site-association` from `APPLE_TEAM_ID` and
`IOS_BUNDLE_ID`; add the production domain to the SwiftUI target's Associated
Domains entitlement as `applinks:<domain>`.

### Chat safety

Game chat is member-only, limited to six messages per ten seconds, and supports
deleting your own message, muting a participant, and reporting a message.
Muted senders are removed from the viewer's chat and do not create chat push
notifications for that viewer. Account deletion anonymizes retained public game
conversation while removing private account, device, and notification data.
