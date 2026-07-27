/**
 * Player-facing dashboard projection.
 *
 * Keeps presentation calculations out of the HTTP server and gives the UI one
 * stable place to read exercise progress, holdings, and turn-start income.
 */

import { earnedTroops } from '../engine/reinforce.js';
import { ownedContinents } from '../engine/bonus.js';
import { CARD_TRADE_REINFORCEMENTS, CARD_TRADE_SIZE } from '../engine/cards.js';
import type { HealthCategory, HealthTrackingType, TerritoryCard } from '../engine/types.js';
import type { GameRepository, TurnState } from './repository.js';

export interface ExerciseProgress {
  key: string;
  label: string;
  unitLabel: string;
  category: HealthCategory;
  trackingType: HealthTrackingType;
  unitsLogged: number;
  countedUnits: number;
  unitCap: number | null;
  troopsEarned: number;
}

export interface PlayerDashboard {
  playerId: string;
  territoriesOwned: number;
  armiesOnBoard: number;
  controlledContinents: Array<{ id: string; label: string; bonus: number }>;
  availableReinforcements: number;
  turnStart: {
    exerciseTroops: number;
    territoryAndContinentTroops: number;
    total: number;
  } | null;
  cards: {
    hand: TerritoryCard[];
    tradeSize: number;
    tradeReward: number;
    canTrade: boolean;
  };
  exercise: {
    totalTroops: number;
    dailyCap: number;
    totalCapApplied: boolean;
    progress: ExerciseProgress[];
  };
}

export async function buildPlayerDashboard(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
  playerId: string,
  turnState?: TurnState | null,
): Promise<PlayerDashboard | null> {
  const game = await repo.loadGame(gameId);
  if (!game) return null;
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return null;

  const logs = await repo.loadExerciseLog(gameId, dayNumber, playerId);
  const exercise = earnedTroops(game.config, logs);
  const unitsByKey = new Map<string, number>();
  for (const entry of logs) {
    unitsByKey.set(entry.exerciseKey, (unitsByKey.get(entry.exerciseKey) ?? 0) + entry.units);
  }

  const territories = game.territories.filter((t) => t.owner === playerId);
  const startBonus = turnState?.startBonus ?? 0;
  const startExerciseTroops = turnState?.startExerciseTroops ?? 0;

  return {
    playerId,
    territoriesOwned: territories.length,
    armiesOnBoard: territories.reduce((sum, t) => sum + t.armies, 0),
    controlledContinents: ownedContinents(game, playerId),
    availableReinforcements: player.pendingReinforcements,
    turnStart: turnState
      ? {
          exerciseTroops: startExerciseTroops,
          territoryAndContinentTroops: startBonus,
          total: startExerciseTroops + startBonus,
        }
      : null,
    cards: {
      hand: player.cards ?? [],
      tradeSize: CARD_TRADE_SIZE,
      tradeReward: CARD_TRADE_REINFORCEMENTS,
      canTrade: turnState?.phase === 'reinforce' && (player.cards?.length ?? 0) >= CARD_TRADE_SIZE,
    },
    exercise: {
      totalTroops: exercise.total,
      dailyCap: game.config.dailyTotalTroopCap,
      totalCapApplied: exercise.totalCapApplied,
      progress: game.config.exercises.map((type) => {
        const unitsLogged = unitsByKey.get(type.key) ?? 0;
        const countedUnits = type.dailyUnitCap === null
          ? unitsLogged
          : Math.min(unitsLogged, type.dailyUnitCap);
        return {
          key: type.key,
          label: type.label,
          unitLabel: type.unitLabel,
          category: type.category ?? 'movement',
          trackingType: type.trackingType ?? 'quantity',
          unitsLogged,
          countedUnits,
          unitCap: type.dailyUnitCap,
          troopsEarned: exercise.perExercise[type.key] ?? 0,
        };
      }),
    },
  };
}
