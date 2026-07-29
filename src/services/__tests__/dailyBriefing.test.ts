import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig, GameEvent } from '../../engine/types.js';
import { buildDailyBriefing } from '../dailyBriefing.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Los_Angeles',
};

function event(overrides: Partial<GameEvent> & Pick<GameEvent, 'id' | 'type'>): GameEvent {
  return { dayNumber: 1, ...overrides } as GameEvent;
}

describe('buildDailyBriefing', () => {
  it('summarizes only events after the player previous turn and before the frozen boundary', () => {
    const game = createGame({
      id: 'g',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      seed: 7,
    });
    game.dayNumber = 2;
    game.events = [
      event({ id: 'a-done', type: 'turn_completed', dayNumber: 1, playerId: 'a', resolution: 'completed' }),
      event({
        id: 'lost-alaska',
        type: 'attack_resolved',
        playerId: 'b',
        previousOwnerId: 'a',
        fromId: 'alberta',
        toId: 'alaska',
        attackerLosses: 1,
        defenderLosses: 2,
        captured: true,
        continentsGained: [],
        continentsLost: ['north_america'],
      }),
      event({
        id: 'held-brazil',
        type: 'attack_resolved',
        playerId: 'c',
        previousOwnerId: 'a',
        fromId: 'peru',
        toId: 'brazil',
        attackerLosses: 2,
        defenderLosses: 1,
        captured: false,
        continentsGained: [],
        continentsLost: [],
      }),
      event({ id: 'trade', type: 'cards_traded', playerId: 'b', troopsAwarded: 3 }),
      event({
        id: 'elimination',
        type: 'player_eliminated',
        eliminatedPlayerId: 'c',
        eliminatedByPlayerId: 'b',
        rewardTroops: 3,
      }),
      event({ id: 'b-done', type: 'turn_completed', playerId: 'b', resolution: 'completed' }),
      event({
        id: 'too-late',
        type: 'attack_resolved',
        playerId: 'b',
        previousOwnerId: 'a',
        fromId: 'ontario',
        toId: 'quebec',
        attackerLosses: 0,
        defenderLosses: 1,
        captured: true,
        continentsGained: [],
        continentsLost: [],
      }),
    ];

    const briefing = buildDailyBriefing(game, 'a', 6);

    expect(briefing).toMatchObject({
      fromDay: 1,
      throughDay: 2,
      isFirstTurn: false,
      territoryGains: [],
      territoryLosses: ['alaska'],
      attacksAgainstYou: 2,
      continentsLost: ['north_america'],
      changedTerritoryIds: ['alaska'],
      hasChanges: true,
    });
    expect(briefing.eliminations).toHaveLength(1);
    expect(briefing.notableEvents.map((item) => item.id)).toEqual([
      'lost-alaska',
      'held-brazil',
      'trade',
      'elimination',
    ]);
  });

  it('labels an empty first turn as all quiet', () => {
    const game = createGame({
      id: 'g',
      config,
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seed: 3,
    });

    expect(buildDailyBriefing(game, 'a', 0)).toMatchObject({
      fromDay: null,
      isFirstTurn: true,
      hasChanges: false,
      changedTerritoryIds: [],
    });
  });
});
