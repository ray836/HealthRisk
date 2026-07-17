/**
 * Game membership — which user controls which seat.
 *
 * Authorization rule (enforced at the server): a user may act on a seat iff they
 * own that seat, and the turn engine independently checks it's that seat's turn.
 * "Practice" mode is just a game where one user owns every seat.
 */

import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

/** Claim a seat for a user; rejects if already held by someone else. */
export async function claimSeat(
  repo: GameRepository,
  gameId: string,
  playerId: string,
  userId: string,
): Promise<void> {
  const existing = await repo.getMemberBySeat(gameId, playerId);
  if (existing && existing.userId !== userId) {
    throw new TurnError('seat_taken', 'That seat is already taken');
  }
  // A user may hold at most one seat per game (except practice, where the caller
  // claims all seats up front and this guard is skipped by claimAllSeats).
  const owned = await repo.getMemberByUser(gameId, userId);
  if (owned && owned.playerId !== playerId) {
    throw new TurnError('already_seated', 'You already hold a seat in this game');
  }
  await repo.setMember({ gameId, playerId, userId });
}

/** Claim every seat for one user (practice / hot-seat game). */
export async function claimAllSeats(
  repo: GameRepository,
  gameId: string,
  playerIds: string[],
  userId: string,
): Promise<void> {
  for (const playerId of playerIds) await repo.setMember({ gameId, playerId, userId });
}

/** Claim the first unclaimed seat for a user (join flow). Returns the seat. */
export async function claimOpenSeat(
  repo: GameRepository,
  gameId: string,
  playerIds: string[],
  userId: string,
): Promise<string> {
  const already = await repo.getMemberByUser(gameId, userId);
  if (already) return already.playerId; // idempotent: rejoin returns your seat
  for (const playerId of playerIds) {
    if (!(await repo.getMemberBySeat(gameId, playerId))) {
      await repo.setMember({ gameId, playerId, userId });
      return playerId;
    }
  }
  throw new TurnError('game_full', 'This game has no open seats');
}

/** The seat a user controls in a game, or null. */
export async function seatFor(repo: GameRepository, gameId: string, userId: string): Promise<string | null> {
  return (await repo.getMemberByUser(gameId, userId))?.playerId ?? null;
}
