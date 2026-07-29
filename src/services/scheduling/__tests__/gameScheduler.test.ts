import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../../repository.js';
import { FakeJobQueue } from '../jobQueue.js';
import { GameScheduler, JOB_SESSION_OPEN, JOB_PLAYER_WINDOW } from '../gameScheduler.js';
import { createGame } from '../../../engine/setup.js';
import { TERRITORY_IDS } from '../../../engine/map.js';
import { currentPlayer } from '../../../engine/turnSession.js';
import type { TurnPlanner } from '../../../engine/planner.js';
import type { GameConfig, GameState } from '../../../engine/types.js';
import { openDailySession } from '../../orchestrator.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function makeGame(): GameState {
  const g = createGame({
    id: 'g',
    config,
    players: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seed: 5,
  });
  return {
    ...g,
    turnOrder: ['a', 'b'],
    dayNumber: 1,
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: id === 'china' ? 'a' : id === 'india' ? 'b' : null,
      armies: 2,
    })),
  };
}

// No-op planner: succeeds, does nothing (plan application is tested elsewhere).
const noopPlanner: TurnPlanner = async () => ({ placements: [], attacks: [] });

describe('GameScheduler daily cycle', () => {
  it('runs a full day: open, complete-in-time, stale timer, miss, next day', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    const queue = new FakeJobQueue();
    let nowMs = Date.parse('2026-01-15T15:00:00Z'); // 10:00 EST
    const scheduler = new GameScheduler({ repo, planner: noopPlanner, queue, clock: { now: () => new Date(nowMs) } });
    scheduler.register();

    // Bootstrap: schedules the first session_open at 19:00 EST (00:00Z next day).
    await scheduler.start('g');
    let pending = queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.name).toBe(JOB_SESSION_OPEN);
    expect(new Date(pending[0]!.runAt).toISOString()).toBe('2026-01-16T00:00:00.000Z');

    // 19:00 EST — session opens, first player (a) gets a 20-min window.
    nowMs = Date.parse('2026-01-16T00:00:00Z');
    await queue.runDue(new Date(nowMs));
    const session1 = await repo.loadSession('g', 1);
    expect(session1!.queue).toEqual(['a', 'b']);
    const aWindow = queue.pending().find((j) => j.name === JOB_PLAYER_WINDOW);
    expect(aWindow).toBeDefined();
    expect(new Date(aWindow!.runAt).toISOString()).toBe('2026-01-16T00:20:00.000Z');

    // a completes in time at 00:10 — line advances to b, b's window scheduled.
    nowMs = Date.parse('2026-01-16T00:10:00Z');
    await scheduler.onPlayerCompleted('g', 1, 'a');
    const bWindow = queue
      .pending()
      .find((j) => j.name === JOB_PLAYER_WINDOW && (j.data as { playerId: string }).playerId === 'b');
    expect(bWindow).toBeDefined();
    expect(new Date(bWindow!.runAt).toISOString()).toBe('2026-01-16T00:30:00.000Z');

    // 00:20 — a's now-stale window fires and is a no-op (front is b, not a).
    nowMs = Date.parse('2026-01-16T00:20:00Z');
    await queue.runDue(new Date(nowMs));
    const sessionAfterStale = await repo.loadSession('g', 1);
    expect(sessionAfterStale!.queue).toEqual(['b']); // unchanged
    expect((await repo.loadGame('g'))!.players.find((p) => p.id === 'b')!.status).toBe('active');

    // 00:30 — b misses; window auto-resolves b and schedules next day's open.
    nowMs = Date.parse('2026-01-16T00:30:00Z');
    await queue.runDue(new Date(nowMs));

    const game = await repo.loadGame('g');
    expect(game!.players.find((p) => p.id === 'a')!.status).toBe('active'); // completed
    expect(game!.players.find((p) => p.id === 'b')!.status).toBe('auto_piloted'); // missed
    expect((await repo.loadSession('g', 1))!.queue).toEqual([]); // day 1 done

    const nextOpen = queue.pending().find((j) => j.name === JOB_SESSION_OPEN);
    expect(nextOpen).toBeDefined();
    expect((nextOpen!.data as { dayNumber: number }).dayNumber).toBe(2);
    expect(new Date(nextOpen!.runAt).toISOString()).toBe('2026-01-17T00:00:00.000Z');
  });

  it('stops scheduling once the game is finished', async () => {
    const repo = new InMemoryGameRepository({ games: [{ ...makeGame(), status: 'finished', winnerId: 'a' }] });
    const queue = new FakeJobQueue();
    const nowMs = Date.parse('2026-01-16T00:00:00Z');
    const scheduler = new GameScheduler({ repo, planner: noopPlanner, queue, clock: { now: () => new Date(nowMs) } });
    scheduler.register();
    await scheduler.start('g');
    // session_open fires but advance sees a finished game and schedules nothing further.
    await queue.runDue(new Date(nowMs));
    expect(queue.pending()).toHaveLength(0);
  });

  it('recovers an overdue persisted deadline without granting extra time', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 1);
    const persistedDeadline = '2026-01-16T00:05:00.000Z';
    const session = (await repo.loadSession('g', 1))!;
    await repo.saveSession({ ...session, windowExpiresAt: persistedDeadline });

    const queue = new FakeJobQueue();
    const nowMs = Date.parse('2026-01-16T00:10:00Z');
    const scheduler = new GameScheduler({
      repo,
      planner: noopPlanner,
      queue,
      clock: { now: () => new Date(nowMs) },
    });
    scheduler.register();

    expect(await scheduler.recoverActiveGames()).toBe(1);
    const recovered = queue.pending();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.name).toBe(JOB_PLAYER_WINDOW);
    expect(new Date(recovered[0]!.runAt).toISOString()).toBe(persistedDeadline);

    await queue.runDue(new Date(nowMs));
    expect(currentPlayer((await repo.loadSession('g', 1))!)).toBe('b');
    expect((await repo.loadGame('g'))!.players.find((player) => player.id === 'a')!.status)
      .toBe('auto_piloted');
  });

  it('treats a duplicate session-open delivery as a no-op after arming the window', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    const queue = new FakeJobQueue();
    const nowMs = Date.parse('2026-01-16T00:00:00Z');
    const scheduler = new GameScheduler({
      repo,
      planner: noopPlanner,
      queue,
      clock: { now: () => new Date(nowMs) },
    });
    scheduler.register();

    const payload = { gameId: 'g', dayNumber: 1 };
    await queue.schedule(JOB_SESSION_OPEN, new Date(nowMs), payload);
    await queue.schedule(JOB_SESSION_OPEN, new Date(nowMs), payload);
    await queue.runDue(new Date(nowMs));

    const playerWindows = queue.pending().filter((job) => job.name === JOB_PLAYER_WINDOW);
    expect(playerWindows).toHaveLength(1);
    expect((playerWindows[0]!.data as { playerId: string }).playerId).toBe('a');
  });
});
