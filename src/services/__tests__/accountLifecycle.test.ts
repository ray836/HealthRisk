import { describe, expect, it } from 'vitest';

import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { deleteAccount } from '../accountLifecycle.js';
import { signup } from '../authApi.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 0,
  windowStartMinuteOfDay: 0,
  perPlayerWindowMinutes: 720,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Denver',
};

describe('account deletion', () => {
  it('cancels an owned lobby, removes private data, and anonymizes chat history', async () => {
    const game = createGame({
      id: 'account-game',
      config,
      players: [{ id: 'p1', name: 'ray' }, { id: 'p2', name: 'Friend' }],
      seed: 1,
    });
    game.status = 'setup';
    const repo = new InMemoryGameRepository({ games: [game] });
    const auth = await signup(repo, 'ray-delete', 'Password@123');
    await repo.setMember({ gameId: game.id, playerId: 'p1', userId: auth.user.id });
    await repo.saveChatMessage({
      id: 'message',
      gameId: game.id,
      userId: auth.user.id,
      playerId: 'p1',
      username: 'ray-delete',
      body: 'Hello',
      createdAt: new Date().toISOString(),
    });

    await expect(deleteAccount(repo, auth.user.id, 'wrong'))
      .rejects.toMatchObject({ code: 'bad_credentials' });
    await deleteAccount(repo, auth.user.id, 'Password@123');

    expect(await repo.getUserById(auth.user.id)).toBeNull();
    expect(await repo.listMembersForUser(auth.user.id)).toEqual([]);
    expect((await repo.loadGame(game.id))?.status).toBe('cancelled');
    expect(await repo.getChatMessage('message')).toMatchObject({
      userId: 'deleted-user',
      username: 'Deleted player',
    });
  });
});
