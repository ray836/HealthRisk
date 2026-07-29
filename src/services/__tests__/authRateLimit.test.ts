import { describe, expect, it } from 'vitest';
import { AuthRateLimiter } from '../authRateLimit.js';

describe('authentication rate limiting', () => {
  it('blocks attempts beyond the window limit and reports a retry delay', () => {
    const limiter = new AuthRateLimiter(2, 60_000);
    expect(limiter.consume('ip', 1_000).allowed).toBe(true);
    expect(limiter.consume('ip', 2_000).allowed).toBe(true);
    const blocked = limiter.consume('ip', 3_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(58);
  });

  it('resets after a successful login or an elapsed window', () => {
    const limiter = new AuthRateLimiter(1, 1_000);
    expect(limiter.consume('ip', 0).allowed).toBe(true);
    expect(limiter.consume('ip', 1).allowed).toBe(false);
    limiter.reset('ip');
    expect(limiter.consume('ip', 2).allowed).toBe(true);
    expect(limiter.consume('ip', 1_002).allowed).toBe(true);
  });
});
