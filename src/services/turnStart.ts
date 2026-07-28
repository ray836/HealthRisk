/**
 * Start-of-turn reinforcement grant.
 *
 * When a player's turn begins, they receive the standard Risk reinforcements
 * (territory count + continent bonuses) *in addition to* the troops they banked
 * from exercise. This is granted exactly once per turn, the first time the turn
 * is touched — whether the player shows up (via the turn API / a game view) or
 * misses their window and is auto-resolved (via handleWindowExpiry). Existence
 * of the TurnState marks the turn as already started, so this is idempotent.
 */

import { standardReinforcements, type ReinforcementBreakdown } from '../engine/bonus.js';
import { currentPlayer } from '../engine/turnSession.js';
import type { GameRepository, TurnState } from './repository.js';

export interface TurnStartResult {
  started: boolean;
  bonus: ReinforcementBreakdown | null;
}

/**
 * Ensure the given player's turn has started: if it hasn't, grant their
 * start-of-turn reinforcements and create the TurnState. Only acts when the
 * player is the current front-of-line player on an active game.
 */
export async function ensureTurnStarted(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
  playerId: string,
): Promise<TurnStartResult> {
  const game = await repo.loadGame(gameId);
  if (!game || game.status !== 'active') return { started: false, bonus: null };
  const session = await repo.loadSession(gameId, dayNumber);
  if (!session || currentPlayer(session) !== playerId) return { started: false, bonus: null };
  const player = game.players.find((p) => p.id === playerId);
  if (!player || player.status === 'eliminated' || player.status === 'forfeited') {
    return { started: false, bonus: null };
  }
  const existingTurnState = await repo.loadTurnState(gameId, dayNumber, playerId);
  if (existingTurnState) {
    // Backfill games whose current turn began before briefings were introduced.
    if (existingTurnState.briefingEventCount === undefined) {
      existingTurnState.briefingEventCount = game.events?.length ?? 0;
      await repo.saveTurnState(existingTurnState);
    }
    return { started: false, bonus: null };
  }

  const bonus = standardReinforcements(game, playerId);
  const eliminationReward = player.pendingEliminationReward ?? 0;
  const players = game.players.map((p) =>
    p.id === playerId
      ? {
          ...p,
          pendingEliminationReward: 0,
          pendingReinforcements: p.pendingReinforcements + bonus.total + eliminationReward,
        }
      : p,
  );
  await repo.saveGame({ ...game, players });

  const newBank = player.pendingReinforcements + bonus.total + eliminationReward;
  const turnState: TurnState = {
    gameId,
    dayNumber,
    playerId,
    phase: newBank > 0 ? 'reinforce' : 'attack',
    attacksMade: 0,
    startBonus: bonus.total,
    startExerciseTroops: player.pendingReinforcements,
    startEliminationTroops: eliminationReward,
    startContinents: bonus.continents.map((c) => c.label),
    briefingEventCount: game.events?.length ?? 0,
    reinforcementTroopsPlaced: 0,
    reinforcementPlacementsMade: 0,
    attackerLosses: 0,
    defenderLosses: 0,
    territoriesCaptured: [],
    cardsTraded: 0,
    fortifiedTroops: 0,
  };
  await repo.saveTurnState(turnState);
  return { started: true, bonus };
}
