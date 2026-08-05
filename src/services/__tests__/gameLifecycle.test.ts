import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import { startDailySession } from '../../engine/turnSession.js';
import {
  deletePracticeGame,
  leaveGame,
  removeLobbyMember,
  startLobbyGame,
} from '../gameLifecycle.js';
import { InMemoryGameRepository } from '../repository.js';

const config: GameConfig = {
  exercises: [
    { key: 'run', label: 'Run', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 5 },
    { key: 'sleep', label: 'Sleep', unitLabel: 'completion', trackingType: 'checkbox', troopsPerUnit: 1, dailyUnitCap: 1 },
  ],
  dailyTotalTroopCap: 8,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/Los_Angeles',
};

function lobby(id = 'lobby', playerCount = 4) {
  const state = createGame({
    id,
    config,
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: `p${index + 1}`,
      name: index === 0 ? 'Creator' : `Player ${index + 1}`,
    })),
    seed: 3,
  });
  state.status = 'setup';
  return state;
}

describe('multiplayer lifecycle', () => {
  it('starts an open lobby with the joined players and rebuilds their board', async () => {
    const state = lobby();
    state.lobbyHealthVotes = { p1: ['run'] };
    const repo = new InMemoryGameRepository({ games: [state] });
    await repo.setMember({ gameId: 'lobby', playerId: 'p1', userId: 'creator' });

    await expect(startLobbyGame(repo, 'lobby', 'creator')).rejects.toMatchObject({
      code: 'lobby_needs_players',
    });

    await repo.setMember({ gameId: 'lobby', playerId: 'p2', userId: 'guest' });
    await repo.saveGame({
      ...(await repo.loadGame('lobby'))!,
      lobbyHealthVotes: { p1: ['run'], p2: ['run'] },
    });

    const started = await startLobbyGame(repo, 'lobby', 'creator');

    expect(started.status).toBe('active');
    expect(started.players.map((player) => player.id)).toEqual(['p1', 'p2']);
    expect(new Set(started.territories.map((territory) => territory.owner))).toEqual(
      new Set(['p1', 'p2']),
    );
    expect(started.config.perPlayerWindowMinutes).toBe(720);
    expect(started.config.exercises.map((exercise) => exercise.key)).toEqual(['run']);
  });

  it('waits for every player to submit and keeps the union of their selected goals', async () => {
    const state = lobby('voting');
    state.lobbyHealthVotes = { p1: ['run'] };
    const repo = new InMemoryGameRepository({ games: [state] });
    await repo.setMember({ gameId: 'voting', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'voting', playerId: 'p2', userId: 'guest' });

    await expect(startLobbyGame(repo, 'voting', 'creator')).rejects.toMatchObject({
      code: 'health_votes_incomplete',
    });

    await repo.saveGame({
      ...(await repo.loadGame('voting'))!,
      lobbyHealthVotes: { p1: ['run'], p2: ['sleep'] },
    });
    const started = await startLobbyGame(repo, 'voting', 'creator');
    expect(started.config.exercises.map((exercise) => exercise.key)).toEqual(['run', 'sleep']);
  });

  it('does not start when everyone submits an empty selection', async () => {
    const state = lobby('no-goals');
    state.lobbyHealthVotes = { p1: [], p2: [] };
    const repo = new InMemoryGameRepository({ games: [state] });
    await repo.setMember({ gameId: 'no-goals', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'no-goals', playerId: 'p2', userId: 'guest' });

    await expect(startLobbyGame(repo, 'no-goals', 'creator')).rejects.toMatchObject({
      code: 'no_health_goals_selected',
    });
  });

  it('frees a guest seat before play and lets the creator cancel the lobby', async () => {
    const repo = new InMemoryGameRepository({ games: [lobby()] });
    await repo.setMember({ gameId: 'lobby', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'lobby', playerId: 'p2', userId: 'guest' });

    expect((await leaveGame(repo, 'lobby', 'guest')).cancelled).toBe(false);
    expect(await repo.getMemberBySeat('lobby', 'p2')).toBeNull();
    expect((await leaveGame(repo, 'lobby', 'creator')).cancelled).toBe(true);
    expect(await repo.listMembers('lobby')).toEqual([]);
  });

  it('awards the remaining player a win when their only opponent forfeits', async () => {
    const state = lobby('active', 2);
    state.status = 'active';
    const session = startDailySession(state, 0);
    const repo = new InMemoryGameRepository({ games: [state], sessions: [session] });
    await repo.setMember({ gameId: 'active', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'active', playerId: 'p2', userId: 'guest' });

    const result = await leaveGame(repo, 'active', 'guest');

    expect(result.forfeited).toBe(true);
    expect(result.game.status).toBe('finished');
    expect(result.game.winnerId).toBe('p1');
    expect(result.game.players.find((player) => player.id === 'p2')?.status).toBe('forfeited');
    expect(result.game.territories.some((territory) => territory.owner === 'p2')).toBe(false);
    expect(result.game.territories.some((territory) => territory.owner === null)).toBe(true);
    expect(result.session?.queue).toEqual([]);
  });

  it('keeps a multi-player game active and turns the quitter\'s armies neutral', async () => {
    const state = lobby('active-three', 3);
    state.status = 'active';
    const quittingArmies = state.territories
      .filter((territory) => territory.owner === 'p2')
      .reduce((total, territory) => total + territory.armies, 0);
    const session = startDailySession(state, 0);
    const repo = new InMemoryGameRepository({ games: [state], sessions: [session] });
    await repo.setMember({ gameId: state.id, playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: state.id, playerId: 'p2', userId: 'quitter' });
    await repo.setMember({ gameId: state.id, playerId: 'p3', userId: 'remaining' });

    const result = await leaveGame(repo, state.id, 'quitter');

    expect(result.game.status).toBe('active');
    expect(result.game.winnerId).toBeUndefined();
    expect(result.game.players.find((player) => player.id === 'p2')?.status).toBe('forfeited');
    expect(result.session?.queue).not.toContain('p2');
    expect(result.session?.queue).toEqual(expect.arrayContaining(['p1', 'p3']));
    expect(result.game.territories.some((territory) => territory.owner === 'p2')).toBe(false);
    expect(result.game.territories
      .filter((territory) => territory.owner === null)
      .reduce((total, territory) => total + territory.armies, 0)).toBeGreaterThanOrEqual(quittingArmies);
  });

  it('requires deleting a practice game instead of forfeiting one controlled seat', async () => {
    const state = lobby('active-practice', 2);
    state.status = 'active';
    state.practice = true;
    const repo = new InMemoryGameRepository({ games: [state] });
    for (const player of state.players) {
      await repo.setMember({ gameId: state.id, playerId: player.id, userId: 'owner' });
    }

    await expect(leaveGame(repo, state.id, 'owner')).rejects.toMatchObject({
      code: 'practice_delete_required',
    });
  });

  it('lets the owner permanently delete practice data but rejects multiplayer deletion', async () => {
    const practice = lobby('practice', 2);
    practice.practice = true;
    practice.status = 'active';
    const practiceSession = startDailySession(practice, 0);
    const multiplayer = lobby('multiplayer', 2);
    const repo = new InMemoryGameRepository({
      games: [practice, multiplayer],
      sessions: [practiceSession],
    });
    for (const player of practice.players) {
      await repo.setMember({ gameId: practice.id, playerId: player.id, userId: 'owner' });
    }
    await repo.setMember({ gameId: multiplayer.id, playerId: 'p1', userId: 'owner' });

    await expect(deletePracticeGame(repo, multiplayer.id, 'owner'))
      .rejects.toMatchObject({ code: 'practice_only' });
    await expect(deletePracticeGame(repo, practice.id, 'someone-else'))
      .rejects.toMatchObject({ code: 'not_creator' });
    await deletePracticeGame(repo, practice.id, 'owner');

    expect(await repo.loadGame(practice.id)).toBeNull();
    expect(await repo.loadSession(practice.id, 0)).toBeNull();
    expect(await repo.listMembers(practice.id)).toEqual([]);
    expect(await repo.loadGame(multiplayer.id)).not.toBeNull();
  });

  it('lets only the creator free another lobby seat', async () => {
    const repo = new InMemoryGameRepository({ games: [lobby()] });
    await repo.setMember({ gameId: 'lobby', playerId: 'p1', userId: 'creator' });
    await repo.setMember({ gameId: 'lobby', playerId: 'p2', userId: 'guest' });

    await expect(removeLobbyMember(repo, 'lobby', 'guest', 'p1'))
      .rejects.toMatchObject({ code: 'not_creator' });
    await removeLobbyMember(repo, 'lobby', 'creator', 'p2');

    expect(await repo.getMemberBySeat('lobby', 'p2')).toBeNull();
    expect((await repo.loadGame('lobby'))?.players[1]?.name).toBe('Player 2');
  });
});
