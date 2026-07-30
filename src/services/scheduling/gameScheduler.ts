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
  /** Planned opening, retained when delivery is late. */
  scheduledAt?: string;
}
interface PlayerWindowData {
  gameId: string;
  dayNumber: number;
  playerId: string;
  /** Exact persisted deadline; superseded deliveries must not end a newer window. */
  deadline?: string;
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

  /**
   * Restore every active game's next timer after an app restart. Existing
   * deadlines are preserved, including overdue deadlines that must fire now.
   */
  async recoverActiveGames(): Promise<number> {
    const activeGames = (await this.repo.listGames()).filter((game) => game.status === 'active');
    for (const game of activeGames) {
      await this.recoverGame(game.id);
    }
    return activeGames.length;
  }

  /** Restore one active game's next due job without extending its deadline. */
  async recoverGame(gameId: string): Promise<boolean> {
    return this.repo.withGameLock(gameId, async () => {
      const game = await this.repo.loadGame(gameId);
      if (!game || game.status !== 'active') return false;
      const session = await this.repo.loadSession(game.id, game.dayNumber);
      if (!session) await openDailySession(this.repo, game.id, game.dayNumber);
      await this.advance(game.id, game.dayNumber);
      return true;
    });
  }

  /** Register job handlers. Call once at startup, before scheduling. */
  register(): void {
    this.queue.work(JOB_SESSION_OPEN, async (data) => {
      const { gameId, dayNumber, scheduledAt } = data as SessionOpenData;
      await this.repo.withGameLock(gameId, async () => {
        const game = await this.repo.loadGame(gameId);
        if (!game || game.status !== 'active' || dayNumber < game.dayNumber) return;

        const existing = await this.repo.loadSession(gameId, dayNumber);
        // A redelivered open job is complete once its current window is armed
        // (or the whole day already ended). A session without a deadline means
        // a prior process stopped between opening it and arming its first turn.
        if (
          existing &&
          (currentPlayer(existing) === null || validDeadline(existing.windowExpiresAt))
        ) {
          return;
        }

        await openDailySession(this.repo, gameId, dayNumber);
        await this.advance(
          gameId,
          dayNumber,
          validDeadline(scheduledAt) ?? this.clock.now(),
        );
        await this.bumpRevision(gameId);
      });
    });

    this.queue.work(JOB_PLAYER_WINDOW, async (data) => {
      const { gameId, dayNumber, playerId, deadline } = data as PlayerWindowData;
      await this.repo.withGameLock(gameId, async () => {
        const session = await this.repo.loadSession(gameId, dayNumber);
        if (!session || currentPlayer(session) !== playerId) return; // stale timer
        if (deadline && session.windowExpiresAt !== deadline) return; // superseded timer
        await handleWindowExpiry(this.repo, this.planner, gameId, dayNumber);
        await this.advance(
          gameId,
          dayNumber,
          validDeadline(deadline) ?? this.clock.now(),
        );
        await this.bumpRevision(gameId);
      });
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
    await this.queue.schedule(
      JOB_SESSION_OPEN,
      at,
      { gameId, dayNumber: day, scheduledAt: at.toISOString() } satisfies SessionOpenData,
      sessionOpenKey(gameId, day),
    );
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
  private async advance(
    gameId: string,
    dayNumber: number,
    anchorNow = this.clock.now(),
  ): Promise<void> {
    const game = await this.repo.loadGame(gameId);
    if (!game || game.status !== 'active') return; // lobby/game over; stop scheduling
    const session = await this.repo.loadSession(gameId, dayNumber);
    if (!session) return;

    const player = currentPlayer(session);
    if (player) {
      const at =
        validDeadline(session.windowExpiresAt) ??
        windowDeadline(anchorNow, game.config.perPlayerWindowMinutes);
      const deadline = at.toISOString();
      const completedWindows = session.completed.length + session.autoResolved.length + 1;
      const inferredSessionStart = new Date(
        at.getTime() -
          completedWindows * game.config.perPlayerWindowMinutes * 60 * 1000,
      );
      const nextSessionOpensAt =
        validDeadline(session.nextSessionOpensAt) ??
        this.nextDayOpenAt(game.config, inferredSessionStart);
      const nextSessionDeadline = nextSessionOpensAt.toISOString();
      // Persist the deadline so the UI can render a countdown.
      if (
        session.windowExpiresAt !== deadline ||
        session.nextSessionOpensAt !== nextSessionDeadline
      ) {
        await this.repo.saveSession({
          ...session,
          windowExpiresAt: deadline,
          nextSessionOpensAt: nextSessionDeadline,
        });
      }
      await this.queue.schedule(
        JOB_PLAYER_WINDOW,
        at,
        {
          gameId,
          dayNumber,
          playerId: player,
          deadline,
        } satisfies PlayerWindowData,
        playerWindowKey(gameId, dayNumber, player),
      );
    } else {
      const at =
        validDeadline(session.nextSessionOpensAt) ??
        nextWindowStart(
          game.config.timezone,
          game.config.windowStartMinuteOfDay,
          anchorNow,
        );
      if (session.nextSessionOpensAt !== at.toISOString()) {
        await this.repo.saveSession({
          ...session,
          windowExpiresAt: undefined,
          nextSessionOpensAt: at.toISOString(),
        });
      }
      const nextDay = dayNumber + 1;
      await this.queue.schedule(
        JOB_SESSION_OPEN,
        at,
        {
          gameId,
          dayNumber: nextDay,
          scheduledAt: at.toISOString(),
        } satisfies SessionOpenData,
        sessionOpenKey(gameId, nextDay),
      );
    }
  }

  private async bumpRevision(gameId: string): Promise<void> {
    const game = await this.repo.loadGame(gameId);
    if (game) await this.repo.saveGame({ ...game, revision: (game.revision ?? 0) + 1 });
  }
}

function validDeadline(value: string | undefined): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function sessionOpenKey(gameId: string, dayNumber: number): string {
  return `${gameId}:${dayNumber}`;
}

function playerWindowKey(gameId: string, dayNumber: number, playerId: string): string {
  return `${gameId}:${dayNumber}:${playerId}`;
}
