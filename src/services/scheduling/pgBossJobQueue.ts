/**
 * Production JobQueue adapter backed by pg-boss (durable jobs on the same
 * Postgres as the game state). This is the real timer mechanism the
 * GameScheduler runs on; it is exercised only against a live database, so it is
 * intentionally thin — all the scheduling *logic* lives in gameScheduler.ts and
 * is tested with FakeJobQueue.
 *
 * Lifecycle:
 *   const q = new PgBossJobQueue(connectionString);
 *   scheduler = new GameScheduler({ ..., queue: q });
 *   scheduler.register();   // buffers work() registrations
 *   await q.start();        // starts pg-boss, creates queues, wires workers
 *   await scheduler.start(gameId);
 *   ...
 *   await q.stop();
 */

import { PgBoss } from 'pg-boss';
import type { ConstructorOptions, Job } from 'pg-boss';
import type { JobQueue } from './jobQueue.js';

type Handler = (data: unknown) => Promise<void>;

export class PgBossJobQueue implements JobQueue {
  private boss: PgBoss;
  private handlers = new Map<string, Handler>();
  private started = false;

  constructor(connection: string | ConstructorOptions | PgBoss) {
    this.boss =
      connection instanceof PgBoss
        ? connection
        : new PgBoss(typeof connection === 'string' ? { connectionString: connection } : connection);
  }

  /** Register a handler. Buffered until start(), which wires the pg-boss worker. */
  work(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  /** Start pg-boss, ensure each queue exists, and attach workers. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const [name, handler] of this.handlers) {
      await this.ensureQueue(name);
      // pg-boss delivers a batch; run our single-payload handler per job.
      await this.boss.work<unknown>(name, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) await handler(job.data);
      });
    }
    this.started = true;
  }

  async schedule(name: string, runAt: Date, data: unknown): Promise<string> {
    await this.ensureQueue(name);
    const id = await this.boss.sendAfter(name, (data ?? {}) as object, null, runAt);
    if (!id) throw new Error(`pg-boss refused job for queue ${name}`);
    return id;
  }

  async cancel(id: string): Promise<void> {
    // JobQueue.cancel only knows the id; try each known queue. The scheduler
    // relies on stale-safe handlers rather than cancellation, so best-effort.
    for (const name of this.handlers.keys()) {
      try {
        await this.boss.cancel(name, id);
        return;
      } catch {
        // wrong queue for this id — try the next
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop();
    this.started = false;
  }

  private ensureQueue(name: string): Promise<unknown> {
    // Idempotent: swallow "already exists" so repeated calls are safe.
    return this.boss.createQueue(name).catch(() => undefined);
  }
}
