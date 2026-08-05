/**
 * Backward-compatible account game summary helpers.
 *
 * Accounts may participate in multiple multiplayer games. The singular lookup
 * remains for older API clients that display one shortcut; new clients should
 * use GET /api/games as the complete authoritative library.
 */

import type { GameState } from '../engine/types.js';
import type { GameRepository } from './repository.js';

export async function isPracticeGame(repo: GameRepository, game: GameState): Promise<boolean> {
  if (game.practice !== undefined) return game.practice;

  // Backward compatibility for games created before the explicit flag existed:
  // practice games assigned every seat to one account.
  const members = await repo.listMembers(game.id);
  return (
    members.length === game.players.length &&
    members.length > 1 &&
    new Set(members.map((member) => member.userId)).size === 1
  );
}

export async function findActiveMultiplayerGame(
  repo: GameRepository,
  userId: string,
): Promise<string | null> {
  const memberships = await repo.listMembersForUser(userId);
  const gameIds = [...new Set(memberships.map((membership) => membership.gameId))];

  for (const gameId of gameIds) {
    const game = await repo.loadGame(gameId);
    if (
      !game ||
      (game.status !== 'setup' && game.status !== 'active') ||
      (await isPracticeGame(repo, game))
    ) continue;

    const seats = memberships
      .filter((membership) => membership.gameId === gameId)
      .map((membership) => membership.playerId);
    const isStillPlaying = game.players.some(
      (player) =>
        seats.includes(player.id) &&
        player.status !== 'eliminated' &&
        player.status !== 'forfeited',
    );
    if (isStillPlaying) return gameId;
  }

  return null;
}
