import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { findActiveMultiplayerGame, isPracticeGame } from '../activeGame.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Los_Angeles',
};

function game(id: string, practice = false) {
  const state = createGame({
    id,
    config,
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    seed: 4,
  });
  state.practice = practice;
  return state;
}

describe('active multiplayer game lookup', () => {
  it('finds an active multiplayer seat but ignores practice games', async () => {
    const multiplayer = game('multi');
    const practice = game('practice', true);
    const repo = new InMemoryGameRepository({ games: [multiplayer, practice] });
    await repo.setMember({ gameId: 'multi', playerId: 'p1', userId: 'user' });
    await repo.setMember({ gameId: 'practice', playerId: 'p1', userId: 'user' });
    await repo.setMember({ gameId: 'practice', playerId: 'p2', userId: 'user' });

    expect(await findActiveMultiplayerGame(repo, 'user')).toBe('multi');
  });

  it('treats a waiting lobby as the account multiplayer slot', async () => {
    const waiting = game('waiting');
    waiting.status = 'setup';
    const repo = new InMemoryGameRepository({ games: [waiting] });
    await repo.setMember({ gameId: 'waiting', playerId: 'p1', userId: 'user' });

    expect(await findActiveMultiplayerGame(repo, 'user')).toBe('waiting');
  });

  it('releases the slot after the player is eliminated or the game finishes', async () => {
    const eliminated = game('eliminated');
    eliminated.players[0]!.status = 'eliminated';
    const finished = game('finished');
    finished.status = 'finished';
    const repo = new InMemoryGameRepository({ games: [eliminated, finished] });
    await repo.setMember({ gameId: 'eliminated', playerId: 'p1', userId: 'user' });
    await repo.setMember({ gameId: 'finished', playerId: 'p1', userId: 'user' });

    expect(await findActiveMultiplayerGame(repo, 'user')).toBeNull();
  });

  it('recognizes legacy hot-seat games without an explicit practice flag', async () => {
    const legacy = game('legacy');
    delete legacy.practice;
    const repo = new InMemoryGameRepository({ games: [legacy] });
    await repo.setMember({ gameId: 'legacy', playerId: 'p1', userId: 'user' });
    await repo.setMember({ gameId: 'legacy', playerId: 'p2', userId: 'user' });

    expect(await isPracticeGame(repo, legacy)).toBe(true);
    expect(await findActiveMultiplayerGame(repo, 'user')).toBeNull();
  });
});
