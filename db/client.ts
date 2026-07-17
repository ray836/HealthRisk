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
import { DDL_STATEMENTS } from './store.js';

/** Either driver's drizzle instance — both expose the same pg query builder. */
export type AppDatabase = PgliteDatabase<Record<string, never>> | PostgresJsDatabase<Record<string, never>>;

export interface DbHandle {
  db: AppDatabase;
  kind: 'pglite' | 'postgres';
  location: string;
  close: () => Promise<void>;
}

export async function createDb(opts: { url?: string; dir?: string } = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;

  if (url) {
    const client = postgres(url);
    for (const stmt of DDL_STATEMENTS) await client.unsafe(stmt);
    return { db: drizzlePostgres(client), kind: 'postgres', location: url, close: () => client.end() };
  }

  // Embedded PGlite. A path persists to disk; ':memory:' is ephemeral (tests).
  const dir = opts.dir ?? process.env.PGLITE_DIR ?? './.data';
  const pg = new PGlite(dir);
  for (const stmt of DDL_STATEMENTS) await pg.exec(stmt);
  return { db: drizzlePglite(pg), kind: 'pglite', location: dir, close: () => pg.close() };
}
