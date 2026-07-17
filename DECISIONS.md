# Exercise Risk — Engine Decisions

Data model + core turn engine, built as pure, UI-free, testable logic. Each
open-item decision is isolated to one function or one config field — nothing is
baked into the schema in a way that's expensive to revise.

## Session 2 — turn-window rule change

Ruleset §5 updated:

- **One window, no requeue.** A player gets a single 20-minute window. Missing
  it auto-resolves the turn immediately — the old "1st miss → back of line, 2nd
  miss → auto-resolve" flow is gone. `turnSession.expireWindow` no longer
  requeues; `missesBeforeAutoResolve` config removed.
- **AI note-driven auto-resolution.** Each player keeps a persistent
  standing-orders note. On a miss, an AI reads the board + note and produces a
  full `TurnPlan` (reinforce/attack/fortify), which the engine re-validates and
  applies. Empty note → deterministic defensive fallback (see open item #2).
  Attacks use a conservative `autoAttackStopLoss` unless the note says otherwise.
  The AI call itself is service-layer (behind `planner.ts`'s `TurnPlanner`); the
  engine stays pure.

## Recommended stack

**TypeScript everywhere + Postgres (Drizzle ORM) + a durable job runner.**

- **TypeScript** — one language for the engine, the future API, and the future
  web UI, so the domain types (`src/engine/types.ts`) are shared, not
  re-described per layer. The engine is written as pure functions with zero
  runtime deps, so it's trivially testable and portable.
- **Postgres** — relational, transactional daily state with real history
  (exercise logs, turn events, combat rounds). Schema in `db/schema.ts`.
- **Drizzle ORM** — SQL-first, lightweight, great TS inference; less magic than
  Prisma for a state machine like this. (Swap for Prisma if you prefer.)
- **Durable scheduler** (not yet built) — the 7pm window + per-player 20-minute
  timers need something that survives restarts. Recommend **pg-boss** (job queue
  on the same Postgres, no new infra) or a small cron worker that calls the pure
  `expireWindow()` / `completeTurn()` reducers. Deliberately kept out of the
  engine so timing logic stays pure and testable.
- **Determinism** — every random outcome (territory deal, turn order, each
  combat) descends from a stored seed, so any game state is reproducible and
  auditable, and the future UI can replay/animate exactly what the server
  computed.

Suggested layering: `engine` (pure, done) → `services` (load state, call engine,
persist, enqueue timers) → `api` (HTTP/WebSocket) → `web` (UI). Only the first
layer exists so far.

## Open items — how each was resolved

| # | Item | Decision (default taken) | Where it lives / how to change |
|---|------|--------------------------|--------------------------------|
| 1 | Board scaling for 10 players | **Neutral garrisons.** Deal 42 territories round-robin; leftovers become neutral (2 armies, ownerless, attackable, never act). 10 players → 40 owned + 2 neutral. | `setup.ts` `dealTerritories`, `NEUTRAL_GARRISON_ARMIES`. Starting-army totals for 7–10 players scale via `startingArmies()` in `map.ts` (keeps ~120 armies on the board). |
| 2 | Auto-resolution | **AI note-driven full turn** (updated session 2). A missed window is resolved by an AI that reads the player's persistent standing-orders note and returns a full `TurnPlan` (reinforce/attack/fortify); the engine re-validates and applies it, skipping anything illegal. Empty note → deterministic defensive fallback: whole bank on most-threatened border territory (`threat(T) = Σ(enemy/neutral neighbor armies) − armies(T)`), no attack, no fortify. | AI seam: `planner.ts` (`buildPlannerContext`, `TurnPlanner`). Executor: `turnPlan.ts` `applyTurnPlan`. Fallback: `autoplace.ts` `defensiveTurnPlan` / `chooseAutoPlaceTarget`. |
| 3 | Combat odds | **Logged step-by-step simulation** of classic Risk dice (attacker ≤3, defender ≤2, defender wins ties), seeded/deterministic, halting on capture / stop-loss / 1-troop floor. Produces a round log for animation + audit. | `combat.ts` `resolveAttack`. To switch to single-pass closed-form, replace the loop; the result shape can stay. |
| 4 | Inactive players | **Auto-resolve defensively each day + Admin forfeit power, plus optional auto-forfeit after N consecutive auto-resolved days** (`autoForfeitAfterDays`, null = admin-only). Forfeited player's territories become neutral so the board stays contestable. | `game.ts` `forfeitPlayer`, `applyTurnEffect`; config field `autoForfeitAfterDays`. |
| 5 | Fortify | **Connected chain, one move** (modern Risk): move once between any two owned territories joined by an unbroken chain of owned territory (BFS). | `fortify.ts` `areConnectedThroughOwned`. For adjacent-only, swap the BFS for an `areAdjacent` check. |
| 6 | Attacks per turn | **Unlimited by default**, but a `maxAttacksPerTurn` config field exists (null = unlimited) so you can cap it later without a schema change. | `types.ts` `GameConfig.maxAttacksPerTurn`; enforce in the turn/attack service layer. |

If any default is wrong for you, tell me which number(s) and I'll adjust — each
is a small, localized change.

## What's built

Pure engine (`src/engine/`) — 79 passing tests across engine + services, clean `tsc`:

- `types.ts` — domain model the engine reasons about.
- `map.ts` — canonical 42-territory board, symmetric adjacency (test-guarded),
  continents, starting-army table.
- `rng.ts` — seeded deterministic PRNG (mulberry32) + string→seed.
- `reinforce.ts` — exercise→troop conversion with per-exercise + daily-total
  caps; reinforcement placement validate/apply.
- `combat.ts` — attack resolution, stop-loss, round log, validate/apply.
- `fortify.ts` — connected-chain movement.
- `autoplace.ts` — defensive auto-placement + `defensiveTurnPlan` (empty-note fallback).
- `turnPlan.ts` — `TurnPlan` type + `applyTurnPlan`: validates & applies an
  AI/fallback turn plan, skipping illegal actions, seeded & reproducible.
- `planner.ts` — AI seam: `buildPlannerContext` (pure) + `TurnPlanner` interface.
- `turnSession.ts` — the daily "line": queue; a single missed window → immediate
  auto-resolve (no requeue).
- `setup.ts` — seeded game creation, neutral deal, starting armies.
- `game.ts` — banking earned troops, elimination, win, forfeit, applying
  turn-session effects (auto-resolution runs the AI/fallback `TurnPlan`).

`db/schema.ts` — Postgres/Drizzle schema mirroring the engine (users, games,
players, territories, exercise logs, turn sessions/turns/actions, attacks +
rounds). Append-only history where it matters; current board materialized for
fast reads; seeds stored for reproducibility.

## Service layer (`src/services/`, session 3)

Wires the pure engine to persistence, the clock, and the AI. All I/O is
injected, so orchestration is unit-testable with an in-memory repo + a stub
planner (12 service tests, no network).

- `aiPlanner.ts` — the AI `TurnPlanner`: Claude (`claude-opus-4-8`, adaptive
  thinking, **structured outputs** constrained to `TURN_PLAN_SCHEMA`) turns a
  `PlannerContext` (board + standing-orders note) into a `TurnPlan`. The note is
  passed as clearly-delimited **data**, not instructions; the engine
  re-validates every action, so a bad/injected note is bounded to that player's
  own turn. Throws on refusal/truncation/bad output → caller falls back to the
  deterministic defensive plan. Credentials resolve from env / `ant auth login`
  profile (no hardcoded key).
- `repository.ts` — `GameRepository` interface + `InMemoryGameRepository`. A
  Drizzle-backed impl maps `GameState`/`DailySession` onto `db/schema.ts`.
- `orchestrator.ts` — `openDailySession`, `markTurnComplete`,
  `handleWindowExpiry` (AI plan → defensive fallback → engine → persist). Clock
  injected for testable timing.

## Scheduler (`src/services/scheduling/`, session 4)

Turns the orchestrator into a game that ticks daily. Timing logic is pure and
tested (incl. DST); the durable timer is behind a `JobQueue` seam so the whole
cycle is driven deterministically in tests with a fake queue + virtual clock
(8 scheduler tests).

- `time.ts` — timezone-aware `nextWindowStart` / `windowDeadline` via
  `Intl.DateTimeFormat` (no tz library). Verified across the EST→EDT boundary.
- `jobQueue.ts` — `JobQueue` interface + `FakeJobQueue` (`runDue(now)` drains
  due jobs, incl. ones handlers reschedule — a single call advances a whole day).
- `gameScheduler.ts` — two job types (`session_open` at 19:00, `player_window`
  20 min after a player reaches the front). After every event it `advance`s:
  schedule the next player's window, or next day's open. **`player_window`
  handlers are stale-safe** — if the front player changed (they completed in
  time), the timer no-ops, so cancellation is never load-bearing.
- `pgBossJobQueue.ts` — production adapter over pg-boss v12 (durable jobs on the
  same Postgres). Thin by design; all logic is in `gameScheduler.ts`. Typechecks
  against installed pg-boss; runs only against a live DB.

## Interactive turn API (`src/services/turnApi.ts`, session 5)

The surface a *present* player drives during their window (5 tests):
`placeReinforcements`, `attack`, `fortify`, `endTurn`, plus a UI-ready
`turnView`. Every action goes through the engine validators (can't produce an
illegal board), is guarded by "you must be at the front of the line", and is
phase-ordered **reinforce\* → attack\* → fortify? → end**. `maxAttacksPerTurn`
is enforced here too. `endTurn` delegates to the scheduler's `onPlayerCompleted`
(advances the line, schedules the next window). Per-turn phase/attack-count lives
in a `TurnState` persisted via the repository (maps to the `turns.phase` column).

- "Your window expired" needs no timer check: once the scheduler auto-resolves
  and advances the line, you're no longer at the front, so the guard rejects you.
- A win mid-turn is handled — attacks run elimination/win checks, and
  `handleWindowExpiry` now no-ops on a finished game.

## Playable demo (`src/server/`, `public/`, session 6)

A no-database way to actually play in a browser. `npm run serve` starts an
Express server on the in-memory repo and serves a single-page board.

- `src/server/server.ts` — JSON API over `TurnApi` + orchestrator:
  `POST /api/games`, `GET /api/games/:id`, and `/reinforce`, `/attack`,
  `/fortify`, `/end`, plus `/expire` (dev: auto-resolve the current player to
  simulate a missed window). Hot-seat: the UI acts as whoever's at the front of
  the line; `TurnError`s map to HTTP 400 with `{error, message}`.
- `public/index.html` — clickable board grouped by continent, colored by owner,
  with reinforce/attack/fortify modes, an action log, and combat results.
- Auto-resolution here uses the deterministic defensive fallback (no API
  credits); swap in `createAiPlanner()` to use the note-driven AI.
- **Geographic SVG map** (`public/index.html`): 42 territories positioned by
  continent, adjacency lines (incl. sea routes), army markers colored by owner;
  reuses the same click/selection logic as the old list view. Coordinates live
  in a `POS` table — easy to nudge; swapping in a real geo-SVG later is isolated.
- **Exercise logging** (`src/services/exerciseApi.ts`, `/exercise` endpoint,
  sidebar panel): log miles/minutes → troops banked, with per-exercise and
  daily-total caps applied against the day's running total (5 tests). This is
  §3, the game's defining mechanic, now real in the demo instead of stubbed.
- **Standard start-of-turn reinforcements** (`src/engine/bonus.ts`,
  `src/services/turnStart.ts`): on top of exercise troops, a player gets
  `floor(territories/3)` (min 3) plus each fully-controlled continent's bonus
  (NA 5, SA 2, EU 5, AF 3, AS 7, AU 2). Granted **once per turn** via
  `ensureTurnStarted`, which fires whether the player shows up (turn API / game
  view) or misses their window (auto-resolution grants it before the defensive
  placement). Snapshotted in `TurnState.startBonus/startContinents` for display.
  A note in the UI shows the breakdown (6 tests: bonus math + grant-once).
- **Phase auto-advance** (§4): placing your last reinforcement ends the reinforce
  phase and moves to attack automatically; reinforcements are mandatory before
  attacking; the UI mode-buttons follow the server phase.
- **Win overlay + turn-start log** in the UI.
- Verified live: create/read/reinforce/exercise return 200 with updated state;
  caps enforce (+0 past a cap); illegal move → 400 `not_adjacent`, unknown
  exercise → 400 `unknown_exercise`.

## Persistence (`db/store.ts`, `db/client.ts`, `src/services/drizzleRepository.ts`, session 7)

Games now survive restarts. `DrizzleGameRepository` implements the same
`GameRepository` interface as the in-memory one, persisting each engine value
(GameState / DailySession / TurnState / exercise logs) as a **jsonb snapshot** —
a direct fit for the engine's load→run→save value semantics.

- **Driver**: defaults to embedded **PGlite** (Postgres compiled to a local
  `.data/` file store) so persistence works with **zero setup**; set
  `DATABASE_URL` for a real Postgres server (identical pg-core schema), or
  `EXRISK_MEMORY=1` for the old ephemeral store. The server picks the store at
  startup and logs which one.
- **Store schema** (`db/store.ts`): four small snapshot tables (`er_games`,
  `er_sessions`, `er_turn_states`, `er_exercise_logs`) with idempotent bootstrap
  DDL — no migration tooling needed for the demo. The richer normalized model in
  `db/schema.ts` (per-territory rows, append-only combat history) remains the
  target for analytics/replay.
- **Verified**: 5 PGlite round-trip tests (game/session/turn-state-with-bonus/
  exercise-log upserts); and a two-process check (`scripts/persistCheck.ts`)
  where a fresh process loads a game the previous one wrote to disk.

## Real turn timers (session 8)

Turns now run on a real timed window, not just manual "End turn":

- **`InProcessJobQueue`** (`jobQueue.ts`): a `setTimeout`-based `JobQueue` for the
  zero-setup PGlite mode (no Postgres server for pg-boss). Timers don't survive a
  restart; the scheduler re-arms from persisted state on reboot. pg-boss remains
  the durable path against a real Postgres.
- **Server wiring**: the `GameScheduler` is created in `main()`; game creation
  opens day 0 and arms the first player's window; ending a turn (or `/expire`)
  advances via the scheduler, which arms the next player's window or opens the
  next day. The window **deadline is persisted on the session**
  (`DailySession.windowExpiresAt`) and surfaced in the game view.
- **Auto-resolve on expiry**: when a window elapses the timer fires
  `handleWindowExpiry` — the player still gets their start-of-turn reinforcements,
  then the defensive fallback places them. Verified by a fake-timer integration
  test (window elapses → player `auto_piloted` → next player armed) plus 3
  `InProcessJobQueue` unit tests.
- **UI**: a live `⏳ m:ss` countdown (turns red under 15s) and gentle polling so
  the auto-resolve/day-rollover shows up while you're idle. Manual End turn still
  works — the timer is a backstop, not a forced wait.
- **Config**: demo window defaults to 3 min (`EXRISK_WINDOW_MIN`, fractional ok —
  e.g. `0.5` = 30s); demo opens the next day immediately for continuous play,
  while the real cadence (`nextDayOpenAt` default) uses the next 7pm.

## Auth & multiplayer (session 9)

Real accounts + seat ownership; the engine stays identity-free (auth lives in
the service/persistence layer).

- **`authApi.ts`**: username/password accounts, passwords hashed with built-in
  `scrypt` (per-user salt, constant-time verify, no new deps); opaque bearer
  tokens stored in the repo (persist + revocable via logout). Endpoints:
  `/api/auth/{signup,login,logout,me}`.
- **`membership.ts`**: maps users → the seats they control. `claimSeat`,
  `claimOpenSeat` (join flow), `claimAllSeats` (practice), `seatFor`.
- **Authorization** (server): a turn action authorizes against the **current**
  front-of-line seat, which the caller must own — so normal players act only on
  their turn, and **"practice" = one user owns every seat** (hot-seat with no
  separate code path). The engine's turn guard independently re-checks it's that
  seat's turn.
- **Repository**: `er_users` / `er_auth_tokens` / `er_members` tables (Drizzle +
  in-memory), so accounts and seat assignments persist.
- **UI**: login/signup bar, bearer token in `localStorage` sent on every
  request, a **practice** checkbox, **join-by-code**, "(you)" seat markers, and
  actions gated on `yourTurn` (spectators see "Waiting for Player X").
- **Verified**: 12 tests (auth hashing/signup/login/logout, membership
  claim/join/practice, Drizzle round-trips) + live checks — unauth → 401, seat
  owner → 200, non-member → 409 `not_your_turn`.

## Not built yet

- **Durable timers across restart** — the in-process timer is fine for local/demo
  but resets on reboot; pg-boss v12's `fromDrizzle` adapter lets the job queue
  share the game DB for cross-restart durability on real Postgres.
- **Exercise dispute resolution** (§8) — admin approve/reject of reported logs.
  Logging itself is built; the approval workflow + admin roles are not.

### Running the AI planner for real

The planner is verified end-to-end via a stubbed client (same code path). To
exercise the live model, set credentials (`ANTHROPIC_API_KEY` or `ant auth
login`) and call `createAiPlanner()` — it bills the Anthropic API, so it's left
off by default.
