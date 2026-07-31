import { describe, expect, it, vi } from 'vitest';

import { createApiClient, type ApiFetch } from '../../../public/api-client.js';

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
  };
}

describe('HealthRisk API client', () => {
  it('uses a configurable base URL, cookie credentials, and bearer authentication', async () => {
    const fetch = vi.fn<ApiFetch>(async () =>
      response(200, { user: { id: 'u1', username: 'ray' } }));
    const api = createApiClient({
      baseUrl: 'https://health-risk.example/',
      token: 'native-session-token',
      credentials: 'include',
      fetch,
    });

    const result = await api.me();

    expect(result.user?.username).toBe('ray');
    expect(fetch).toHaveBeenCalledWith(
      'https://health-risk.example/api/auth/me',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        headers: expect.objectContaining({
          accept: 'application/json',
          authorization: 'Bearer native-session-token',
        }),
      }),
    );
  });

  it('adds a game revision without mutating the caller payload', async () => {
    const fetch = vi.fn<ApiFetch>(async () => response(200, { game: { id: 'game-1' } }));
    const api = createApiClient({ fetch });
    const payload = { exerciseKey: 'running', units: 2 };

    await api.post('/api/games/game-1/exercise', payload, { revision: 7 });

    expect(payload).toEqual({ exerciseKey: 'running', units: 2 });
    const init = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({
      exerciseKey: 'running',
      units: 2,
      revision: 7,
    });
  });

  it('sends chat independently from game revision state', async () => {
    const fetch = vi.fn<ApiFetch>(async () => response(201, {
      message: { id: 'chat-1', body: 'Hello team' },
    }));
    const api = createApiClient({ fetch });

    await api.sendChatMessage('game-1', 'Hello team');

    expect(fetch).toHaveBeenCalledWith(
      '/api/games/game-1/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'Hello team' }),
      }),
    );
  });

  it('normalizes server failures and refreshes after a stale revision', async () => {
    const onStaleGame = vi.fn(async () => undefined);
    const api = createApiClient({
      fetch: (async () =>
        response(409, {
          error: 'stale_game',
          message: 'The game changed in another browser',
        })) as ApiFetch,
      onStaleGame,
    });

    const result = api.post('/api/games/game-1/attack', {}, { revision: 4 });

    await expect(result).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'stale_game',
      message: 'The game changed in another browser',
      isStaleGame: true,
    });
    expect(onStaleGame).toHaveBeenCalledOnce();
  });

  it('distinguishes unreachable servers from API responses', async () => {
    const api = createApiClient({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as ApiFetch,
    });

    await expect(api.get('/api/health')).rejects.toEqual(
      expect.objectContaining({
        name: 'ApiError',
        status: 0,
        code: 'network_error',
        message: 'Unable to reach the HealthRisk server.',
      }),
    );
  });
});
