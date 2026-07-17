/**
 * Durable job-queue seam.
 *
 * The scheduler needs to run work at a future instant (open a session at 19:00,
 * expire a player's window 20 minutes after it opens) in a way that survives
 * process restarts. That's a durable timer, not `setTimeout`. This interface
 * abstracts it; `pgBossJobQueue.ts` is the production adapter, `FakeJobQueue`
 * below drives it deterministically in tests.
 */

export interface JobQueue {
  /** Register a handler for a job name. Call before scheduling/starting. */
  work(name: string, handler: (data: unknown) => Promise<void>): void;
  /** Schedule `data` to run under `name` at `runAt`. Returns a job id. */
  schedule(name: string, runAt: Date, data: unknown): Promise<string>;
  /** Best-effort cancel of a scheduled job. Missing/already-run ids are a no-op. */
  cancel(id: string): Promise<void>;
}

/**
 * Real single-process timer queue (`setTimeout`), for the zero-setup PGlite mode
 * where there's no Postgres server for pg-boss. Timers don't survive a process
 * restart — on reboot the scheduler re-arms windows from persisted state — which
 * is fine for a local/demo deployment. For durable cross-restart timers, use
 * PgBossJobQueue against a real Postgres.
 */
export class InProcessJobQueue implements JobQueue {
  private handlers = new Map<string, (data: unknown) => Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(private now: () => number = () => Date.now()) {}

  work(name: string, handler: (data: unknown) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  async schedule(name: string, runAt: Date, data: unknown): Promise<string> {
    const id = `job-${this.seq++}`;
    const delay = Math.max(0, runAt.getTime() - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const handler = this.handlers.get(name);
      if (handler) handler(data).catch((err) => console.error(`job ${name} failed:`, err));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(id, timer);
    return id;
  }

  async cancel(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

interface FakeJob {
  id: string;
  name: string;
  runAt: number;
  data: unknown;
  cancelled: boolean;
}

/**
 * In-memory queue for tests. Jobs don't fire on a real clock; call `runDue(now)`
 * to execute everything due at or before `now`, in time order. Handlers may
 * schedule further jobs, which run within the same drain if they're also due —
 * so a single `runDue` past a whole day advances the entire cycle.
 */
export class FakeJobQueue implements JobQueue {
  private handlers = new Map<string, (data: unknown) => Promise<void>>();
  private jobs: FakeJob[] = [];
  private seq = 0;

  work(name: string, handler: (data: unknown) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  async schedule(name: string, runAt: Date, data: unknown): Promise<string> {
    const id = `job-${this.seq++}`;
    this.jobs.push({ id, name, runAt: runAt.getTime(), data, cancelled: false });
    return id;
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (job) job.cancelled = true;
  }

  /** Jobs still pending (not run, not cancelled), for assertions. */
  pending(): Array<{ name: string; runAt: number; data: unknown }> {
    return this.jobs
      .filter((j) => !j.cancelled)
      .map((j) => ({ name: j.name, runAt: j.runAt, data: j.data }));
  }

  /**
   * Run all due jobs at or before `now`, oldest first, until none remain due.
   * A safety cap prevents an accidental infinite reschedule loop from hanging
   * the test.
   */
  async runDue(now: Date, maxSteps = 1000): Promise<number> {
    const cutoff = now.getTime();
    let ran = 0;
    for (let step = 0; step < maxSteps; step++) {
      const next = this.jobs
        .filter((j) => !j.cancelled && j.runAt <= cutoff)
        .sort((a, b) => a.runAt - b.runAt)[0];
      if (!next) return ran;
      next.cancelled = true; // consume
      const handler = this.handlers.get(next.name);
      if (handler) await handler(next.data);
      ran++;
    }
    throw new Error(`runDue exceeded ${maxSteps} steps — likely a reschedule loop`);
  }
}
