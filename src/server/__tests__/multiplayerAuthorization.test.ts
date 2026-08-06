import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface AuthResult {
  token: string;
}

interface GameView {
  id: string;
  revision: number;
  status: string;
  winnerId: string | null;
  dayNumber: number;
  isCreator: boolean;
  currentPlayerId: string | null;
  mySeats: string[];
  perPlayerWindowMinutes: number;
  nextSessionOpensAt: string | null;
  players: Array<{
    id: string;
    name: string;
    status: string;
    healthProgress: null | {
      historyWindowDays: number;
      consistencyPercent: number | null;
      goals: Array<{
        exerciseKey: string;
        currentStatus: 'not_started' | 'in_progress' | 'goal_met';
        completedDays: number;
        trackedDays: number;
        consistencyPercent: number | null;
      }>;
    };
  }>;
  territories: Array<{ id: string; owner: string | null; armies: number }>;
  exercises: Array<{
    key: string;
    label: string;
    category: string;
    trackingType: string;
    unitLabel: string;
    troopsPerUnit: number;
    dailyUnitCap: number | null;
  }>;
  categoryTroopCaps: Record<string, number>;
  dailyTotalTroopCap: number;
  healthRulesVersion: number;
  pendingHealthRuleProposal?: unknown;
  claimedPlayerCount: number;
  lobbyCapacity: number;
  chatMessages: Array<{
    id: string;
    userId: string;
    playerId: string;
    username: string;
    body: string;
    createdAt: string;
  }>;
  lobbyHealthVoting: {
    voteCounts: Record<string, number>;
    submittedPlayerIds: string[];
    includedExerciseKeys: string[];
    submissionCount: number;
    requiredSubmissions: number;
    allSubmitted: boolean;
    hasSubmitted: boolean;
    mySelections: string[];
  };
  healthLogging: {
    allowed: boolean;
    playerId: string | null;
    playerName: string | null;
    appliesTo: 'current_move' | 'upcoming_move' | 'next_move' | null;
    reason: 'game_not_active' | 'out_of_game' | 'no_seat' | null;
  };
  schedule: {
    nextSessionOpensAt: string | null;
  };
}

interface GameResult {
  game: GameView;
}

interface ExerciseResult extends GameResult {
  deltaTroops: number;
  dayTotal: number;
}

interface ChatResult {
  message: GameView['chatMessages'][number];
}

let server: Server;
let baseUrl: string;

async function request<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return {
    response,
    body: (await response.json()) as T,
  };
}

beforeAll(async () => {
  process.env.EXRISK_MEMORY = '1';
  delete process.env.VERCEL;
  const { default: app } = await import('../server.js');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('multiplayer route authorization', () => {
  it('lets an account create, join, and start multiple concurrent multiplayer games', async () => {
    const password = 'RouteTest@2026';
    const owner = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'multi-game-owner', password },
    });
    const guest = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'multi-game-guest', password },
    });

    const first = await request<GameView>('/api/games', {
      method: 'POST',
      token: owner.body.token,
      body: { practice: false },
    });
    const second = await request<GameView>('/api/games', {
      method: 'POST',
      token: owner.body.token,
      body: { practice: false },
    });

    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const joinedFirst = await request<GameResult>(`/api/games/${first.body.id}/join`, {
      method: 'POST',
      token: guest.body.token,
      body: {},
    });
    const joinedSecond = await request<GameResult>(`/api/games/${second.body.id}/join`, {
      method: 'POST',
      token: guest.body.token,
      body: {},
    });

    expect(joinedFirst.response.status).toBe(200);
    expect(joinedSecond.response.status).toBe(200);

    for (const gameId of [first.body.id, second.body.id]) {
      const latest = await request<GameView>(`/api/games/${gameId}`, {
        token: owner.body.token,
      });
      const choices = latest.body.exercises.map((exercise) => exercise.key);
      const mismatchedRules = await request<{ error: string }>(
        `/api/games/${gameId}/lobby-health-votes`,
        {
          method: 'POST',
          token: owner.body.token,
          body: {
            healthRulesVersion: latest.body.healthRulesVersion + 1,
            exerciseKeys: choices,
          },
        },
      );
      expect(mismatchedRules.response.status).toBe(409);
      expect(mismatchedRules.body.error).toBe('stale_health_rules');
      const [ownerVote, guestVote] = await Promise.all([
        request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
          method: 'POST',
          token: owner.body.token,
          body: {
            healthRulesVersion: latest.body.healthRulesVersion,
            exerciseKeys: choices,
          },
        }),
        request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
          method: 'POST',
          token: guest.body.token,
          body: {
            healthRulesVersion: latest.body.healthRulesVersion,
            exerciseKeys: choices,
          },
        }),
      ]);
      expect(ownerVote.response.status).toBe(200);
      expect(guestVote.response.status).toBe(200);
      const ready = await request<GameView>(`/api/games/${gameId}`, {
        token: owner.body.token,
      });
      expect(ready.body.lobbyHealthVoting.submissionCount).toBe(2);
      const started = await request<GameResult>(`/api/games/${gameId}/start`, {
        method: 'POST',
        token: owner.body.token,
        body: { revision: ready.body.revision },
      });
      expect(started.response.status).toBe(200);
      expect(started.body.game.status).toBe('active');
    }

    const beforeForfeit = await request<GameView>(`/api/games/${first.body.id}`, {
      token: guest.body.token,
    });
    const ownerSeat = beforeForfeit.body.players.find(
      (player) => player.name === 'multi-game-owner',
    )!;
    const guestSeat = beforeForfeit.body.players.find(
      (player) => player.name === 'multi-game-guest',
    )!;
    const guestTerritories = new Map(
      beforeForfeit.body.territories
        .filter((territory) => territory.owner === guestSeat.id)
        .map((territory) => [territory.id, territory.armies]),
    );
    const forfeited = await request<{ ok: true; game: GameView }>(
      `/api/games/${first.body.id}/leave`,
      {
        method: 'POST',
        token: guest.body.token,
        body: { revision: beforeForfeit.body.revision },
      },
    );
    expect(forfeited.response.status).toBe(200);
    expect(forfeited.body.game.status).toBe('finished');
    expect(forfeited.body.game.winnerId).toBe(ownerSeat.id);
    expect(forfeited.body.game.currentPlayerId).toBeNull();
    expect(forfeited.body.game.players.find((player) => player.id === guestSeat.id)?.status)
      .toBe('forfeited');
    for (const [territoryId, armies] of guestTerritories) {
      expect(forfeited.body.game.territories.find((territory) => territory.id === territoryId))
        .toMatchObject({ owner: null, armies });
    }

    const ownerGames = await request<{ games: Array<{ id: string }> }>('/api/games', {
      token: owner.body.token,
    });
    const guestGames = await request<{ games: Array<{ id: string }> }>('/api/games', {
      token: guest.body.token,
    });
    expect(ownerGames.body.games.map((game) => game.id)).toEqual(
      expect.arrayContaining([first.body.id, second.body.id]),
    );
    expect(guestGames.body.games.map((game) => game.id)).toEqual(
      expect.arrayContaining([first.body.id, second.body.id]),
    );

    const metadata = await request<{
      capabilities: { multipleConcurrentGames: boolean };
    }>('/api/meta');
    expect(metadata.body.capabilities.multipleConcurrentGames).toBe(true);
  });

  it('lets only the creator update the rules everyone sees in the lobby', async () => {
    const password = 'RouteTest@2026';
    const creator = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'lobby-rules-owner', password },
    });
    const other = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'lobby-rules-guest', password },
    });
    const created = await request<GameView>('/api/games', {
      method: 'POST',
      token: creator.body.token,
      body: { players: 2, practice: false },
    });
    expect(created.body.claimedPlayerCount).toBe(1);
    expect(created.body.lobbyCapacity).toBe(10);
    expect(created.body.players).toHaveLength(1);
    expect(created.body.lobbyHealthVoting.requiredSubmissions).toBe(1);
    const gameId = created.body.id;
    const joined = await request<GameResult>(`/api/games/${gameId}/join`, {
      method: 'POST',
      token: other.body.token,
      body: {},
    });
    expect(joined.body.game.players).toHaveLength(2);
    expect(joined.body.game.lobbyHealthVoting.requiredSubmissions).toBe(2);
    const guestView = await request<GameView>(`/api/games/${gameId}`, {
      token: other.body.token,
    });
    const rules = {
      exercises: [{
        key: 'walk',
        label: 'Outdoor walk',
        category: 'movement',
        trackingType: 'duration',
        unitLabel: 'minute',
        troopsPerUnit: 0.1,
        dailyUnitCap: 60,
      }],
      categoryTroopCaps: { movement: 6 },
      dailyTotalTroopCap: 8,
    };

    const denied = await request<{ error: string }>(`/api/games/${gameId}/health-rules/propose`, {
      method: 'POST',
      token: other.body.token,
      body: { ...rules, revision: guestView.body.revision },
    });
    expect(denied.response.status).toBe(403);
    expect(denied.body.error).toBe('not_creator');

    const creatorView = await request<GameView>(`/api/games/${gameId}`, {
      token: creator.body.token,
    });
    const updated = await request<GameResult>(`/api/games/${gameId}/health-rules/propose`, {
      method: 'POST',
      token: creator.body.token,
      body: { ...rules, revision: creatorView.body.revision },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body.game.exercises).toEqual([
      expect.objectContaining({
        key: 'walk',
        label: 'Outdoor walk',
        trackingType: 'duration',
        troopsPerUnit: 0.1,
        dailyUnitCap: 60,
      }),
    ]);
    expect(updated.body.game.pendingHealthRuleProposal).toBeNull();

    const visibleToGuest = await request<GameView>(`/api/games/${gameId}`, {
      token: other.body.token,
    });
    expect(visibleToGuest.body.exercises[0]?.label).toBe('Outdoor walk');
    expect(visibleToGuest.body.dailyTotalTroopCap).toBe(8);
  });

  it('lets active members log health anytime while keeping move actions turn-owned', async () => {
    const password = 'RouteTest@2026';
    const creator = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'route-owner-a', password },
    });
    const other = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'route-owner-b', password },
    });

    const created = await request<GameView>('/api/games', {
      method: 'POST',
      token: creator.body.token,
      body: { players: 2, practice: false },
    });
    const gameId = created.body.id;
    await request<GameResult>(`/api/games/${gameId}/join`, {
      method: 'POST',
      token: other.body.token,
      body: {},
    });
    let latest = await request<GameView>(`/api/games/${gameId}`, {
      token: creator.body.token,
    });
    const creatorVote = await request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
      method: 'POST',
      token: creator.body.token,
      body: {
        healthRulesVersion: latest.body.healthRulesVersion,
        exerciseKeys: latest.body.exercises.map((exercise) => exercise.key),
      },
    });
    const guestVote = await request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
      method: 'POST',
      token: other.body.token,
      body: {
        healthRulesVersion: creatorVote.body.game.healthRulesVersion,
        exerciseKeys: creatorVote.body.game.exercises.map((exercise) => exercise.key),
      },
    });
    latest = { response: guestVote.response, body: guestVote.body.game };
    const started = await request<GameResult>(`/api/games/${gameId}/start`, {
      method: 'POST',
      token: creator.body.token,
      body: { revision: latest.body.revision },
    });

    let game = started.body.game;
    expect(game.players).toHaveLength(2);
    expect(game.perPlayerWindowMinutes).toBe(720);
    const tokensBySeat = new Map<string, string>();
    for (const seat of game.mySeats) tokensBySeat.set(seat, creator.body.token);
    const otherView = await request<GameView>(`/api/games/${gameId}`, {
      token: other.body.token,
    });
    for (const seat of otherView.body.mySeats) tokensBySeat.set(seat, other.body.token);

    const currentToken = tokensBySeat.get(game.currentPlayerId!);
    const wrongToken =
      currentToken === creator.body.token ? other.body.token : creator.body.token;
    const loggedBetweenTurns = await request<ExerciseResult>(`/api/games/${gameId}/exercise`, {
      method: 'POST',
      token: wrongToken,
      body: { revision: game.revision, exerciseKey: 'running', units: 1 },
    });
    expect(loggedBetweenTurns.response.status).toBe(200);
    expect(loggedBetweenTurns.body.deltaTroops).toBe(1);
    expect(loggedBetweenTurns.body.dayTotal).toBe(1);
    expect(loggedBetweenTurns.body.game.healthLogging).toMatchObject({
      allowed: true,
      appliesTo: 'upcoming_move',
    });
    const loggingSeat = [...tokensBySeat].find(([, token]) => token === wrongToken)?.[0];
    const sharedProgress = loggedBetweenTurns.body.game.players
      .find((player) => player.id === loggingSeat)
      ?.healthProgress;
    expect(sharedProgress).toMatchObject({
      historyWindowDays: 0,
      consistencyPercent: null,
    });
    expect(sharedProgress?.goals.find((goal) => goal.exerciseKey === 'running')).toMatchObject({
      currentStatus: 'in_progress',
      completedDays: 0,
      trackedDays: 0,
      consistencyPercent: null,
    });
    game = loggedBetweenTurns.body.game;

    const denied = await request<{ error: string }>(`/api/games/${gameId}/expire`, {
      method: 'POST',
      token: wrongToken,
      body: { revision: game.revision },
    });
    expect(denied.response.status).toBe(409);
    expect(denied.body.error).toBe('not_your_turn');

    for (let remainingTurns = 2; remainingTurns > 0; remainingTurns -= 1) {
      const ownerToken = tokensBySeat.get(game.currentPlayerId!);
      expect(ownerToken).toBeTruthy();
      const resolved = await request<GameResult>(`/api/games/${gameId}/expire`, {
        method: 'POST',
        token: ownerToken,
        body: { revision: game.revision },
      });
      expect(resolved.response.status).toBe(200);
      game = resolved.body.game;
    }

    expect(game.status).toBe('active');
    expect(game.currentPlayerId).toBeNull();
    expect(game.nextSessionOpensAt).toMatch(/Z$/);
    expect(game.schedule.nextSessionOpensAt).toBe(game.nextSessionOpensAt);

    const loggedAfterMoves = await request<ExerciseResult>(`/api/games/${gameId}/exercise`, {
      method: 'POST',
      token: creator.body.token,
      body: { revision: game.revision, exerciseKey: 'running', units: 1 },
    });
    expect(loggedAfterMoves.response.status).toBe(200);
    expect(loggedAfterMoves.body.game.currentPlayerId).toBeNull();
    expect(loggedAfterMoves.body.game.healthLogging).toMatchObject({
      allowed: true,
      appliesTo: 'next_move',
    });
  });

  it('returns the next practice round immediately after the final controlled seat ends', async () => {
    const owner = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'practice-fast-owner', password: 'RouteTest@2026' },
    });
    const created = await request<GameView>('/api/games', {
      method: 'POST',
      token: owner.body.token,
      body: { practice: true, players: 2 },
    });

    expect(created.response.status).toBe(201);
    const firstSeat = created.body.currentPlayerId;
    expect(firstSeat).toBeTruthy();
    expect(created.body.dayNumber).toBe(0);
    expect(created.body.nextSessionOpensAt).toBeNull();

    const firstTurn = await request<GameResult>(`/api/games/${created.body.id}/end`, {
      method: 'POST',
      token: owner.body.token,
      body: { revision: created.body.revision },
    });
    expect(firstTurn.response.status).toBe(200);
    expect(firstTurn.body.game.dayNumber).toBe(0);
    expect(firstTurn.body.game.currentPlayerId).not.toBe(firstSeat);

    const finalTurn = await request<GameResult>(`/api/games/${created.body.id}/end`, {
      method: 'POST',
      token: owner.body.token,
      body: { revision: firstTurn.body.game.revision },
    });
    expect(finalTurn.response.status).toBe(200);
    expect(finalTurn.body.game.dayNumber).toBe(1);
    expect(finalTurn.body.game.currentPlayerId).toBe(firstSeat);
    expect(finalTurn.body.game.nextSessionOpensAt).toBeNull();
    expect(finalTurn.body.game.schedule.nextSessionOpensAt).toBeNull();

    const deleted = await request<{ ok: true }>(`/api/games/${created.body.id}/delete`, {
      method: 'POST',
      token: owner.body.token,
      body: { revision: finalTurn.body.game.revision },
    });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const library = await request<{ games: GameView[] }>('/api/games', {
      token: owner.body.token,
    });
    expect(library.body.games.map((game) => game.id)).not.toContain(created.body.id);
    const missing = await request<{ error: string }>(`/api/games/${created.body.id}`, {
      token: owner.body.token,
    });
    expect(missing.response.status).toBe(404);
    expect(missing.body.error).toBe('no_game');
  });

  it('keeps one member-only conversation from the lobby into the active game', async () => {
    const password = 'RouteTest@2026';
    const creator = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'chat-route-owner', password },
    });
    const other = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'chat-route-guest', password },
    });
    const created = await request<GameView>('/api/games', {
      method: 'POST',
      token: creator.body.token,
      body: { practice: false },
    });
    const gameId = created.body.id;

    const lobbyMessage = await request<ChatResult>(`/api/games/${gameId}/chat`, {
      method: 'POST',
      token: creator.body.token,
      body: { body: 'Welcome to the lobby!' },
    });
    expect(lobbyMessage.response.status).toBe(201);
    expect(lobbyMessage.body.message).toMatchObject({
      username: 'chat-route-owner',
      playerId: 'p1',
      body: 'Welcome to the lobby!',
    });

    const denied = await request<{ error: string }>(`/api/games/${gameId}/chat`, {
      method: 'POST',
      token: other.body.token,
      body: { body: 'Can I talk before joining?' },
    });
    expect(denied.response.status).toBe(403);
    expect(denied.body.error).toBe('no_seat');

    const joined = await request<GameResult>(`/api/games/${gameId}/join`, {
      method: 'POST',
      token: other.body.token,
      body: {},
    });
    expect(joined.body.game.chatMessages).toHaveLength(1);

    await request<ChatResult>(`/api/games/${gameId}/chat`, {
      method: 'POST',
      token: other.body.token,
      body: { body: 'Thanks — ready to play.' },
    });
    let latest = await request<GameView>(`/api/games/${gameId}`, {
      token: creator.body.token,
    });
    expect(latest.body.chatMessages.map((message) => message.body)).toEqual([
      'Welcome to the lobby!',
      'Thanks — ready to play.',
    ]);

    const creatorVote = await request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
      method: 'POST',
      token: creator.body.token,
      body: {
        healthRulesVersion: latest.body.healthRulesVersion,
        exerciseKeys: latest.body.exercises.map((exercise) => exercise.key),
      },
    });
    const guestVote = await request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
      method: 'POST',
      token: other.body.token,
      body: {
        healthRulesVersion: creatorVote.body.game.healthRulesVersion,
        exerciseKeys: creatorVote.body.game.exercises.map((exercise) => exercise.key),
      },
    });
    const started = await request<GameResult>(`/api/games/${gameId}/start`, {
      method: 'POST',
      token: creator.body.token,
      body: { revision: guestVote.body.game.revision },
    });
    expect(started.body.game.status).toBe('active');
    expect(started.body.game.chatMessages).toHaveLength(2);

    const activeMessage = await request<ChatResult>(`/api/games/${gameId}/chat`, {
      method: 'POST',
      token: creator.body.token,
      body: { body: 'The game has started.' },
    });
    expect(activeMessage.response.status).toBe(201);
    const guestView = await request<GameView>(`/api/games/${gameId}`, {
      token: other.body.token,
    });
    expect(guestView.body.chatMessages.map((message) => message.body)).toEqual([
      'Welcome to the lobby!',
      'Thanks — ready to play.',
      'The game has started.',
    ]);
  });

  it('replays mobile retries and exposes lifecycle and notification resources', async () => {
    const password = 'RouteTest@2026';
    const creator = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'mobile-route-owner', password },
    });
    const guest = await request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: { username: 'mobile-route-guest', password },
    });
    const createInput = { practice: false };
    const first = await request<GameView>('/api/games', {
      method: 'POST',
      token: creator.body.token,
      idempotencyKey: 'create-mobile-game-1',
      body: createInput,
    });
    const replay = await request<GameView>('/api/games', {
      method: 'POST',
      token: creator.body.token,
      idempotencyKey: 'create-mobile-game-1',
      body: createInput,
    });
    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(201);
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    const gameId = first.body.id;
    await request<GameResult>(`/api/games/${gameId}/join`, {
      method: 'POST',
      token: guest.body.token,
      idempotencyKey: 'join-mobile-game-1',
      body: {},
    });
    const games = await request<{ games: Array<{ id: string; status: string; inviteLink: string }> }>(
      '/api/games',
      { token: creator.body.token },
    );
    expect(games.body.games).toContainEqual(expect.objectContaining({
      id: gameId,
      status: 'setup',
      inviteLink: `/join/${gameId}`,
    }));

    const latest = await request<GameView>(`/api/games/${gameId}`, { token: creator.body.token });
    const guestSeat = latest.body.players.find((player) => player.name === 'mobile-route-guest')!.id;
    const removed = await request<GameResult>(`/api/games/${gameId}/members/${guestSeat}`, {
      method: 'DELETE',
      token: creator.body.token,
      idempotencyKey: 'remove-mobile-guest-1',
      body: { revision: latest.body.revision },
    });
    expect(removed.response.status).toBe(200);
    expect(removed.body.game.players).toHaveLength(1);

    const notifications = await request<{
      notifications: Array<{ type: string; title: string }>;
      unreadCount: number;
    }>('/api/notifications', { token: guest.body.token });
    expect(notifications.body.notifications).toContainEqual(expect.objectContaining({
      type: 'lobby_removed',
      title: 'Removed from lobby',
    }));
    expect(notifications.body.unreadCount).toBeGreaterThan(0);

    const inviteResponse = await fetch(`${baseUrl}/join/${gameId}`);
    expect(inviteResponse.status).toBe(200);
    expect(await inviteResponse.text()).toContain('Exercise Risk');
  });
});
