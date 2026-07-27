/**
 * Game-level controller helpers (§3 banking, §7 elimination, §8 forfeit, §9 win).
 *
 * These sit above the phase primitives and update player/game status. They stay
 * pure — each returns a new GameState — so they compose with the phase modules
 * and remain unit-testable without a database or scheduler.
 */

import { defensiveTurnPlan } from './autoplace.js';
import { applyTurnPlan, type TurnPlan, type TurnPlanReport } from './turnPlan.js';
import { earnedTroops, type ExerciseLogEntry } from './reinforce.js';
import type { GameState, PlayerId } from './types.js';
import type { TurnEffect } from './turnSession.js';

export const ELIMINATION_REWARD_REINFORCEMENTS = 3;

/**
 * Bank a player's earned troops from a day's logs onto their pending
 * reinforcements (§3). Eliminated/forfeited players earn nothing (§3, §7).
 */
export function grantDailyReinforcements(
  state: GameState,
  playerId: PlayerId,
  logs: ExerciseLogEntry[],
): GameState {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return state;
  if (player.status === 'eliminated' || player.status === 'forfeited') return state;
  const { total } = earnedTroops(state.config, logs);
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, pendingReinforcements: p.pendingReinforcements + total } : p,
  );
  return { ...state, players };
}

/** Clear any unplaced pending reinforcements at the end of a player's turn. */
export function clearPending(state: GameState, playerId: PlayerId): GameState {
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, pendingReinforcements: 0 } : p,
  );
  return { ...state, players };
}

/**
 * Re-evaluate elimination for every player: a player owning zero territories is
 * eliminated (§7). When an eliminator is supplied, each newly eliminated
 * player produces a public event and banks a fixed reward for the eliminator's
 * next turn. Defeated hands are discarded rather than transferred.
 */
export function applyEliminations(state: GameState, eliminatedByPlayerId?: PlayerId): GameState {
  const owns = new Map<PlayerId, number>();
  for (const t of state.territories) {
    if (t.owner) owns.set(t.owner, (owns.get(t.owner) ?? 0) + 1);
  }
  const eliminatedIds = state.players
    .filter(
      (player) =>
        player.status !== 'eliminated' &&
        player.status !== 'forfeited' &&
        (owns.get(player.id) ?? 0) === 0,
    )
    .map((player) => player.id);
  if (eliminatedIds.length === 0) return state;

  const players = state.players.map((p) => {
    if (p.status === 'eliminated' || p.status === 'forfeited') return p;
    if (eliminatedIds.includes(p.id)) {
      return {
        ...p,
        status: 'eliminated' as const,
        cards: [],
        pendingEliminationReward: 0,
        pendingReinforcements: 0,
      };
    }
    if (p.id === eliminatedByPlayerId) {
      return {
        ...p,
        pendingEliminationReward:
          (p.pendingEliminationReward ?? 0) +
          eliminatedIds.length * ELIMINATION_REWARD_REINFORCEMENTS,
      };
    }
    return p;
  });
  const events = eliminatedByPlayerId
    ? [
        ...(state.events ?? []),
        ...eliminatedIds.map((eliminatedPlayerId) => ({
          id: `${state.id}:${state.dayNumber}:${eliminatedByPlayerId}:eliminated:${eliminatedPlayerId}`,
          type: 'player_eliminated' as const,
          dayNumber: state.dayNumber,
          eliminatedPlayerId,
          eliminatedByPlayerId,
          rewardTroops: ELIMINATION_REWARD_REINFORCEMENTS,
        })),
      ]
    : state.events;
  return { ...state, players, events };
}

/**
 * Win check (§9): once only one player owns territory, no opponent remains able
 * to act. Neutral garrisons do not delay the victory screen.
 */
export function checkWin(state: GameState): GameState {
  const owners = new Set(state.territories.map((t) => t.owner).filter((owner) => owner !== null));
  if (owners.size !== 1) return state;
  const [winnerId] = [...owners];
  if (winnerId == null) return state;
  return { ...state, status: 'finished', winnerId };
}

/**
 * Admin forfeit (§8, DECISIONS.md open item #4): remove a player; their
 * territories become neutral garrisons so the board stays contestable.
 */
export function forfeitPlayer(state: GameState, playerId: PlayerId): GameState {
  const territories = state.territories.map((t) =>
    t.owner === playerId ? { ...t, owner: null } : { ...t },
  );
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, status: 'forfeited' as const, pendingReinforcements: 0 } : p,
  );
  return { ...state, territories, players };
}

export interface TurnEffectResult {
  state: GameState;
  /** Present when a turn was auto-resolved; details what the plan actually did. */
  autoReport?: TurnPlanReport;
}

/**
 * Apply a turn-session effect to game state.
 *   - completed:     reset the player's consecutive auto-resolved day counter,
 *                    clear any leftover pending, mark active.
 *   - auto_resolved: execute the player's turn plan (AI note-driven, passed in
 *                    via `plan`, or the deterministic defensive fallback when
 *                    omitted), bump the counter, clear pending, mark
 *                    auto_piloted, and — if the configured threshold is hit —
 *                    auto-forfeit.
 *
 * The AI itself is never called here (this stays pure): the service layer reads
 * the player's standing-orders note, calls the AI to produce a TurnPlan, and
 * passes it in. Omitting `plan` uses the defensive fallback.
 *
 * After any turn we re-check eliminations and win.
 */
export function applyTurnEffect(
  state: GameState,
  effect: TurnEffect,
  plan?: TurnPlan,
): TurnEffectResult {
  let next = state;
  let autoReport: TurnPlanReport | undefined;

  if (effect.type === 'completed') {
    next = clearPending(next, effect.playerId);
    next = setPlayer(next, effect.playerId, (p) => ({
      ...p,
      status: p.status === 'eliminated' || p.status === 'forfeited' ? p.status : 'active',
      consecutiveAutoResolvedDays: 0,
    }));
  } else if (effect.type === 'auto_resolved') {
    const effectivePlan = plan ?? defensiveTurnPlan(next, effect.playerId);
    const seedBase = `${next.id}:${next.dayNumber}:${effect.playerId}`;
    autoReport = applyTurnPlan(next, effect.playerId, effectivePlan, seedBase);
    next = autoReport.state;
    next = clearPending(next, effect.playerId);
    next = setPlayer(next, effect.playerId, (p) => ({
      ...p,
      status: p.status === 'eliminated' || p.status === 'forfeited' ? p.status : 'auto_piloted',
      consecutiveAutoResolvedDays: p.consecutiveAutoResolvedDays + 1,
    }));
    const threshold = next.config.autoForfeitAfterDays;
    if (threshold !== null) {
      const p = next.players.find((x) => x.id === effect.playerId);
      if (p && p.consecutiveAutoResolvedDays >= threshold) {
        next = forfeitPlayer(next, effect.playerId);
      }
    }
  }

  next = applyEliminations(next, effect.type === 'auto_resolved' ? effect.playerId : undefined);
  next = checkWin(next);
  return { state: next, autoReport };
}

function setPlayer(
  state: GameState,
  playerId: PlayerId,
  fn: (p: GameState['players'][number]) => GameState['players'][number],
): GameState {
  return { ...state, players: state.players.map((p) => (p.id === playerId ? fn(p) : p)) };
}
