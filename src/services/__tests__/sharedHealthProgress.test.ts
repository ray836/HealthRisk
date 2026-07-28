import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { InMemoryGameRepository } from '../repository.js';
import { buildSharedHealthProgress } from '../sharedHealthProgress.js';

const config: GameConfig = {
  exercises: [
    {
      key: 'running',
      label: 'Running',
      unitLabel: 'mile',
      troopsPerUnit: 1,
      dailyUnitCap: 5,
    },
    {
      key: 'vegetables',
      label: 'Vegetable goal',
      category: 'nutrition',
      trackingType: 'checkbox',
      unitLabel: 'completion',
      troopsPerUnit: 1,
      dailyUnitCap: 1,
    },
  ],
  dailyTotalTroopCap: 6,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Los_Angeles',
};

describe('buildSharedHealthProgress', () => {
  it('shares capped totals and completion counts without exposing log details', async () => {
    const game = createGame({
      id: 'g',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      seed: 7,
    });
    const repo = new InMemoryGameRepository({ games: [game] });
    await repo.saveExerciseLog('g', 0, 'a', [
      { exerciseKey: 'running', units: 3 },
      { exerciseKey: 'vegetables', units: 1 },
    ]);
    await repo.saveExerciseLog('g', 0, 'b', [
      { exerciseKey: 'running', units: 8 },
      { exerciseKey: 'vegetables', units: 1 },
    ]);

    const progress = await buildSharedHealthProgress(repo, 'g', 0);

    expect(progress).toEqual([
      {
        playerId: 'a',
        troopsEarned: 4,
        dailyCap: 6,
        percent: 67,
        goalsCompleted: 1,
        goalsTracked: 2,
        status: 'in_progress',
      },
      {
        playerId: 'b',
        troopsEarned: 6,
        dailyCap: 6,
        percent: 100,
        goalsCompleted: 2,
        goalsTracked: 2,
        status: 'goal_met',
      },
      {
        playerId: 'c',
        troopsEarned: 0,
        dailyCap: 6,
        percent: 0,
        goalsCompleted: 0,
        goalsTracked: 2,
        status: 'not_started',
      },
    ]);
    expect(progress[0]).not.toHaveProperty('logs');
    expect(progress[0]).not.toHaveProperty('perExercise');
  });
});
