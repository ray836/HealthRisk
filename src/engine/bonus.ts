/**
 * Standard Risk start-of-turn reinforcements (territory + continent bonuses).
 *
 * In Exercise Risk these are *added to* the troops earned from exercise (§3),
 * not a replacement: at the start of your turn you get
 *   - floor(territories owned / 3), minimum 3, plus
 *   - each continent's bonus for every continent you fully control.
 *
 * Pure — computed from current ownership at the moment the turn begins.
 */

import { CONTINENTS } from './map.js';
import type { GameState, PlayerId } from './types.js';

export interface OwnedContinent {
  id: string;
  label: string;
  bonus: number;
}

export interface ReinforcementBreakdown {
  territoriesOwned: number;
  territoryTroops: number;
  continents: OwnedContinent[];
  continentTroops: number;
  total: number;
}

/** floor(n/3), min 3 (standard Risk base reinforcement). */
export function baseReinforcements(territoriesOwned: number): number {
  return Math.max(3, Math.floor(territoriesOwned / 3));
}

/** Continents the player fully controls. */
export function ownedContinents(state: GameState, playerId: PlayerId): OwnedContinent[] {
  const owner = new Map(state.territories.map((t) => [t.id, t.owner]));
  const out: OwnedContinent[] = [];
  for (const c of CONTINENTS) {
    if (c.territories.every((tid) => owner.get(tid) === playerId)) {
      out.push({ id: c.id, label: c.label, bonus: c.bonus });
    }
  }
  return out;
}

/** Full start-of-turn reinforcement breakdown for a player. */
export function standardReinforcements(state: GameState, playerId: PlayerId): ReinforcementBreakdown {
  const territoriesOwned = state.territories.filter((t) => t.owner === playerId).length;
  const continents = ownedContinents(state, playerId);
  const continentTroops = continents.reduce((s, c) => s + c.bonus, 0);
  const territoryTroops = baseReinforcements(territoriesOwned);
  return {
    territoriesOwned,
    territoryTroops,
    continents,
    continentTroops,
    total: territoryTroops + continentTroops,
  };
}
