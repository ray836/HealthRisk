import type { GameState, PlayerId } from '../engine/types.js';
import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

export interface LobbyHealthVoteSummary {
  voteCounts: Record<string, number>;
  submittedPlayerIds: PlayerId[];
  includedExerciseKeys: string[];
  allSubmitted: boolean;
}

/** Build the public, privacy-light lobby tally without exposing who chose what. */
export function summarizeLobbyHealthVotes(game: GameState): LobbyHealthVoteSummary {
  const votes = game.lobbyHealthVotes ?? {};
  const playerIds = new Set(game.players.map((player) => player.id));
  const exerciseKeys = new Set(game.config.exercises.map((exercise) => exercise.key));
  const submittedPlayerIds = Object.keys(votes).filter((playerId) => playerIds.has(playerId));
  const voteCounts: Record<string, number> = Object.fromEntries(
    game.config.exercises.map((exercise) => [exercise.key, 0]),
  );

  for (const playerId of submittedPlayerIds) {
    for (const exerciseKey of new Set(votes[playerId] ?? [])) {
      if (exerciseKeys.has(exerciseKey)) {
        voteCounts[exerciseKey] = (voteCounts[exerciseKey] ?? 0) + 1;
      }
    }
  }

  return {
    voteCounts,
    submittedPlayerIds,
    includedExerciseKeys: game.config.exercises
      .filter((exercise) => (voteCounts[exercise.key] ?? 0) > 0)
      .map((exercise) => exercise.key),
    allSubmitted: game.players.every((player) =>
      Object.prototype.hasOwnProperty.call(votes, player.id)),
  };
}

/** Save one player's complete approval selection. An empty list is a valid submission. */
export async function submitLobbyHealthVotes(
  repo: GameRepository,
  gameId: string,
  playerId: PlayerId,
  selectedExerciseKeys: string[],
): Promise<GameState> {
  const game = await repo.loadGame(gameId);
  if (!game) throw new TurnError('no_game', 'Unknown game');
  if (game.status !== 'setup') {
    throw new TurnError('game_started', 'Health-goal selections close when the game starts');
  }
  if (!game.players.some((player) => player.id === playerId)) {
    throw new TurnError('no_seat', 'Join this lobby before selecting health goals');
  }

  const allowedKeys = new Set(game.config.exercises.map((exercise) => exercise.key));
  const uniqueKeys = [...new Set(selectedExerciseKeys)];
  if (uniqueKeys.some((exerciseKey) => !allowedKeys.has(exerciseKey))) {
    throw new TurnError('bad_health_vote', 'Select only health goals from this lobby');
  }

  const next = {
    ...game,
    lobbyHealthVotes: {
      ...(game.lobbyHealthVotes ?? {}),
      [playerId]: uniqueKeys,
    },
  };
  await repo.saveGame(next);
  return next;
}
