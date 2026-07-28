/**
 * Balanced conquest-card rules.
 *
 * A player earns at most one card per turn after capturing territory. Any
 * three cards trade for a fixed three reinforcements. The fixed value keeps
 * cards useful without allowing them to outpace daily health-goal rewards.
 */

import type { GameState, PlayerId, TerritoryCard, TerritoryId } from './types.js';
import { appendGameEvent } from './gameEvents.js';

export const CARD_TRADE_SIZE = 3;
export const CARD_TRADE_REINFORCEMENTS = 3;

export interface CardRuleError {
  code: string;
  message: string;
}

export interface CardAwardResult {
  state: GameState;
  card: TerritoryCard;
  awarded: boolean;
}

export function cardsForPlayer(state: GameState, playerId: PlayerId): TerritoryCard[] {
  return state.players.find((player) => player.id === playerId)?.cards ?? [];
}

/**
 * Award the territory captured first during this turn. The stable id guarantees
 * a retried end-turn operation cannot add the same reward twice.
 */
export function awardConquestCard(
  state: GameState,
  playerId: PlayerId,
  dayNumber: number,
  territoryId: TerritoryId,
): CardAwardResult {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Unknown player ${playerId}`);

  const card: TerritoryCard = {
    id: `${state.id}:${dayNumber}:${playerId}:conquest`,
    territoryId,
    earnedDay: dayNumber,
  };
  const hand = player.cards ?? [];
  const existing = hand.find((candidate) => candidate.id === card.id);
  if (existing) return { state, card: existing, awarded: false };

  const next = {
      ...state,
      players: state.players.map((candidate) =>
        candidate.id === playerId
          ? { ...candidate, cards: [...hand, card] }
          : candidate,
      ),
    };
  return {
    state: appendGameEvent(next, {
      id: `${card.id}:earned`,
      type: 'conquest_card_earned',
      dayNumber,
      playerId,
      territoryId,
    }),
    card,
    awarded: true,
  };
}

export function validateCardTrade(state: GameState, playerId: PlayerId): CardRuleError | null {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return { code: 'no_player', message: 'Unknown player' };
  const held = player.cards?.length ?? 0;
  if (held < CARD_TRADE_SIZE) {
    return {
      code: 'not_enough_cards',
      message: `You need ${CARD_TRADE_SIZE} cards to trade (${held} held)`,
    };
  }
  return null;
}

export function applyCardTrade(state: GameState, playerId: PlayerId): GameState {
  const error = validateCardTrade(state, playerId);
  if (error) throw new Error(error.message);

  return {
    ...state,
    players: state.players.map((player) =>
      player.id === playerId
        ? {
            ...player,
            cards: (player.cards ?? []).slice(CARD_TRADE_SIZE),
            pendingReinforcements: player.pendingReinforcements + CARD_TRADE_REINFORCEMENTS,
          }
        : player,
    ),
  };
}
