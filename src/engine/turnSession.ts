/**
 * Daily turn window / "the line" (§5).
 *
 * Each day at the configured window-start time a session opens. Players take
 * turns from the front of a queue seeded by the game's fixed randomized turn
 * order (§2.5). Each player at the front gets a single `perPlayerWindowMinutes`
 * window.
 *
 *   - Complete in time -> leave the queue (done for the day).
 *   - Miss the window  -> the turn is auto-resolved immediately (AI acts on the
 *                         player's standing-orders note; empty note falls back
 *                         to defensive placement). No second chance, no requeue.
 *
 * This module is a pure reducer over a DailySession value. It emits an effect
 * describing what happened; a controller applies that effect to GameState —
 * for an auto-resolved turn it computes a TurnPlan (via AI or the deterministic
 * fallback) and passes it to applyTurnEffect. Wall-clock scheduling lives
 * outside the engine — the scheduler calls completeTurn()/expireWindow() at the
 * right moments.
 */

import type { GameState, PlayerId } from './types.js';

export interface DailySession {
  gameId: string;
  dayNumber: number;
  /** Players still to resolve today, front = currently active. */
  queue: PlayerId[];
  completed: PlayerId[];
  autoResolved: PlayerId[];
  /** ISO deadline for the current front player's window (set by the scheduler). */
  windowExpiresAt?: string;
}

export type TurnEffect =
  | { type: 'completed'; playerId: PlayerId }
  | { type: 'auto_resolved'; playerId: PlayerId };

/** Players eligible to take a turn today. */
function eligiblePlayers(state: GameState): Set<PlayerId> {
  return new Set(
    state.players
      .filter((p) => p.status === 'active' || p.status === 'auto_piloted')
      .map((p) => p.id),
  );
}

export function startDailySession(state: GameState, dayNumber: number): DailySession {
  const eligible = eligiblePlayers(state);
  const queue = state.turnOrder.filter((id) => eligible.has(id));
  return { gameId: state.id, dayNumber, queue, completed: [], autoResolved: [] };
}

export function currentPlayer(session: DailySession): PlayerId | null {
  return session.queue[0] ?? null;
}

export function isComplete(session: DailySession): boolean {
  return session.queue.length === 0;
}

/** The player at the front finished their turn in time. */
export function completeTurn(
  session: DailySession,
  playerId: PlayerId,
): { session: DailySession; effect: TurnEffect } {
  if (currentPlayer(session) !== playerId) {
    throw new Error(`It is not ${playerId}'s turn (front is ${currentPlayer(session)})`);
  }
  const next: DailySession = {
    ...session,
    queue: session.queue.slice(1),
    completed: [...session.completed, playerId],
  };
  return { session: next, effect: { type: 'completed', playerId } };
}

/**
 * The front player's single window expired. There is no requeue — the turn is
 * auto-resolved and the player leaves the queue. The caller applies the
 * 'auto_resolved' effect (AI/defensive turn plan) via applyTurnEffect.
 */
export function expireWindow(session: DailySession): { session: DailySession; effect: TurnEffect } {
  const playerId = currentPlayer(session);
  if (playerId === null) {
    throw new Error('No active player: session is complete');
  }
  const next: DailySession = {
    ...session,
    queue: session.queue.slice(1),
    autoResolved: [...session.autoResolved, playerId],
  };
  return { session: next, effect: { type: 'auto_resolved', playerId } };
}
