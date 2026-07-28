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
