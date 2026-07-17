import { describe, it, expect } from 'vitest';
import { baseReinforcements, ownedContinents, standardReinforcements } from '../bonus.js';
import { CONTINENTS, TERRITORY_IDS } from '../map.js';
import type { GameConfig, GameState } from '../types.js';

const config = {} as GameConfig;

function board(ownerOf: (id: string) => string | null): GameState {
  return {
    id: 'g',
    config,
    players: [],
    territories: TERRITORY_IDS.map((id) => ({ id, owner: ownerOf(id), armies: 1 })),
    turnOrder: [],
    dayNumber: 0,
    status: 'active',
  };
}

const northAmerica = CONTINENTS.find((c) => c.id === 'north_america')!;

describe('baseReinforcements', () => {
  it('is floor(n/3) with a minimum of 3', () => {
    expect(baseReinforcements(1)).toBe(3);
    expect(baseReinforcements(8)).toBe(3);
    expect(baseReinforcements(9)).toBe(3);
    expect(baseReinforcements(11)).toBe(3);
    expect(baseReinforcements(12)).toBe(4);
    expect(baseReinforcements(21)).toBe(7);
  });
});

describe('continent control', () => {
  it('awards a continent only when fully owned', () => {
    // a owns all of North America minus one territory -> no bonus.
    const partial = board((id) => (northAmerica.territories.includes(id) && id !== 'alaska' ? 'a' : null));
    expect(ownedContinents(partial, 'a')).toHaveLength(0);

    // a owns all of North America -> the continent bonus applies.
    const full = board((id) => (northAmerica.territories.includes(id) ? 'a' : null));
    const owned = ownedContinents(full, 'a');
    expect(owned.map((c) => c.id)).toEqual(['north_america']);
    expect(owned[0]!.bonus).toBe(northAmerica.bonus); // 5
  });
});

describe('standardReinforcements', () => {
  it('sums territory and continent bonuses', () => {
    // a owns all 9 NA territories + 3 more elsewhere = 12 territories, plus the NA continent.
    const extra = ['brazil', 'venezuela', 'peru'];
    const s = board((id) => (northAmerica.territories.includes(id) || extra.includes(id) ? 'a' : null));
    const r = standardReinforcements(s, 'a');
    expect(r.territoriesOwned).toBe(12);
    expect(r.territoryTroops).toBe(4); // floor(12/3)
    expect(r.continentTroops).toBe(5); // North America
    expect(r.total).toBe(9);
  });

  it('gives the base minimum with a single territory and no continent', () => {
    const s = board((id) => (id === 'china' ? 'a' : null));
    const r = standardReinforcements(s, 'a');
    expect(r.total).toBe(3);
    expect(r.continents).toHaveLength(0);
  });
});
