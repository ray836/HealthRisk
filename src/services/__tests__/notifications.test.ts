import { describe, expect, it } from 'vitest';

import { NotificationService } from '../notifications.js';
import { InMemoryGameRepository } from '../repository.js';

describe('mobile notifications', () => {
  it('registers iOS devices and keeps a durable notification inbox without APNs credentials', async () => {
    const repo = new InMemoryGameRepository();
    const service = new NotificationService(repo);
    const device = await service.registerIosDevice('u1', {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
    });

    expect(device).toMatchObject({ userId: 'u1', platform: 'ios', environment: 'sandbox' });
    expect(service.pushConfigured).toBe(false);
    await service.notifyUsers(['u1'], {
      gameId: 'g1',
      type: 'turn_started',
      title: 'Your move',
      body: 'The board is ready.',
      deepLink: '/game/g1',
    });

    expect(await repo.listNotifications('u1')).toEqual([
      expect.objectContaining({ type: 'turn_started', gameId: 'g1', readAt: null }),
    ]);
  });

  it('does not create chat notifications from a muted sender', async () => {
    const repo = new InMemoryGameRepository();
    const service = new NotificationService(repo);
    await repo.setChatMute('g1', 'recipient', 'sender', new Date().toISOString());

    await service.notifyUsers(['recipient'], {
      gameId: 'g1',
      type: 'chat_message',
      title: 'Sender',
      body: 'Hidden',
      senderUserId: 'sender',
    });

    expect(await repo.listNotifications('recipient')).toEqual([]);
  });
});
