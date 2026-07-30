import { describe, expect, it } from 'vitest';

import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import {
  submitLobbyHealthVotes,
  summarizeLobbyHealthVotes,
} from '../lobbyHealthVoting.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [
    { key: 'run', label: 'Run', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 5 },
    { key: 'cycle', label: 'Cycle', unitLabel: 'mile', troopsPerUnit: 0.25, dailyUnitCap: 40 },
  ],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Denver',
};

function votingGame() {
  const game = createGame({
    id: 'vote-game',
    config,
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    seed: 9,
  });
  game.status = 'setup';
  game.lobbyHealthVotes = {};
  return game;
}

describe('lobby health-goal voting', () => {
  it('counts approvals while treating an empty choice as a completed submission', async () => {
    const repo = new InMemoryGameRepository({ games: [votingGame()] });
    await submitLobbyHealthVotes(repo, 'vote-game', 'p1', ['run']);
    await submitLobbyHealthVotes(repo, 'vote-game', 'p2', []);

    expect(summarizeLobbyHealthVotes((await repo.loadGame('vote-game'))!)).toEqual({
      voteCounts: { run: 1, cycle: 0 },
      submittedPlayerIds: ['p1', 'p2'],
      includedExerciseKeys: ['run'],
      allSubmitted: true,
    });
  });

  it('rejects selections that are not part of the creator-defined candidates', async () => {
    const repo = new InMemoryGameRepository({ games: [votingGame()] });
    await expect(
      submitLobbyHealthVotes(repo, 'vote-game', 'p1', ['swimming']),
    ).rejects.toMatchObject({ code: 'bad_health_vote' });
  });
});
