import { describe, expect, it } from 'vitest';

import { InMemoryGameRepository } from '../repository.js';

describe('GameRepository game lock', () => {
  it('serializes concurrent operations for the same game', async () => {
    const repo = new InMemoryGameRepository();
    const sequence: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstIsRunning = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = repo.withGameLock('g', async () => {
      sequence.push('first:start');
      firstEntered();
      await holdFirst;
      sequence.push('first:end');
    });
    await firstIsRunning;

    const second = repo.withGameLock('g', async () => {
      sequence.push('second');
    });
    await Promise.resolve();
    expect(sequence).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(sequence).toEqual(['first:start', 'first:end', 'second']);
  });
});
