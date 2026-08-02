/**
 * The half-open socket.
 *
 * A Rust+ connection can stay established at the TCP level while the server
 * stops answering. ws reports neither an error nor a close for that, so the
 * client's own reconnect loop -- which is driven entirely by those two events
 * -- never runs. isConnected stays true, /status stays green, and every
 * marker poll times out.
 *
 * Before the watchdog the poller simply backed off to a minute between
 * attempts and retried against a dead socket indefinitely. These tests pin
 * down that it now gives up on the socket and forces a reconnect instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkerPoller } from '../src/events/poller.js';
import type { EventDetector } from '../src/events/detector.js';
import type { RustPlusClient } from '../src/rustplus/client.js';

const INTERVAL_MS = 5_000;

/** A client that answers every poll the way a half-open socket does. */
function stalledClient(): RustPlusClient & { reconnects: string[] } {
  const reconnects: string[] = [];
  return {
    isConnected: true,
    getMapMarkers: () => Promise.reject(new Error('getMapMarkers timed out after 15000ms')),
    reconnect: (reason: string) => void reconnects.push(reason),
    reconnects,
  } as unknown as RustPlusClient & { reconnects: string[] };
}

const detector = { update: () => [] } as unknown as EventDetector;

function poller(client: RustPlusClient): MarkerPoller {
  const p = new MarkerPoller(client, detector, INTERVAL_MS);
  // Failures are emitted as 'error'; an EventEmitter with no listener throws.
  p.on('error', () => {});
  return p;
}

describe('poller stall watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forces a reconnect once polls keep failing on a live socket', async () => {
    const client = stalledClient();
    const p = poller(client);

    p.start();
    // Three failures, each followed by a longer backoff.
    await vi.advanceTimersByTimeAsync(120_000);
    p.stop();

    expect(client.reconnects.length).toBeGreaterThan(0);
    expect(client.reconnects[0]).toContain('marker polls failed while connected');
  });

  it('does not force a reconnect while the client reports disconnected', async () => {
    // The client is already working the problem via its own backoff; piling
    // forced reconnects on top would reset it and hammer the server.
    const client = stalledClient();
    (client as { isConnected: boolean }).isConnected = false;
    const p = poller(client);

    p.start();
    await vi.advanceTimersByTimeAsync(120_000);
    p.stop();

    expect(client.reconnects).toHaveLength(0);
  });

  it('does not force a reconnect on an isolated failure', async () => {
    let calls = 0;
    const reconnects: string[] = [];
    const client = {
      isConnected: true,
      getMapMarkers: () => {
        calls += 1;
        // Only the first poll fails; a single blip must not trigger anything.
        return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve([]);
      },
      reconnect: (reason: string) => void reconnects.push(reason),
    } as unknown as RustPlusClient;

    const p = poller(client);
    p.start();
    await vi.advanceTimersByTimeAsync(60_000);
    p.stop();

    expect(reconnects).toHaveLength(0);
    expect(calls).toBeGreaterThan(1);
  });

  it('stops forcing reconnects once polling recovers', async () => {
    let failing = true;
    const reconnects: string[] = [];
    const client = {
      isConnected: true,
      getMapMarkers: () => (failing ? Promise.reject(new Error('timed out')) : Promise.resolve([])),
      reconnect: (reason: string) => {
        reconnects.push(reason);
        failing = false;
      },
    } as unknown as RustPlusClient;

    const p = poller(client);
    p.start();
    await vi.advanceTimersByTimeAsync(300_000);
    p.stop();

    // One reconnect fixed it; the watchdog must not keep firing afterwards.
    expect(reconnects).toHaveLength(1);
  });
});
