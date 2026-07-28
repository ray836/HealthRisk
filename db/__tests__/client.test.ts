import { describe, expect, it } from 'vitest';
import {
  createDb,
  describeDatabaseLocation,
} from '../client.js';
import { LATEST_DATABASE_VERSION } from '../migrations.js';

describe('database startup', () => {
  it('migrates the local store and reports readiness', async () => {
    const handle = await createDb({ dir: 'memory://', mode: 'test' });
    try {
      expect(handle.kind).toBe('pglite');
      expect(handle.persistent).toBe(false);
      expect(handle.migrationVersion).toBe(LATEST_DATABASE_VERSION);
      await expect(handle.check()).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('refuses an accidental local database in production', async () => {
    await expect(
      createDb({ dir: 'memory://', mode: 'production' }),
    ).rejects.toThrow('DATABASE_URL is required');
  });

  it('never includes Postgres credentials in its log label', () => {
    const label = describeDatabaseLocation(
      'postgres://ray:super-secret@db.example.com:5432/healthrisk?sslmode=require',
    );
    expect(label).toBe('db.example.com:5432/healthrisk');
    expect(label).not.toContain('ray');
    expect(label).not.toContain('super-secret');
  });
});
