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

## Sessions

Browser sessions use a 30-day `HttpOnly`, `SameSite=Lax` cookie. Native clients
can use the opaque bearer token returned by signup/login. Only a SHA-256 digest
of that token is stored in the database, and expired sessions are rejected and
removed.

Migration 3 intentionally revokes sessions created by older builds because
those tokens were stored in plaintext and never expired. Players sign in again
once after that migration; game membership and game state are unaffected.
