import { randomUUID } from 'node:crypto';

import { apnsConfigured, sendApnsNotification } from './apns.js';
import type {
  DeviceRegistration,
  GameRepository,
  NotificationType,
  UserNotification,
} from './repository.js';
import { TurnError } from './turnApi.js';

const DEVICE_TOKEN_RE = /^[A-Fa-f0-9]{32,256}$/;

interface NotifyInput {
  gameId?: string;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string;
  senderUserId?: string;
}

export class NotificationService {
  constructor(private readonly repo: GameRepository) {}

  get pushConfigured(): boolean {
    return apnsConfigured();
  }

  async registerIosDevice(
    userId: string,
    input: { token: unknown; environment: unknown },
  ): Promise<DeviceRegistration> {
    const token = String(input.token ?? '').trim();
    if (!DEVICE_TOKEN_RE.test(token)) {
      throw new TurnError('bad_device_token', 'Provide a valid APNs device token');
    }
    const environment = input.environment === 'production' ? 'production' : 'sandbox';
    const now = new Date().toISOString();
    return this.repo.upsertDeviceRegistration({
      id: randomUUID(),
      userId,
      platform: 'ios',
      token: token.toLowerCase(),
      environment,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
  }

  async notifyUsers(
    userIds: string[],
    input: NotifyInput,
  ): Promise<UserNotification[]> {
    const notifications: UserNotification[] = [];
    const deliveries: Array<Promise<void>> = [];
    for (const userId of [...new Set(userIds)]) {
      if (userId === input.senderUserId) continue;
      if (
        input.gameId &&
        input.senderUserId &&
        (await this.repo.listMutedUserIds(input.gameId, userId)).includes(input.senderUserId)
      ) continue;
      const notification: UserNotification = {
        id: randomUUID(),
        userId,
        gameId: input.gameId ?? null,
        type: input.type,
        title: input.title,
        body: input.body,
        deepLink: input.deepLink ?? null,
        createdAt: new Date().toISOString(),
        readAt: null,
      };
      await this.repo.saveNotification(notification);
      notifications.push(notification);
      const devices = await this.repo.listDeviceRegistrations(userId);
      deliveries.push(
        ...devices.map(async (device) => {
          const result = await sendApnsNotification(device, notification);
          if (result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
            await this.repo.deleteDeviceRegistration(device.id, userId);
          }
        }),
      );
    }
    await Promise.allSettled(deliveries);
    return notifications;
  }

  async notifyGameMembers(
    gameId: string,
    input: Omit<NotifyInput, 'gameId'>,
  ): Promise<UserNotification[]> {
    const users = (await this.repo.listMembers(gameId)).map((member) => member.userId);
    return this.notifyUsers(users, { ...input, gameId });
  }
}
