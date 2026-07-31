/**
 * Small, driver-neutral migration runner for the snapshot store.
 *
 * Both hosted Postgres and local PGlite execute these migrations. Keeping the
 * migration history in code means the compiled server has everything required
 * to boot, while the version table prevents repeatedly treating startup DDL as
 * the schema-management strategy.
 */

import { DDL_STATEMENTS } from './store.js';

export interface SqlMigrationAdapter {
  execute(sql: string): Promise<void>;
  rows<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  statements: string[];
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  {
    version: 1,
    name: 'snapshot_store',
    statements: DDL_STATEMENTS,
  },
  {
    version: 2,
    name: 'multiplayer_lookup_indexes',
    statements: [
      'CREATE INDEX IF NOT EXISTS er_members_user_idx ON er_members (user_id)',
      'CREATE INDEX IF NOT EXISTS er_auth_tokens_user_idx ON er_auth_tokens (user_id)',
      'CREATE INDEX IF NOT EXISTS er_games_updated_idx ON er_games (updated_at)',
    ],
  },
  {
    version: 3,
    name: 'expiring_hashed_sessions',
    statements: [
      'ALTER TABLE er_auth_tokens ADD COLUMN IF NOT EXISTS expires_at text',
      // Pre-migration tokens were plaintext and permanent. Revoke them once
      // instead of carrying insecure browser sessions forward.
      'DELETE FROM er_auth_tokens',
      'ALTER TABLE er_auth_tokens ALTER COLUMN expires_at SET NOT NULL',
    ],
  },
  {
    version: 4,
    name: 'game_chat',
    statements: [
      `CREATE TABLE IF NOT EXISTS er_chat_messages (
         id text PRIMARY KEY,
         game_id text NOT NULL,
         user_id text NOT NULL,
         player_id text NOT NULL,
         username text NOT NULL,
         body text NOT NULL,
         created_at text NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS er_chat_messages_game_created_idx
      ON er_chat_messages (game_id, created_at)`,
    ],
  },
  {
    version: 5,
    name: 'mobile_readiness',
    statements: [
      'ALTER TABLE er_chat_messages ADD COLUMN IF NOT EXISTS deleted_at text',
      `CREATE TABLE IF NOT EXISTS er_idempotency_records (
         user_id text NOT NULL,
         scope text NOT NULL,
         idempotency_key text NOT NULL,
         request_hash text NOT NULL,
         response_status integer,
         response_body jsonb,
         created_at text NOT NULL,
         expires_at text NOT NULL,
         PRIMARY KEY (user_id, scope, idempotency_key)
       )`,
      'CREATE INDEX IF NOT EXISTS er_idempotency_expiry_idx ON er_idempotency_records (expires_at)',
      `CREATE TABLE IF NOT EXISTS er_device_registrations (
         id text PRIMARY KEY,
         user_id text NOT NULL,
         platform text NOT NULL,
         token text NOT NULL UNIQUE,
         environment text NOT NULL,
         created_at text NOT NULL,
         updated_at text NOT NULL,
         disabled_at text
       )`,
      'CREATE INDEX IF NOT EXISTS er_device_registrations_user_idx ON er_device_registrations (user_id)',
      `CREATE TABLE IF NOT EXISTS er_user_notifications (
         id text PRIMARY KEY,
         user_id text NOT NULL,
         game_id text,
         type text NOT NULL,
         title text NOT NULL,
         body text NOT NULL,
         deep_link text,
         created_at text NOT NULL,
         read_at text
       )`,
      'CREATE INDEX IF NOT EXISTS er_user_notifications_user_created_idx ON er_user_notifications (user_id, created_at)',
      `CREATE TABLE IF NOT EXISTS er_chat_mutes (
         game_id text NOT NULL,
         user_id text NOT NULL,
         muted_user_id text NOT NULL,
         created_at text NOT NULL,
         PRIMARY KEY (game_id, user_id, muted_user_id)
       )`,
      `CREATE TABLE IF NOT EXISTS er_chat_reports (
         id text PRIMARY KEY,
         game_id text NOT NULL,
         message_id text NOT NULL,
         reporter_user_id text NOT NULL,
         reason text NOT NULL,
         status text NOT NULL,
         created_at text NOT NULL
       )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS er_chat_reports_unique_idx ON er_chat_reports (message_id, reporter_user_id)',
    ],
  },
];

export const LATEST_DATABASE_VERSION =
  DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1]?.version ?? 0;

export async function applyDatabaseMigrations(
  adapter: SqlMigrationAdapter,
): Promise<number> {
  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS er_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows = await adapter.rows<{ version: number }>(
    'SELECT version FROM er_schema_migrations ORDER BY version',
  );
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const migration of DATABASE_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await adapter.execute('BEGIN');
    try {
      for (const statement of migration.statements) await adapter.execute(statement);
      const safeName = migration.name.replaceAll("'", "''");
      await adapter.execute(
        `INSERT INTO er_schema_migrations (version, name)
         VALUES (${migration.version}, '${safeName}')
         ON CONFLICT (version) DO NOTHING`,
      );
      await adapter.execute('COMMIT');
    } catch (error) {
      await adapter.execute('ROLLBACK').catch(() => undefined);
      throw new Error(
        `Database migration ${migration.version} (${migration.name}) failed`,
        { cause: error },
      );
    }
  }

  return LATEST_DATABASE_VERSION;
}
