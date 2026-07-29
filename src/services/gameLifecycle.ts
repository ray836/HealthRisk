/**
 * Multiplayer lifecycle rules kept outside the HTTP layer so lobby behavior is
 * identical for the local server and a future hosted deployment.
 */

import { checkWin, forfeitPlayer } from '../engine/game.js';
import type { GameState } from '../engine/types.js';
import type { DailySession } from '../engine/turnSession.js';
import { pruneIneligiblePlayers } from '../engine/turnSession.js';
import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

export const MINUTES_PER_DAY = 24 * 60;

function dailyWindowMinutes(playerCount: number): number {
  return Math.max(1, Math.floor(MINUTES_PER_DAY / playerCount));
}

async function requireCreator(
  repo: GameRepository,
  game: GameState,
  userId: string,
): Promise<void> {
  const creator = await repo.getMemberBySeat(game.id, game.players[0]!.id);
  if (!creator || creator.userId !== userId) {
    throw new TurnError('not_creator', 'Only the game creator can do that');
  }
}

/** Start a full lobby and allocate one predictable slice of each day per seat. */
export async function startLobbyGame(
  repo: GameRepository,
  gameId: string,
  userId: string,
): Promise<GameState> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  await requireCreator(repo, game, userId);
  if (game.status !== 'setup') throw new TurnError('game_started', 'This game has already started');

  const members = await repo.listMembers(gameId);
  if (members.length !== game.players.length) {
    throw new TurnError(
      'lobby_not_full',
      `Waiting for ${game.players.length - members.length} more player(s)`,
    );
  }

  const started: GameState = {
    ...game,
    status: 'active',
    config: {
      ...game.config,
      perPlayerWindowMinutes: dailyWindowMinutes(game.players.length),
    },
  };
  await repo.saveGame(started);
  return started;
}

export interface LeaveGameResult {
  game: GameState;
  cancelled: boolean;
  forfeited: boolean;
  session?: DailySession;
}

/**
 * Before play, a non-creator simply frees their seat; the creator cancels the
 * lobby. During play, leaving is an explicit forfeit and their land becomes
 * neutral so the remaining game cannot be held hostage.
 */
export async function leaveGame(
  repo: GameRepository,
  gameId: string,
  userId: string,
): Promise<LeaveGameResult> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  const member = await repo.getMemberByUser(gameId, userId);
  if (!member) throw new TurnError('no_seat', 'You are not a member of this game');

  if (game.status === 'setup') {
    const isCreator = member.playerId === game.players[0]!.id;
    if (isCreator) {
      const cancelled = { ...game, status: 'cancelled' as const };
      await repo.saveGame(cancelled);
      for (const lobbyMember of await repo.listMembers(gameId)) {
        await repo.deleteMember(gameId, lobbyMember.playerId);
      }
      return { game: cancelled, cancelled: true, forfeited: false };
    }

    await repo.deleteMember(gameId, member.playerId);
    const reset = {
      ...game,
      players: game.players.map((player) =>
        player.id === member.playerId
          ? { ...player, name: `Player ${Number(player.id.replace(/\D/g, '')) || ''}`.trim() }
          : player,
      ),
    };
    await repo.saveGame(reset);
    return { game: reset, cancelled: false, forfeited: false };
  }

  if (game.status !== 'active') {
    throw new TurnError('game_over', 'This game is no longer active');
  }

  const player = game.players.find((candidate) => candidate.id === member.playerId);
  if (!player || player.status === 'forfeited' || player.status === 'eliminated') {
    throw new TurnError('already_out', 'You are already out of this game');
  }

  const forfeited = checkWin(forfeitPlayer(game, member.playerId));
  await repo.saveGame(forfeited);
  const session = await repo.loadSession(gameId, game.dayNumber);
  const pruned = session ? pruneIneligiblePlayers(session, forfeited) : undefined;
  if (pruned) await repo.saveSession(pruned);
  return { game: forfeited, cancelled: false, forfeited: true, session: pruned };
}

