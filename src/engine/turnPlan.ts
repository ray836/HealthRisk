/**
 * Turn plans (§5 auto-resolution).
 *
 * A TurnPlan is a structured description of a whole turn — where to reinforce,
 * which attacks to make, and an optional fortify. It is the interface between
 * the (impure, service-layer) AI that reads a player's standing-orders note and
 * the (pure) engine that must actually execute a turn.
 *
 * Crucially, the engine NEVER trusts a plan blindly: applyTurnPlan validates
 * every action against the live board and silently skips anything illegal (a
 * territory the player doesn't own, a non-adjacent attack, over-spending the
 * bank, an AI hallucination). Whatever survives validation is applied in order,
 * and a report of applied vs. rejected actions is returned for audit/UI.
 *
 * Both the AI path and the deterministic defensive fallback produce a TurnPlan,
 * so auto-resolution has exactly one execution path.
 */

import {
  validateAttack,
  resolveAttack,
  applyAttackResult,
  type AttackDeclaration,
  type AttackResult,
} from './combat.js';
import {
  validateReinforcement,
  applyReinforcement,
  type ReinforcePlacement,
} from './reinforce.js';
import { validateFortify, applyFortify, type FortifyMove } from './fortify.js';
import { recordAttackEvent, recordFortifiedEvent } from './gameEvents.js';
import type { GameState, PlayerId } from './types.js';

export interface TurnPlan {
  /** Where to place banked reinforcements. */
  placements: ReinforcePlacement[];
  /** Attacks to attempt, in order. */
  attacks: AttackDeclaration[];
  /** Optional single fortify move at end of turn. */
  fortify?: FortifyMove;
  /** Free-form rationale from the AI, surfaced to the player later. */
  rationale?: string;
}

export interface RejectedAction {
  kind: 'reinforce' | 'attack' | 'fortify';
  reason: string;
  detail: unknown;
}

export interface AppliedAttack {
  declaration: AttackDeclaration;
  result: AttackResult;
}

export interface TurnPlanReport {
  state: GameState;
  placedTroops: number;
  attacks: AppliedAttack[];
  fortified: FortifyMove | null;
  rejected: RejectedAction[];
}

/**
 * Validate and apply a turn plan for one player. Pure: returns a new GameState
 * plus a report. Illegal actions are skipped, not thrown.
 *
 * @param seedBase Opaque stable base derived by the server, used
 *   to seed each attack deterministically as `${seedBase}:atk:${index}`, so an
 *   auto-resolved turn is fully reproducible/auditable.
 * @param eventBase Public stable base used only for idempotent event IDs. It is
 *   intentionally separate so an event ID never needs to reveal seed material.
 */
export function applyTurnPlan(
  state: GameState,
  playerId: PlayerId,
  plan: TurnPlan,
  seedBase: string,
  eventBase: string = seedBase,
): TurnPlanReport {
  let current = state;
  const rejected: RejectedAction[] = [];

  // --- Reinforcement: filter to legal placements, then apply the largest
  //     affordable subset. We validate the whole set; if it over-spends the
  //     bank or references bad territories, we drop offending placements and
  //     retry so a single bad line doesn't void the whole reinforcement.
  const legalPlacements: ReinforcePlacement[] = [];
  let budget = current.players.find((p) => p.id === playerId)?.pendingReinforcements ?? 0;
  for (const p of plan.placements) {
    const err = validateReinforcement(current, playerId, [p]);
    if (err) {
      rejected.push({ kind: 'reinforce', reason: err.code, detail: p });
      continue;
    }
    if (p.count > budget) {
      rejected.push({ kind: 'reinforce', reason: 'over_bank', detail: p });
      continue;
    }
    legalPlacements.push(p);
    budget -= p.count;
  }
  let placedTroops = 0;
  if (legalPlacements.length > 0) {
    current = applyReinforcement(current, playerId, legalPlacements);
    placedTroops = legalPlacements.reduce((s, p) => s + p.count, 0);
  }

  // --- Attacks: in order, respecting an optional per-turn cap.
  const attacks: AppliedAttack[] = [];
  const cap = current.config.maxAttacksPerTurn;
  for (let i = 0; i < plan.attacks.length; i++) {
    if (cap !== null && attacks.length >= cap) {
      rejected.push({ kind: 'attack', reason: 'max_attacks_reached', detail: plan.attacks[i] });
      continue;
    }
    const decl = plan.attacks[i]!;
    const err = validateAttack(current, playerId, decl);
    if (err) {
      rejected.push({ kind: 'attack', reason: err.code, detail: decl });
      continue;
    }
    const result = resolveAttack(
      decl.committedTroops,
      current.territories.find((t) => t.id === decl.toId)!.armies,
      decl.stopLoss,
      `${seedBase}:atk:${i}`,
      decl.fromId,
      decl.toId,
    );
    const beforeAttack = current;
    current = applyAttackResult(current, playerId, decl, result);
    current = recordAttackEvent(
      beforeAttack,
      current,
      playerId,
      decl,
      result,
      `${eventBase}:attack_event:${i}`,
    );
    attacks.push({ declaration: decl, result });
  }

  // --- Fortify: at most one.
  let fortified: FortifyMove | null = null;
  if (plan.fortify) {
    const err = validateFortify(current, playerId, plan.fortify);
    if (err) {
      rejected.push({ kind: 'fortify', reason: err.code, detail: plan.fortify });
    } else {
      current = applyFortify(current, plan.fortify);
      current = recordFortifiedEvent(
        current,
        playerId,
        plan.fortify,
        `${eventBase}:fortify_event`,
      );
      fortified = plan.fortify;
    }
  }

  return { state: current, placedTroops, attacks, fortified, rejected };
}
