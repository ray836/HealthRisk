import { describe, it, expect } from 'vitest';
import { resolveAttack } from '../combat.js';

describe('combat resolution', () => {
  it('is deterministic for a given seed', () => {
    const a = resolveAttack(10, 8, 100, 'battle-1');
    const b = resolveAttack(10, 8, 100, 'battle-1');
    expect(a).toEqual(b);
  });

  it('different seeds can produce different outcomes', () => {
    const results = new Set(
      Array.from({ length: 20 }, (_, i) => resolveAttack(5, 5, 100, `s${i}`).captured),
    );
    // over 20 seeds we expect both outcomes to appear at 5v5
    expect(results.size).toBe(2);
  });

  it('halts at the stop-loss limit without capturing', () => {
    // Big defender, tiny stop-loss => attacker should bail out.
    const r = resolveAttack(20, 20, 2, 'sl');
    expect(r.endReason).toBe('stop_loss');
    expect(r.captured).toBe(false);
    expect(r.totalAttackerLosses).toBe(2);
  });

  it('never exceeds the declared stop-loss when a round could inflict two losses', () => {
    for (let i = 0; i < 1_000; i++) {
      const r = resolveAttack(20, 20, 3, `strict-stop-${i}`);
      expect(r.totalAttackerLosses).toBeLessThanOrEqual(3);
    }
  });

  it('halts when the committed attacking force is exhausted', () => {
    // Overwhelming defender, generous stop-loss => attacker force ground out.
    const r = resolveAttack(4, 40, 1000, 'grind');
    expect(r.endReason).toBe('attacker_min');
    expect(r.survivingAttackers).toBe(0);
    expect(r.captured).toBe(false);
  });

  it('lets the final committed troop fight because the origin garrison is separate', () => {
    const outcomes = Array.from({ length: 200 }, (_, i) =>
      resolveAttack(1, 1, 1, `one-on-one-${i}`),
    );

    // Before entering combat with one committed troop was fixed, every result
    // stopped without rolling. A standard one-die exchange always resolves in
    // exactly one comparison and can end either way.
    expect(outcomes.every((result) => result.rounds.length === 1)).toBe(true);
    expect(outcomes.some((result) => result.captured)).toBe(true);
    expect(outcomes.some((result) => !result.captured)).toBe(true);
  });

  it('matches classic Risk one-attacker-die versus one-defender-die odds', () => {
    let captures = 0;
    const sampleSize = 20_000;
    for (let i = 0; i < sampleSize; i++) {
      if (resolveAttack(1, 1, 1, `one-die-odds-${i}`).captured) captures++;
    }

    // The attacker wins 15/36 comparisons (41.666...%); the defender wins ties.
    expect(captures / sampleSize).toBeCloseTo(15 / 36, 2);
  });

  it('captures when defender reaches zero', () => {
    const r = resolveAttack(30, 2, 1000, 'stomp');
    expect(r.captured).toBe(true);
    expect(r.remainingDefenders).toBe(0);
    expect(r.endReason).toBe('capture');
    expect(r.survivingAttackers).toBeGreaterThanOrEqual(1);
  });

  it('conserves troops: losses + survivors == starting force (both sides)', () => {
    const start = { atk: 12, def: 9 };
    const r = resolveAttack(start.atk, start.def, 1000, 'conserve');
    expect(r.survivingAttackers + r.totalAttackerLosses).toBe(start.atk);
    expect(r.remainingDefenders + r.totalDefenderLosses).toBe(start.def);
  });

  it('attacker is statistically favored with a large force', () => {
    let wins = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      if (resolveAttack(10, 8, 1000, `w${i}`).captured) wins++;
    }
    // 10 attacking vs 8 defending should win clearly more than half the time.
    expect(wins / N).toBeGreaterThan(0.6);
  });

  it('records a round log consistent with the summary', () => {
    const r = resolveAttack(8, 6, 1000, 'log');
    const atkLost = r.rounds.reduce((s, rd) => s + rd.attackerLosses, 0);
    const defLost = r.rounds.reduce((s, rd) => s + rd.defenderLosses, 0);
    expect(atkLost).toBe(r.totalAttackerLosses);
    expect(defLost).toBe(r.totalDefenderLosses);
    // each round every die is in [1,6], attacker <=3 dice, defender <=2
    for (const rd of r.rounds) {
      expect(rd.attackerDice.length).toBeLessThanOrEqual(3);
      expect(rd.defenderDice.length).toBeLessThanOrEqual(2);
      for (const d of [...rd.attackerDice, ...rd.defenderDice]) {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(6);
      }
    }
  });
});
