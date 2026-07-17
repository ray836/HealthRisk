/**
 * Planner seam (§5 AI auto-resolution).
 *
 * The engine is pure and deterministic; calling an LLM is neither. So the AI
 * lives behind this seam:
 *
 *   buildPlannerContext(state, playerId)  -- pure: packages everything the AI
 *                                            needs (board, this player's
 *                                            holdings, legal attack edges,
 *                                            bank, and their standing-orders
 *                                            note) into a plain object.
 *   TurnPlanner                           -- the service implements this,
 *                                            turning that context (via an LLM)
 *                                            into a TurnPlan.
 *
 * The returned TurnPlan is then run through applyTurnPlan, which re-validates
 * everything, so a bad plan can never corrupt state. `defensiveTurnPlan`
 * (autoplace.ts) is the built-in fallback planner for empty notes / AI outage.
 */

import { NEIGHBORS } from './map.js';
import type { GameState, PlayerId, TerritoryId } from './types.js';
import type { TurnPlan } from './turnPlan.js';

export interface TerritoryView {
  id: TerritoryId;
  armies: number;
  owner: PlayerId | null; // null = neutral
  mine: boolean;
  neighbors: Array<{ id: TerritoryId; armies: number; owner: PlayerId | null; mine: boolean }>;
}

export interface AttackEdge {
  fromId: TerritoryId;
  toId: TerritoryId;
  /** Max troops the player could commit from `fromId` (armies - 1). */
  maxCommit: number;
  defenderArmies: number;
}

export interface PlannerContext {
  gameId: string;
  dayNumber: number;
  playerId: PlayerId;
  /** The player's persistent standing-orders note (may be empty). */
  note: string;
  pendingReinforcements: number;
  /** Conservative default stop-loss for note-driven attacks. */
  defaultStopLoss: number;
  maxAttacksPerTurn: number | null;
  /** Every territory the player owns, with neighbors, for placement/fortify. */
  ownedTerritories: TerritoryView[];
  /** All legal attack edges (owned -> adjacent enemy/neutral with >1 army to commit). */
  legalAttacks: AttackEdge[];
}

/**
 * A pluggable turn planner. The deterministic fallback and the AI implementation
 * both satisfy this. Async because the AI implementation does I/O.
 */
export type TurnPlanner = (ctx: PlannerContext) => Promise<TurnPlan> | TurnPlan;

/** Build the (pure) context object an AI planner consumes. */
export function buildPlannerContext(state: GameState, playerId: PlayerId): PlannerContext {
  const byId = new Map(state.territories.map((t) => [t.id, t]));
  const player = state.players.find((p) => p.id === playerId);

  const ownedTerritories: TerritoryView[] = [];
  const legalAttacks: AttackEdge[] = [];

  for (const t of state.territories) {
    if (t.owner !== playerId) continue;
    const neighbors = (NEIGHBORS[t.id] ?? []).map((n) => {
      const nt = byId.get(n)!;
      return { id: n, armies: nt.armies, owner: nt.owner, mine: nt.owner === playerId };
    });
    ownedTerritories.push({ id: t.id, armies: t.armies, owner: t.owner, mine: true, neighbors });

    if (t.armies > 1) {
      for (const nb of neighbors) {
        if (!nb.mine) {
          legalAttacks.push({
            fromId: t.id,
            toId: nb.id,
            maxCommit: t.armies - 1,
            defenderArmies: nb.armies,
          });
        }
      }
    }
  }

  return {
    gameId: state.id,
    dayNumber: state.dayNumber,
    playerId,
    note: player?.standingOrdersNote ?? '',
    pendingReinforcements: player?.pendingReinforcements ?? 0,
    defaultStopLoss: state.config.autoAttackStopLoss,
    maxAttacksPerTurn: state.config.maxAttacksPerTurn,
    ownedTerritories,
    legalAttacks,
  };
}
