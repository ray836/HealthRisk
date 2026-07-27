import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { buildPlayerDashboard } from '../playerDashboard.js';
import { InMemoryGameRepository, type TurnState } from '../repository.js';

const config: GameConfig = {
  exercises: [
    { key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 5 },
    { key: 'lifting', label: 'Weightlifting', unitLabel: 'min', troopsPerUnit: 1 / 30, dailyUnitCap: 90 },
  ],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

describe('buildPlayerDashboard', () => {
  it('projects holdings, exercise progress, and turn-start income', async () => {
    const game = createGame({
      id: 'g',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seed: 7,
    });
    game.players.find((p) => p.id === 'a')!.pendingReinforcements = 9;
    const repo = new InMemoryGameRepository({ games: [game] });
    await repo.saveExerciseLog('g', 0, 'a', [
      { exerciseKey: 'running', units: 3 },
      { exerciseKey: 'lifting', units: 30 },
    ]);
    const turnState: TurnState = {
      gameId: 'g',
      dayNumber: 0,
      playerId: 'a',
      phase: 'reinforce',
      attacksMade: 0,
      startBonus: 5,
      startExerciseTroops: 4,
      startContinents: [],
    };
    await repo.saveTurnState(turnState);

    const dashboard = await buildPlayerDashboard(repo, 'g', 0, 'a', turnState);

    expect(dashboard).toMatchObject({
      playerId: 'a',
      territoriesOwned: 21,
      availableReinforcements: 9,
      turnStart: {
        exerciseTroops: 4,
        territoryAndContinentTroops: 5,
        total: 9,
      },
      exercise: {
        totalTroops: 4,
        dailyCap: 8,
        totalCapApplied: false,
      },
    });
    expect(dashboard!.armiesOnBoard).toBeGreaterThanOrEqual(21);
    expect(dashboard!.exercise.progress).toEqual([
      expect.objectContaining({ key: 'running', unitsLogged: 3, countedUnits: 3, troopsEarned: 3 }),
      expect.objectContaining({ key: 'lifting', unitsLogged: 30, countedUnits: 30, troopsEarned: 1 }),
    ]);
  });

  it('clips displayed counted units at the exercise cap', async () => {
    const game = createGame({
      id: 'g',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seed: 3,
    });
    const repo = new InMemoryGameRepository({ games: [game] });
    await repo.saveExerciseLog('g', 0, 'a', [{ exerciseKey: 'running', units: 8 }]);

    const dashboard = await buildPlayerDashboard(repo, 'g', 0, 'a');

    expect(dashboard!.exercise.progress[0]).toMatchObject({
      unitsLogged: 8,
      countedUnits: 5,
      troopsEarned: 5,
    });
  });
});
