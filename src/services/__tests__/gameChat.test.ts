import { describe, expect, it } from 'vitest';

import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  deleteOwnChatMessage,
  reportChatMessage,
  sendGameChatMessage,
  setChatMuted,
} from '../gameChat.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 0,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 720,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Denver',
};

function game(practice = false) {
  const state = createGame({
    id: 'chat-game',
    config,
    players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
    seed: 5,
  });
  state.practice = practice;
  state.status = 'setup';
  return state;
}

describe('game chat', () => {
  it('stores trimmed messages for members before the game starts', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await repo.setMember({ gameId: 'chat-game', playerId: 'p1', userId: 'u1' });

    const message = await sendGameChatMessage(
      repo,
      'chat-game',
      { id: 'u1', username: 'alice' },
      '  Ready when you are!  ',
    );

    expect(message).toMatchObject({
      gameId: 'chat-game',
      userId: 'u1',
      playerId: 'p1',
      username: 'alice',
      body: 'Ready when you are!',
    });
    expect(await repo.listChatMessages('chat-game')).toEqual([message]);
  });

  it('rejects non-members, empty messages, oversized messages, and practice chat', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await repo.setMember({ gameId: 'chat-game', playerId: 'p1', userId: 'u1' });
    const user = { id: 'u1', username: 'alice' };

    await expect(sendGameChatMessage(
      repo,
      'chat-game',
      { id: 'u2', username: 'bob' },
      'Hello',
    )).rejects.toMatchObject({ code: 'no_seat' });
    await expect(sendGameChatMessage(repo, 'chat-game', user, '   '))
      .rejects.toMatchObject({ code: 'empty_chat_message' });
    await expect(sendGameChatMessage(
      repo,
      'chat-game',
      user,
      'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1),
    )).rejects.toMatchObject({ code: 'chat_message_too_long' });

    const practiceRepo = new InMemoryGameRepository({ games: [game(true)] });
    await practiceRepo.setMember({ gameId: 'chat-game', playerId: 'p1', userId: 'u1' });
    await expect(sendGameChatMessage(practiceRepo, 'chat-game', user, 'Hello'))
      .rejects.toMatchObject({ code: 'chat_unavailable' });
  });

  it('rate-limits bursts and supports delete, mute, and report controls', async () => {
    const repo = new InMemoryGameRepository({ games: [game()] });
    await repo.setMember({ gameId: 'chat-game', playerId: 'p1', userId: 'u1' });
    await repo.setMember({ gameId: 'chat-game', playerId: 'p2', userId: 'u2' });
    const alice = { id: 'u1', username: 'alice' };
    let message = await sendGameChatMessage(repo, 'chat-game', alice, 'First');
    for (let index = 1; index < CHAT_RATE_LIMIT_COUNT; index += 1) {
      message = await sendGameChatMessage(repo, 'chat-game', alice, `Message ${index}`);
    }
    await expect(sendGameChatMessage(repo, 'chat-game', alice, 'Too fast'))
      .rejects.toMatchObject({ code: 'chat_rate_limited' });

    await expect(deleteOwnChatMessage(repo, 'chat-game', message.id, 'u2'))
      .rejects.toMatchObject({ code: 'not_message_owner' });
    await deleteOwnChatMessage(repo, 'chat-game', message.id, 'u1');
    expect(await repo.getChatMessage(message.id)).toMatchObject({ body: '', deletedAt: expect.any(String) });

    await setChatMuted(repo, 'chat-game', 'u2', 'u1', true);
    expect(await repo.listMutedUserIds('chat-game', 'u2')).toEqual(['u1']);
    await setChatMuted(repo, 'chat-game', 'u2', 'u1', false);
    expect(await repo.listMutedUserIds('chat-game', 'u2')).toEqual([]);

    const reportId = await reportChatMessage(repo, 'chat-game', message.id, 'u2', 'Unkind message');
    expect(reportId).toEqual(expect.any(String));
  });
});
