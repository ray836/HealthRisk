/**
 * Multiplayer lifecycle rules kept outside the HTTP layer so lobby behavior is
 * identical for the local server and a future hosted deployment.
 */

import { checkWin, forfeitPlayer } from '../engine/game.js';
import { createGame } from '../engine/setup.js';
import type { GameState } from '../engine/types.js';
import type { DailySession } from '../engine/turnSession.js';
import { pruneIneligiblePlayers } from '../engine/turnSession.js';
import { summarizeLobbyHealthVotes } from './lobbyHealthVoting.js';
import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

export const MINUTES_PER_DAY = 24 * 60;

function dailyWindowMinutes(playerCount: number): number {
  return Math.max(1, Math.floor(MINUTES_PER_DAY / playerCount));
}

function lobbyStartSeed(gameId: string, playerIds: string[]): number {
  let seed = 2166136261;
  for (const character of `${gameId}:${playerIds.join(',')}`) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  }
  return seed >>> 0;
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

/** Finalize an open lobby and allocate the board for whoever actually joined. */
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
  const joinedPlayerIds = new Set(members.map((member) => member.playerId));
  const joinedPlayers = game.players.filter((player) => joinedPlayerIds.has(player.id));
  if (joinedPlayers.length < 2) {
    throw new TurnError(
      'lobby_needs_players',
      'Invite at least one more player before starting',
    );
  }
  const healthVotes = summarizeLobbyHealthVotes(
    game,
    joinedPlayers.map((player) => player.id),
  );
  if (!healthVotes.allSubmitted) {
    throw new TurnError(
      'health_votes_incomplete',
      `Waiting for ${joinedPlayers.length - healthVotes.submittedPlayerIds.length} player(s) to review the health goals`,
    );
  }
  if (!healthVotes.includedExerciseKeys.length) {
    throw new TurnError(
      'no_health_goals_selected',
      'At least one player must select a health goal before the game starts',
    );
  }
  const includedExerciseKeys = new Set(healthVotes.includedExerciseKeys);
  const startedConfig = {
    ...game.config,
    exercises: game.config.exercises.filter((exercise) =>
      includedExerciseKeys.has(exercise.key)),
    perPlayerWindowMinutes: dailyWindowMinutes(joinedPlayers.length),
  };
  const initialized = createGame({
    id: game.id,
    config: startedConfig,
    players: joinedPlayers.map((player) => ({ id: player.id, name: player.name })),
    seed: lobbyStartSeed(game.id, joinedPlayers.map((player) => player.id)),
  });
  const started: GameState = {
    ...game,
    ...initialized,
    revision: game.revision,
    practice: false,
    lobbyHealthVotes: game.lobbyHealthVotes,
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

/** Creator-only lobby moderation. Removed seats immediately become joinable. */
export async function removeLobbyMember(
  repo: GameRepository,
  gameId: string,
  creatorUserId: string,
  playerId: string,
): Promise<GameState> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  await requireCreator(repo, game, creatorUserId);
  if (game.status !== 'setup') {
    throw new TurnError('game_started', 'Players can only be removed before the game starts');
  }
  if (playerId === game.players[0]?.id) {
    throw new TurnError('cannot_remove_creator', 'The creator can cancel the lobby instead');
  }
  if (!(await repo.getMemberBySeat(gameId, playerId))) {
    throw new TurnError('no_seat', 'That player is no longer in the lobby');
  }

  await repo.deleteMember(gameId, playerId);
  const lobbyHealthVotes = { ...(game.lobbyHealthVotes ?? {}) };
  delete lobbyHealthVotes[playerId];
  const updated: GameState = {
    ...game,
    lobbyHealthVotes,
    players: game.players.map((player) =>
      player.id === playerId
        ? { ...player, name: `Player ${Number(playerId.replace(/\D/g, '')) || ''}`.trim() }
        : player,
    ),
  };
  await repo.saveGame(updated);
  return updated;
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
    const remainingLobbyHealthVotes = { ...(game.lobbyHealthVotes ?? {}) };
    delete remainingLobbyHealthVotes[member.playerId];
    const reset = {
      ...game,
      lobbyHealthVotes: remainingLobbyHealthVotes,
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

