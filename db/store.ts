/**
 * Working persistence schema (the snapshot store the app actually reads/writes).
 *
 * The engine treats GameState / DailySession / TurnState / exercise logs as
 * whole value objects — every operation loads one, runs pure logic, and saves it
 * back. So we persist each as a jsonb snapshot keyed by its natural id. This is a
 * legitimate snapshot store: simple, correct, and a direct fit for the access
 * pattern. (The richer normalized model in db/schema.ts — per-territory rows,
 * append-only combat history — remains the target for analytics/replay.)
 *
 * Uses drizzle pg-core so it runs on Postgres or embedded PGlite unchanged.
 */

import { pgTable, text, integer, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const games = pgTable('er_games', {
  id: text('id').primaryKey(),
  state: jsonb('state').notNull(), // GameState
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'er_sessions',
  {
    gameId: text('game_id').notNull(),
    dayNumber: integer('day_number').notNull(),
    session: jsonb('session').notNull(), // DailySession
  },
  (t) => ({ pk: primaryKey({ columns: [t.gameId, t.dayNumber] }) }),
);

export const turnStates = pgTable(
  'er_turn_states',
  {
    gameId: text('game_id').notNull(),
    dayNumber: integer('day_number').notNull(),
    playerId: text('player_id').notNull(),
    state: jsonb('state').notNull(), // TurnState
  },
  (t) => ({ pk: primaryKey({ columns: [t.gameId, t.dayNumber, t.playerId] }) }),
);

export const exerciseLogs = pgTable(
  'er_exercise_logs',
  {
    gameId: text('game_id').notNull(),
    dayNumber: integer('day_number').notNull(),
    playerId: text('player_id').notNull(),
    entries: jsonb('entries').notNull(), // ExerciseLogEntry[]
  },
  (t) => ({ pk: primaryKey({ columns: [t.gameId, t.dayNumber, t.playerId] }) }),
);

export const users = pgTable('er_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});

export const authTokens = pgTable('er_auth_tokens', {
  tokenHash: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const members = pgTable(
  'er_members',
  {
    gameId: text('game_id').notNull(),
    playerId: text('player_id').notNull(),
    userId: text('user_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.gameId, t.playerId] }) }),
);

export const chatMessages = pgTable('er_chat_messages', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull(),
  userId: text('user_id').notNull(),
  playerId: text('player_id').notNull(),
  username: text('username').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Initial snapshot-store schema, applied by db/migrations.ts as migration 1. */
export const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS er_games (
     id text PRIMARY KEY,
     state jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS er_sessions (
     game_id text NOT NULL,
     day_number integer NOT NULL,
     session jsonb NOT NULL,
     PRIMARY KEY (game_id, day_number)
   )`,
  `CREATE TABLE IF NOT EXISTS er_turn_states (
     game_id text NOT NULL,
     day_number integer NOT NULL,
     player_id text NOT NULL,
     state jsonb NOT NULL,
     PRIMARY KEY (game_id, day_number, player_id)
   )`,
  `CREATE TABLE IF NOT EXISTS er_exercise_logs (
     game_id text NOT NULL,
     day_number integer NOT NULL,
     player_id text NOT NULL,
     entries jsonb NOT NULL,
     PRIMARY KEY (game_id, day_number, player_id)
   )`,
  `CREATE TABLE IF NOT EXISTS er_users (
     id text PRIMARY KEY,
     username text NOT NULL UNIQUE,
     password_hash text NOT NULL,
     created_at text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS er_auth_tokens (
     token text PRIMARY KEY,
     user_id text NOT NULL,
     created_at text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS er_members (
     game_id text NOT NULL,
     player_id text NOT NULL,
     user_id text NOT NULL,
     PRIMARY KEY (game_id, player_id)
   )`,
];
