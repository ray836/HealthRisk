import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { logExercise } from '../exerciseApi.js';
import { createGame } from '../../engine/setup.js';
import type { GameConfig, GameState } from '../../engine/types.js';

const config: GameConfig = {
  exercises: [
    { key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 },
    { key: 'lifting', label: 'Weightlifting', unitLabel: 'min', troopsPerUnit: 1 / 30, dailyUnitCap: 90 },
  ],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function game(): GameState {
  return createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 1 });
}

async function bank(repo: InMemoryGameRepository, id = 'a') {
  return (await repo.loadGame('g'))!.players.find((p) => p.id === id)!.pendingReinforcements;
}

describe('logExercise', () => {
  it('banks earned troops incrementally', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    let r = await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 2 });
    expect(r.deltaTroops).toBe(2);
    expect(await bank(repo)).toBe(2);
    r = await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 1 });
    expect(r.deltaTroops).toBe(1);
    expect(await bank(repo)).toBe(3);
  });

  it('respects the per-exercise unit cap (no troops past it)', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 3 }); // at 3-mile cap
    const r = await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 5 }); // over cap
    expect(r.deltaTroops).toBe(0);
    expect(await bank(repo)).toBe(3);
  });

  it('respects the daily total cap across exercise types', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 3 }); // 3 troops
    const r = await logExercise(repo, 'g', 0, 'a', { exerciseKey: 'lifting', units: 90 }); // +3 raw -> clipped to total 5
    expect(r.dayTotal).toBe(5);
    expect(r.totalCapApplied).toBe(true);
    expect(await bank(repo)).toBe(5);
  });

  it('rejects unknown exercises and non-positive units', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await expect(logExercise(repo, 'g', 0, 'a', { exerciseKey: 'yoga', units: 5 })).rejects.toMatchObject({ code: 'unknown_exercise' });
    await expect(logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 0 })).rejects.toMatchObject({ code: 'bad_units' });
  });

  it('does not bank for eliminated players', async () => {
    let g = game();
    g = { ...g, players: g.players.map((p) => (p.id === 'a' ? { ...p, status: 'eliminated' } : p)) };
    const repo = new InMemoryGameRepository({ games: [g] });
    await expect(logExercise(repo, 'g', 0, 'a', { exerciseKey: 'running', units: 2 })).rejects.toMatchObject({ code: 'not_active_player' });
  });
});
