/**
 * Database client factory.
 *
 * Defaults to embedded PGlite (Postgres compiled to a local file store) so the
 * app persists across restarts with zero setup. Set DATABASE_URL to point at a
 * real Postgres server instead — the pg-core schema and repository are identical
 * either way. Bootstraps the store DDL on connect.
 */

import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import {
  applyDatabaseMigrations,
  type SqlMigrationAdapter,
} from './migrations.js';

/** Either driver's drizzle instance — both expose the same pg query builder. */
export type AppDatabase = PgliteDatabase<Record<string, never>> | PostgresJsDatabase<Record<string, never>>;

export interface DbHandle {
  db: AppDatabase;
  kind: 'pglite' | 'postgres';
  /** Credential-free description safe to write to application logs. */
  location: string;
  persistent: boolean;
  migrationVersion: number;
  /** Cross-request logical mutex for one game id. */
  withGameLock: <T>(gameId: string, action: () => Promise<T>) => Promise<T>;
  check: () => Promise<void>;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url?: string;
  dir?: string;
  mode?: 'development' | 'test' | 'production';
}

export function describeDatabaseLocation(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\/+/, '') || '(default)';
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${database}`;
  } catch {
    return 'configured Postgres';
  }
}

export async function createDb(opts: CreateDbOptions = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  const mode = opts.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');

  if (mode === 'production' && !url) {
    throw new Error(
      'DATABASE_URL is required when NODE_ENV=production; refusing to start with a local PGlite store',
    );
  }

  if (url) {
    const max = Math.max(1, Number(process.env.DATABASE_MAX_CONNECTIONS ?? 10) || 10);
    const client = postgres(url, { max });
    // The generic migration runner uses explicit BEGIN/COMMIT statements.
    // postgres.js requires those statements to stay on one reserved connection,
    // so migrations get a short-lived single-connection client while the app
    // keeps its independently configured pool.
    const migrationClient = postgres(url, { max: 1 });
    const adapter: SqlMigrationAdapter = {
      execute: async (sql) => {
        await migrationClient.unsafe(sql);
      },
      rows: async <T extends Record<string, unknown>>(sql: string) =>
        (await migrationClient.unsafe(sql)) as unknown as T[],
    };
    let migrationVersion: number;
    try {
      migrationVersion = await applyDatabaseMigrations(adapter);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    } finally {
      await migrationClient.end().catch(() => undefined);
    }
    // Use a dedicated direct connection for advisory locks. Keeping it
    // separate from the query pool avoids deadlocking when the app pool is
    // intentionally limited to one connection.
    const lockUrl = process.env.DATABASE_URL_UNPOOLED ?? url;
    const lockClient = postgres(lockUrl, { max: 1 });
    return {
      db: drizzlePostgres(client),
      kind: 'postgres',
      location: describeDatabaseLocation(url),
      persistent: true,
      migrationVersion,
      withGameLock: async <T>(gameId: string, action: () => Promise<T>): Promise<T> => {
        const result = await lockClient.begin(async (sql) => {
          await sql.unsafe(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [gameId],
          );
          return action();
        });
        return result as T;
      },
      check: async () => {
        await client.unsafe('SELECT 1');
      },
      close: async () => {
        await Promise.all([client.end(), lockClient.end()]);
      },
    };
  }

  // Embedded PGlite. A path persists to disk; ':memory:' is ephemeral (tests).
  const dir = opts.dir ?? process.env.PGLITE_DIR ?? './.data';
  const pg = new PGlite(dir);
  const adapter: SqlMigrationAdapter = {
    execute: async (sql) => {
      await pg.exec(sql);
    },
    rows: async <T extends Record<string, unknown>>(sql: string) =>
      (await pg.query<T>(sql)).rows,
  };
  const migrationVersion = await applyDatabaseMigrations(adapter);
  const localLock = createLocalGameLock();
  return {
    db: drizzlePglite(pg),
    kind: 'pglite',
    location: dir,
    persistent: dir !== 'memory://' && dir !== ':memory:',
    migrationVersion,
    withGameLock: localLock,
    check: async () => {
      await pg.query('SELECT 1');
    },
    close: () => pg.close(),
  };
}

function createLocalGameLock(): <T>(
  gameId: string,
  action: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(gameId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(gameId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (tails.get(gameId) === tail) tails.delete(gameId);
    }
  };
}
