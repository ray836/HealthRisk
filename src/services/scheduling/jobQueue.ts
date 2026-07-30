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
  /**
   * Schedule `data` to run under `name` at `runAt`. `uniqueKey` makes repeated
   * recovery/advance calls reuse one pending logical job.
   */
  schedule(name: string, runAt: Date, data: unknown, uniqueKey?: string): Promise<string>;
  /** Best-effort cancel of a scheduled job. Missing/already-run ids are a no-op. */
  cancel(id: string): Promise<void>;
}

/**
 * Serverless scheduling boundary. It records no resident timers because a
 * function can be frozen immediately after returning. GameScheduler still
 * persists the current player's deadline before calling schedule(), which
 * leaves enough durable state for the upcoming cron/reconciliation worker.
 */
export class PassiveJobQueue implements JobQueue {
  private seq = 0;

  work(_name: string, _handler: (data: unknown) => Promise<void>): void {
    // A request function must not attach a long-running worker.
  }

  async schedule(
    name: string,
    _runAt: Date,
    _data: unknown,
    uniqueKey?: string,
  ): Promise<string> {
    return `passive:${name}:${uniqueKey ?? this.seq++}`;
  }

  async cancel(_id: string): Promise<void> {
    // No resident timer exists to cancel.
  }
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
  private uniqueJobs = new Map<string, string>();
  private uniqueKeyById = new Map<string, string>();
  private seq = 0;

  constructor(private now: () => number = () => Date.now()) {}

  work(name: string, handler: (data: unknown) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  async schedule(name: string, runAt: Date, data: unknown, uniqueKey?: string): Promise<string> {
    const compoundKey = uniqueKey ? `${name}:${uniqueKey}` : undefined;
    const existingId = compoundKey ? this.uniqueJobs.get(compoundKey) : undefined;
    if (existingId) return existingId;

    const id = `job-${this.seq++}`;
    const delay = Math.max(0, runAt.getTime() - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.releaseUniqueKey(id);
      const handler = this.handlers.get(name);
      if (handler) handler(data).catch((err) => console.error(`job ${name} failed:`, err));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(id, timer);
    if (compoundKey) {
      this.uniqueJobs.set(compoundKey, id);
      this.uniqueKeyById.set(id, compoundKey);
    }
    return id;
  }

  async cancel(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.releaseUniqueKey(id);
    }
  }

  private releaseUniqueKey(id: string): void {
    const compoundKey = this.uniqueKeyById.get(id);
    if (!compoundKey) return;
    this.uniqueKeyById.delete(id);
    if (this.uniqueJobs.get(compoundKey) === id) this.uniqueJobs.delete(compoundKey);
  }
}

interface FakeJob {
  id: string;
  name: string;
  runAt: number;
  data: unknown;
  uniqueKey?: string;
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

  async schedule(name: string, runAt: Date, data: unknown, uniqueKey?: string): Promise<string> {
    const existing = uniqueKey
      ? this.jobs.find((job) => !job.cancelled && job.name === name && job.uniqueKey === uniqueKey)
      : undefined;
    if (existing) return existing.id;

    const id = `job-${this.seq++}`;
    this.jobs.push({ id, name, runAt: runAt.getTime(), data, uniqueKey, cancelled: false });
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
