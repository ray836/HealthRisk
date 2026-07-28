/**
 * Persistent public gameplay events.
 *
 * These small, presentation-neutral records power the day-by-day activity
 * history and each player's frozen "since your last turn" briefing.
 */

import { ownedContinents } from './bonus.js';
import type { AttackDeclaration, AttackResult } from './combat.js';
import type { FortifyMove } from './fortify.js';
import type { GameEvent, GameState, PlayerId } from './types.js';

export function appendGameEvent(state: GameState, event: GameEvent): GameState {
  if ((state.events ?? []).some((candidate) => candidate.id === event.id)) return state;
  return { ...state, events: [...(state.events ?? []), event] };
}

function continentIds(state: GameState, playerId: PlayerId | null): Set<string> {
  return new Set(playerId ? ownedContinents(state, playerId).map((continent) => continent.id) : []);
}

function added(after: Set<string>, before: Set<string>): string[] {
  return [...after].filter((id) => !before.has(id));
}

function removed(before: Set<string>, after: Set<string>): string[] {
  return [...before].filter((id) => !after.has(id));
}

export function recordAttackEvent(
  before: GameState,
  after: GameState,
  playerId: PlayerId,
  declaration: AttackDeclaration,
  result: AttackResult,
  eventId: string,
): GameState {
  const previousOwnerId =
    before.territories.find((territory) => territory.id === declaration.toId)?.owner ?? null;
  const attackerBefore = continentIds(before, playerId);
  const attackerAfter = continentIds(after, playerId);
  const defenderBefore = continentIds(before, previousOwnerId);
  const defenderAfter = continentIds(after, previousOwnerId);

  return appendGameEvent(after, {
    id: eventId,
    type: 'attack_resolved',
    dayNumber: before.dayNumber,
    playerId,
    previousOwnerId,
    fromId: declaration.fromId,
    toId: declaration.toId,
    attackerLosses: result.totalAttackerLosses,
    defenderLosses: result.totalDefenderLosses,
    captured: result.captured,
    continentsGained: result.captured ? added(attackerAfter, attackerBefore) : [],
    continentsLost: result.captured ? removed(defenderBefore, defenderAfter) : [],
  });
}

export function recordFortifiedEvent(
  state: GameState,
  playerId: PlayerId,
  move: FortifyMove,
  eventId: string,
): GameState {
  return appendGameEvent(state, {
    id: eventId,
    type: 'fortified',
    dayNumber: state.dayNumber,
    playerId,
    fromId: move.fromId,
    toId: move.toId,
    count: move.count,
  });
}

export function recordCardsTradedEvent(
  state: GameState,
  playerId: PlayerId,
  troopsAwarded: number,
  eventId: string,
): GameState {
  return appendGameEvent(state, {
    id: eventId,
    type: 'cards_traded',
    dayNumber: state.dayNumber,
    playerId,
    troopsAwarded,
  });
}

export function recordTurnCompletedEvent(
  state: GameState,
  playerId: PlayerId,
  resolution: 'completed' | 'auto_resolved',
): GameState {
  return appendGameEvent(state, {
    id: `${state.id}:${state.dayNumber}:${playerId}:turn_completed`,
    type: 'turn_completed',
    dayNumber: state.dayNumber,
    playerId,
    resolution,
  });
}
