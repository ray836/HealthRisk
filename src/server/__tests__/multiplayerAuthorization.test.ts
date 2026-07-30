import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface AuthResult {
  token: string;
}

interface GameView {
  id: string;
  revision: number;
  status: string;
  isCreator: boolean;
  currentPlayerId: string | null;
  mySeats: string[];
  nextSessionOpensAt: string | null;
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
  pendingHealthRuleProposal?: unknown;
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

let server: Server;
let baseUrl: string;

async function request<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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
    const gameId = created.body.id;
    await request<GameResult>(`/api/games/${gameId}/join`, {
      method: 'POST',
      token: other.body.token,
      body: {},
    });
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
    expect(denied.response.status).toBe(400);
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
        revision: latest.body.revision,
        exerciseKeys: latest.body.exercises.map((exercise) => exercise.key),
      },
    });
    const guestVote = await request<GameResult>(`/api/games/${gameId}/lobby-health-votes`, {
      method: 'POST',
      token: other.body.token,
      body: {
        revision: creatorVote.body.game.revision,
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
});
