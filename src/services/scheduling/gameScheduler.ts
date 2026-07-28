/**
 * Game scheduler — drives the daily turn cycle (§5) on top of a durable JobQueue.
 *
 * Two job types:
 *   session_open { gameId, dayNumber }            — fires at 19:00 local
 *   player_window { gameId, dayNumber, playerId } — fires 20 min after the
 *                                                   player reached the front
 *
 * After every event (session opened, window expired, player completed) the
 * scheduler `advance`s: if a player is now at the front of the line it schedules
 * their window; if the line is empty it schedules the next day's session_open.
 *
 * player_window handlers are stale-safe: if the front player changed before the
 * timer fired (the player completed in time), the timer is a no-op. This is why
 * we never need reliable timer cancellation — a superseded timer harmlessly
 * ignores itself.
 */

import { currentPlayer } from '../../engine/turnSession.js';
import type { TurnPlanner } from '../../engine/planner.js';
import type { GameState } from '../../engine/types.js';
import {
  openDailySession,
  markTurnComplete,
  handleWindowExpiry,
  systemClock,
  type Clock,
} from '../orchestrator.js';
import type { GameRepository } from '../repository.js';
import type { JobQueue } from './jobQueue.js';
import { nextDayWindowStart, nextWindowStart, windowDeadline } from './time.js';

export const JOB_SESSION_OPEN = 'exercise-risk:session_open';
export const JOB_PLAYER_WINDOW = 'exercise-risk:player_window';

interface SessionOpenData {
  gameId: string;
  dayNumber: number;
}
interface PlayerWindowData {
  gameId: string;
  dayNumber: number;
  playerId: string;
}

export interface GameSchedulerDeps {
  repo: GameRepository;
  planner: TurnPlanner;
  queue: JobQueue;
  clock?: Clock;
  /**
   * When to open the *next* day's session after a day's line empties. Defaults
   * to the next window-start time (the real daily cadence). A demo can pass a
   * function returning `now` to make play continuous.
   */
  nextDayOpenAt?: (config: GameState['config'], now: Date) => Date;
}

export class GameScheduler {
  private repo: GameRepository;
  private planner: TurnPlanner;
  private queue: JobQueue;
  private clock: Clock;
  private nextDayOpenAt: (config: GameState['config'], now: Date) => Date;

  constructor(deps: GameSchedulerDeps) {
    this.repo = deps.repo;
    this.planner = deps.planner;
    this.queue = deps.queue;
    this.clock = deps.clock ?? systemClock;
    this.nextDayOpenAt =
      deps.nextDayOpenAt ??
      ((config, now) =>
        nextDayWindowStart(config.timezone, config.windowStartMinuteOfDay, now));
  }

  /** Arm the current front player's window (public entry for the server on open). */
  async armNextWindow(gameId: string, dayNumber: number): Promise<void> {
    await this.advance(gameId, dayNumber);
  }

  /** Register job handlers. Call once at startup, before scheduling. */
  register(): void {
    this.queue.work(JOB_SESSION_OPEN, async (data) => {
      const { gameId, dayNumber } = data as SessionOpenData;
      await openDailySession(this.repo, gameId, dayNumber);
      await this.advance(gameId, dayNumber);
      await this.bumpRevision(gameId);
    });

    this.queue.work(JOB_PLAYER_WINDOW, async (data) => {
      const { gameId, dayNumber, playerId } = data as PlayerWindowData;
      const session = await this.repo.loadSession(gameId, dayNumber);
      if (!session || currentPlayer(session) !== playerId) return; // stale timer
      await handleWindowExpiry(this.repo, this.planner, gameId, dayNumber);
      await this.advance(gameId, dayNumber);
      await this.bumpRevision(gameId);
    });
  }

  /**
   * Bootstrap a game's schedule: enqueue the first session_open at the next
   * window-start. `dayNumber` defaults to the game's current dayNumber.
   */
  async start(gameId: string, dayNumber?: number): Promise<void> {
    const game = await this.repo.loadGame(gameId);
    if (!game) throw new Error(`Unknown game ${gameId}`);
    const day = dayNumber ?? game.dayNumber;
    const at = nextWindowStart(game.config.timezone, game.config.windowStartMinuteOfDay, this.clock.now());
    await this.queue.schedule(JOB_SESSION_OPEN, at, { gameId, dayNumber: day } satisfies SessionOpenData);
  }

  /**
   * Call from the interactive API when the player at the front finishes their
   * turn in time. Advances the line (their pending window timer becomes a
   * stale no-op).
   */
  async onPlayerCompleted(gameId: string, dayNumber: number, playerId: string): Promise<void> {
    await markTurnComplete(this.repo, gameId, dayNumber, playerId);
    await this.advance(gameId, dayNumber);
  }

  /** Schedule the next thing: this day's next player, or next day's open. */
  private async advance(gameId: string, dayNumber: number): Promise<void> {
    const game = await this.repo.loadGame(gameId);
    if (!game || game.status !== 'active') return; // lobby/game over; stop scheduling
    const session = await this.repo.loadSession(gameId, dayNumber);
    if (!session) return;

    const now = this.clock.now();
    const player = currentPlayer(session);
    if (player) {
      const at = windowDeadline(now, game.config.perPlayerWindowMinutes);
      // Persist the deadline so the UI can render a countdown.
      await this.repo.saveSession({ ...session, windowExpiresAt: at.toISOString() });
      await this.queue.schedule(JOB_PLAYER_WINDOW, at, {
        gameId,
        dayNumber,
        playerId: player,
      } satisfies PlayerWindowData);
    } else {
      const at = this.nextDayOpenAt(game.config, now);
      await this.queue.schedule(JOB_SESSION_OPEN, at, {
        gameId,
        dayNumber: dayNumber + 1,
      } satisfies SessionOpenData);
    }
  }

  private async bumpRevision(gameId: string): Promise<void> {
    const game = await this.repo.loadGame(gameId);
    if (game) await this.repo.saveGame({ ...game, revision: (game.revision ?? 0) + 1 });
  }
}
