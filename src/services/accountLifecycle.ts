import { verifyPassword } from './authApi.js';
import { leaveGame } from './gameLifecycle.js';
import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

/** Remove an account and its private data while preserving anonymized game history. */
export async function deleteAccount(
  repo: GameRepository,
  userId: string,
  password: string,
): Promise<void> {
  const user = await repo.getUserById(userId);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new TurnError('bad_credentials', 'Enter your password to delete this account');
  }

  const memberships = await repo.listMembersForUser(userId);
  const gameIds = [...new Set(memberships.map((membership) => membership.gameId))];
  for (const gameId of gameIds) {
    const game = await repo.loadGame(gameId);
    if (!game) continue;
    const owned = memberships.filter((membership) => membership.gameId === gameId);
    if (game.practice) {
      if (game.status === 'setup' || game.status === 'active') {
        await repo.saveGame({ ...game, status: 'cancelled' });
      }
      for (const member of await repo.listMembers(gameId)) {
        if (member.userId === userId) await repo.deleteMember(gameId, member.playerId);
      }
      continue;
    }
    if (game.status === 'setup' || game.status === 'active') {
      await leaveGame(repo, gameId, userId);
    }
    for (const member of owned) await repo.deleteMember(gameId, member.playerId);
  }

  await repo.anonymizeChatMessagesByUser(userId);
  await repo.deletePrivateUserData(userId);
  await repo.deleteTokensForUser(userId);
  await repo.deleteUser(userId);
}
