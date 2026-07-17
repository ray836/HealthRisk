/**
 * Defensive auto-placement (§5, DECISIONS.md open item #2).
 *
 * Used as the deterministic fallback when a player misses their window and has
 * no usable standing-orders note. The player takes no attack and no fortify;
 * their banked reinforcements are placed entirely on the single most-threatened
 * border territory.
 *
 * Threat model, per owned *border* territory T (a territory with at least one
 * neighbor not owned by the player):
 *   threat(T) = sum(armies of enemy/neutral neighbors) - armies(T)
 * Higher threat = more exposed. We reinforce the highest-threat territory.
 *
 * Deterministic tie-breaks (so auto-resolution is reproducible and auditable):
 *   1. highest threat deficit
 *   2. highest total adjacent enemy strength
 *   3. fewest own armies currently
 *   4. territory id, alphabetical
 *
 * If the player has no border territories (they own everything adjacent to
 * them — effectively near-victory), reinforce the owned territory with the
 * fewest armies (alphabetical tie-break).
 */

import { NEIGHBORS } from './map.js';
import { applyReinforcement } from './reinforce.js';
import type { TurnPlan } from './turnPlan.js';
import type { GameState, TerritoryId } from './types.js';

interface Candidate {
  id: TerritoryId;
  threat: number;
  adjEnemy: number;
  ownArmies: number;
}

export function chooseAutoPlaceTarget(state: GameState, playerId: string): TerritoryId | null {
  const armiesOf = new Map(state.territories.map((t) => [t.id, t]));
  const owned = state.territories.filter((t) => t.owner === playerId);
  if (owned.length === 0) return null;

  const borders: Candidate[] = [];
  for (const t of owned) {
    let adjEnemy = 0;
    let hasEnemyNeighbor = false;
    for (const n of NEIGHBORS[t.id] ?? []) {
      const neighbor = armiesOf.get(n);
      if (!neighbor) continue;
      if (neighbor.owner !== playerId) {
        hasEnemyNeighbor = true;
        adjEnemy += neighbor.armies;
      }
    }
    if (hasEnemyNeighbor) {
      borders.push({ id: t.id, threat: adjEnemy - t.armies, adjEnemy, ownArmies: t.armies });
    }
  }

  const pool: Candidate[] =
    borders.length > 0
      ? borders
      : owned.map((t) => ({ id: t.id, threat: -t.armies, adjEnemy: 0, ownArmies: t.armies }));

  pool.sort(
    (a, b) =>
      b.threat - a.threat ||
      b.adjEnemy - a.adjEnemy ||
      a.ownArmies - b.ownArmies ||
      a.id.localeCompare(b.id),
  );
  return pool[0]!.id;
}

/**
 * Auto-resolve the reinforcement of an inactive player: place their entire
 * pending bank on the chosen defensive target. No attack, no fortify.
 * Returns new state. If the player has no banked troops or no territories,
 * state is returned unchanged (aside from any pending clear the caller does).
 */
export function autoResolveReinforcement(state: GameState, playerId: string): GameState {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.pendingReinforcements <= 0) return state;
  const target = chooseAutoPlaceTarget(state, playerId);
  if (!target) return state;
  return applyReinforcement(state, playerId, [
    { territoryId: target, count: player.pendingReinforcements },
  ]);
}

/**
 * The deterministic defensive fallback expressed as a TurnPlan: place the whole
 * bank on the most-threatened border territory, no attacks, no fortify. This is
 * what auto-resolution uses when a player's standing-orders note is empty (or
 * when the AI planner is unavailable), so every auto-resolved turn flows through
 * the same applyTurnPlan path.
 */
export function defensiveTurnPlan(state: GameState, playerId: string): TurnPlan {
  const player = state.players.find((p) => p.id === playerId);
  const target = chooseAutoPlaceTarget(state, playerId);
  const placements =
    player && player.pendingReinforcements > 0 && target
      ? [{ territoryId: target, count: player.pendingReinforcements }]
      : [];
  return { placements, attacks: [], rationale: 'defensive fallback (no standing orders)' };
}
