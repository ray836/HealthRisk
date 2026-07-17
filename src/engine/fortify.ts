/**
 * Fortify phase (§4.3).
 *
 * Modern-Risk rule (DECISIONS.md, open item #5): one move per turn, between any
 * two owned territories connected by an unbroken chain of territories the player
 * owns. Connectivity is a BFS over the owned-territory subgraph.
 */

import { NEIGHBORS } from './map.js';
import type { GameState, TerritoryId } from './types.js';
import type { ValidationError } from './combat.js';

export interface FortifyMove {
  fromId: TerritoryId;
  toId: TerritoryId;
  count: number;
}

/**
 * True if `to` is reachable from `from` using only territories owned by
 * `playerId`. Both endpoints must be owned by the player.
 */
export function areConnectedThroughOwned(
  state: GameState,
  playerId: string,
  fromId: TerritoryId,
  toId: TerritoryId,
): boolean {
  const ownedBy = new Set(
    state.territories.filter((t) => t.owner === playerId).map((t) => t.id),
  );
  if (!ownedBy.has(fromId) || !ownedBy.has(toId)) return false;
  if (fromId === toId) return true;

  const visited = new Set<TerritoryId>([fromId]);
  const queue: TerritoryId[] = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of NEIGHBORS[cur] ?? []) {
      if (!ownedBy.has(n) || visited.has(n)) continue;
      if (n === toId) return true;
      visited.add(n);
      queue.push(n);
    }
  }
  return false;
}

/**
 * Validate a fortify move: distinct owned endpoints, connected via owned chain,
 * positive count, and origin must keep at least 1 army behind.
 */
export function validateFortify(
  state: GameState,
  playerId: string,
  move: FortifyMove,
): ValidationError | null {
  if (move.fromId === move.toId) return { code: 'same_territory', message: 'From and to must differ' };
  const from = state.territories.find((t) => t.id === move.fromId);
  const to = state.territories.find((t) => t.id === move.toId);
  if (!from || !to) return { code: 'no_territory', message: 'Unknown territory' };
  if (from.owner !== playerId) return { code: 'not_owner', message: 'You do not own the origin' };
  if (to.owner !== playerId) return { code: 'not_owner', message: 'You do not own the destination' };
  if (move.count < 1) return { code: 'bad_count', message: 'Must move at least 1 army' };
  if (move.count > from.armies - 1) {
    return { code: 'must_hold_origin', message: 'Must leave at least 1 army at the origin' };
  }
  if (!areConnectedThroughOwned(state, playerId, move.fromId, move.toId)) {
    return { code: 'not_connected', message: 'Territories are not connected through owned territory' };
  }
  return null;
}

/** Apply a validated fortify move. Returns new state. */
export function applyFortify(state: GameState, move: FortifyMove): GameState {
  const territories = state.territories.map((t) => ({ ...t }));
  territories.find((t) => t.id === move.fromId)!.armies -= move.count;
  territories.find((t) => t.id === move.toId)!.armies += move.count;
  return { ...state, territories };
}
