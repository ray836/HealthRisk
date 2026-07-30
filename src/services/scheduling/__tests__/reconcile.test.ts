import { describe, expect, it } from 'vitest';

import { TERRITORY_IDS } from '../../../engine/map.js';
import type { TurnPlanner } from '../../../engine/planner.js';
import { createGame } from '../../../engine/setup.js';
import { currentPlayer } from '../../../engine/turnSession.js';
import type { GameConfig, GameState } from '../../../engine/types.js';
import { openDailySession } from '../../orchestrator.js';
import { InMemoryGameRepository } from '../../repository.js';
import {
  isAuthorizedCronRequest,
  reconcileGameDue,
} from '../reconcile.js';

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
  const game = createGame({
    id: 'g',
    config,
    players: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seed: 5,
  });
  return {
    ...game,
    turnOrder: ['a', 'b'],
    dayNumber: 1,
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: id === 'china' ? 'a' : id === 'india' ? 'b' : null,
      armies: 2,
    })),
  };
}

const noopPlanner: TurnPlanner = async () => ({ placements: [], attacks: [] });

describe('scheduled-turn reconciliation', () => {
  it('fails closed unless the exact configured Bearer secret is supplied', () => {
    expect(isAuthorizedCronRequest(undefined, 'correct-secret')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer correct-secret', undefined)).toBe(false);
    expect(isAuthorizedCronRequest('correct-secret', 'correct-secret')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer wrong-secret', 'correct-secret')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer correct-secret', 'correct-secret')).toBe(true);
  });

  it('catches up every overdue player from persisted deadlines without adding time', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    const startingRevision = (await repo.loadGame('g'))!.revision ?? 0;
    await openDailySession(repo, 'g', 1);
    const session = (await repo.loadSession('g', 1))!;
    await repo.saveSession({
      ...session,
      windowExpiresAt: '2026-01-16T00:05:00.000Z',
      nextSessionOpensAt: '2026-01-17T00:00:00.000Z',
    });

    const result = await reconcileGameDue(
      {
        repo,
        planner: noopPlanner,
        clock: { now: () => new Date('2026-01-16T00:50:00.000Z') },
      },
      'g',
    );

    expect(result).toEqual({
      activeGames: 1,
      processedJobs: 2,
      hasMoreDue: false,
    });
    const reconciled = (await repo.loadSession('g', 1))!;
    expect(currentPlayer(reconciled)).toBeNull();
    expect(reconciled.autoResolved).toEqual(['a', 'b']);
    expect(reconciled.nextSessionOpensAt).toBe('2026-01-17T00:00:00.000Z');
    const game = (await repo.loadGame('g'))!;
    expect(game.players.map((player) => player.status)).toEqual([
      'auto_piloted',
      'auto_piloted',
    ]);
    expect(game.revision).toBe(startingRevision + 2);
  });

  it('opens an overdue next day from its planned time, not invocation time', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 1);
    const session = (await repo.loadSession('g', 1))!;
    await repo.saveSession({
      ...session,
      queue: [],
      completed: ['a', 'b'],
      nextSessionOpensAt: '2026-01-17T00:00:00.000Z',
    });

    const result = await reconcileGameDue(
      {
        repo,
        planner: noopPlanner,
        clock: { now: () => new Date('2026-01-17T00:10:00.000Z') },
      },
      'g',
    );

    expect(result.processedJobs).toBe(1);
    expect((await repo.loadGame('g'))!.dayNumber).toBe(2);
    const day2 = (await repo.loadSession('g', 2))!;
    expect(currentPlayer(day2)).toBe('a');
    expect(day2.windowExpiresAt).toBe('2026-01-17T00:20:00.000Z');
    expect(day2.nextSessionOpensAt).toBe('2026-01-18T00:00:00.000Z');
  });
});
