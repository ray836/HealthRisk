/**
 * Request-safe scheduled-turn reconciliation.
 *
 * Serverless functions cannot own resident timers. Each invocation reconstructs
 * due jobs from persisted session anchors, drains a bounded batch, and exits.
 * Scheduler handlers take the repository's per-game lock, making this safe to
 * call from browser requests and a cron invocation at the same time.
 */

import { timingSafeEqual } from 'node:crypto';

import type { TurnPlanner } from '../../engine/planner.js';
import { systemClock, type Clock } from '../orchestrator.js';
import type { GameRepository } from '../repository.js';
import { GameScheduler } from './gameScheduler.js';
import { FakeJobQueue } from './jobQueue.js';

export interface ReconcileDeps {
  repo: GameRepository;
  planner: TurnPlanner;
  clock?: Clock;
  maxSteps?: number;
}

export interface ReconcileResult {
  activeGames: number;
  processedJobs: number;
  hasMoreDue: boolean;
}

/** Fail closed when the configured secret or Bearer credential is absent. */
export function isAuthorizedCronRequest(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authorization?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Catch up one game, used immediately before reads and player mutations. */
export async function reconcileGameDue(
  deps: ReconcileDeps,
  gameId: string,
): Promise<ReconcileResult> {
  const now = (deps.clock ?? systemClock).now();
  const queue = new FakeJobQueue();
  const scheduler = new GameScheduler({
    repo: deps.repo,
    planner: deps.planner,
    queue,
    clock: { now: () => now },
  });
  scheduler.register();
  const active = await scheduler.recoverGame(gameId);
  if (!active) return { activeGames: 0, processedJobs: 0, hasMoreDue: false };
  const drained = await queue.runDueBatch(now, deps.maxSteps ?? 20);
  return {
    activeGames: 1,
    processedJobs: drained.ran,
    hasMoreDue: drained.hasMoreDue,
  };
}

/** Catch up all active games, used by the authenticated cron endpoint. */
export async function reconcileAllDue(
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const games = (await deps.repo.listGames()).filter((game) => game.status === 'active');
  let processedJobs = 0;
  let hasMoreDue = false;
  for (const game of games) {
    const result = await reconcileGameDue(
      { ...deps, maxSteps: deps.maxSteps ?? 20 },
      game.id,
    );
    processedJobs += result.processedJobs;
    hasMoreDue ||= result.hasMoreDue;
  }
  return { activeGames: games.length, processedJobs, hasMoreDue };
}
