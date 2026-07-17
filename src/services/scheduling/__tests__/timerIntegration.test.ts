import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryGameRepository } from '../../repository.js';
import { InProcessJobQueue } from '../jobQueue.js';
import { GameScheduler } from '../gameScheduler.js';
import { openDailySession, systemClock } from '../../orchestrator.js';
import { currentPlayer } from '../../../engine/turnSession.js';
import { createGame } from '../../../engine/setup.js';
import { TERRITORY_IDS } from '../../../engine/map.js';
import type { TurnPlanner } from '../../../engine/planner.js';
import type { GameConfig, GameState } from '../../../engine/types.js';

afterEach(() => vi.useRealTimers());

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 10,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 1, // 60s window
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function makeGame(): GameState {
  const g = createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 5 });
  const owner: Record<string, string> = { china: 'a', mongolia: 'a', india: 'b', siam: 'b' };
  return {
    ...g,
    turnOrder: ['a', 'b'],
    dayNumber: 0,
    territories: TERRITORY_IDS.map((id) => ({ id, owner: owner[id] ?? null, armies: 2 })),
  };
}

// Defensive fallback (planner throws) — no credits, deterministic.
const throwingPlanner: TurnPlanner = async () => {
  throw new Error('planner disabled');
};

describe('timed window auto-resolves via the in-process timer', () => {
  it('auto-resolves the front player when their window elapses and advances the line', async () => {
    vi.useFakeTimers();
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    const queue = new InProcessJobQueue();
    const scheduler = new GameScheduler({ repo, planner: throwingPlanner, queue, clock: systemClock, nextDayOpenAt: (_c, now) => now });
    scheduler.register();

    await openDailySession(repo, 'g', 0);
    await scheduler.armNextWindow('g', 0); // arm player a's window

    // The deadline is persisted for the UI.
    let session = await repo.loadSession('g', 0);
    expect(currentPlayer(session!)).toBe('a');
    expect(session!.windowExpiresAt).toBeTruthy();

    // Before the window elapses: still a's turn.
    await vi.advanceTimersByTimeAsync(30_000);
    session = await repo.loadSession('g', 0);
    expect(currentPlayer(session!)).toBe('a');

    // Past the 60s window: a is auto-resolved, b is up, b's window armed.
    await vi.advanceTimersByTimeAsync(31_000);
    const game = await repo.loadGame('g');
    expect(game!.players.find((p) => p.id === 'a')!.status).toBe('auto_piloted');
    session = await repo.loadSession('g', 0);
    expect(currentPlayer(session!)).toBe('b');
    expect(session!.windowExpiresAt).toBeTruthy();
  });
});
