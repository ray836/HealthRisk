/**
 * Game setup (§2).
 *
 * Territory distribution uses the neutral-garrison approach (DECISIONS.md open
 * item #1): territories are dealt evenly to players; leftovers become neutral
 * garrisons with a fixed army count, ownerless and unable to act, but
 * attackable. Everything is seeded so a game's initial board is reproducible.
 */

import { makeRng } from './rng.js';
import { TERRITORY_IDS, startingArmies } from './map.js';
import type { GameConfig, GameState, Player, PlayerId, Territory } from './types.js';

export const NEUTRAL_GARRISON_ARMIES = 2;

export interface CreateGameInput {
  id: string;
  config: GameConfig;
  players: Array<{ id: PlayerId; name: string }>;
  seed: number;
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = makeRng(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Deal all 42 territories: round-robin to players, remainder to neutral.
 * Returns a map territoryId -> ownerId | null.
 */
export function dealTerritories(
  playerIds: PlayerId[],
  seed: number,
): Record<string, PlayerId | null> {
  const order = shuffled(TERRITORY_IDS, seed);
  const perPlayer = Math.floor(order.length / playerIds.length);
  const owned = perPlayer * playerIds.length;

  const assignment: Record<string, PlayerId | null> = {};
  for (let i = 0; i < owned; i++) {
    assignment[order[i]!] = playerIds[i % playerIds.length]!;
  }
  for (let i = owned; i < order.length; i++) {
    assignment[order[i]!] = null; // neutral
  }
  return assignment;
}

/**
 * Distribute a player's starting armies across their territories: 1 on each,
 * then the remainder round-robin (deterministic). Neutral territories get a
 * fixed garrison.
 */
export function createGame(input: CreateGameInput): GameState {
  const { id, config, players, seed } = input;
  if (players.length < 2 || players.length > 10) {
    throw new Error('Exercise Risk supports 2–10 players');
  }
  const playerIds = players.map((p) => p.id);
  const assignment = dealTerritories(playerIds, seed);

  // Base 1 army everywhere; neutral gets the garrison count.
  const territories: Territory[] = TERRITORY_IDS.map((tid) => {
    const owner = assignment[tid] ?? null;
    return { id: tid, owner, armies: owner === null ? NEUTRAL_GARRISON_ARMIES : 1 };
  });

  // Distribute each player's remaining starting armies round-robin over their
  // owned territories, seeded for reproducibility.
  const totalPerPlayer = startingArmies(players.length);
  for (const pid of playerIds) {
    const ownedTerr = territories.filter((t) => t.owner === pid);
    let remaining = totalPerPlayer - ownedTerr.length; // 1 already placed each
    if (remaining < 0) {
      throw new Error(`Starting armies (${totalPerPlayer}) < territories owned by ${pid}`);
    }
    const orderedOwned = shuffled(
      ownedTerr.map((t) => t.id),
      seed ^ hashId(pid),
    );
    let i = 0;
    while (remaining > 0) {
      const tid = orderedOwned[i % orderedOwned.length]!;
      territories.find((t) => t.id === tid)!.armies += 1;
      remaining--;
      i++;
    }
  }

  const turnOrder = shuffled(playerIds, seed ^ 0x9e3779b9);

  const playerRecords: Player[] = players.map((p) => ({
    id: p.id,
    name: p.name,
    status: 'active',
    cards: [],
    pendingEliminationReward: 0,
    pendingReinforcements: 0,
    consecutiveAutoResolvedDays: 0,
    standingOrdersNote: '',
  }));

  return {
    id,
    revision: 1,
    config,
    players: playerRecords,
    territories,
    turnOrder,
    dayNumber: 0,
    status: 'active',
  };
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
