import { describe, it, expect } from 'vitest';
import {
  startDailySession,
  currentPlayer,
  completeTurn,
  expireWindow,
  isComplete,
  pruneIneligiblePlayers,
} from '../turnSession.js';
import type { GameConfig, GameState } from '../types.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 10,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

function game(): GameState {
  return {
    id: 'g',
    config,
    players: [
      { id: 'p1', name: 'A', status: 'active', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
      { id: 'p2', name: 'B', status: 'active', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
      { id: 'p3', name: 'C', status: 'eliminated', pendingReinforcements: 0, consecutiveAutoResolvedDays: 0, standingOrdersNote: '' },
    ],
    territories: [],
    turnOrder: ['p1', 'p2', 'p3'],
    dayNumber: 1,
    status: 'active',
  };
}

describe('daily turn session', () => {
  it('seeds the queue from turn order, excluding eliminated players', () => {
    const s = startDailySession(game(), 1);
    expect(s.queue).toEqual(['p1', 'p2']);
    expect(currentPlayer(s)).toBe('p1');
  });

  it('a completed turn leaves the queue', () => {
    let s = startDailySession(game(), 1);
    s = { ...s, windowExpiresAt: '2026-01-01T01:00:00.000Z' };
    const r = completeTurn(s, 'p1');
    s = r.session;
    expect(r.effect).toEqual({ type: 'completed', playerId: 'p1' });
    expect(currentPlayer(s)).toBe('p2');
    expect(s.windowExpiresAt).toBeUndefined();
  });

  it('removes a player eliminated after the daily queue opened', () => {
    const session = startDailySession(game(), 1);
    const state = game();
    state.players = state.players.map((player) =>
      player.id === 'p2' ? { ...player, status: 'eliminated' as const } : player,
    );
    expect(pruneIneligiblePlayers(session, state).queue).toEqual(['p1']);
  });

  it('closes the turn queue when a forfeit finishes the game', () => {
    const session = {
      ...startDailySession(game(), 1),
      windowExpiresAt: '2026-01-01T01:00:00.000Z',
    };
    const state = { ...game(), status: 'finished' as const, winnerId: 'p1' };

    const pruned = pruneIneligiblePlayers(session, state);

    expect(pruned.queue).toEqual([]);
    expect(pruned.windowExpiresAt).toBeUndefined();
  });

  it('throws if a non-front player tries to complete', () => {
    const s = startDailySession(game(), 1);
    expect(() => completeTurn(s, 'p2')).toThrow();
  });

  it('a missed window auto-resolves immediately with no requeue', () => {
    let s = startDailySession(game(), 1);
    s = { ...s, windowExpiresAt: '2026-01-01T01:00:00.000Z' };
    const r = expireWindow(s); // p1 misses their single window
    s = r.session;
    expect(r.effect).toEqual({ type: 'auto_resolved', playerId: 'p1' });
    expect(s.autoResolved).toContain('p1');
    // p1 does NOT go to the back of the line; they leave the queue entirely.
    expect(s.queue).toEqual(['p2']);
    expect(currentPlayer(s)).toBe('p2');
    expect(s.windowExpiresAt).toBeUndefined();
  });

  it('mixes completed and missed turns until the queue empties', () => {
    let s = startDailySession(game(), 1);
    s = completeTurn(s, 'p1').session; // p1 plays
    s = expireWindow(s).session; // p2 misses -> auto-resolved, leaves
    expect(isComplete(s)).toBe(true);
    expect(s.completed).toEqual(['p1']);
    expect(s.autoResolved).toEqual(['p2']);
  });

  it('session completes when the queue empties', () => {
    let s = startDailySession(game(), 1);
    s = completeTurn(s, 'p1').session;
    s = completeTurn(s, 'p2').session;
    expect(isComplete(s)).toBe(true);
  });
});
