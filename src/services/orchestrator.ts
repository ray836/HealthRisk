/**
 * Turn orchestration — the glue between the scheduler, the persistence layer,
 * the pure engine, and the AI planner.
 *
 * Responsibilities:
 *   - open the daily session at the window-start time,
 *   - record a player's completed turn,
 *   - resolve a missed window: build the planner context, ask the AI for a plan
 *     (falling back to the engine's deterministic defensive plan on any failure),
 *     apply it through the engine, and persist.
 *
 * The engine stays pure; all I/O (DB, clock, LLM) is injected here, so the
 * orchestration itself is straightforward to unit-test with an in-memory repo
 * and a stub planner.
 */

import { buildPlannerContext, type TurnPlanner } from '../engine/planner.js';
import { applyTurnEffect } from '../engine/game.js';
import type { TurnPlanReport } from '../engine/turnPlan.js';
import {
  startDailySession,
  completeTurn,
  expireWindow,
  currentPlayer,
  type DailySession,
} from '../engine/turnSession.js';
import type { GameRepository } from './repository.js';
import { ensureTurnStarted } from './turnStart.js';
import { applyApprovedHealthRules } from './healthRules.js';

/** Injectable clock so window timing is testable. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/**
 * Open (or return the existing) daily session for a game. Also syncs the game's
 * `dayNumber` to this session's day, since it feeds combat seeds
 * (`${gameId}:${dayNumber}:${playerId}`) and the AI planner context.
 */
export async function openDailySession(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
): Promise<DailySession> {
  const existing = await repo.loadSession(gameId, dayNumber);
  if (existing) return existing;
  const loaded = await repo.loadGame(gameId);
  if (!loaded) throw new Error(`Unknown game ${gameId}`);
  const game = applyApprovedHealthRules({ ...loaded, dayNumber }, dayNumber);
  if (game.dayNumber !== loaded.dayNumber || game !== loaded) {
    await repo.saveGame(game);
  }
  const session = startDailySession(game, dayNumber);
  await repo.saveSession(session);
  return session;
}

/**
 * Record that the current player completed their turn in time. The player's
 * reinforce/attack/fortify actions are assumed already applied to GameState by
 * the interactive API layer (via the engine primitives); this advances the line
 * and updates the player's status/counters.
 */
export async function markTurnComplete(
  repo: GameRepository,
  gameId: string,
  dayNumber: number,
  playerId: string,
): Promise<void> {
  const session = await repo.loadSession(gameId, dayNumber);
  if (!session) throw new Error(`No session for ${gameId} day ${dayNumber}`);
  const game = await repo.loadGame(gameId);
  if (!game) throw new Error(`Unknown game ${gameId}`);

  const { session: next, effect } = completeTurn(session, playerId);
  const { state } = applyTurnEffect(game, effect);
  await repo.saveGame(state);
  await repo.saveSession(next);
}

export interface WindowExpiryResult {
  playerId: string;
  usedFallback: boolean;
  report?: TurnPlanReport;
}

/**
 * Resolve a missed window for the player currently at the front of the line.
 * Asks the AI planner for a note-driven plan; if the planner throws (empty note
 * handled inside the planner, or AI unavailable / bad output), falls back to the
 * engine's deterministic defensive plan by passing no plan to applyTurnEffect.
 */
export async function handleWindowExpiry(
  repo: GameRepository,
  planner: TurnPlanner,
  gameId: string,
  dayNumber: number,
): Promise<WindowExpiryResult> {
  const session = await repo.loadSession(gameId, dayNumber);
  if (!session) throw new Error(`No session for ${gameId} day ${dayNumber}`);
  const game = await repo.loadGame(gameId);
  if (!game) throw new Error(`Unknown game ${gameId}`);

  const playerId = currentPlayer(session);
  if (playerId === null) throw new Error('Session is complete; no player to expire');

  // A player may have won during their turn; don't auto-resolve a finished game.
  if (game.status !== 'active') return { playerId, usedFallback: false };

  // A missed player still gets their start-of-turn reinforcements (territory +
  // continent), so the defensive auto-placement has them to place.
  await ensureTurnStarted(repo, gameId, dayNumber, playerId);
  const current = (await repo.loadGame(gameId))!;

  // Ask the AI for a plan; any failure => deterministic defensive fallback.
  let plan;
  let usedFallback = false;
  try {
    plan = await planner(buildPlannerContext(current, playerId));
  } catch {
    usedFallback = true;
  }

  const { session: next, effect } = expireWindow(session);
  const { state, autoReport } = applyTurnEffect(current, effect, plan);
  await repo.saveGame(state);
  await repo.saveSession(next);

  return { playerId, usedFallback, report: autoReport };
}
