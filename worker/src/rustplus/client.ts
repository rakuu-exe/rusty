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
import { connect as tcpConnect } from 'node:net';
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

/**
 * How long to wait for a connection to complete before giving up on it.
 *
 * A rejected token produces no error and no close — the socket simply goes
 * quiet. Without this the client sits on a dead connection forever, never
 * emitting 'disconnected' and so never scheduling a retry, which is exactly
 * how it got stuck showing Disconnected while doing nothing about it.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * The error `ws` raises when the handshake is aborted mid-flight.
 *
 * Both close() and terminate() take this branch when readyState is CONNECTING
 * (ws/lib/websocket.js), and rustplus.js's disconnect() calls terminate(). So
 * the connect timeout above *causes* this error every time it fires. It says
 * nothing about the server and must not be reported as a socket failure.
 */
const ABORTED_HANDSHAKE = 'WebSocket was closed before the connection was established';

/** Long enough for a SYN/ACK across Europe, short enough not to stack up. */
const TCP_PROBE_TIMEOUT_MS = 10_000;

function timeoutFor(kind: string): number {
  return kind === 'getMap' ? MAP_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

/**
 * Bare TCP reachability check against the companion port.
 *
 * Aborting the handshake at 30s replaces the real network error with
 * ABORTED_HANDSHAKE, since the OS takes ~75s to report ETIMEDOUT on its own.
 * That left every failure looking identical. This recovers the distinction:
 *
 *   'open'        the port answers, so the refusal is above TCP -- a stale
 *                 token or a per-playerId throttle
 *   ETIMEDOUT     packets go nowhere; companion port firewalled or closed
 *   ECONNREFUSED  host is up but nothing is listening on that port
 *
 * It opens a raw socket and closes it without speaking Rust+, so it neither
 * authenticates nor spends anything against the per-playerId rate limit.
 */
function probeTcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const finish = (result: string): void => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => finish('ETIMEDOUT (no answer)'));
    socket.once('connect', () => finish('open'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
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

    /**
     * Node throws when an EventEmitter emits 'error' with no listener, taking
     * the whole process down. Rust servers reset connections routinely, so
     * this fired every few minutes in production and crash-looped the bot:
     *
     *   Error: read ECONNRESET
     *   Emitted 'error' event on RustPlusClient instance at: ...
     *
     * A default listener makes emitting safe regardless of what callers
     * subscribe to. Reconnection is driven by 'disconnected', which always
     * follows, so an error alone needs no other handling.
     */
    this.on('error', (error) => {
      logger.debug({ server: this.label, err: error.message }, 'Rust+ client error');
    });
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

      /**
       * Resolve once the socket is up, but do not leave the caller hanging if
       * it never is. app.start() awaits this, and a connection that never
       * settles used to block startup indefinitely — which is how the process
       * handlers ended up never being installed.
       */
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(
          { server: this.label },
          'first Rust+ connection did not complete; continuing and retrying in the background',
        );
        resolve();
      }, CONNECT_TIMEOUT_MS + 5_000);

      const onFirstConnect = () => {
        clearTimeout(startupTimer);
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

    // Set while tearing down a stalled handshake, so the resulting ws error is
    // recognised as ours rather than reported as a failure from the server.
    let abortingConnect = false;

    // A silently rejected connection never errors or closes, so give up on it
    // explicitly and let the normal backoff schedule another attempt.
    const connectTimer = setTimeout(() => {
      if (this.connected) return;

      // Ask TCP directly why, before discarding the attempt -- the answer is
      // what separates "port unreachable" from "token or throttle".
      void probeTcp(serverIp, appPort).then((reachability) => {
        logger.warn(
          { server: this.label, timeoutMs: CONNECT_TIMEOUT_MS, port: appPort, reachability },
          reachability === 'open'
            ? 'companion port answers but the Rust+ handshake never completed -- stale token or per-player throttle'
            : 'companion port is not reachable -- nothing to do with the token',
        );
      });

      abortingConnect = true;
      try {
        socket.disconnect();
      } catch {
        /* already gone */
      }
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    socket.on('connected', () => {
      clearTimeout(connectTimer);
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      logger.info({ server: this.label }, 'Rust+ connected');
      this.emit('connected');
    });

    socket.on('disconnected', () => {
      clearTimeout(connectTimer);
      const wasConnected = this.connected;
      this.connected = false;
      // A handshake we aborted ourselves was never a connection to lose.
      if (!abortingConnect) logger.warn({ server: this.label }, 'Rust+ disconnected');
      if (wasConnected) this.emit('disconnected', 'socket closed');
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      /**
       * Our own abort, echoed back. Reporting it as a socket error made every
       * failure look like the server had hung up on us, and rejected the
       * startup promise into a spurious 'failed to start server runtime'.
       */
      if (abortingConnect && error.message === ABORTED_HANDSHAKE) {
        logger.debug({ server: this.label }, 'stalled handshake torn down');
        return;
      }

      clearTimeout(connectTimer);
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
