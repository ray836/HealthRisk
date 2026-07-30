/**
 * Applies pending database migrations and verifies the hosted Postgres
 * connection without starting the HTTP server or durable job workers.
 *
 * Run with: npm run db:check
 */

import { createDb } from '../db/client.js';

async function main(): Promise<void> {
  const directUrl = process.env.DATABASE_URL_UNPOOLED;
  const url = directUrl ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      'DATABASE_URL_UNPOOLED or DATABASE_URL is required. Add the Neon connection to .env.local.',
    );
  }

  const database = await createDb({ url, mode: 'production' });
  try {
    await database.check();
    console.log(`Database connection: healthy`);
    console.log(`Database location: ${database.location}`);
    console.log(`Migration version: ${database.migrationVersion}`);
    console.log(`Connection type: ${directUrl ? 'direct (unpooled)' : 'pooled fallback'}`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown database error';
  console.error(`Database check failed: ${message}`);
  process.exitCode = 1;
});
