/**
 * Authentication: user accounts + bearer-token sessions.
 *
 * Passwords are hashed with scrypt (built-in node:crypto) using a per-user salt;
 * verification is constant-time. Sessions are opaque random bearer tokens stored
 * in the repository, so they persist and can be revoked (logout). No new deps.
 *
 * Identity stops here — the engine has no concept of a user. Membership.ts maps
 * users to the seats they control.
 */

import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { GameRepository, User } from './repository.js';
import { TurnError } from './turnApi.js';

const scrypt = promisify(scryptCb);
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface PublicUser {
  id: string;
  username: string;
}
const toPublic = (u: User): PublicUser => ({ id: u.id, username: u.username });

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

export async function signup(
  repo: GameRepository,
  username: string,
  password: string,
): Promise<{ token: string; user: PublicUser }> {
  if (!USERNAME_RE.test(username)) {
    throw new TurnError('bad_username', 'Username must be 3–24 letters, digits, underscores, or hyphens');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new TurnError('bad_password', 'Password must be at least 6 characters');
  }
  if (await repo.getUserByUsername(username)) {
    throw new TurnError('username_taken', 'That username is taken');
  }
  const user: User = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await repo.createUser(user);
  return { token: await issueToken(repo, user.id), user: toPublic(user) };
}

export async function login(
  repo: GameRepository,
  username: string,
  password: string,
): Promise<{ token: string; user: PublicUser }> {
  const user = await repo.getUserByUsername(username);
  // Verify even when the user is missing, to avoid leaking which usernames exist.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, `x:${'0'.repeat(128)}`);
  if (!user || !ok) throw new TurnError('bad_credentials', 'Invalid username or password');
  return { token: await issueToken(repo, user.id), user: toPublic(user) };
}

async function issueToken(repo: GameRepository, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await repo.createToken({ token, userId, createdAt: new Date().toISOString() });
  return token;
}

/** Resolve a bearer token to its user, or null. */
export async function resolveToken(repo: GameRepository, token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;
  const record = await repo.getToken(token);
  if (!record) return null;
  const user = await repo.getUserById(record.userId);
  return user ? toPublic(user) : null;
}

export async function logout(repo: GameRepository, token: string | undefined): Promise<void> {
  if (token) await repo.deleteToken(token);
}
