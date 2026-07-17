import { describe, it, expect } from 'vitest';
import { tzOffsetMs, zonedInstant, nextWindowStart, windowDeadline } from '../time.js';

const NY = 'America/New_York';
const HOUR = 3600_000;

describe('timezone timing', () => {
  it('computes the correct UTC offset across DST', () => {
    // EST (winter) is UTC-5, EDT (summer) is UTC-4.
    expect(tzOffsetMs(NY, new Date('2026-01-15T12:00:00Z')) / HOUR).toBe(-5);
    expect(tzOffsetMs(NY, new Date('2026-07-15T12:00:00Z')) / HOUR).toBe(-4);
  });

  it('maps a local wall-clock to the right UTC instant (winter vs summer)', () => {
    // 19:00 EST on 2026-01-15 == 00:00Z on 2026-01-16
    expect(zonedInstant(NY, 2026, 1, 15, 19 * 60).toISOString()).toBe('2026-01-16T00:00:00.000Z');
    // 19:00 EDT on 2026-07-15 == 23:00Z same day
    expect(zonedInstant(NY, 2026, 7, 15, 19 * 60).toISOString()).toBe('2026-07-15T23:00:00.000Z');
  });

  it('returns today\'s window when it is still ahead', () => {
    // 10:00 EST, window 19:00 -> today at 00:00Z next day
    const from = new Date('2026-01-15T15:00:00Z'); // 10:00 EST
    expect(nextWindowStart(NY, 19 * 60, from).toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('rolls to tomorrow when today\'s window has passed', () => {
    // 20:00 EST (01:00Z next day), window 19:00 already gone -> tomorrow 19:00 EST
    const from = new Date('2026-01-16T01:00:00Z'); // 20:00 EST on the 15th
    expect(nextWindowStart(NY, 19 * 60, from).toISOString()).toBe('2026-01-17T00:00:00.000Z');
  });

  it('crosses the spring-forward day correctly (window well clear of the gap)', () => {
    // DST begins 2026-03-08 in the US. 19:00 local on the 7th (EST) -> next day
    // 19:00 local on the 8th is EDT (UTC-4) -> 23:00Z.
    const from = new Date('2026-03-08T01:00:00Z'); // evening of the 7th, EST
    const next = nextWindowStart(NY, 19 * 60, from);
    expect(next.toISOString()).toBe('2026-03-08T23:00:00.000Z');
  });

  it('windowDeadline adds the given minutes', () => {
    const d = windowDeadline(new Date('2026-01-16T00:00:00Z'), 20);
    expect(d.toISOString()).toBe('2026-01-16T00:20:00.000Z');
  });
});
