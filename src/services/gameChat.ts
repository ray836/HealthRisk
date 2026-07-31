import { randomUUID } from 'node:crypto';

import { TurnError } from './turnApi.js';
import type { ChatMessage, GameRepository } from './repository.js';
import type { PublicUser } from './authApi.js';

export const CHAT_MESSAGE_MAX_LENGTH = 500;

/**
 * Add one message to the conversation shared by a multiplayer lobby and its
 * eventual active game. Chat is independent from game revision so a message
 * cannot make another player's board action stale.
 */
export async function sendGameChatMessage(
  repo: GameRepository,
  gameId: string,
  user: PublicUser,
  value: unknown,
): Promise<ChatMessage> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  if (game.practice) {
    throw new TurnError('chat_unavailable', 'Chat is available in multiplayer games');
  }
  if (game.status === 'cancelled') {
    throw new TurnError('chat_closed', 'This lobby was cancelled');
  }

  const member = await repo.getMemberByUser(gameId, user.id);
  if (!member) throw new TurnError('no_seat', 'Join this game before using chat');

  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) throw new TurnError('empty_chat_message', 'Write a message before sending');
  if (body.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw new TurnError(
      'chat_message_too_long',
      `Messages can be up to ${CHAT_MESSAGE_MAX_LENGTH} characters`,
    );
  }

  const message: ChatMessage = {
    id: randomUUID(),
    gameId,
    userId: user.id,
    playerId: member.playerId,
    username: user.username,
    body,
    createdAt: new Date().toISOString(),
  };
  await repo.saveChatMessage(message);
  return message;
}
