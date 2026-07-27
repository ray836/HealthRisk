import { describe, it, expect } from 'vitest';
import { createGame } from '../setup.js';
import {
  grantDailyReinforcements,
  applyEliminations,
  checkWin,
  forfeitPlayer,
  applyTurnEffect,
} from '../game.js';
import { chooseAutoPlaceTarget } from '../autoplace.js';
import { TERRITORY_IDS } from '../map.js';
import type { GameConfig, GameState } from '../types.js';

const config: GameConfig = {
  exercises: [{ key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 }],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: 3,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

describe('game setup', () => {
  it('deals all 42 territories with neutrals for 10 players', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const g = createGame({ id: 'g', config, players, seed: 42 });
    expect(g.territories).toHaveLength(42);
    const neutral = g.territories.filter((t) => t.owner === null);
    expect(neutral).toHaveLength(2); // 42 - 40
    for (const n of neutral) expect(n.armies).toBe(2);
  });

  it('gives each player the configured starting army total', () => {
    const players = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const g = createGame({ id: 'g', config, players, seed: 7 });
    for (const p of players) {
      const total = g.territories.filter((t) => t.owner === p.id).reduce((s, t) => s + t.armies, 0);
      expect(total).toBe(30); // 4-player standard
    }
  });

  it('is reproducible for a given seed', () => {
    const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const g1 = createGame({ id: 'g', config, players, seed: 99 });
    const g2 = createGame({ id: 'g', config, players, seed: 99 });
    expect(g1.territories).toEqual(g2.territories);
    expect(g1.turnOrder).toEqual(g2.turnOrder);
  });
});

describe('reinforcement banking and status', () => {
  it('banks earned troops for active players', () => {
    const g = createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 1 });
    const next = grantDailyReinforcements(g, 'a', [{ exerciseKey: 'running', units: 3 }]);
    expect(next.players.find((p) => p.id === 'a')!.pendingReinforcements).toBe(3);
  });

  it('does not bank for eliminated players', () => {
    let g = createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 1 });
    g = { ...g, players: g.players.map((p) => (p.id === 'a' ? { ...p, status: 'eliminated' } : p)) };
    const next = grantDailyReinforcements(g, 'a', [{ exerciseKey: 'running', units: 3 }]);
    expect(next.players.find((p) => p.id === 'a')!.pendingReinforcements).toBe(0);
  });
});

function twoPlayerBoard(aTerr: string[], bTerr: string[]): GameState {
  return {
    id: 'g',
    config,
    players: [
      { id: 'a', name: 'A', status: 'active', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
      { id: 'b', name: 'B', status: 'active', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
    ],
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: aTerr.includes(id) ? 'a' : bTerr.includes(id) ? 'b' : null,
      armies: 1,
    })),
    turnOrder: ['a', 'b'],
    dayNumber: 0,
    status: 'active',
  };
}

describe('elimination and win', () => {
  it('eliminates a player with no territories', () => {
    const s = twoPlayerBoard(TERRITORY_IDS.filter((t) => t !== 'brazil'), ['brazil']);
    let next = applyEliminations({ ...s });
    // b still owns brazil; nobody eliminated yet
    expect(next.players.find((p) => p.id === 'b')!.status).toBe('active');
    // now a takes brazil: b owns nothing
    next = { ...next, territories: next.territories.map((t) => ({ ...t, owner: 'a' })) };
    next = applyEliminations(next);
    expect(next.players.find((p) => p.id === 'b')!.status).toBe('eliminated');
  });

  it('banks a fixed reward, discards the defeated hand, and records the elimination once', () => {
    let state = twoPlayerBoard(TERRITORY_IDS, []);
    state = {
      ...state,
      players: state.players.map((player) =>
        player.id === 'b'
          ? {
              ...player,
              cards: [{ id: 'b-card', territoryId: 'brazil', earnedDay: 0 }],
              pendingReinforcements: 5,
            }
          : player,
      ),
    };

    const next = applyEliminations(state, 'a');
    expect(next.players.find((player) => player.id === 'a')!.pendingEliminationReward).toBe(3);
    expect(next.players.find((player) => player.id === 'b')).toMatchObject({
      status: 'eliminated',
      cards: [],
      pendingReinforcements: 0,
    });
    expect(next.events).toEqual([
      expect.objectContaining({
        type: 'player_eliminated',
        eliminatedPlayerId: 'b',
        eliminatedByPlayerId: 'a',
        rewardTroops: 3,
      }),
    ]);

    const repeated = applyEliminations(next, 'a');
    expect(repeated.players.find((player) => player.id === 'a')!.pendingEliminationReward).toBe(3);
    expect(repeated.events).toHaveLength(1);
  });

  it('declares the last remaining player the winner even while neutral garrisons remain', () => {
    const almost = twoPlayerBoard(TERRITORY_IDS.filter((t) => t !== 'brazil'), []);
    const earlyWin = checkWin(almost);
    expect(earlyWin.status).toBe('finished');
    expect(earlyWin.winnerId).toBe('a');
    const all = twoPlayerBoard(TERRITORY_IDS, []);
    const won = checkWin(all);
    expect(won.status).toBe('finished');
    expect(won.winnerId).toBe('a');
  });
});

describe('auto-resolution', () => {
  it('picks the most-threatened border territory', () => {
    // a owns two adjacent-to-enemy territories; china faces bigger enemy stacks.
    const s: GameState = {
      ...twoPlayerBoard(['china', 'ural'], ['siberia', 'mongolia', 'india', 'afghanistan']),
    };
    // Boost the stacks around china so it's clearly the most threatened.
    for (const id of ['siberia', 'mongolia', 'india', 'afghanistan']) {
      s.territories.find((t) => t.id === id)!.armies = 5;
    }
    const target = chooseAutoPlaceTarget(s, 'a');
    expect(target).toBe('china');
  });

  it('auto-resolves an inactive turn by placing the full bank defensively', () => {
    let s = twoPlayerBoard(['china', 'ural'], ['siberia', 'mongolia', 'india', 'afghanistan']);
    // Below the forfeit threshold so we can observe the placement itself.
    s = { ...s, players: s.players.map((p) => (p.id === 'a' ? { ...p, pendingReinforcements: 4, consecutiveAutoResolvedDays: 0 } : p)) };
    const before = s.territories.reduce((sum, t) => sum + (t.owner === 'a' ? t.armies : 0), 0);
    s = applyTurnEffect(s, { type: 'auto_resolved', playerId: 'a' }).state;
    const after = s.territories.reduce((sum, t) => sum + (t.owner === 'a' ? t.armies : 0), 0);
    expect(after).toBe(before + 4);
    expect(s.players.find((p) => p.id === 'a')!.status).toBe('auto_piloted');
    expect(s.players.find((p) => p.id === 'a')!.pendingReinforcements).toBe(0);
    expect(s.players.find((p) => p.id === 'a')!.consecutiveAutoResolvedDays).toBe(1);
  });

  it('auto-forfeits once the consecutive auto-resolve threshold is hit', () => {
    let s = twoPlayerBoard(['china', 'ural'], ['siberia', 'mongolia', 'india', 'afghanistan']);
    // Counter already at 2; this 3rd consecutive auto-resolve hits autoForfeitAfterDays=3.
    s = { ...s, players: s.players.map((p) => (p.id === 'a' ? { ...p, pendingReinforcements: 4, consecutiveAutoResolvedDays: 2 } : p)) };
    s = applyTurnEffect(s, { type: 'auto_resolved', playerId: 'a' }).state;
    expect(s.players.find((p) => p.id === 'a')!.status).toBe('forfeited');
    // forfeited player's territories became neutral
    expect(s.territories.filter((t) => t.owner === 'a')).toHaveLength(0);
  });

  it('auto-resolves a note-driven plan (reinforce + attack) via applyTurnEffect', () => {
    // a owns china with a big stack; b holds a weak india. A note-driven plan
    // reinforces china then attacks india — passed in as if produced by the AI.
    let s = twoPlayerBoard(['china'], ['india']);
    s = {
      ...s,
      territories: s.territories.map((t) =>
        t.id === 'china' ? { ...t, armies: 12 } : t.id === 'india' ? { ...t, armies: 1 } : t,
      ),
      players: s.players.map((p) => (p.id === 'a' ? { ...p, pendingReinforcements: 3 } : p)),
    };
    const plan = {
      placements: [{ territoryId: 'china', count: 3 }],
      attacks: [{ fromId: 'china', toId: 'india', committedTroops: 14, stopLoss: 14 }],
    };
    const res = applyTurnEffect(s, { type: 'auto_resolved', playerId: 'a' }, plan);
    expect(res.autoReport).toBeDefined();
    expect(res.autoReport!.attacks[0]!.result.captured).toBe(true);
    expect(res.state.territories.find((t) => t.id === 'india')!.owner).toBe('a');
    expect(res.state.players.find((p) => p.id === 'a')!.status).toBe('auto_piloted');
  });

  it('resets the auto-resolve counter on a completed turn', () => {
    let s = twoPlayerBoard(['china'], ['india']);
    s = { ...s, players: s.players.map((p) => (p.id === 'a' ? { ...p, consecutiveAutoResolvedDays: 2 } : p)) };
    s = applyTurnEffect(s, { type: 'completed', playerId: 'a' }).state;
    expect(s.players.find((p) => p.id === 'a')!.consecutiveAutoResolvedDays).toBe(0);
  });
});

describe('forfeit', () => {
  it('converts a forfeited player\'s territories to neutral', () => {
    const s = twoPlayerBoard(['china', 'ural'], ['india']);
    const next = forfeitPlayer(s, 'a');
    expect(next.players.find((p) => p.id === 'a')!.status).toBe('forfeited');
    expect(next.territories.filter((t) => t.owner === 'a')).toHaveLength(0);
    expect(next.territories.filter((t) => t.id === 'china')[0]!.owner).toBeNull();
  });
});
