/**
 * Polls getMapMarkers on an interval and feeds snapshots to the detector.
 *
 * Uses a self-rescheduling loop rather than setInterval so a slow or hung
 * request cannot stack up overlapping polls against the rate limiter.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { RustPlusClient } from '../rustplus/client.js';
import type { EventDetector } from './detector.js';
import type { DetectedEvent } from './types.js';
import type { RustMapMarker } from '../rustplus/types.js';

export interface MarkerPollerEvents {
  events: [events: DetectedEvent[]];
  /** The raw snapshot, for consumers other than the event detector. */
  markers: [markers: RustMapMarker[]];
  error: [error: Error];
}

/**
 * Failed polls in a row before the socket is treated as dead.
 *
 * The client only reconnects when ws reports an error or a close. A half-open
 * socket reports neither, so without this the poller would back off to a
 * minute apart and retry against a corpse forever, with isConnected still
 * true and /status still green.
 *
 * Three failures is roughly seventy seconds of silence given the backoff
 * below -- long enough not to fire on one slow response, short enough that
 * nobody notices the gap.
 */
const STALL_LIMIT = 3;

export class MarkerPoller extends EventEmitter<MarkerPollerEvents> {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private loggedFirstPoll = false;

  constructor(
    private readonly client: RustPlusClient,
    private readonly detector: EventDetector,
    private readonly intervalMs: number,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      // A disconnected client would reject every poll; the client reconnects
      // on its own, so just idle until it is back rather than logging noise.
      if (!this.client.isConnected) {
        this.scheduleNext(this.intervalMs);
        return;
      }

      const markers = await this.client.getMapMarkers();

      // One-time confirmation that polling actually reaches the server and
      // returns data. After this the loop is silent unless something happens.
      if (!this.loggedFirstPoll) {
        this.loggedFirstPoll = true;
        const counts = new Map<number, number>();
        for (const m of markers) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
        logger.info(
          { markers: markers.length, byType: Object.fromEntries(counts) },
          'first marker poll succeeded; watching for events',
        );
      }

      const events = this.detector.update(markers);
      // Vending shares the same snapshot; it costs no extra rate-limit tokens.
      this.emit('markers', markers);
      this.consecutiveFailures = 0;

      if (events.length > 0) {
        logger.debug({ count: events.length }, 'detected events');
        this.emit('events', events);
      }

      this.scheduleNext(this.intervalMs);
    } catch (error) {
      this.consecutiveFailures += 1;
      const err = error instanceof Error ? error : new Error(String(error));

      // Repeated failures usually mean the server is down or the token was
      // invalidated by a wipe. Backing off avoids hammering it while the
      // client's own reconnect loop works the problem.
      const backoff = Math.min(this.intervalMs * 2 ** Math.min(this.consecutiveFailures, 5), 60_000);

      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
        logger.warn({ err: err.message, failures: this.consecutiveFailures }, 'marker poll failed');
      }

      this.emit('error', err);

      /**
       * The client still believes it is connected, yet nothing gets through.
       * That is the half-open case, and only a forced reconnect clears it.
       */
      if (this.consecutiveFailures >= STALL_LIMIT && this.client.isConnected) {
        this.consecutiveFailures = 0;
        this.client.reconnect(`${STALL_LIMIT} marker polls failed while connected`);
      }

      this.scheduleNext(backoff);
    }
  }
}
