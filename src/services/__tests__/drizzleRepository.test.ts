import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb, type DbHandle } from '../../../db/client.js';
import { DrizzleGameRepository } from '../drizzleRepository.js';
import { createGame } from '../../engine/setup.js';
import type { GameConfig } from '../../engine/types.js';
import type { DailySession } from '../../engine/turnSession.js';
import type { TurnState } from '../repository.js';

const config: GameConfig = {
  exercises: [{ key: 'running', label: 'Running', unitLabel: 'mile', troopsPerUnit: 1, dailyUnitCap: 3 }],
  dailyTotalTroopCap: 5,
  windowStartMinuteOfDay: 19 * 60,
  perPlayerWindowMinutes: 20,
  autoForfeitAfterDays: null,
  autoAttackStopLoss: 3,
  maxAttacksPerTurn: null,
  timezone: 'America/New_York',
};

describe('DrizzleGameRepository (PGlite in-memory)', () => {
  let handle: DbHandle;
  let repo: DrizzleGameRepository;

  beforeAll(async () => {
    handle = await createDb({ dir: 'memory://' });
    repo = new DrizzleGameRepository(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it('round-trips a full game and upserts on save', async () => {
    const g = createGame({ id: 'g1', config, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 7 });
    await repo.saveGame(g);
    const loaded = await repo.loadGame('g1');
    expect(loaded).toEqual(g);
    expect((await repo.listGames()).map((game) => game.id)).toContain('g1');

    // Upsert: saving again overwrites.
    const changed = { ...g, dayNumber: 3, status: 'finished' as const, winnerId: 'a' };
    await repo.saveGame(changed);
    const reloaded = await repo.loadGame('g1');
    expect(reloaded!.dayNumber).toBe(3);
    expect(reloaded!.winnerId).toBe('a');
  });

  it('returns null for a missing game', async () => {
    expect(await repo.loadGame('nope')).toBeNull();
  });

  it('round-trips sessions and turn states (incl. bonus fields)', async () => {
    const session: DailySession = { gameId: 'g1', dayNumber: 1, queue: ['a', 'b'], completed: [], autoResolved: [] };
    await repo.saveSession(session);
    expect(await repo.loadSession('g1', 1)).toEqual(session);

    const ts: TurnState = {
      gameId: 'g1',
      dayNumber: 1,
      playerId: 'a',
      phase: 'attack',
      attacksMade: 2,
      startBonus: 8,
      startContinents: ['Africa'],
    };
    await repo.saveTurnState(ts);
    expect(await repo.loadTurnState('g1', 1, 'a')).toEqual(ts);
    expect(await repo.loadTurnState('g1', 1, 'zzz')).toBeNull();
  });

  it('round-trips exercise logs and defaults to empty', async () => {
    expect(await repo.loadExerciseLog('g1', 1, 'a')).toEqual([]);
    const entries = [{ exerciseKey: 'running', units: 3 }];
    await repo.saveExerciseLog('g1', 1, 'a', entries);
    expect(await repo.loadExerciseLog('g1', 1, 'a')).toEqual(entries);
    // upsert overwrites
    await repo.saveExerciseLog('g1', 1, 'a', [...entries, { exerciseKey: 'running', units: 1 }]);
    expect(await repo.loadExerciseLog('g1', 1, 'a')).toHaveLength(2);
  });

  it('persists across a new repository instance on the same db', async () => {
    const repo2 = new DrizzleGameRepository(handle.db);
    const loaded = await repo2.loadGame('g1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('g1');
  });

  it('round-trips users, tokens, and members', async () => {
    await repo.createUser({ id: 'u1', username: 'alice', passwordHash: 'salt:hash', createdAt: 'now' });
    expect((await repo.getUserByUsername('alice'))!.id).toBe('u1');
    expect((await repo.getUserById('u1'))!.username).toBe('alice');
    expect(await repo.getUserByUsername('nobody')).toBeNull();

    await repo.createToken({
      tokenHash: 'tok1',
      userId: 'u1',
      createdAt: 'now',
      expiresAt: 'later',
    });
    expect((await repo.getToken('tok1'))!.userId).toBe('u1');
    await repo.deleteToken('tok1');
    expect(await repo.getToken('tok1')).toBeNull();

    await repo.setMember({ gameId: 'g1', playerId: 'p1', userId: 'u1' });
    expect((await repo.getMemberByUser('g1', 'u1'))!.playerId).toBe('p1');
    expect((await repo.getMemberBySeat('g1', 'p1'))!.userId).toBe('u1');
    // upsert reassigns
    await repo.setMember({ gameId: 'g1', playerId: 'p1', userId: 'u2' });
    expect((await repo.getMemberBySeat('g1', 'p1'))!.userId).toBe('u2');
    expect(await repo.listMembers('g1')).toHaveLength(1);
  });

  it('stores a bounded game conversation in chronological order', async () => {
    const newer = {
      id: 'chat-2',
      gameId: 'g1',
      userId: 'u2',
      playerId: 'p2',
      username: 'bob',
      body: 'Ready to play?',
      createdAt: '2026-07-30T18:01:00.000Z',
    };
    const older = {
      id: 'chat-1',
      gameId: 'g1',
      userId: 'u1',
      playerId: 'p1',
      username: 'alice',
      body: 'Welcome!',
      createdAt: '2026-07-30T18:00:00.000Z',
    };
    await repo.saveChatMessage(newer);
    await repo.saveChatMessage(older);

    expect(await repo.listChatMessages('g1')).toEqual([older, newer]);
    expect(await repo.listChatMessages('g1', 1)).toEqual([newer]);
    expect(await repo.listChatMessages('another-game')).toEqual([]);
  });
});
