/**
 * Exercise logging (§3) — the game's defining mechanic: real-world exercise
 * converts to reinforcement troops.
 *
 * Logs accumulate per player per day so the per-exercise and daily-total caps
 * are applied against the *day's* running total, not each entry in isolation.
 * We recompute `earnedTroops` before and after appending the new entry and bank
 * only the delta — so once you hit a cap, further logging banks nothing.
 */

import { earnedTroops, type ExerciseLogEntry } from '../engine/reinforce.js';
import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

export interface LogExerciseResult {
  /** Troops added to the bank by this entry (0 if a cap was already reached). */
  deltaTroops: number;
  /** The player's total earned troops for the day after this entry. */
  dayTotal: number;
  /** True if the daily total cap clipped the sum. */
  totalCapApplied: boolean;
}

/**
 * Record one exercise entry for a player and bank the troops it earns.
 * Eliminated/forfeited players earn nothing (§3, §7).
 */
export async function logExercise(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
  playerId: string,
  entry: ExerciseLogEntry,
): Promise<LogExerciseResult> {
  if (!(entry.units > 0)) throw new TurnError('bad_units', 'Units must be positive');

  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  const player = game.players.find((p) => p.id === playerId);
  if (!player) throw new TurnError('no_player', 'Unknown player');
  if (player.status === 'eliminated' || player.status === 'forfeited') {
    throw new TurnError('not_active_player', 'Eliminated players cannot earn troops');
  }
  if (!game.config.exercises.some((e) => e.key === entry.exerciseKey)) {
    throw new TurnError('unknown_exercise', `No exercise type "${entry.exerciseKey}"`);
  }

  const prev = await repo.loadExerciseLog(gameId, dayNumber, playerId);
  const before = earnedTroops(game.config, prev);
  const next = [...prev, entry];
  const after = earnedTroops(game.config, next);
  const delta = after.total - before.total;

  await repo.saveExerciseLog(gameId, dayNumber, playerId, next);
  if (delta > 0) {
    const players = game.players.map((p) =>
      p.id === playerId ? { ...p, pendingReinforcements: p.pendingReinforcements + delta } : p,
    );
    await repo.saveGame({ ...game, players });
  }

  return { deltaTroops: delta, dayTotal: after.total, totalCapApplied: after.totalCapApplied };
}
