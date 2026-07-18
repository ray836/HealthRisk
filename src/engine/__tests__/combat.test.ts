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

  it('halts when the attacking force is exhausted (reduced to <= 1)', () => {
    // Overwhelming defender, generous stop-loss => attacker force ground out.
    // A 2-loss round from a force of 2 can wipe it to 0, so the floor is <= 1.
    const r = resolveAttack(4, 40, 1000, 'grind');
    expect(r.endReason).toBe('attacker_min');
    expect(r.survivingAttackers).toBeLessThanOrEqual(1);
    expect(r.captured).toBe(false);
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
