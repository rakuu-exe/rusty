/**
 * The crash-loop regression.
 *
 * Node throws when an EventEmitter emits 'error' with no listener attached.
 * RustPlusClient emits 'error' on every socket failure, and Rust servers reset
 * connections routinely, so in production this killed the process every few
 * minutes:
 *
 *   Error: read ECONNRESET
 *   Emitted 'error' event on RustPlusClient instance at: ...
 *
 * It was survivable in theory because of the uncaughtException handler, except
 * that handler was registered *after* app.start(), which blocks on the first
 * Rust+ connection. A socket error during startup therefore hit a process with
 * no handler at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ABORTED_HANDSHAKE = 'WebSocket was closed before the connection was established';

vi.mock('@liamcottle/rustplus.js', () => {
  const { EventEmitter } = require('node:events');
  const sockets: EventEmitter[] = ((globalThis as Record<string, unknown>).__sockets ??= []) as EventEmitter[];

  class FakeRustPlus extends EventEmitter {
    constructor() {
      super();
      sockets.push(this);
    }
    connect() {}
    /**
     * Mirrors the real thing: rustplus.js disconnect() calls ws terminate(),
     * and terminate() on a CONNECTING socket aborts the handshake, which emits
     * an error carrying exactly this message before closing.
     */
    disconnect() {
      this.emit('error', new Error(ABORTED_HANDSHAKE));
      this.emit('disconnected');
    }
    isConnected() {
      return false;
    }
  }
  return { default: FakeRustPlus };
});

// The reachability probe must not touch the network from a test.
vi.mock('node:net', () => ({
  connect: () => {
    const { EventEmitter } = require('node:events');
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      destroy: () => void;
    };
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return socket;
  },
}));

const { RustPlusClient } = await import('../src/rustplus/client.js');

function client() {
  return new RustPlusClient({
    serverIp: '127.0.0.1',
    appPort: 28082,
    playerId: '765611980000000000',
    playerToken: 'token',
    label: 'Test Server',
  });
}

describe('RustPlusClient error handling', () => {
  it('does not throw when emitting an error nobody listens for', () => {
    // The exact production crash: a socket error with no subscriber.
    const c = client();
    expect(() => c.emit('error', new Error('read ECONNRESET'))).not.toThrow();
  });

  it('survives repeated errors, as a flapping server produces', () => {
    const c = client();
    for (let i = 0; i < 20; i++) {
      expect(() => c.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    }
  });

  it('still delivers errors to a caller that does subscribe', () => {
    // The default listener must not swallow the event.
    const c = client();
    const seen: Error[] = [];
    c.on('error', (e) => seen.push(e));

    c.emit('error', new Error('boom'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe('boom');
  });

  it('reports not connected before connecting', () => {
    expect(client().isConnected).toBe(false);
  });
});

describe('stalled handshake teardown', () => {
  function sockets(): { emit(event: string, ...args: unknown[]): boolean }[] {
    return ((globalThis as Record<string, unknown>).__sockets ??= []) as {
      emit(event: string, ...args: unknown[]): boolean;
    }[];
  }

  beforeEach(() => {
    sockets().length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The connect timeout tears down a handshake that never completed, and ws
   * answers that teardown with an 'error'. Reporting it made every failure
   * look like the server had hung up, and rejected the startup promise into a
   * spurious 'failed to start server runtime' -- which is what the production
   * logs showed on every single retry, obscuring the real cause.
   */
  it('does not report its own abort as a socket error', async () => {
    const c = client();
    const seen: Error[] = [];
    c.on('error', (e) => seen.push(e));

    void c.connect();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(seen).toHaveLength(0);
  });

  it('resolves the startup promise rather than rejecting it', async () => {
    const c = client();
    const connecting = c.connect();

    await vi.advanceTimersByTimeAsync(36_000);

    await expect(connecting).resolves.toBeUndefined();
  });

  it('still reports a genuine socket error', async () => {
    const c = client();
    const seen: Error[] = [];
    c.on('error', (e) => seen.push(e));

    // A genuine failure still rejects the startup promise, by design.
    c.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    sockets()[0]!.emit('error', new Error('read ECONNRESET'));

    expect(seen.map((e) => e.message)).toEqual(['read ECONNRESET']);
  });

  it('keeps retrying after an aborted handshake', async () => {
    const c = client();
    void c.connect();

    // First attempt, its abort at 30s, and the backoff reconnect after it.
    await vi.advanceTimersByTimeAsync(35_000);

    expect(sockets().length).toBeGreaterThan(1);
  });
});
