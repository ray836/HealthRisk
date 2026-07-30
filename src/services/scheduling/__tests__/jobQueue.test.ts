import { describe, it, expect, vi, afterEach } from 'vitest';
import { InProcessJobQueue, PassiveJobQueue } from '../jobQueue.js';

afterEach(() => vi.useRealTimers());

describe('InProcessJobQueue', () => {
  it('fires the handler at the scheduled time, not before', async () => {
    vi.useFakeTimers();
    const q = new InProcessJobQueue();
    let fired: unknown = null;
    q.work('job', async (data) => { fired = data; });

    await q.schedule('job', new Date(Date.now() + 1000), { x: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toEqual({ x: 1 });
  });

  it('cancel prevents a scheduled job from firing', async () => {
    vi.useFakeTimers();
    const q = new InProcessJobQueue();
    let fired = false;
    q.work('job', async () => { fired = true; });

    const id = await q.schedule('job', new Date(Date.now() + 1000), {});
    await q.cancel(id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toBe(false);
  });

  it('runs a past-due job promptly', async () => {
    vi.useFakeTimers();
    const q = new InProcessJobQueue();
    let fired = false;
    q.work('job', async () => { fired = true; });

    await q.schedule('job', new Date(Date.now() - 5000), {}); // already past
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toBe(true);
  });

  it('keeps only one pending job for the same logical key', async () => {
    vi.useFakeTimers();
    const q = new InProcessJobQueue();
    const received: unknown[] = [];
    q.work('job', async (data) => { received.push(data); });

    const first = await q.schedule('job', new Date(Date.now() + 1000), { attempt: 1 }, 'same');
    const duplicate = await q.schedule('job', new Date(Date.now() + 2000), { attempt: 2 }, 'same');
    expect(duplicate).toBe(first);

    await vi.advanceTimersByTimeAsync(2500);
    expect(received).toEqual([{ attempt: 1 }]);
  });
});

describe('PassiveJobQueue', () => {
  it('records no resident work while returning stable logical ids', async () => {
    const q = new PassiveJobQueue();
    let fired = false;
    q.work('job', async () => {
      fired = true;
    });

    const first = await q.schedule('job', new Date(0), {}, 'same');
    const second = await q.schedule('job', new Date(0), {}, 'same');

    expect(first).toBe('passive:job:same');
    expect(second).toBe(first);
    expect(fired).toBe(false);
  });
});
