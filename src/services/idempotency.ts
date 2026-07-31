import { createHash } from 'node:crypto';

import type { GameRepository } from './repository.js';
import { TurnError } from './turnApi.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export interface IdempotentResponse<T = unknown> {
  status: number;
  body: T;
  replayed: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function requestHash(scope: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ scope, payload: stableValue(payload) }), 'utf8')
    .digest('hex');
}

/**
 * Execute a mutation once for a user-provided key. Native clients can retry an
 * interrupted request with the same key and receive the original JSON result.
 */
export async function executeIdempotent<T>(
  repo: GameRepository,
  input: {
    userId: string;
    scope: string;
    key?: string;
    payload: unknown;
    now?: Date;
  },
  action: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResponse<T>> {
  if (!input.key) {
    const response = await action();
    return { ...response, replayed: false };
  }
  if (!IDEMPOTENCY_KEY_RE.test(input.key)) {
    throw new TurnError(
      'bad_idempotency_key',
      'Idempotency-Key must be 8–128 letters, digits, dots, colons, underscores, or hyphens',
    );
  }

  const now = input.now ?? new Date();
  const hash = requestHash(input.scope, input.payload);
  const reserved = await repo.reserveIdempotency({
    userId: input.userId,
    scope: input.scope,
    key: input.key,
    requestHash: hash,
    responseStatus: null,
    responseBody: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
  });

  if (!reserved) {
    const existing = await repo.getIdempotency(input.userId, input.scope, input.key);
    if (existing && Date.parse(existing.expiresAt) <= now.getTime()) {
      await repo.deleteIdempotency(input.userId, input.scope, input.key);
      return executeIdempotent(repo, input, action);
    }
    if (!existing || existing.requestHash !== hash) {
      throw new TurnError(
        'idempotency_conflict',
        'That Idempotency-Key was already used for a different request',
      );
    }
    if (existing.responseStatus == null) {
      throw new TurnError(
        'idempotency_in_progress',
        'That request is still being processed; retry shortly with the same key',
      );
    }
    return {
      status: existing.responseStatus,
      body: existing.responseBody as T,
      replayed: true,
    };
  }

  try {
    const response = await action();
    await repo.completeIdempotency(
      input.userId,
      input.scope,
      input.key,
      response.status,
      response.body,
    );
    return { ...response, replayed: false };
  } catch (error) {
    await repo.deleteIdempotency(input.userId, input.scope, input.key);
    throw error;
  }
}
