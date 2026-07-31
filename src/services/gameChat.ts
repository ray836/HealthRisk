import { randomUUID } from 'node:crypto';

import { TurnError } from './turnApi.js';
import type { ChatMessage, GameRepository } from './repository.js';
import type { PublicUser } from './authApi.js';

export const CHAT_MESSAGE_MAX_LENGTH = 500;
export const CHAT_RATE_LIMIT_COUNT = 6;
export const CHAT_RATE_LIMIT_WINDOW_MS = 10_000;

async function requireChatMember(repo: GameRepository, gameId: string, userId: string) {
  const member = await repo.getMemberByUser(gameId, userId);
  if (!member) throw new TurnError('no_seat', 'Join this game before using chat');
  return member;
}

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

  const member = await requireChatMember(repo, gameId, user.id);

  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) throw new TurnError('empty_chat_message', 'Write a message before sending');
  if (body.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw new TurnError(
      'chat_message_too_long',
      `Messages can be up to ${CHAT_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  const since = new Date(Date.now() - CHAT_RATE_LIMIT_WINDOW_MS).toISOString();
  if ((await repo.countRecentChatMessages(gameId, user.id, since)) >= CHAT_RATE_LIMIT_COUNT) {
    throw new TurnError('chat_rate_limited', 'You are sending messages too quickly; wait a few seconds');
  }

  const message: ChatMessage = {
    id: randomUUID(),
    gameId,
    userId: user.id,
    playerId: member.playerId,
    username: user.username,
    body,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };
  await repo.saveChatMessage(message);
  return message;
}

export async function deleteOwnChatMessage(
  repo: GameRepository,
  gameId: string,
  messageId: string,
  userId: string,
): Promise<void> {
  await requireChatMember(repo, gameId, userId);
  const message = await repo.getChatMessage(messageId);
  if (!message || message.gameId !== gameId) throw new TurnError('no_message', 'Message not found');
  if (message.userId !== userId) {
    throw new TurnError('not_message_owner', 'You can only delete your own messages');
  }
  if (!message.deletedAt) await repo.softDeleteChatMessage(messageId, new Date().toISOString());
}

export async function setChatMuted(
  repo: GameRepository,
  gameId: string,
  userId: string,
  mutedUserId: string,
  muted: boolean,
): Promise<void> {
  await requireChatMember(repo, gameId, userId);
  if (mutedUserId === userId) throw new TurnError('cannot_mute_self', 'You cannot mute yourself');
  if (muted && !(await repo.getMemberByUser(gameId, mutedUserId))) {
    throw new TurnError('no_chat_user', 'That user is not a member of this game');
  }
  if (muted) await repo.setChatMute(gameId, userId, mutedUserId, new Date().toISOString());
  else await repo.deleteChatMute(gameId, userId, mutedUserId);
}

export async function reportChatMessage(
  repo: GameRepository,
  gameId: string,
  messageId: string,
  userId: string,
  rawReason: unknown,
): Promise<string> {
  await requireChatMember(repo, gameId, userId);
  const message = await repo.getChatMessage(messageId);
  if (!message || message.gameId !== gameId) throw new TurnError('no_message', 'Message not found');
  if (message.userId === userId) throw new TurnError('cannot_report_self', 'You cannot report your own message');
  const reason = String(rawReason ?? '').trim();
  if (reason.length < 3 || reason.length > 300) {
    throw new TurnError('bad_report_reason', 'Give a short reason between 3 and 300 characters');
  }
  const id = randomUUID();
  await repo.saveChatReport({
    id,
    gameId,
    messageId,
    reporterUserId: userId,
    reason,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  return id;
}
