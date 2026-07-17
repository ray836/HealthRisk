/**
 * Exercise Risk — persistence schema (Postgres via Drizzle ORM).
 *
 * This mirrors the engine's in-memory GameState (src/engine/types.ts) but is
 * the durable source of truth for a long-running, multi-user, daily-cadence
 * game. Design goals:
 *
 *   - Append-only history where it matters (exercise logs, combat rounds, turn
 *     events) so the game is auditable and the future UI can replay/animate.
 *   - Current board state stored explicitly (territory ownership + armies) so a
 *     read never has to re-fold the whole event log.
 *   - Everything reproducible: seeds are stored, not just their outputs.
 *
 * Money/troops are integers. Timestamps are timestamptz (store UTC; the game's
 * configured IANA timezone governs when the 7pm window opens).
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  bigint,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const gameStatus = pgEnum('game_status', ['setup', 'active', 'finished']);
export const playerStatus = pgEnum('player_status', [
  'active',
  'auto_piloted',
  'forfeited',
  'eliminated',
]);
export const turnPhase = pgEnum('turn_phase', ['reinforce', 'attack', 'fortify', 'done']);
export const turnResolution = pgEnum('turn_resolution', [
  'pending',
  'completed', // player finished in time
  'auto_resolved', // missed window -> AI/defensive turn plan executed
  'skipped', // eliminated/forfeited; no turn taken
]);
/** How an auto_resolved turn's plan was produced (§5). */
export const autoSource = pgEnum('auto_source', ['note_ai', 'defensive_fallback']);
export const attackEndReason = pgEnum('attack_end_reason', [
  'capture',
  'stop_loss',
  'attacker_min',
]);
export const exerciseLogStatus = pgEnum('exercise_log_status', [
  'reported',
  'approved',
  'rejected', // admin dispute resolution (§8)
]);

// ---------------------------------------------------------------------------
// Users & Games
// ---------------------------------------------------------------------------

/** A person; may belong to many games. Auth details live elsewhere. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable('games', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: gameStatus('status').notNull().default('setup'),
  adminUserId: uuid('admin_user_id')
    .notNull()
    .references(() => users.id),

  /**
   * Full GameConfig blob (exercise table, caps, window time, timezone,
   * missesBeforeAutoResolve, autoForfeitAfterDays, maxAttacksPerTurn). Locked
   * once status leaves 'setup' (§3). Stored as JSON because it's read whole and
   * never queried field-by-field. The exercise table is *also* normalized into
   * exercise_types below for referential integrity of logs.
   */
  config: jsonb('config').notNull(),

  /** Master seed; every derived seed (deal, turn order, combats) descends from it. */
  seed: bigint('seed', { mode: 'number' }).notNull(),

  /** Fixed randomized base line order (§2.5): array of game_players.id. */
  turnOrder: jsonb('turn_order').notNull().default('[]'),

  dayNumber: integer('day_number').notNull().default(0),
  winnerPlayerId: uuid('winner_player_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/** Normalized exercise conversion rows (§3). Immutable once the game starts. */
export const exerciseTypes = pgTable(
  'exercise_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // 'running'
    label: text('label').notNull(),
    unitLabel: text('unit_label').notNull(), // 'mile'
    /** Troops per unit; fractional allowed, so store numerator/denominator to
     *  avoid float drift in the DB (engine does the math). */
    troopsPerUnitNum: integer('troops_per_unit_num').notNull(),
    troopsPerUnitDen: integer('troops_per_unit_den').notNull().default(1),
    dailyUnitCap: integer('daily_unit_cap'), // null = uncapped for this type
  },
  (t) => ({
    uqGameKey: uniqueIndex('uq_exercise_game_key').on(t.gameId, t.key),
  }),
);

// ---------------------------------------------------------------------------
// Players (a user's seat in a specific game)
// ---------------------------------------------------------------------------

export const gamePlayers = pgTable(
  'game_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    seatName: text('seat_name').notNull(), // display name within this game
    color: text('color'), // UI later
    status: playerStatus('status').notNull().default('active'),

    /** Banked troops awaiting placement (§3). Derivable from logs+turns but
     *  materialized for fast reads. */
    pendingReinforcements: integer('pending_reinforcements').notNull().default(0),

    /** Drives admin/auto forfeit of inactive players (§8, open item #4). */
    consecutiveAutoResolvedDays: integer('consecutive_auto_resolved_days')
      .notNull()
      .default(0),

    /**
     * Persistent standing-orders note (§5). If the player misses their single
     * 20-minute window, an AI resolves their full turn from this text. Empty =>
     * deterministic defensive fallback. Set-and-forget; editable anytime.
     */
    standingOrdersNote: text('standing_orders_note').notNull().default(''),

    eliminatedAt: timestamp('eliminated_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqGameUser: uniqueIndex('uq_player_game_user').on(t.gameId, t.userId),
    byGame: index('idx_players_game').on(t.gameId),
  }),
);

// ---------------------------------------------------------------------------
// Board state (current ownership + armies)
// ---------------------------------------------------------------------------

/**
 * One row per territory per game. owner_player_id NULL = neutral garrison
 * (§2.3). Territory ids are the engine's string keys ('alaska', ...) — the map
 * topology itself lives in code (src/engine/map.ts), not the DB, since it's
 * static reference data.
 */
export const territories = pgTable(
  'territories',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    territoryId: text('territory_id').notNull(), // 'alaska'
    ownerPlayerId: uuid('owner_player_id').references(() => gamePlayers.id), // NULL = neutral
    armies: integer('armies').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.gameId, t.territoryId] }),
    byOwner: index('idx_territories_owner').on(t.gameId, t.ownerPlayerId),
  }),
);

// ---------------------------------------------------------------------------
// Exercise logs (§3) — append-only, one row per reported activity
// ---------------------------------------------------------------------------

export const exerciseLogs = pgTable(
  'exercise_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => gamePlayers.id, { onDelete: 'cascade' }),
    exerciseKey: text('exercise_key').notNull(),
    units: integer('units').notNull(), // whole units; use minutes/tenths if you need finer
    /** The game "exercise day" this counts toward (a date in the game tz). */
    exerciseDate: date('exercise_date').notNull(),
    status: exerciseLogStatus('status').notNull().default('reported'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id),
  },
  (t) => ({
    byPlayerDay: index('idx_logs_player_day').on(t.playerId, t.exerciseDate),
  }),
);

// ---------------------------------------------------------------------------
// Turn sessions, turns, and the "line"
// ---------------------------------------------------------------------------

/** One nightly window per game per day (§5). */
export const turnSessions = pgTable(
  'turn_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    dayNumber: integer('day_number').notNull(),
    /** Live queue snapshot (array of game_players.id, front first). Updated as
     *  turns complete/miss; the immutable per-player record is in `turns`. */
    queue: jsonb('queue').notNull().default('[]'),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(), // 7pm in game tz
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    uqGameDay: uniqueIndex('uq_session_game_day').on(t.gameId, t.dayNumber),
  }),
);

/** One row per player per day: the outcome of their daily turn. */
export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => turnSessions.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => gamePlayers.id, { onDelete: 'cascade' }),
    phase: turnPhase('phase').notNull().default('reinforce'),
    resolution: turnResolution('resolution').notNull().default('pending'),
    /** Reinforcements available to this turn (snapshot of pending at turn start). */
    reinforcementsGranted: integer('reinforcements_granted').notNull().default(0),

    // --- Auto-resolution provenance (§5). Set only when resolution = 'auto_resolved'.
    autoSource: autoSource('auto_source'), // note_ai | defensive_fallback
    /** The player's note snapshot the AI acted on (for audit). */
    autoNoteSnapshot: text('auto_note_snapshot'),
    /** The exact TurnPlan executed (placements/attacks/fortify + rationale). */
    autoPlan: jsonb('auto_plan'),
    /** applyTurnPlan report: what was applied vs. rejected. */
    autoReport: jsonb('auto_report'),

    windowOpensAt: timestamp('window_opens_at', { withTimezone: true }),
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    uqSessionPlayer: uniqueIndex('uq_turn_session_player').on(t.sessionId, t.playerId),
  }),
);

/**
 * Append-only actions taken within a turn (reinforce placements, fortify move).
 * Attacks get their own richer table below. This gives a full, ordered replay.
 */
export const turnActions = pgTable(
  'turn_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // ordering within the turn
    kind: text('kind').notNull(), // 'reinforce' | 'fortify'
    /** Payload: reinforce -> {placements:[{territoryId,count}]}; fortify -> {fromId,toId,count} */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqTurnSeq: uniqueIndex('uq_action_turn_seq').on(t.turnId, t.seq),
  }),
);

// ---------------------------------------------------------------------------
// Combat (§6) — header + per-round log for replay/audit
// ---------------------------------------------------------------------------

export const attacks = pgTable(
  'attacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // order among attacks in this turn
    fromTerritoryId: text('from_territory_id').notNull(),
    toTerritoryId: text('to_territory_id').notNull(),
    committedTroops: integer('committed_troops').notNull(),
    stopLoss: integer('stop_loss').notNull(),
    /** Seed used for this combat; result is fully reproducible from it (§6). */
    seed: bigint('seed', { mode: 'number' }).notNull(),
    endReason: attackEndReason('end_reason').notNull(),
    captured: boolean('captured').notNull(),
    attackerLosses: integer('attacker_losses').notNull(),
    defenderLosses: integer('defender_losses').notNull(),
    survivingAttackers: integer('surviving_attackers').notNull(),
    remainingDefenders: integer('remaining_defenders').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqTurnSeq: uniqueIndex('uq_attack_turn_seq').on(t.turnId, t.seq),
  }),
);

/**
 * Per-exchange dice log. Optional to persist (fully derivable by replaying the
 * seed), but stored so the UI can animate without recomputation and audits are
 * trivial. Drop this table if storage matters more than convenience.
 */
export const attackRounds = pgTable(
  'attack_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attackId: uuid('attack_id')
      .notNull()
      .references(() => attacks.id, { onDelete: 'cascade' }),
    roundNo: integer('round_no').notNull(),
    attackerDice: jsonb('attacker_dice').notNull(), // number[]
    defenderDice: jsonb('defender_dice').notNull(), // number[]
    attackerLosses: integer('attacker_losses').notNull(),
    defenderLosses: integer('defender_losses').notNull(),
  },
  (t) => ({
    uqAttackRound: uniqueIndex('uq_round_attack_no').on(t.attackId, t.roundNo),
  }),
);
