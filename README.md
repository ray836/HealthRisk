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

Hosted Postgres deployments use `pg-boss` on the same database for durable
player-window and next-day jobs. Local PGlite development uses lightweight
in-process timers. In both modes, startup scans persisted active games and
restores their next timer without extending the saved player deadline. An
overdue deadline runs immediately, while duplicate or superseded deliveries
are safe no-ops.

The current deployment target is one application instance. The durable queue
can coordinate workers across instances, but HTTP game mutations still use a
process-local lock; add a Postgres transaction/advisory lock before horizontally
scaling the web server.

## Sessions

Browser sessions use a 30-day `HttpOnly`, `SameSite=Lax` cookie. Native clients
can use the opaque bearer token returned by signup/login. Only a SHA-256 digest
of that token is stored in the database, and expired sessions are rejected and
removed.

Migration 3 intentionally revokes sessions created by older builds because
those tokens were stored in plaintext and never expired. Players sign in again
once after that migration; game membership and game state are unaffected.
