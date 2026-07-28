/**
 * Privacy-conscious health progress shared with other game members.
 *
 * This projection intentionally exposes only aggregate daily momentum. Raw log
 * entries, exercise names, quantities, and category details stay private.
 */

import { earnedTroops } from '../engine/reinforce.js';
import type { GameRepository } from './repository.js';

export type SharedHealthStatus = 'not_started' | 'in_progress' | 'goal_met';

export interface SharedHealthProgress {
  playerId: string;
  troopsEarned: number;
  dailyCap: number;
  percent: number;
  goalsCompleted: number;
  goalsTracked: number;
  status: SharedHealthStatus;
}

export async function buildSharedHealthProgress(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
): Promise<SharedHealthProgress[]> {
  const game = await repo.loadGame(gameId);
  if (!game) return [];

  return Promise.all(game.players.map(async (player) => {
    const logs = await repo.loadExerciseLog(gameId, dayNumber, player.id);
    const earned = earnedTroops(game.config, logs);
    const unitsByKey = new Map<string, number>();
    for (const entry of logs) {
      unitsByKey.set(entry.exerciseKey, (unitsByKey.get(entry.exerciseKey) ?? 0) + entry.units);
    }
    const trackedGoals = game.config.exercises.filter((exercise) => exercise.dailyUnitCap !== null);
    const goalsCompleted = trackedGoals.filter(
      (exercise) => (unitsByKey.get(exercise.key) ?? 0) >= exercise.dailyUnitCap!,
    ).length;
    const dailyCap = game.config.dailyTotalTroopCap;
    const percent = dailyCap > 0 ? Math.min(100, Math.round((earned.total / dailyCap) * 100)) : 0;
    const status: SharedHealthStatus =
      earned.total >= dailyCap
        ? 'goal_met'
        : earned.total > 0 || logs.length > 0
          ? 'in_progress'
          : 'not_started';

    return {
      playerId: player.id,
      troopsEarned: earned.total,
      dailyCap,
      percent,
      goalsCompleted,
      goalsTracked: trackedGoals.length,
      status,
    };
  }));
}
