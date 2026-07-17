import { describe, it, expect } from 'vitest';
import {
  CONTINENTS,
  TERRITORY_IDS,
  NEIGHBORS,
  areAdjacent,
  assertSymmetric,
  startingArmies,
} from '../map.js';

describe('board data', () => {
  it('has exactly 42 territories across 6 continents', () => {
    expect(TERRITORY_IDS).toHaveLength(42);
    expect(CONTINENTS).toHaveLength(6);
    const counts = CONTINENTS.map((c) => c.territories.length);
    expect(counts).toEqual([9, 4, 7, 6, 12, 4]);
  });

  it('has no duplicate territory ids', () => {
    expect(new Set(TERRITORY_IDS).size).toBe(42);
  });

  it('adjacency is fully symmetric', () => {
    expect(() => assertSymmetric()).not.toThrow();
  });

  it('every territory has at least one neighbor', () => {
    for (const t of TERRITORY_IDS) {
      expect(NEIGHBORS[t]!.length).toBeGreaterThan(0);
    }
  });

  it('encodes the canonical inter-continent bridges', () => {
    expect(areAdjacent('alaska', 'kamchatka')).toBe(true); // NA <-> Asia
    expect(areAdjacent('greenland', 'iceland')).toBe(true); // NA <-> Europe
    expect(areAdjacent('brazil', 'north_africa')).toBe(true); // SA <-> Africa
    expect(areAdjacent('siam', 'indonesia')).toBe(true); // Asia <-> Australia
    expect(areAdjacent('central_america', 'venezuela')).toBe(true); // NA <-> SA
    // a couple of non-edges
    expect(areAdjacent('alaska', 'iceland')).toBe(false);
    expect(areAdjacent('brazil', 'argentina')).toBe(true);
    expect(areAdjacent('japan', 'china')).toBe(false);
  });

  it('scales starting armies down for high player counts', () => {
    expect(startingArmies(3)).toBe(35);
    expect(startingArmies(6)).toBe(20);
    expect(startingArmies(10)).toBe(12);
    expect(startingArmies(8)).toBe(15);
    expect(() => startingArmies(11)).toThrow();
  });
});
