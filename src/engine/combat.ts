/**
 * Combat resolution (§6).
 *
 * Probability-based, but resolved as a *logged step-by-step simulation* of
 * classic Risk dice exchanges rather than manual rolling or a single opaque
 * formula (DECISIONS.md, open item #3). Each exchange uses standard Risk dice
 * odds — attacker rolls up to 3, defender up to 2, highest dice compared
 * pairwise, defender wins ties. This reproduces the classic per-troop
 * probabilities exactly while remaining deterministic (seeded) and auditable.
 *
 * The attack ends on exactly one of the §6 conditions:
 *   1. capture       — defender reaches 0
 *   2. stop_loss     — attacker's cumulative losses reach the stop-loss limit
 *   3. attacker_min  — attacking force reduced to 1 (origin must hold >= 1)
 *
 * This module is pure: it computes a result; applying it to GameState is the
 * caller's job (see applyAttackResult).
 */

import { makeRng, seedFromString, type Rng } from './rng.js';
import { areAdjacent } from './map.js';
import type { GameState, TerritoryId } from './types.js';

export interface AttackDeclaration {
  fromId: TerritoryId;
  toId: TerritoryId;
  /** Troops marching out of `fromId`. Origin retains (armies - committedTroops) >= 1. */
  committedTroops: number;
  /** Max cumulative attacker losses before the attack halts (§6.2). */
  stopLoss: number;
}

export type AttackEndReason = 'capture' | 'stop_loss' | 'attacker_min';

export interface CombatRound {
  attackerDice: number[];
  defenderDice: number[];
  attackerLosses: number;
  defenderLosses: number;
  attackerForceAfter: number;
  defenderForceAfter: number;
}

export interface AttackResult {
  fromId: TerritoryId;
  toId: TerritoryId;
  endReason: AttackEndReason;
  captured: boolean;
  rounds: CombatRound[];
  totalAttackerLosses: number;
  totalDefenderLosses: number;
  /** Surviving troops from the committed force. */
  survivingAttackers: number;
  /** Defender troops remaining on the target (0 if captured). */
  remainingDefenders: number;
  /** Seed used, stored so the exact sequence can be replayed/audited. */
  seed: number;
}

function rollDesc(rng: Rng, count: number): number[] {
  const dice: number[] = [];
  for (let i = 0; i < count; i++) dice.push(rng.int(1, 6));
  return dice.sort((a, b) => b - a);
}

/**
 * Resolve one declared attack. `seed` (or a stable combat id via seedFromString)
 * makes the result reproducible. Does not mutate anything.
 */
export function resolveAttack(
  attackerForceStart: number,
  defenderForceStart: number,
  stopLoss: number,
  seedInput: number | string,
  fromId: TerritoryId = 'from',
  toId: TerritoryId = 'to',
): AttackResult {
  const seed = typeof seedInput === 'string' ? seedFromString(seedInput) : seedInput >>> 0;
  const rng = makeRng(seed);

  let attackerForce = attackerForceStart;
  let defenderForce = defenderForceStart;
  let attackerLosses = 0;
  let defenderLosses = 0;
  const rounds: CombatRound[] = [];

  let endReason: AttackEndReason;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (defenderForce <= 0) {
      endReason = 'capture';
      break;
    }
    if (attackerLosses >= stopLoss) {
      endReason = 'stop_loss';
      break;
    }
    if (attackerForce <= 1) {
      endReason = 'attacker_min';
      break;
    }

    const attackerDice = rollDesc(rng, Math.min(3, attackerForce));
    const defenderDice = rollDesc(rng, Math.min(2, defenderForce));
    const compares = Math.min(attackerDice.length, defenderDice.length);

    let aLost = 0;
    let dLost = 0;
    for (let i = 0; i < compares; i++) {
      if (attackerDice[i]! > defenderDice[i]!) dLost++; // defender loses ties-excluded
      else aLost++; // defender wins ties
    }
    attackerForce -= aLost;
    defenderForce -= dLost;
    attackerLosses += aLost;
    defenderLosses += dLost;

    rounds.push({
      attackerDice,
      defenderDice,
      attackerLosses: aLost,
      defenderLosses: dLost,
      attackerForceAfter: attackerForce,
      defenderForceAfter: defenderForce,
    });
  }

  return {
    fromId,
    toId,
    endReason,
    captured: endReason === 'capture',
    rounds,
    totalAttackerLosses: attackerLosses,
    totalDefenderLosses: defenderLosses,
    survivingAttackers: attackerForce,
    remainingDefenders: Math.max(0, defenderForce),
    seed,
  };
}

export interface ValidationError {
  code: string;
  message: string;
}

/** Validate a declaration against current state. Returns null if OK. */
export function validateAttack(
  state: GameState,
  attackerId: string,
  decl: AttackDeclaration,
): ValidationError | null {
  const from = state.territories.find((t) => t.id === decl.fromId);
  const to = state.territories.find((t) => t.id === decl.toId);
  if (!from || !to) return { code: 'no_territory', message: 'Unknown territory' };
  if (from.owner !== attackerId) return { code: 'not_owner', message: 'You do not own the origin' };
  if (to.owner === attackerId) return { code: 'self_attack', message: 'Cannot attack your own territory' };
  if (!areAdjacent(decl.fromId, decl.toId)) return { code: 'not_adjacent', message: 'Territories are not adjacent' };
  if (decl.committedTroops < 1) return { code: 'no_troops', message: 'Must commit at least 1 troop' };
  if (decl.committedTroops > from.armies - 1) {
    return { code: 'must_hold_origin', message: 'Must leave at least 1 army to hold the origin' };
  }
  if (decl.stopLoss < 1) return { code: 'bad_stop_loss', message: 'Stop-loss must be at least 1' };
  return null;
}

/**
 * Apply an attack result to a copy of the game state. On capture, all surviving
 * committed troops move into the captured territory; the origin keeps whatever
 * was not committed. Returns a new GameState (does not mutate the input).
 */
export function applyAttackResult(
  state: GameState,
  attackerId: string,
  decl: AttackDeclaration,
  result: AttackResult,
): GameState {
  const territories = state.territories.map((t) => ({ ...t }));
  const from = territories.find((t) => t.id === decl.fromId)!;
  const to = territories.find((t) => t.id === decl.toId)!;

  if (result.captured) {
    // Origin already held (armies - committed); survivors move into target.
    from.armies -= decl.committedTroops;
    to.owner = attackerId;
    to.armies = result.survivingAttackers;
  } else {
    // Survivors return to origin; origin keeps its retained troops too.
    from.armies = from.armies - decl.committedTroops + result.survivingAttackers;
    to.armies = result.remainingDefenders;
  }

  return { ...state, territories };
}
