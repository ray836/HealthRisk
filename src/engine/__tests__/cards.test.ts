import { describe, expect, it } from 'vitest';
import {
  applyCardTrade,
  awardConquestCard,
  CARD_TRADE_REINFORCEMENTS,
  validateCardTrade,
} from '../cards.js';
import { createGame } from '../setup.js';
import type { GameConfig } from '../types.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function game() {
  return createGame({
    id: 'g',
    config,
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    seed: 7,
  });
}

describe('conquest cards', () => {
  it('awards a captured-territory card only once for the same turn', () => {
    const first = awardConquestCard(game(), 'a', 2, 'india');
    expect(first.awarded).toBe(true);
    expect(first.card).toMatchObject({ territoryId: 'india', earnedDay: 2 });
    expect(first.state.players.find((player) => player.id === 'a')!.cards).toHaveLength(1);
    expect(first.state.events).toContainEqual(
      expect.objectContaining({
        type: 'conquest_card_earned',
        playerId: 'a',
        territoryId: 'india',
      }),
    );

    const retry = awardConquestCard(first.state, 'a', 2, 'brazil');
    expect(retry.awarded).toBe(false);
    expect(retry.card.territoryId).toBe('india');
    expect(retry.state.players.find((player) => player.id === 'a')!.cards).toHaveLength(1);
    expect(retry.state.events).toHaveLength(1);
  });

  it('trades exactly three cards for a fixed three troops', () => {
    let state = game();
    state = awardConquestCard(state, 'a', 1, 'india').state;
    state = awardConquestCard(state, 'a', 2, 'china').state;
    state = awardConquestCard(state, 'a', 3, 'siam').state;

    expect(validateCardTrade(state, 'a')).toBeNull();
    const next = applyCardTrade(state, 'a');
    const player = next.players.find((candidate) => candidate.id === 'a')!;
    expect(player.cards).toHaveLength(0);
    expect(player.pendingReinforcements).toBe(CARD_TRADE_REINFORCEMENTS);
  });

  it('rejects a trade with fewer than three cards', () => {
    const state = awardConquestCard(game(), 'a', 1, 'india').state;
    expect(validateCardTrade(state, 'a')).toMatchObject({ code: 'not_enough_cards' });
  });
});
