import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { openDailySession, markTurnComplete, handleWindowExpiry } from '../orchestrator.js';
import { createGame } from '../../engine/setup.js';
import { TERRITORY_IDS } from '../../engine/map.js';
import type { TurnPlanner } from '../../engine/planner.js';
import type { GameConfig, GameState } from '../../engine/types.js';

const config: GameConfig = {
  exercises: [{ key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 }],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

/** Build a 2-player game and force a known board/turn order for the test. */
function makeGame(): GameState {
  let g = createGame({
    id: 'g',
    config,
    players: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seed: 5,
  });
  // Deterministic board: a owns china (big stack), b owns india (weak). Rest neutral.
  g = {
    ...g,
    turnOrder: ['a', 'b'],
    dayNumber: 1,
    territories: TERRITORY_IDS.map((id) => ({
      id,
      owner: id === 'china' ? 'a' : id === 'india' ? 'b' : null,
      armies: id === 'china' ? 12 : id === 'india' ? 1 : 2,
    })),
    players: g.players.map((p) =>
      p.id === 'a' ? { ...p, pendingReinforcements: 3, standingOrdersNote: 'take india from china' } : p,
    ),
  };
  return g;
}

describe('orchestrator', () => {
  it('opens a daily session seeded from turn order', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    const session = await openDailySession(repo, 'g', 1);
    expect(session.queue).toEqual(['a', 'b']);
    // idempotent — returns the same stored session
    const again = await openDailySession(repo, 'g', 1);
    expect(again.queue).toEqual(['a', 'b']);
  });

  it('applies an AI note-driven plan on a missed window', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 1);

    // Stub planner: reinforce china, then attack india (a strong, legal push).
    const planner: TurnPlanner = async (ctx) => {
      expect(ctx.note).toBe('take india from china');
      return {
        placements: [{ territoryId: 'china', count: 3 }],
        attacks: [{ fromId: 'china', toId: 'india', committedTroops: 14, stopLoss: 100 }],
      };
    };

    const res = await handleWindowExpiry(repo, planner, 'g', 1);
    expect(res.playerId).toBe('a');
    expect(res.usedFallback).toBe(false);
    expect(res.report!.attacks[0]!.result.captured).toBe(true);

    const game = await repo.loadGame('g');
    expect(game!.territories.find((t) => t.id === 'india')!.owner).toBe('a');
    expect(game!.players.find((p) => p.id === 'a')!.status).toBe('auto_piloted');

    const session = await repo.loadSession('g', 1);
    expect(session!.queue).toEqual(['b']); // a left the line, no requeue
  });

  it('falls back to the defensive plan when the AI planner throws', async () => {
    const repo = new InMemoryGameRepository({ games: [makeGame()] });
    await openDailySession(repo, 'g', 1);

    const planner: TurnPlanner = async () => {
      throw new Error('AI unavailable');
    };

    const before = (await repo.loadGame('g'))!;
    const chinaBefore = before.territories.find((t) => t.id === 'china')!.armies;

    const res = await handleWindowExpiry(repo, planner, 'g', 1);
    expect(res.usedFallback).toBe(true);

    const game = await repo.loadGame('g');
    // No attack happened (india still b's); the banked troops were placed defensively.
    expect(game!.territories.find((t) => t.id === 'india')!.owner).toBe('b');
    const chinaAfter = game!.territories.find((t) => t.id === 'china')!.armies;
    // Bank = 3 seeded exercise + 3 start-of-turn territory bonus = 6, all placed on
    // china (a's only border territory) by the defensive fallback.
    expect(chinaAfter).toBe(chinaBefore + 6);
  });

  it('records a completed turn and resets the auto-resolve counter', async () => {
    let g = makeGame();
    g = { ...g, players: g.players.map((p) => (p.id === 'a' ? { ...p, consecutiveAutoResolvedDays: 2 } : p)) };
    const repo = new InMemoryGameRepository({ games: [g] });
    await openDailySession(repo, 'g', 1);

    await markTurnComplete(repo, 'g', 1, 'a');
    const game = await repo.loadGame('g');
    expect(game!.players.find((p) => p.id === 'a')!.consecutiveAutoResolvedDays).toBe(0);
    const session = await repo.loadSession('g', 1);
    expect(session!.queue).toEqual(['b']);
  });
});
