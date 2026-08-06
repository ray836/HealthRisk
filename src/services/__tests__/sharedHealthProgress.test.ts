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
        historyWindowDays: 0,
        consistencyPercent: null,
        goals: [
          {
            exerciseKey: 'running',
            currentStatus: 'in_progress',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
          {
            exerciseKey: 'vegetables',
            currentStatus: 'goal_met',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
        ],
      },
      {
        playerId: 'b',
        troopsEarned: 6,
        dailyCap: 6,
        percent: 100,
        goalsCompleted: 2,
        goalsTracked: 2,
        status: 'goal_met',
        historyWindowDays: 0,
        consistencyPercent: null,
        goals: [
          {
            exerciseKey: 'running',
            currentStatus: 'goal_met',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
          {
            exerciseKey: 'vegetables',
            currentStatus: 'goal_met',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
        ],
      },
      {
        playerId: 'c',
        troopsEarned: 0,
        dailyCap: 6,
        percent: 0,
        goalsCompleted: 0,
        goalsTracked: 2,
        status: 'not_started',
        historyWindowDays: 0,
        consistencyPercent: null,
        goals: [
          {
            exerciseKey: 'running',
            currentStatus: 'not_started',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
          {
            exerciseKey: 'vegetables',
            currentStatus: 'not_started',
            completedDays: 0,
            trackedDays: 0,
            consistencyPercent: null,
          },
        ],
      },
    ]);
    expect(progress[0]).not.toHaveProperty('logs');
    expect(progress[0]).not.toHaveProperty('perExercise');
  });

  it('compares prior completed days without treating today as missed', async () => {
    const game = createGame({
      id: 'history',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seed: 8,
    });
    game.dayNumber = 3;
    const repo = new InMemoryGameRepository({ games: [game] });
    await repo.saveExerciseLog('history', 0, 'a', [
      { exerciseKey: 'running', units: 5 },
      { exerciseKey: 'vegetables', units: 1 },
    ]);
    await repo.saveExerciseLog('history', 1, 'a', [{ exerciseKey: 'running', units: 5 }]);
    await repo.saveExerciseLog('history', 2, 'b', [{ exerciseKey: 'vegetables', units: 1 }]);
    await repo.saveExerciseLog('history', 3, 'a', [{ exerciseKey: 'running', units: 2 }]);

    const progress = await buildSharedHealthProgress(repo, 'history', 3);
    const firstPlayer = progress[0]!;
    const secondPlayer = progress[1]!;

    expect(firstPlayer.historyWindowDays).toBe(3);
    expect(firstPlayer.consistencyPercent).toBe(50);
    expect(firstPlayer.goals).toEqual([
      {
        exerciseKey: 'running',
        currentStatus: 'in_progress',
        completedDays: 2,
        trackedDays: 3,
        consistencyPercent: 67,
      },
      {
        exerciseKey: 'vegetables',
        currentStatus: 'not_started',
        completedDays: 1,
        trackedDays: 3,
        consistencyPercent: 33,
      },
    ]);
    expect(secondPlayer.consistencyPercent).toBe(17);
    expect(secondPlayer.goals[1]!.currentStatus).toBe('not_started');
  });
});
