import { currentPlayer } from '../engine/turnSession.js';
import type { GameRepository } from './repository.js';

export interface GameSummary {
  id: string;
  status: 'setup' | 'active' | 'finished' | 'cancelled';
  practice: boolean;
  isCreator: boolean;
  myPlayerIds: string[];
  playerCount: number;
  lobbyCapacity: number;
  dayNumber: number;
  currentPlayerId: string | null;
  yourTurn: boolean;
  winnerId: string | null;
  playerNames: string[];
}

/** Compact account-level history used by web and native game pickers. */
export async function listUserGames(
  repo: GameRepository,
  userId: string,
): Promise<GameSummary[]> {
  const memberships = await repo.listMembersForUser(userId);
  const grouped = new Map<string, string[]>();
  for (const membership of memberships) {
    const seats = grouped.get(membership.gameId) ?? [];
    seats.push(membership.playerId);
    grouped.set(membership.gameId, seats);
  }

  const summaries: GameSummary[] = [];
  for (const [gameId, myPlayerIds] of grouped) {
    const game = await repo.loadGame(gameId);
    if (!game) continue;
    const members = await repo.listMembers(gameId);
    const session = await repo.loadSession(gameId, game.dayNumber);
    const actor = session ? currentPlayer(session) : null;
    summaries.push({
      id: game.id,
      status: game.status,
      practice: game.practice ?? false,
      isCreator: myPlayerIds.includes(game.players[0]?.id ?? ''),
      myPlayerIds,
      playerCount: game.status === 'setup' ? members.length : game.players.length,
      lobbyCapacity: game.players.length,
      dayNumber: game.dayNumber,
      currentPlayerId: actor,
      yourTurn: !!actor && myPlayerIds.includes(actor),
      winnerId: game.winnerId ?? null,
      playerNames: game.players
        .filter((player) => game.status !== 'setup' || members.some((member) => member.playerId === player.id))
        .map((player) => player.name),
    });
  }

  const priority = { active: 0, setup: 1, finished: 2, cancelled: 3 } as const;
  return summaries.sort(
    (left, right) =>
      priority[left.status] - priority[right.status] ||
      right.dayNumber - left.dayNumber ||
      left.id.localeCompare(right.id),
  );
}
