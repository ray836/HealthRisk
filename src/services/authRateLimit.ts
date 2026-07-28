/** Small per-process guard against password guessing and signup abuse. */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface AttemptWindow {
  count: number;
  resetsAt: number;
}

export class AuthRateLimiter {
  private attempts = new Map<string, AttemptWindow>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  consume(key: string, now = Date.now()): RateLimitResult {
    const existing = this.attempts.get(key);
    const window =
      !existing || existing.resetsAt <= now
        ? { count: 0, resetsAt: now + this.windowMs }
        : existing;
    window.count += 1;
    this.attempts.set(key, window);
    return {
      allowed: window.count <= this.maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetsAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
