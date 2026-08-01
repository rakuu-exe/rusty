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

import { describe, expect, it, vi } from 'vitest';

vi.mock('@liamcottle/rustplus.js', () => {
  const { EventEmitter } = require('node:events');
  class FakeRustPlus extends EventEmitter {
    connect() {}
    disconnect() {}
    isConnected() {
      return false;
    }
  }
  return { default: FakeRustPlus };
});

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
