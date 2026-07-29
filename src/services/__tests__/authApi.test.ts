import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import {
  hashPassword,
  logout,
  login,
  resolveToken,
  sessionTokenHash,
  signup,
  verifyPassword,
} from '../authApi.js';

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toContain(':');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('signup', () => {
  it('creates a user and returns a working token', async () => {
    const repo = new InMemoryGameRepository();
    const { token, user } = await signup(repo, 'alice', 'hunter22');
    expect(user.username).toBe('alice');
    expect(await resolveToken(repo, token)).toMatchObject({ username: 'alice' });
    expect(await repo.getToken(token)).toBeNull();
    expect(await repo.getToken(sessionTokenHash(token))).toMatchObject({
      userId: user.id,
    });
  });

  it('allows hyphens and underscores in usernames', async () => {
    const repo = new InMemoryGameRepository();
    await expect(signup(repo, 'ray-player_1', 'hunter22')).resolves.toMatchObject({
      user: { username: 'ray-player_1' },
    });
  });

  it('rejects duplicate usernames and bad inputs', async () => {
    const repo = new InMemoryGameRepository();
    await signup(repo, 'alice', 'hunter22');
    await expect(signup(repo, 'alice', 'another1')).rejects.toMatchObject({ code: 'username_taken' });
    await expect(signup(repo, 'a', 'hunter22')).rejects.toMatchObject({ code: 'bad_username' });
    await expect(signup(repo, 'bob', 'short')).rejects.toMatchObject({ code: 'bad_password' });
  });
});

describe('login / logout', () => {
  it('logs in with correct credentials, rejects wrong ones', async () => {
    const repo = new InMemoryGameRepository();
    await signup(repo, 'alice', 'hunter22');
    const { token } = await login(repo, 'alice', 'hunter22');
    expect(await resolveToken(repo, token)).toMatchObject({ username: 'alice' });
    await expect(login(repo, 'alice', 'nope')).rejects.toMatchObject({ code: 'bad_credentials' });
    await expect(login(repo, 'ghost', 'whatever')).rejects.toMatchObject({ code: 'bad_credentials' });
  });

  it('logout invalidates the token', async () => {
    const repo = new InMemoryGameRepository();
    const { token } = await signup(repo, 'alice', 'hunter22');
    await logout(repo, token);
    expect(await resolveToken(repo, token)).toBeNull();
  });

  it('resolveToken returns null for missing/blank tokens', async () => {
    const repo = new InMemoryGameRepository();
    expect(await resolveToken(repo, undefined)).toBeNull();
    expect(await resolveToken(repo, 'garbage')).toBeNull();
  });

  it('rejects and removes an expired session', async () => {
    const repo = new InMemoryGameRepository();
    const { user } = await signup(repo, 'alice', 'hunter22');
    const token = 'expired-raw-token';
    const tokenHash = sessionTokenHash(token);
    await repo.createToken({
      tokenHash,
      userId: user.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });

    expect(await resolveToken(repo, token, new Date('2026-01-03T00:00:00.000Z'))).toBeNull();
    expect(await repo.getToken(tokenHash)).toBeNull();
  });
});
