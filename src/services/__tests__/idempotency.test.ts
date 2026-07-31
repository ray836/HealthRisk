import { describe, expect, it, vi } from 'vitest';

import { executeIdempotent } from '../idempotency.js';
import { InMemoryGameRepository } from '../repository.js';

describe('idempotent mutations', () => {
  it('replays the first response without running the mutation twice', async () => {
    const repo = new InMemoryGameRepository();
    const action = vi.fn(async () => ({ status: 200, body: { earned: 2 } }));
    const input = {
      userId: 'u1',
      scope: 'game:g1:exercise',
      key: 'mobile-request-123',
      payload: { units: 2 },
    };

    expect(await executeIdempotent(repo, input, action)).toMatchObject({
      replayed: false,
      body: { earned: 2 },
    });
    expect(await executeIdempotent(repo, input, action)).toMatchObject({
      replayed: true,
      body: { earned: 2 },
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it('rejects reusing a key with different input', async () => {
    const repo = new InMemoryGameRepository();
    await executeIdempotent(
      repo,
      { userId: 'u1', scope: 'move', key: 'same-request-key', payload: { count: 1 } },
      async () => ({ status: 200, body: { ok: true } }),
    );
    await expect(executeIdempotent(
      repo,
      { userId: 'u1', scope: 'move', key: 'same-request-key', payload: { count: 2 } },
      async () => ({ status: 200, body: { ok: true } }),
    )).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
});
