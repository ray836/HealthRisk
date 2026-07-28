import { describe, expect, it, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import { PgBossJobQueue } from '../pgBossJobQueue.js';

describe('PgBossJobQueue', () => {
  it('uses a stately queue and a singleton key for duplicate-safe timers', async () => {
    let queueCreated = false;
    const boss = Object.create(PgBoss.prototype) as PgBoss;
    boss.start = vi.fn(async () => boss);
    boss.getQueue = vi.fn(async () =>
      queueCreated ? ({ policy: 'stately' } as Awaited<ReturnType<PgBoss['getQueue']>>) : null,
    );
    boss.createQueue = vi.fn(async () => {
      queueCreated = true;
    });
    boss.work = vi.fn(async () => 'worker-id');
    boss.sendAfter = vi.fn(async () => null);
    boss.stop = vi.fn(async () => undefined);

    const queue = new PgBossJobQueue(boss);
    queue.work('turn-window', async () => undefined);
    await queue.start();
    const id = await queue.schedule(
      'turn-window',
      new Date('2026-01-01T00:00:00.000Z'),
      { gameId: 'g' },
      'g:1:p1',
    );

    expect(boss.createQueue).toHaveBeenCalledWith('turn-window', { policy: 'stately' });
    expect(boss.sendAfter).toHaveBeenCalledWith(
      'turn-window',
      { gameId: 'g' },
      { singletonKey: 'g:1:p1' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(id).toBe('existing:turn-window:g:1:p1');

    await queue.stop();
    expect(boss.stop).toHaveBeenCalled();
  });
});
