import { describe, it, expect } from 'vitest';
import { earnedTroops, validateReinforcement, applyReinforcement } from '../reinforce.js';
import type { GameConfig, GameState } from '../types.js';

const config: GameConfig = {
  exercises: [
    { key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 },
    { key: 'lifting', label: 'Weightlifting', unitLabel: 'min', troopsPerUnit: 1 / 30, dailyUnitCap: 60 },
  ],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

describe('earnedTroops', () => {
  it('applies per-exercise unit caps', () => {
    const r = earnedTroops(config, [{ exerciseKey: 'running', units: 10 }]);
    expect(r.perExercise.running).toBe(3); // capped at 3 miles
    expect(r.total).toBe(3);
  });

  it('accumulates fractional conversions before flooring the total', () => {
    // 45 min lifting = 1.5 troops; floors to 1 at the total stage
    const r = earnedTroops(config, [{ exerciseKey: 'lifting', units: 45 }]);
    expect(r.total).toBe(1);
  });

  it('sums across exercise types then applies the daily total cap', () => {
    const r = earnedTroops(config, [
      { exerciseKey: 'running', units: 3 }, // 3 troops
      { exerciseKey: 'lifting', units: 60 }, // 2 troops -> raw 5
    ]);
    expect(r.total).toBe(5);
    expect(r.totalCapApplied).toBe(false);
  });

  it('clips to the daily total cap and flags it', () => {
    const generous: GameConfig = { ...config, dailyTotalTroopCap: 4 };
    const r = earnedTroops(generous, [
      { exerciseKey: 'running', units: 3 },
      { exerciseKey: 'lifting', units: 60 },
    ]);
    expect(r.total).toBe(4);
    expect(r.totalCapApplied).toBe(true);
  });

  it('ignores unknown exercise keys', () => {
    const r = earnedTroops(config, [{ exerciseKey: 'yoga', units: 100 }]);
    expect(r.total).toBe(0);
  });

  it('caps categories before applying the overall daily cap', () => {
    const healthConfig: GameConfig = {
      ...config,
      exercises: [
        { key: 'run', label: 'Run', unitLabel: 'mile', category: 'movement', troopsPerUnit: 2, dailyUnitCap: 10 },
        { key: 'veg', label: 'Vegetables', unitLabel: 'completion', category: 'nutrition', troopsPerUnit: 1, dailyUnitCap: 1 },
      ],
      categoryTroopCaps: { movement: 4, nutrition: 2 },
      dailyTotalTroopCap: 6,
    };
    const r = earnedTroops(healthConfig, [
      { exerciseKey: 'run', units: 10 },
      { exerciseKey: 'veg', units: 1 },
    ]);
    expect(r.perExercise.run).toBe(20);
    expect(r.perCategory.movement).toBe(4);
    expect(r.perCategory.nutrition).toBe(1);
    expect(r.total).toBe(5);
    expect(r.totalCapApplied).toBe(true);
  });
});

function stateWith(pending: number): GameState {
  return {
    id: 'g',
    config,
    players: [{ id: 'p1', name: 'A', status: 'active', pendingReinforcements: pending, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' }],
    territories: [
      { id: 'alaska', owner: 'p1', armies: 1 },
      { id: 'brazil', owner: 'p2', armies: 1 },
    ],
    turnOrder: ['p1'],
    dayNumber: 0,
    status: 'active',
  };
}

describe('reinforcement placement', () => {
  it('rejects placing more than banked', () => {
    const s = stateWith(2);
    const err = validateReinforcement(s, 'p1', [{ territoryId: 'alaska', count: 3 }]);
    expect(err?.code).toBe('over_bank');
  });

  it('rejects placing on territory you do not own', () => {
    const s = stateWith(5);
    const err = validateReinforcement(s, 'p1', [{ territoryId: 'brazil', count: 1 }]);
    expect(err?.code).toBe('not_owner');
  });

  it('rejects empty or malformed placement counts before they can corrupt game totals', () => {
    const s = stateWith(5);
    expect(validateReinforcement(s, 'p1', [])?.code).toBe('bad_placements');
    for (const count of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      const placements = [{ territoryId: 'alaska', count }] as unknown as Parameters<
        typeof validateReinforcement
      >[2];
      expect(validateReinforcement(s, 'p1', placements)?.code).toBe('bad_count');
    }
  });

  it('applies placements and debits the bank', () => {
    const s = stateWith(5);
    const err = validateReinforcement(s, 'p1', [{ territoryId: 'alaska', count: 3 }]);
    expect(err).toBeNull();
    const next = applyReinforcement(s, 'p1', [{ territoryId: 'alaska', count: 3 }]);
    expect(next.territories.find((t) => t.id === 'alaska')!.armies).toBe(4);
    expect(next.players[0]!.pendingReinforcements).toBe(2);
  });
});
