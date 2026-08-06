/**
 * Privacy-conscious health progress shared with other game members.
 *
 * This projection intentionally exposes only aggregate daily momentum and
 * goal-completion rates. Raw log entries and quantities stay private.
 */

import { earnedTroops } from '../engine/reinforce.js';
import type { GameRepository } from './repository.js';

export type SharedHealthStatus = 'not_started' | 'in_progress' | 'goal_met';

export interface SharedHealthGoalProgress {
  exerciseKey: string;
  currentStatus: SharedHealthStatus;
  completedDays: number;
  trackedDays: number;
  consistencyPercent: number | null;
}

export interface SharedHealthProgress {
  playerId: string;
  troopsEarned: number;
  dailyCap: number;
  percent: number;
  goalsCompleted: number;
  goalsTracked: number;
  status: SharedHealthStatus;
  historyWindowDays: number;
  consistencyPercent: number | null;
  goals: SharedHealthGoalProgress[];
}

const HISTORY_WINDOW_DAYS = 7;

function unitsByExercise(logs: { exerciseKey: string; units: number }[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const entry of logs) {
    units.set(entry.exerciseKey, (units.get(entry.exerciseKey) ?? 0) + entry.units);
  }
  return units;
}

function goalStatus(units: number, cap: number): SharedHealthStatus {
  if (units >= cap) return 'goal_met';
  if (units > 0) return 'in_progress';
  return 'not_started';
}

export async function buildSharedHealthProgress(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
): Promise<SharedHealthProgress[]> {
  const game = await repo.loadGame(gameId);
  if (!game) return [];
  const historyStartDay = Math.max(0, dayNumber - HISTORY_WINDOW_DAYS);
  const historyWindowDays = Math.max(0, dayNumber - historyStartDay);
  const snapshots = await repo.listExerciseLogs(gameId, historyStartDay, dayNumber);
  const logsByDayAndPlayer = new Map(
    snapshots.map((snapshot) => [`${snapshot.dayNumber}:${snapshot.playerId}`, snapshot.entries]),
  );
  const unitsByDayAndPlayer = new Map(
    [...logsByDayAndPlayer].map(([key, logs]) => [key, unitsByExercise(logs)]),
  );
  const trackedGoals = game.config.exercises.filter((exercise) => exercise.dailyUnitCap !== null);

  return game.players.map((player) => {
    const logs = logsByDayAndPlayer.get(`${dayNumber}:${player.id}`) ?? [];
    const earned = earnedTroops(game.config, logs);
    const unitsByKey = unitsByDayAndPlayer.get(`${dayNumber}:${player.id}`) ?? new Map<string, number>();
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
    const goals = trackedGoals.map((exercise): SharedHealthGoalProgress => {
      let completedDays = 0;
      for (let historyDay = historyStartDay; historyDay < dayNumber; historyDay += 1) {
        const historicalUnits = unitsByDayAndPlayer
          .get(`${historyDay}:${player.id}`)
          ?.get(exercise.key) ?? 0;
        if (historicalUnits >= exercise.dailyUnitCap!) completedDays += 1;
      }
      return {
        exerciseKey: exercise.key,
        currentStatus: goalStatus(unitsByKey.get(exercise.key) ?? 0, exercise.dailyUnitCap!),
        completedDays,
        trackedDays: historyWindowDays,
        consistencyPercent:
          historyWindowDays > 0 ? Math.round((completedDays / historyWindowDays) * 100) : null,
      };
    });
    const completedGoalDays = goals.reduce((sum, goal) => sum + goal.completedDays, 0);
    const trackedGoalDays = historyWindowDays * trackedGoals.length;

    return {
      playerId: player.id,
      troopsEarned: earned.total,
      dailyCap,
      percent,
      goalsCompleted,
      goalsTracked: trackedGoals.length,
      status,
      historyWindowDays,
      consistencyPercent:
        trackedGoalDays > 0 ? Math.round((completedGoalDays / trackedGoalDays) * 100) : null,
      goals,
    };
  });
}
