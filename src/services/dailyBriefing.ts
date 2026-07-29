/**
 * Player-specific daily briefing derived from the public gameplay event log.
 *
 * The caller supplies the event count captured at turn start. That boundary
 * keeps the briefing stable for the whole turn even while other browsers poll
 * and new events arrive.
 */

import type {
  GameEvent,
  GameState,
  PlayerEliminationEvent,
  PlayerId,
  TerritoryId,
} from '../engine/types.js';

export interface DailyBriefing {
  fromDay: number | null;
  throughDay: number;
  isFirstTurn: boolean;
  territoryGains: TerritoryId[];
  territoryLosses: TerritoryId[];
  attacksAgainstYou: number;
  continentsGained: string[];
  continentsLost: string[];
  eliminations: PlayerEliminationEvent[];
  notableEvents: GameEvent[];
  changedTerritoryIds: TerritoryId[];
  hasChanges: boolean;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function buildDailyBriefing(
  game: GameState,
  playerId: PlayerId,
  eventCount: number,
): DailyBriefing {
  const boundedEvents = (game.events ?? []).slice(0, Math.max(0, eventCount));
  let anchorIndex = -1;
  for (let index = boundedEvents.length - 1; index >= 0; index -= 1) {
    const event = boundedEvents[index]!;
    if (event.type === 'turn_completed' && event.playerId === playerId) {
      anchorIndex = index;
      break;
    }
  }

  const events = boundedEvents.slice(anchorIndex + 1);
  const territoryGains: TerritoryId[] = [];
  const territoryLosses: TerritoryId[] = [];
  const continentsGained: string[] = [];
  const continentsLost: string[] = [];
  const notableEvents: GameEvent[] = [];
  let attacksAgainstYou = 0;

  for (const event of events) {
    if (event.type === 'attack_resolved') {
      if (event.playerId === playerId && event.captured) {
        territoryGains.push(event.toId);
        continentsGained.push(...event.continentsGained);
        notableEvents.push(event);
      } else if (event.previousOwnerId === playerId) {
        attacksAgainstYou += 1;
        if (event.captured) {
          territoryLosses.push(event.toId);
          continentsLost.push(...event.continentsLost);
        }
        notableEvents.push(event);
      }
    } else if (
      event.type === 'player_eliminated' ||
      event.type === 'cards_traded' ||
      event.type === 'conquest_card_earned' ||
      (event.type === 'turn_completed' && event.resolution === 'auto_resolved')
    ) {
      notableEvents.push(event);
    }
  }

  const gains = unique(territoryGains);
  const losses = unique(territoryLosses);
  const gainedContinents = unique(continentsGained);
  const lostContinents = unique(continentsLost);
  const eliminations = events.filter(
    (event): event is PlayerEliminationEvent => event.type === 'player_eliminated',
  );
  const changedTerritoryIds = unique([...gains, ...losses]);
  const hasChanges =
    changedTerritoryIds.length > 0 ||
    attacksAgainstYou > 0 ||
    gainedContinents.length > 0 ||
    lostContinents.length > 0 ||
    notableEvents.length > 0;

  return {
    fromDay: anchorIndex >= 0 ? boundedEvents[anchorIndex]!.dayNumber : null,
    throughDay: game.dayNumber,
    isFirstTurn: anchorIndex < 0,
    territoryGains: gains,
    territoryLosses: losses,
    attacksAgainstYou,
    continentsGained: gainedContinents,
    continentsLost: lostContinents,
    eliminations,
    notableEvents,
    changedTerritoryIds,
    hasChanges,
  };
}
