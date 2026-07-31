import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

import type { DeviceRegistration, UserNotification } from './repository.js';

interface ApnsConfig {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
}

export interface ApnsDeliveryResult {
  delivered: boolean;
  status?: number;
  reason?: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function configFromEnvironment(): ApnsConfig | null {
  const teamId = process.env.APNS_TEAM_ID ?? process.env.APPLE_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const bundleId = process.env.IOS_BUNDLE_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY?.replaceAll('\\n', '\n');
  return teamId && keyId && bundleId && privateKey
    ? { teamId, keyId, bundleId, privateKey }
    : null;
}

function providerToken(config: ApnsConfig, now = new Date()): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now.getTime() / 1000) }));
  const content = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(content), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${content}.${base64url(signature)}`;
}

/** Minimal APNs provider client; it stays disabled until Apple credentials exist. */
export async function sendApnsNotification(
  device: DeviceRegistration,
  notification: UserNotification,
): Promise<ApnsDeliveryResult> {
  const config = configFromEnvironment();
  if (!config || device.disabledAt) return { delivered: false, reason: 'not_configured' };
  const host = device.environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
  const payload = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      'thread-id': notification.gameId ?? 'account',
    },
    notificationId: notification.id,
    gameId: notification.gameId ?? undefined,
    deepLink: notification.deepLink ?? undefined,
  });

  return new Promise((resolve) => {
    const client = http2.connect(host);
    let settled = false;
    const finish = (result: ApnsDeliveryResult) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(result);
    };
    client.once('error', (error) => finish({ delivered: false, reason: error.message }));
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization: `bearer ${providerToken(config)}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let responseBody = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    request.on('data', (chunk) => {
      responseBody += chunk;
    });
    request.on('end', () => {
      let reason: string | undefined;
      try {
        reason = responseBody ? String(JSON.parse(responseBody).reason ?? '') : undefined;
      } catch {
        reason = responseBody || undefined;
      }
      finish({ delivered: status === 200, status, reason });
    });
    request.setTimeout(8_000, () => {
      request.close();
      finish({ delivered: false, reason: 'timeout' });
    });
    request.end(payload);
  });
}

export function apnsConfigured(): boolean {
  return configFromEnvironment() !== null;
}
