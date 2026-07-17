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
  if (await repo.loadTurnState(gameId, dayNumber, playerId)) return { started: false, bonus: null };

  const bonus = standardReinforcements(game, playerId);
  const players = game.players.map((p) =>
    p.id === playerId ? { ...p, pendingReinforcements: p.pendingReinforcements + bonus.total } : p,
  );
  await repo.saveGame({ ...game, players });

  const newBank = player.pendingReinforcements + bonus.total;
  const turnState: TurnState = {
    gameId,
    dayNumber,
    playerId,
    phase: newBank > 0 ? 'reinforce' : 'attack',
    attacksMade: 0,
    startBonus: bonus.total,
    startContinents: bonus.continents.map((c) => c.label),
  };
  await repo.saveTurnState(turnState);
  return { started: true, bonus };
}
