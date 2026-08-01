/**
 * Promise-shaped wrapper around @liamcottle/rustplus.js.
 *
 * Adds the three things the raw library leaves to the caller and that a
 * long-lived bot cannot do without:
 *
 *  1. Reconnection. Rust servers restart constantly (wipes, crashes, monthly
 *     forced restarts). Without backoff the bot silently stops reporting.
 *  2. Rate limiting. Every request goes through a token bucket mirroring
 *     Facepunch's own, so a burst of getMap + getMapMarkers cannot trip it.
 *  3. Timeouts. The underlying callbacks never fire if the socket half-closes,
 *     which would otherwise leak a pending promise per poll.
 */

import { EventEmitter } from 'node:events';
import RustPlus, { type AppMessage } from '@liamcottle/rustplus.js';
import { logger } from '../logger.js';
import { RateLimitedQueue, TokenBucketRateLimiter } from './rateLimiter.js';
import type { RustMapInfo, RustMapMarker, RustServerInfo, RustTeamMessage, RustTime } from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * getMap returns the full map JPEG inline, which is several megabytes on a
 * 4000-size map. 15s was not enough against a live server and the request
 * timed out before monuments could be cached, so it gets its own budget.
 */
const MAP_REQUEST_TIMEOUT_MS = 90_000;

const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function timeoutFor(kind: string): number {
  return kind === 'getMap' ? MAP_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

export interface RustPlusClientOptions {
  serverIp: string;
  appPort: number;
  playerId: string;
  playerToken: string;
  /** Label used in logs; the server's display name. */
  label?: string;
}

export interface RustPlusClientEvents {
  connected: [];
  disconnected: [reason: string];
  teamMessage: [message: RustTeamMessage];
  error: [error: Error];
}

export class RustPlusError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'api' | 'disconnected',
  ) {
    super(message);
    this.name = 'RustPlusError';
  }
}

export class RustPlusClient extends EventEmitter<RustPlusClientEvents> {
  private socket: RustPlus | null = null;
  private readonly queue: RateLimitedQueue;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private shuttingDown = false;
  private connected = false;

  constructor(private readonly options: RustPlusClientOptions) {
    super();
    this.queue = new RateLimitedQueue(new TokenBucketRateLimiter());
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get label(): string {
    return this.options.label ?? `${this.options.serverIp}:${this.options.appPort}`;
  }

  /**
   * Open the socket and keep it open. Resolves on the first successful
   * connection; later drops are handled transparently via `disconnected` /
   * `connected` events rather than by rejecting.
   */
  connect(): Promise<void> {
    this.shuttingDown = false;

    return new Promise((resolve, reject) => {
      let settled = false;

      const onFirstConnect = () => {
        settled = true;
        resolve();
      };
      const onFirstFailure = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      this.once('connected', onFirstConnect);
      this.openSocket(onFirstFailure);
    });
  }

  private openSocket(onFirstFailure?: (error: Error) => void): void {
    const { serverIp, appPort, playerId, playerToken } = this.options;
    const socket = new RustPlus(serverIp, appPort, playerId, playerToken);
    this.socket = socket;

    socket.on('connected', () => {
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      logger.info({ server: this.label }, 'Rust+ connected');
      this.emit('connected');
    });

    socket.on('disconnected', () => {
      const wasConnected = this.connected;
      this.connected = false;
      logger.warn({ server: this.label }, 'Rust+ disconnected');
      if (wasConnected) this.emit('disconnected', 'socket closed');
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      logger.error({ server: this.label, err: error.message }, 'Rust+ socket error');
      this.emit('error', error);
      onFirstFailure?.(error);
      // 'disconnected' follows an 'error', which is where reconnect is scheduled.
    });

    socket.on('message', (message: AppMessage) => {
      const teamMessage = message.broadcast?.teamMessage?.message;
      if (!teamMessage) return;

      this.emit('teamMessage', {
        steamId: String(teamMessage.steamId),
        name: teamMessage.name,
        message: teamMessage.message,
        color: teamMessage.color,
        time: teamMessage.time,
      });
    });

    socket.connect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;

    const delay = this.backoffMs;
    // Jitter keeps a fleet of reconnects from synchronising after a server
    // restart, and costs nothing for a single bot.
    const jittered = delay + Math.floor(Math.random() * 1000);
    logger.info({ server: this.label, delayMs: jittered }, 'scheduling Rust+ reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.openSocket();
    }, jittered);
  }

  /** Close the socket and stop reconnecting. */
  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    try {
      this.socket?.disconnect();
    } catch (error) {
      logger.debug({ err: error }, 'error while closing Rust+ socket');
    }
    this.socket = null;
  }

  /**
   * Issue a request through the rate limiter, with a timeout.
   *
   * `kind` selects the token cost, so callers must pass the real method name.
   */
  private request<T>(kind: string, invoke: (socket: RustPlus, done: (message: AppMessage) => void) => void, extract: (message: AppMessage) => T): Promise<T> {
    return this.queue.run(kind, () => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        return Promise.reject(new RustPlusError(`Not connected to ${this.label}`, 'disconnected'));
      }

      const timeoutMs = timeoutFor(kind);

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new RustPlusError(`${kind} timed out after ${timeoutMs}ms`, 'timeout'));
        }, timeoutMs);

        invoke(socket, (message) => {
          clearTimeout(timer);

          const apiError = message.response?.error?.error;
          if (apiError) {
            reject(new RustPlusError(`${kind} failed: ${apiError}`, 'api'));
            return;
          }

          try {
            resolve(extract(message));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    });
  }

  getInfo(): Promise<RustServerInfo> {
    return this.request(
      'getInfo',
      (socket, done) => socket.getInfo((m) => void done(m)),
      (m) => m.response?.info as RustServerInfo,
    );
  }

  getTime(): Promise<RustTime> {
    return this.request(
      'getTime',
      (socket, done) => socket.getTime((m) => void done(m)),
      (m) => m.response?.time as RustTime,
    );
  }

  /** Costs 5 tokens -- call once per connection/wipe, never per poll. */
  getMap(): Promise<RustMapInfo> {
    return this.request(
      'getMap',
      (socket, done) => socket.getMap((m) => void done(m)),
      (m) => m.response?.map as RustMapInfo,
    );
  }

  getMapMarkers(): Promise<RustMapMarker[]> {
    return this.request(
      'getMapMarkers',
      (socket, done) => socket.getMapMarkers((m) => void done(m)),
      (m) => (m.response?.mapMarkers?.markers ?? []) as RustMapMarker[],
    );
  }

  /** Costs 2 tokens. Only the paired player's team can see the result. */
  sendTeamMessage(message: string): Promise<void> {
    return this.request(
      'sendTeamMessage',
      (socket, done) => socket.sendTeamMessage(message, (m) => void done(m)),
      () => undefined,
    );
  }
}
