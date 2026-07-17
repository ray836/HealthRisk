/**
 * Reinforcement phase (§3, §4.1).
 *
 * Two concerns, kept separate:
 *   1. earnedTroops(): convert a day's logged exercise into troops, applying
 *      per-exercise daily caps and the daily total troop cap. Global config —
 *      same table for every player.
 *   2. placeReinforcements(): validate & apply a player placing banked troops
 *      onto territories they own.
 */

import type { GameConfig, GameState, TerritoryId } from './types.js';
import type { ValidationError } from './combat.js';

/** A single self-reported exercise entry for one day. */
export interface ExerciseLogEntry {
  exerciseKey: string;
  units: number; // e.g. miles run, minutes lifted
}

export interface EarnedBreakdown {
  total: number;
  perExercise: Record<string, number>;
  /** True if the daily total cap clipped the sum. */
  totalCapApplied: boolean;
}

/**
 * Convert a day's logs into earned troops. Per-exercise unit caps apply first,
 * then troops are summed and clipped to the daily total troop cap.
 *
 * Troops are floored to whole numbers only at the *total* stage, so fractional
 * conversions (e.g. 1 troop / 30 min => 0.0333/min) accumulate correctly before
 * rounding. Unknown exercise keys contribute 0.
 */
export function earnedTroops(config: GameConfig, logs: ExerciseLogEntry[]): EarnedBreakdown {
  const byKey: Record<string, number> = {};
  for (const log of logs) {
    byKey[log.exerciseKey] = (byKey[log.exerciseKey] ?? 0) + log.units;
  }

  const perExercise: Record<string, number> = {};
  let rawTotal = 0;
  for (const ex of config.exercises) {
    const rawUnits = byKey[ex.key] ?? 0;
    const cappedUnits = ex.dailyUnitCap === null ? rawUnits : Math.min(rawUnits, ex.dailyUnitCap);
    const troops = cappedUnits * ex.troopsPerUnit;
    perExercise[ex.key] = troops;
    rawTotal += troops;
  }

  const flooredTotal = Math.floor(rawTotal);
  const total = Math.min(flooredTotal, config.dailyTotalTroopCap);
  return { total, perExercise, totalCapApplied: flooredTotal > config.dailyTotalTroopCap };
}

export interface ReinforcePlacement {
  territoryId: TerritoryId;
  count: number;
}

/**
 * Validate a set of placements: player must own each target, counts positive,
 * and the sum must not exceed the player's pending (banked) reinforcements.
 * A player may place fewer than banked; the remainder is forfeited for the turn
 * (matches "capped by whatever you actually earned/logged", §4.1).
 */
export function validateReinforcement(
  state: GameState,
  playerId: string,
  placements: ReinforcePlacement[],
): ValidationError | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { code: 'no_player', message: 'Unknown player' };
  let sum = 0;
  for (const p of placements) {
    if (p.count <= 0) return { code: 'bad_count', message: 'Placement count must be positive' };
    const terr = state.territories.find((t) => t.id === p.territoryId);
    if (!terr) return { code: 'no_territory', message: `Unknown territory ${p.territoryId}` };
    if (terr.owner !== playerId) return { code: 'not_owner', message: `You do not own ${p.territoryId}` };
    sum += p.count;
  }
  if (sum > player.pendingReinforcements) {
    return { code: 'over_bank', message: 'Placing more troops than you have banked' };
  }
  return null;
}

/**
 * Apply placements. Returns new state with troops added and the player's
 * pending bank reduced by the amount placed (unplaced remainder is cleared to 0
 * at turn end via clearPendingAfterTurn, not here).
 */
export function applyReinforcement(
  state: GameState,
  playerId: string,
  placements: ReinforcePlacement[],
): GameState {
  const territories = state.territories.map((t) => ({ ...t }));
  let placed = 0;
  for (const p of placements) {
    const terr = territories.find((t) => t.id === p.territoryId)!;
    terr.armies += p.count;
    placed += p.count;
  }
  const players = state.players.map((pl) =>
    pl.id === playerId
      ? { ...pl, pendingReinforcements: pl.pendingReinforcements - placed }
      : pl,
  );
  return { ...state, territories, players };
}
