/**
 * Shared HealthRisk HTTP client.
 *
 * This file is deliberately build-free so the current browser can load it
 * directly. Its adjacent .d.ts file makes the same client typed for a future
 * Capacitor application.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized() {
    return this.status === 401 || this.status === 403;
  }

  get isStaleGame() {
    return this.code === 'stale_game';
  }
}

function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function apiUrl(baseUrl, path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createApiClient(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('A fetch implementation is required');

  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const credentials = options.credentials ?? 'same-origin';
  let token = options.token ?? null;

  const currentToken = () => options.getToken?.() ?? token;

  async function request(path, requestOptions = {}) {
    const method = requestOptions.method ?? 'GET';
    const headers = {
      accept: 'application/json',
      ...(requestOptions.headers ?? {}),
    };
    const bearerToken = currentToken();
    if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

    let body = requestOptions.body;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(apiUrl(baseUrl, path), {
        method,
        headers,
        credentials,
        body,
        signal: requestOptions.signal,
      });
    } catch (cause) {
      throw new ApiError('Unable to reach the HealthRisk server.', {
        code: 'network_error',
        details: cause,
      });
    }

    const data = await responseBody(response);
    if (!response.ok) {
      const objectData = data && typeof data === 'object' ? data : null;
      const error = new ApiError(
        objectData?.message || objectData?.error || (typeof data === 'string' ? data : 'Request failed'),
        {
          status: response.status,
          code: objectData?.error || `http_${response.status}`,
          details: data,
        },
      );
      if (error.isStaleGame) await options.onStaleGame?.(error);
      throw error;
    }
    return data;
  }

  function get(path, requestOptions = {}) {
    return request(path, { ...requestOptions, method: 'GET' });
  }

  function post(path, body, requestOptions = {}) {
    const payload =
      requestOptions.revision === undefined
        ? body
        : { ...(body ?? {}), revision: requestOptions.revision };
    return request(path, { ...requestOptions, method: 'POST', body: payload });
  }

  return {
    get baseUrl() {
      return baseUrl;
    },
    setToken(value) {
      token = value || null;
    },
    request,
    get,
    post,
    me: () => get('/api/auth/me'),
    login: (credentialsBody) => post('/api/auth/login', credentialsBody),
    signup: (credentialsBody) => post('/api/auth/signup', credentialsBody),
    logout: () => post('/api/auth/logout'),
    getGame: (gameId) => get(`/api/games/${encodeURIComponent(gameId)}`),
    createGame: (input) => post('/api/games', input),
    joinGame: (gameId) => post(`/api/games/${encodeURIComponent(gameId)}/join`),
    sendChatMessage: (gameId, body) =>
      post(`/api/games/${encodeURIComponent(gameId)}/chat`, { body }),
    logHealthProgress: (gameId, input, revision) =>
      post(`/api/games/${encodeURIComponent(gameId)}/exercise`, input, { revision }),
  };
}
