import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { TurnApi, TurnError } from '../turnApi.js';
import { openDailySession, markTurnComplete } from '../orchestrator.js';
import { GameScheduler, JOB_PLAYER_WINDOW } from '../scheduling/gameScheduler.js';
import { FakeJobQueue } from '../scheduling/jobQueue.js';
import { createGame } from '../../engine/setup.js';
import { TERRITORY_IDS } from '../../engine/map.js';
import type { TurnPlanner } from '../../engine/planner.js';
import type { GameConfig, GameState } from '../../engine/types.js';

function makeConfig(over: Partial<GameConfig> = {}): GameConfig {
  return {
    exercises: [],
    dailyTotalTroopCap: 10,
    windowStartMinuteOfDay: 19 * 60,
    perPlayerWindowMinutes: 20,
    autoForfeitAfterDays: null,
    autoAttackStopLoss: 3,
    maxAttacksPerTurn: null,
    timezone: 'America/New_York',
    ...over,
  };
}

// a: china (big) + mongolia (for fortify). b: india (weak) + siam (so b survives one loss).
function makeGame(config: GameConfig): GameState {
  const owner: Record<string, string | null> = {
    china: 'a',
    mongolia: 'a',
    india: 'b',
    siam: 'b',
  };
  const armies: Record<string, number> = { china: 12, mongolia: 5, india: 1, siam: 3 };
  const g = createGame({ id: 'g', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 5 });
  return {
    ...g,
    turnOrder: ['a', 'b'],
    dayNumber: 1,
    territories: TERRITORY_IDS.map((id) => ({ id, owner: owner[id] ?? null, armies: armies[id] ?? 2 })),
    // No exercise seed: a owns 2 territories, so the start-of-turn bonus grants 3.
  };
}

function setup(config = makeConfig()) {
  const repo = new InMemoryGameRepository({ games: [makeGame(config)] });
  const api = new TurnApi({ repo, onPlayerCompleted: (gid, day, pid) => markTurnComplete(repo, gid, day, pid) });
  return { repo, api };
}

describe('TurnApi — full turn', () => {
  it('reinforce -> attack -> fortify -> end, in order', async () => {
    const { repo, api } = setup();
    await openDailySession(repo, 'g', 1);

    const view0 = await api.turnView('g', 1);
    expect(view0!.playerId).toBe('a');
    expect(view0!.phase).toBe('reinforce');
    expect(view0!.context.pendingReinforcements).toBe(3);

    const r = await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]);
    expect(r.remainingBank).toBe(0);
    expect((await repo.loadGame('g'))!.territories.find((t) => t.id === 'china')!.armies).toBe(15);

    const result = await api.attack('g', 1, 'a', { fromId: 'china', toId: 'india', committedTroops: 14, stopLoss: 14 });
    expect(result.captured).toBe(true);
    expect((await repo.loadGame('g'))!.territories.find((t) => t.id === 'india')!.owner).toBe('a');

    // reinforcing after an attack is rejected
    await expect(api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 1 }])).rejects.toMatchObject({
      code: 'reinforce_phase_over',
    });

    await api.fortify('g', 1, 'a', { fromId: 'mongolia', toId: 'china', count: 4 });
    expect((await repo.loadGame('g'))!.territories.find((t) => t.id === 'mongolia')!.armies).toBe(1);

    // no attack or second fortify after fortifying
    await expect(api.attack('g', 1, 'a', { fromId: 'china', toId: 'siam', committedTroops: 3, stopLoss: 2 })).rejects.toMatchObject({
      code: 'attack_phase_over',
    });
    await expect(api.fortify('g', 1, 'a', { fromId: 'china', toId: 'mongolia', count: 1 })).rejects.toMatchObject({
      code: 'fortify_already_done',
    });

    await api.endTurn('g', 1, 'a');
    const view1 = await api.turnView('g', 1);
    expect(view1!.playerId).toBe('b'); // line advanced
  });

  it('rejects actions from a player who is not at the front of the line', async () => {
    const { repo, api } = setup();
    await openDailySession(repo, 'g', 1);
    await expect(api.placeReinforcements('g', 1, 'b', [{ territoryId: 'india', count: 0 }])).rejects.toMatchObject({
      code: 'not_your_turn',
    });
  });

  it('auto-advances to the attack phase once the bank is empty', async () => {
    const { repo, api } = setup();
    await openDailySession(repo, 'g', 1);
    // Bank is 3, so attacking first is blocked until reinforcements are placed.
    await expect(
      api.attack('g', 1, 'a', { fromId: 'china', toId: 'india', committedTroops: 2, stopLoss: 1 }),
    ).rejects.toMatchObject({ code: 'place_reinforcements_first' });
    // Place all 3 -> phase auto-advances to attack.
    await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]);
    expect((await api.turnView('g', 1))!.phase).toBe('attack');
    // Now attacking is allowed.
    const r = await api.attack('g', 1, 'a', { fromId: 'china', toId: 'india', committedTroops: 2, stopLoss: 1 });
    expect(r).toBeDefined();
  });

  it('surfaces engine validation errors (attacking a non-adjacent territory)', async () => {
    const { repo, api } = setup();
    await openDailySession(repo, 'g', 1);
    await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]); // -> attack phase
    await expect(
      api.attack('g', 1, 'a', { fromId: 'china', toId: 'brazil', committedTroops: 3, stopLoss: 2 }),
    ).rejects.toBeInstanceOf(TurnError);
    await expect(
      api.attack('g', 1, 'a', { fromId: 'china', toId: 'brazil', committedTroops: 3, stopLoss: 2 }),
    ).rejects.toMatchObject({ code: 'not_adjacent' });
  });

  it('rejects a stop-loss above the number of committed troops', async () => {
    const { api, repo } = setup();
    await openDailySession(repo, 'g', 1);
    await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]);
    await expect(
      api.attack('g', 1, 'a', { fromId: 'china', toId: 'india', committedTroops: 3, stopLoss: 4 }),
    ).rejects.toMatchObject({ code: 'bad_stop_loss' });
  });

  it('enforces maxAttacksPerTurn', async () => {
    const { repo, api } = setup(makeConfig({ maxAttacksPerTurn: 1 }));
    await openDailySession(repo, 'g', 1);
    await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]); // -> attack phase
    await api.attack('g', 1, 'a', { fromId: 'china', toId: 'india', committedTroops: 2, stopLoss: 1 });
    await expect(
      api.attack('g', 1, 'a', { fromId: 'china', toId: 'siam', committedTroops: 2, stopLoss: 1 }),
    ).rejects.toMatchObject({ code: 'max_attacks_reached' });
  });

  it('endTurn schedules the next player\'s window via the scheduler hook', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame(makeConfig())] });
    const queue = new FakeJobQueue();
    const noopPlanner: TurnPlanner = async () => ({ placements: [], attacks: [] });
    const nowMs = Date.parse('2026-01-16T00:00:00Z');
    const scheduler = new GameScheduler({ repo, planner: noopPlanner, queue, clock: { now: () => new Date(nowMs) } });
    scheduler.register();
    await openDailySession(repo, 'g', 1);

    const api = new TurnApi({ repo, onPlayerCompleted: (g, d, p) => scheduler.onPlayerCompleted(g, d, p) });
    await api.endTurn('g', 1, 'a'); // a skips their whole turn

    const bWindow = queue
      .pending()
      .find((j) => j.name === JOB_PLAYER_WINDOW && (j.data as { playerId: string }).playerId === 'b');
    expect(bWindow).toBeDefined();
    expect(new Date(bWindow!.runAt).toISOString()).toBe('2026-01-16T00:20:00.000Z');
  });

  it('capture -> earn third card -> next-turn trade -> reinforce', async () => {
    const seeded = makeGame(makeConfig());
    seeded.players = seeded.players.map((player) =>
      player.id === 'a'
        ? {
            ...player,
            cards: [
              { id: 'old-1', territoryId: 'china', earnedDay: 0 },
              { id: 'old-2', territoryId: 'mongolia', earnedDay: 0 },
            ],
          }
        : player,
    );
    const repo = new InMemoryGameRepository({ games: [seeded] });
    const api = new TurnApi({
      repo,
      onPlayerCompleted: (gameId, dayNumber, playerId) =>
        markTurnComplete(repo, gameId, dayNumber, playerId),
    });

    await openDailySession(repo, 'g', 1);
    await api.placeReinforcements('g', 1, 'a', [{ territoryId: 'china', count: 3 }]);
    const attack = await api.attack('g', 1, 'a', {
      fromId: 'china',
      toId: 'india',
      committedTroops: 14,
      stopLoss: 14,
    });
    expect(attack.captured).toBe(true);

    const ended = await api.endTurn('g', 1, 'a');
    expect(ended.cardAwarded).toMatchObject({ territoryId: 'india', earnedDay: 1 });
    expect((await repo.loadGame('g'))!.players.find((player) => player.id === 'a')!.cards).toHaveLength(3);

    await api.endTurn('g', 1, 'b');
    await openDailySession(repo, 'g', 2);
    expect((await api.turnView('g', 2))!.playerId).toBe('a');
    expect((await repo.loadGame('g'))!.players.find((player) => player.id === 'a')!.pendingReinforcements).toBe(3);

    const trade = await api.tradeCards('g', 2, 'a');
    expect(trade).toEqual({ remainingBank: 6, remainingCards: 0, troopsAwarded: 3 });
    await api.placeReinforcements('g', 2, 'a', [{ territoryId: 'china', count: 6 }]);
    expect((await api.turnView('g', 2))!.phase).toBe('attack');
  });
});
