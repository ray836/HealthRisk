import { describe, it, expect } from 'vitest';
import { areConnectedThroughOwned, validateFortify, applyFortify } from '../fortify.js';
import type { GameConfig, GameState } from '../types.js';

const config = {} as GameConfig;

// Owned chain: alaska - alberta - ontario (all p1). quebec is p1 but only
// reachable via ontario. brazil is p2. northwest_territory is p2 (a gap).
function state(): GameState {
  return {
    id: 'g',
    config,
    players: [],
    territories: [
      { id: 'alaska', owner: 'p1', armies: 5 },
      { id: 'alberta', owner: 'p1', armies: 3 },
      { id: 'ontario', owner: 'p1', armies: 2 },
      { id: 'quebec', owner: 'p1', armies: 1 },
      { id: 'northwest_territory', owner: 'p2', armies: 4 },
      { id: 'western_us', owner: 'p2', armies: 4 },
    ],
    turnOrder: [],
    dayNumber: 0,
    status: 'active',
  };
}

describe('fortify connectivity', () => {
  it('connects endpoints through an owned chain', () => {
    // alaska -> quebec via alberta -> ontario -> quebec (all owned by p1)
    expect(areConnectedThroughOwned(state(), 'p1', 'alaska', 'quebec')).toBe(true);
  });

  it('does not connect through enemy territory', () => {
    // alaska and greenland would need to pass through non-owned territory
    const s = state();
    // quebec connects to greenland? greenland not present/owned -> not connected
    expect(areConnectedThroughOwned(s, 'p1', 'alaska', 'greenland')).toBe(false);
  });

  it('rejects a fortify that leaves origin empty', () => {
    const err = validateFortify(state(), 'p1', { fromId: 'alaska', toId: 'alberta', count: 5 });
    expect(err?.code).toBe('must_hold_origin');
  });

  it('rejects moving between disconnected owned territories', () => {
    // Make quebec unreachable by flipping ontario to p2
    const s = state();
    s.territories.find((t) => t.id === 'ontario')!.owner = 'p2';
    const err = validateFortify(s, 'p1', { fromId: 'alaska', toId: 'quebec', count: 1 });
    expect(err?.code).toBe('not_connected');
  });

  it('applies a valid fortify move', () => {
    const s = state();
    const err = validateFortify(s, 'p1', { fromId: 'alaska', toId: 'quebec', count: 4 });
    expect(err).toBeNull();
    const next = applyFortify(s, { fromId: 'alaska', toId: 'quebec', count: 4 });
    expect(next.territories.find((t) => t.id === 'alaska')!.armies).toBe(1);
    expect(next.territories.find((t) => t.id === 'quebec')!.armies).toBe(5);
  });
});
