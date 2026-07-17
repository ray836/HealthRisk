import { describe, it, expect } from 'vitest';
import { applyTurnPlan, type TurnPlan } from '../turnPlan.js';
import { buildPlannerContext } from '../planner.js';
import { defensiveTurnPlan } from '../autoplace.js';
import { TERRITORY_IDS } from '../map.js';
import type { GameConfig, GameState } from '../types.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 20,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

// a owns venezuela (adjacent to brazil/peru, both b's). b's stacks are weak so
// a big committed attack should reliably capture.
function board(overrides?: Partial<GameConfig>): GameState {
  const aTerr = new Set(['venezuela', 'central_america']);
  const bTerr = new Set(['brazil', 'peru']);
  return {
    id: 'g',
    config: { ...config, ...overrides },
    players: [
      { id: 'a', name: 'A', status: 'active', pendingReinforcements: 5, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
      { id: 'b', name: 'B', status: 'active', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
    ],
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: aTerr.has(id) ? 'a' : bTerr.has(id) ? 'b' : null,
      armies: aTerr.has(id) ? 10 : bTerr.has(id) ? 1 : 1,
    })),
    turnOrder: ['a', 'b'],
    dayNumber: 3,
    status: 'active',
  };
}

describe('applyTurnPlan', () => {
  it('applies legal placements and debits the bank', () => {
    const plan: TurnPlan = { placements: [{ territoryId: 'venezuela', count: 5 }], attacks: [] };
    const rep = applyTurnPlan(board(), 'a', plan, 'seed');
    expect(rep.placedTroops).toBe(5);
    expect(rep.state.territories.find((t) => t.id === 'venezuela')!.armies).toBe(15);
    expect(rep.state.players.find((p) => p.id === 'a')!.pendingReinforcements).toBe(0);
    expect(rep.rejected).toHaveLength(0);
  });

  it('skips illegal placements but keeps legal ones', () => {
    const plan: TurnPlan = {
      placements: [
        { territoryId: 'brazil', count: 2 }, // not owned by a
        { territoryId: 'venezuela', count: 3 }, // ok
        { territoryId: 'venezuela', count: 99 }, // over remaining bank
      ],
      attacks: [],
    };
    const rep = applyTurnPlan(board(), 'a', plan, 'seed');
    expect(rep.placedTroops).toBe(3);
    expect(rep.rejected.map((r) => r.reason).sort()).toEqual(['not_owner', 'over_bank']);
  });

  it('executes a note-style attack and captures a weak neighbor', () => {
    const plan: TurnPlan = {
      placements: [{ territoryId: 'venezuela', count: 5 }], // venezuela -> 15
      attacks: [{ fromId: 'venezuela', toId: 'brazil', committedTroops: 12, stopLoss: 100 }],
    };
    const rep = applyTurnPlan(board(), 'a', plan, 'seed');
    expect(rep.attacks).toHaveLength(1);
    expect(rep.attacks[0]!.result.captured).toBe(true);
    expect(rep.state.territories.find((t) => t.id === 'brazil')!.owner).toBe('a');
  });

  it('skips an illegal attack (non-adjacent) without throwing', () => {
    const plan: TurnPlan = {
      placements: [],
      attacks: [{ fromId: 'venezuela', toId: 'india', committedTroops: 3, stopLoss: 3 }],
    };
    const rep = applyTurnPlan(board(), 'a', plan, 'seed');
    expect(rep.attacks).toHaveLength(0);
    expect(rep.rejected[0]!.reason).toBe('not_adjacent');
  });

  it('honors maxAttacksPerTurn', () => {
    const plan: TurnPlan = {
      placements: [],
      attacks: [
        { fromId: 'venezuela', toId: 'brazil', committedTroops: 3, stopLoss: 2 },
        { fromId: 'venezuela', toId: 'peru', committedTroops: 3, stopLoss: 2 },
      ],
    };
    const rep = applyTurnPlan(board({ maxAttacksPerTurn: 1 }), 'a', plan, 'seed');
    expect(rep.attacks).toHaveLength(1);
    expect(rep.rejected.some((r) => r.reason === 'max_attacks_reached')).toBe(true);
  });

  it('is deterministic for a given seedBase', () => {
    const plan: TurnPlan = {
      placements: [{ territoryId: 'venezuela', count: 5 }],
      attacks: [{ fromId: 'venezuela', toId: 'brazil', committedTroops: 8, stopLoss: 4 }],
    };
    const a = applyTurnPlan(board(), 'a', plan, 'g:3:a');
    const b = applyTurnPlan(board(), 'a', plan, 'g:3:a');
    expect(a.state.territories).toEqual(b.state.territories);
  });
});

describe('buildPlannerContext', () => {
  it('surfaces the note, bank, holdings and only legal attack edges', () => {
    const s = board();
    s.players[0]!.standingOrdersNote = 'push into South America from Venezuela';
    const ctx = buildPlannerContext(s, 'a');
    expect(ctx.note).toBe('push into South America from Venezuela');
    expect(ctx.pendingReinforcements).toBe(5);
    expect(ctx.defaultStopLoss).toBe(3);
    expect(ctx.ownedTerritories.map((t) => t.id).sort()).toEqual(['central_america', 'venezuela']);
    // venezuela (10 armies) can attack brazil and peru; central_america only
    // borders venezuela (owned) + US territories (neutral) -> those are legal too
    const edges = ctx.legalAttacks.filter((e) => e.fromId === 'venezuela').map((e) => e.toId).sort();
    expect(edges).toEqual(['brazil', 'peru']);
  });
});

describe('defensiveTurnPlan (empty-note fallback)', () => {
  it('produces placement-only, no attacks', () => {
    const plan = defensiveTurnPlan(board(), 'a');
    expect(plan.attacks).toHaveLength(0);
    expect(plan.fortify).toBeUndefined();
    expect(plan.placements.reduce((s, p) => s + p.count, 0)).toBe(5); // whole bank
  });
});
