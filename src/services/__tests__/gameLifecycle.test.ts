import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { startDailySession } from '../../engine/turnSession.js';
import { leaveGame, startLobbyGame } from '../gameLifecycle.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Los_Angeles',
};

function lobby(id = 'lobby') {
  const state = createGame({
    id,
    config,
    players: [{ id: 'p1', name: 'Creator' }, { id: 'p2', name: 'Guest' }],
    seed: 3,
  });
  state.status = 'setup';
  return state;
}

describe('multiplayer lifecycle', () => {
  it('requires a full lobby and gives every player one half-day turn window', async () => {
    const repo = new InMemoryGameRepository({ games: [lobby()] });
    await repo.setMember({ gameId: 'lobby', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'lobby', playerId: 'p2', userId: 'guest' });

    const started = await startLobbyGame(repo, 'lobby', 'creator');

    expect(started.status).toBe('active');
    expect(started.config.perPlayerWindowMinutes).toBe(720);
  });

  it('frees a guest seat before play and lets the creator cancel the lobby', async () => {
    const repo = new InMemoryGameRepository({ games: [lobby()] });
    await repo.setMember({ gameId: 'lobby', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'lobby', playerId: 'p2', userId: 'guest' });

    expect((await leaveGame(repo, 'lobby', 'guest')).cancelled).toBe(false);
    expect(await repo.getMemberBySeat('lobby', 'p2')).toBeNull();
    expect((await leaveGame(repo, 'lobby', 'creator')).cancelled).toBe(true);
    expect(await repo.listMembers('lobby')).toEqual([]);
  });

  it('turns an active departure into a forfeit and removes it from the queue', async () => {
    const state = lobby('active');
    state.status = 'active';
    const session = startDailySession(state, 0);
    const repo = new InMemoryGameRepository({ games: [state], sessions: [session] });
    await repo.setMember({ gameId: 'active', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'active', playerId: 'p2', userId: 'guest' });

    const result = await leaveGame(repo, 'active', 'guest');

    expect(result.forfeited).toBe(true);
    expect(result.game.players.find((player) => player.id === 'p2')?.status).toBe('forfeited');
    expect(result.session?.queue).not.toContain('p2');
  });
});
