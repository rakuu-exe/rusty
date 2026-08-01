/**
 * Rust+ pairing over Firebase Cloud Messaging.
 *
 * Linking cannot start in game. The Rust+ API only exposes the *already-paired*
 * player's team chat, so the bot is deaf until it holds a playerToken for the
 * server -- which is exactly what pairing produces. The order therefore has to
 * be:
 *
 *   1. Obtain FCM credentials once, via `npm run fcm-register` (Chrome + Steam
 *      login). This writes rustplus.config.json.
 *   2. Hand those credentials to the bot; it stores them encrypted and opens a
 *      push listener.
 *   3. In game: Esc -> Rust+ -> "Pair with Server". Facepunch pushes a
 *      notification containing ip, port, playerId and playerToken.
 *   4. This module catches it, saves the server, and the worker connects.
 *
 * Only after that do in-game commands work.
 */

import { EventEmitter } from 'node:events';
// Explicit .js extension: Node's ESM resolver requires it for a deep import,
// even though bundler-style resolution (and therefore tsx) works without.
import PushReceiverClient, { type PushNotificationData } from '@liamcottle/push-receiver/src/client.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { PairingNotification } from './types.js';

/**
 * Shape of rustplus.config.json as written by `rustplus.js fcm-register`.
 * Only the gcm credentials are needed to receive pushes; the rest is kept so
 * the whole blob can be round-tripped through storage.
 */
export const fcmCredentialsSchema = z.object({
  fcm_credentials: z.object({
    fcm: z.object({ token: z.string() }).passthrough(),
    gcm: z
      .object({
        androidId: z.union([z.string(), z.number()]).transform(String),
        securityToken: z.union([z.string(), z.number()]).transform(String),
      })
      .passthrough(),
  }).passthrough(),
  expo_push_token: z.string().optional(),
  rustplus_auth_token: z.string().optional(),
});

export type FcmCredentials = z.infer<typeof fcmCredentialsSchema>;

/** Payload carried in the `body` entry of a pairing push. */
const pairingBodySchema = z.object({
  type: z.string(),
  ip: z.string(),
  port: z.union([z.string(), z.number()]).transform(String),
  playerId: z.union([z.string(), z.number()]).transform(String),
  playerToken: z.union([z.string(), z.number()]).transform(String),
  name: z.string().default('Rust Server'),
  desc: z.string().optional(),
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  entityType: z.union([z.string(), z.number()]).transform(String).optional(),
});

/**
 * The Steam auth token behind FCM registration expires two weeks after it is
 * issued. Past that, pairing pushes stop arriving with no other symptom, so
 * the expiry is tracked explicitly and surfaced in Discord.
 */
export const STEAM_TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** Warn this far ahead of expiry so there is time to re-register. */
export const STEAM_TOKEN_WARN_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;

export function steamTokenExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + STEAM_TOKEN_LIFETIME_MS);
}

export function isSteamTokenExpiring(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() - now.getTime() <= STEAM_TOKEN_WARN_AHEAD_MS;
}

export interface PairingListenerEvents {
  /** A server pairing notification, ready to be persisted. */
  serverPaired: [notification: PairingNotification];
  /** A smart device pairing -- captured but unused in v1. */
  entityPaired: [notification: PairingNotification];
  error: [error: Error];
}

/**
 * Listens for Rust+ pairing pushes.
 *
 * Notifications carry a persistentId which FCM re-delivers on reconnect; those
 * ids are tracked so re-pairing is not announced twice after a restart.
 */
export class PairingListener extends EventEmitter<PairingListenerEvents> {
  private client: PushReceiverClient | null = null;
  private readonly seenPersistentIds = new Set<string>();

  constructor(private readonly credentials: FcmCredentials) {
    super();
  }

  async start(): Promise<void> {
    const { androidId, securityToken } = this.credentials.fcm_credentials.gcm;

    const client = new PushReceiverClient(androidId, securityToken, [...this.seenPersistentIds]);
    this.client = client;

    client.on('ON_DATA_RECEIVED', (data) => this.handleNotification(data));
    client.on('connect', () => logger.info('FCM pairing listener connected'));
    client.on('disconnect', () => logger.warn('FCM pairing listener disconnected'));

    await client.connect();
  }

  stop(): void {
    try {
      this.client?.destroy();
    } catch (error) {
      logger.debug({ err: error }, 'error closing FCM listener');
    }
    this.client = null;
  }

  private handleNotification(data: PushNotificationData): void {
    if (data.persistentId) {
      if (this.seenPersistentIds.has(data.persistentId)) return;
      this.seenPersistentIds.add(data.persistentId);
    }

    const body = data.appData.find((entry) => entry.key === 'body')?.value;
    if (!body) return;

    // Rust+ sends several push channels (pairing, alarm, team, player) down the
    // same connection; anything that is not a pairing payload is ignored rather
    // than treated as malformed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      logger.debug('ignoring non-JSON push payload');
      return;
    }

    const result = pairingBodySchema.safeParse(parsed);
    if (!result.success) {
      logger.debug('ignoring push that is not a pairing notification');
      return;
    }

    const notification: PairingNotification = result.data;
    logger.info({ type: notification.type, name: notification.name }, 'received pairing notification');

    if (notification.type === 'server') {
      this.emit('serverPaired', notification);
    } else {
      this.emit('entityPaired', notification);
    }
  }
}

/** Parse and validate a rustplus.config.json blob supplied by the user. */
export function parseFcmCredentials(raw: string): FcmCredentials {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('That is not valid JSON. Paste the entire contents of rustplus.config.json.');
  }

  const result = fcmCredentialsSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      'Those credentials are missing fcm_credentials.gcm.androidId / securityToken. ' +
        'Re-run `npm run fcm-register` and paste the whole file.',
    );
  }

  return result.data;
}
