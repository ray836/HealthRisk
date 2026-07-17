import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { ensureTurnStarted } from '../turnStart.js';
import { openDailySession } from '../orchestrator.js';
import { createGame } from '../../engine/setup.js';
import { CONTINENTS, TERRITORY_IDS } from '../../engine/map.js';
import type { GameConfig, GameState } from '../../engine/types.js';

const config = {
  exercises: [],
  dailyTotalTroopCap: 20,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
} as GameConfig;

const africa = CONTINENTS.find((c) => c.id === 'africa')!;

// a controls all of Africa (6 territories); turn order puts a first.
function makeGame(): GameState {
  const g = createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 1 });
  return {
    ...g,
    turnOrder: ['a', 'b'],
    dayNumber: 0,
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: africa.territories.includes(id) ? 'a' : 'b',
      armies: 2,
    })),
    players: g.players.map((p) => (p.id === 'a' ? { ...p, pendingReinforcements: 2 } : p)), // 2 banked from exercise
  };
}

async function bank(repo: InMemoryGameRepository, id = 'a') {
  return (await repo.loadGame('g'))!.players.find((p) => p.id === id)!.pendingReinforcements;
}

describe('ensureTurnStarted', () => {
  it('adds the standard reinforcement (territory + continent) on top of exercise, once', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 0);

    // a owns 6 territories (Africa): base floor(6/3)=3, +3 continent bonus = 6.
    const r = await ensureTurnStarted(repo, 'g', 0, 'a');
    expect(r.started).toBe(true);
    expect(r.bonus!.territoryTroops).toBe(3);
    expect(r.bonus!.continentTroops).toBe(africa.bonus); // 3
    expect(r.bonus!.total).toBe(6);
    expect(await bank(repo)).toBe(2 + 6); // exercise + bonus

    // Idempotent: a second call does not grant again.
    const again = await ensureTurnStarted(repo, 'g', 0, 'a');
    expect(again.started).toBe(false);
    expect(await bank(repo)).toBe(8);

    const ts = await repo.loadTurnState('g', 0, 'a');
    expect(ts!.startBonus).toBe(6);
    expect(ts!.startContinents).toEqual(['Africa']);
  });

  it('does not grant to a player who is not at the front of the line', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 0);
    const r = await ensureTurnStarted(repo, 'g', 0, 'b'); // a is first
    expect(r.started).toBe(false);
    expect(await bank(repo, 'b')).toBe(0);
  });
});
