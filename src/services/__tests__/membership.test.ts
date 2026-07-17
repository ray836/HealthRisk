import { describe, it, expect } from 'vitest';
import { InMemoryGameRepository } from '../repository.js';
import { claimSeat, claimAllSeats, claimOpenSeat, seatFor } from '../membership.js';

const seats = ['p1', 'p2', 'p3'];

describe('membership', () => {
  it('claims a seat and reports it', async () => {
    const repo = new InMemoryGameRepository();
    await claimSeat(repo, 'g', 'p1', 'userA');
    expect(await seatFor(repo, 'g', 'userA')).toBe('p1');
    expect(await seatFor(repo, 'g', 'userB')).toBeNull();
  });

  it('rejects taking a seat someone else holds', async () => {
    const repo = new InMemoryGameRepository();
    await claimSeat(repo, 'g', 'p1', 'userA');
    await expect(claimSeat(repo, 'g', 'p1', 'userB')).rejects.toMatchObject({ code: 'seat_taken' });
  });

  it('rejects a user holding two seats', async () => {
    const repo = new InMemoryGameRepository();
    await claimSeat(repo, 'g', 'p1', 'userA');
    await expect(claimSeat(repo, 'g', 'p2', 'userA')).rejects.toMatchObject({ code: 'already_seated' });
  });

  it('claimOpenSeat fills seats in order, is idempotent, and fills up', async () => {
    const repo = new InMemoryGameRepository();
    expect(await claimOpenSeat(repo, 'g', seats, 'userA')).toBe('p1');
    expect(await claimOpenSeat(repo, 'g', seats, 'userB')).toBe('p2');
    // rejoin returns the same seat
    expect(await claimOpenSeat(repo, 'g', seats, 'userA')).toBe('p1');
    expect(await claimOpenSeat(repo, 'g', seats, 'userC')).toBe('p3');
    await expect(claimOpenSeat(repo, 'g', seats, 'userD')).rejects.toMatchObject({ code: 'game_full' });
  });

  it('claimAllSeats gives one user every seat (practice mode)', async () => {
    const repo = new InMemoryGameRepository();
    await claimAllSeats(repo, 'g', seats, 'solo');
    expect(await seatFor(repo, 'g', 'solo')).toBe('p1');
    for (const s of seats) expect((await repo.getMemberBySeat('g', s))!.userId).toBe('solo');
  });
});
