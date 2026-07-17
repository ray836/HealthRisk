/**
 * Deterministic, seedable pseudo-random number generator.
 *
 * Combat resolution must be reproducible: given the same inputs and seed, the
 * engine must always produce the same result. That makes outcomes testable,
 * auditable (we can replay a stored seed to prove a combat result), and lets
 * the future UI animate the exact sequence the server computed.
 *
 * mulberry32 — small, fast, good statistical quality for game use. Not for
 * cryptographic purposes.
 */

export interface Rng {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns an integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number;
  /** The current internal state — persist this to resume/replay a stream. */
  state(): number;
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(minInclusive: number, maxInclusive: number): number {
      const span = maxInclusive - minInclusive + 1;
      return minInclusive + Math.floor(next() * span);
    },
    state(): number {
      return s >>> 0;
    },
  };
}

/**
 * Derives a stable 32-bit seed from a string (e.g. a combat id) so every
 * combat has an independent, reproducible stream without needing to store a
 * random number up front — you can recompute it from the combat's identity.
 */
export function seedFromString(input: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
