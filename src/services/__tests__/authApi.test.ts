import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { hashPassword, verifyPassword, signup, login, resolveToken, logout } from '../authApi.js';

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
    const { token, user } = await signup(repo, 'alice', 'hunter2');
    expect(user.username).toBe('alice');
    expect(await resolveToken(repo, token)).toMatchObject({ username: 'alice' });
  });

  it('rejects duplicate usernames and bad inputs', async () => {
    const repo = new InMemoryGameRepository();
    await signup(repo, 'alice', 'hunter2');
    await expect(signup(repo, 'alice', 'another')).rejects.toMatchObject({ code: 'username_taken' });
    await expect(signup(repo, 'a', 'hunter2')).rejects.toMatchObject({ code: 'bad_username' });
    await expect(signup(repo, 'bob', 'short')).rejects.toMatchObject({ code: 'bad_password' });
  });
});

describe('login / logout', () => {
  it('logs in with correct credentials, rejects wrong ones', async () => {
    const repo = new InMemoryGameRepository();
    await signup(repo, 'alice', 'hunter2');
    const { token } = await login(repo, 'alice', 'hunter2');
    expect(await resolveToken(repo, token)).toMatchObject({ username: 'alice' });
    await expect(login(repo, 'alice', 'nope')).rejects.toMatchObject({ code: 'bad_credentials' });
    await expect(login(repo, 'ghost', 'whatever')).rejects.toMatchObject({ code: 'bad_credentials' });
  });

  it('logout invalidates the token', async () => {
    const repo = new InMemoryGameRepository();
    const { token } = await signup(repo, 'alice', 'hunter2');
    await logout(repo, token);
    expect(await resolveToken(repo, token)).toBeNull();
  });

  it('resolveToken returns null for missing/blank tokens', async () => {
    const repo = new InMemoryGameRepository();
    expect(await resolveToken(repo, undefined)).toBeNull();
    expect(await resolveToken(repo, 'garbage')).toBeNull();
  });
});
