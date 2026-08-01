/**
 * Database-backed timers for delayed events.
 *
 * Two events in v1 fire on a clock rather than on a marker change: the oil rig
 * crate unlocking 15 minutes after heavy scientists land, and Cargo Ship
 * entering egress after 50 minutes. Both are persisted rather than held in
 * memory, because a redeploy or crash in between would otherwise silently
 * swallow the alert people are actually waiting for.
 *
 * On boot, pending timers are rehydrated. Ones that came due while the worker
 * was down fire immediately -- late is better than never, and the message
 * carries the real timestamp so it is not misleading.
 */

import { armTimer, getPendingTimers, markTimerFired } from '../db.js';
import { logger } from '../logger.js';
import { TimerKind, type DetectedEvent, type TimerKindValue } from './types.js';

export interface TimerPayload extends Record<string, unknown> {
  markerId: string | null;
  grid: string;
  x: number;
  y: number;
  monument?: string;
}

export type TimerFiredHandler = (event: DetectedEvent) => Promise<void> | void;

export class TimerScheduler {
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly serverId: string,
    private readonly onFired: TimerFiredHandler,
  ) {}

  /**
   * Re-arm timers persisted by a previous run.
   *
   * Call once after connecting, before the first poll, so a crate armed before
   * a restart still produces its "OPENS" alert.
   */
  async rehydrate(): Promise<void> {
    const pending = await getPendingTimers(this.serverId);
    if (pending.length === 0) return;

    logger.info({ count: pending.length }, 'rehydrating pending timers');
    for (const timer of pending) {
      this.schedule(timer.id, timer.kind as TimerKindValue, new Date(timer.expires_at), timer.payload as TimerPayload);
    }
  }

  /** Arm a crate unlock timer. No-ops if one is already pending for the marker. */
  async armCrateUnlock(event: DetectedEvent): Promise<void> {
    if (!event.opensAt) return;

    const payload: TimerPayload = {
      markerId: event.markerId,
      grid: event.grid,
      x: event.x,
      y: event.y,
      ...(event.monument ? { monument: event.monument } : {}),
    };

    const row = await armTimer({
      serverId: this.serverId,
      kind: TimerKind.OilRigCrateUnlock,
      expiresAt: event.opensAt,
      payload,
    });

    // Null means a pending timer already exists for this marker -- a duplicate
    // observation, not an error.
    if (row) this.schedule(row.id, TimerKind.OilRigCrateUnlock, event.opensAt, payload);
  }

  /** Arm a cargo ship egress timer. */
  async armCargoEgress(event: DetectedEvent, egressAt: Date): Promise<void> {
    const payload: TimerPayload = {
      markerId: event.markerId,
      grid: event.grid,
      x: event.x,
      y: event.y,
    };

    const row = await armTimer({
      serverId: this.serverId,
      kind: TimerKind.CargoShipEgress,
      expiresAt: egressAt,
      payload,
    });

    if (row) this.schedule(row.id, TimerKind.CargoShipEgress, egressAt, payload);
  }

  private schedule(timerId: string, kind: TimerKindValue, expiresAt: Date, payload: TimerPayload): void {
    if (this.stopped || this.handles.has(timerId)) return;

    // setTimeout saturates past ~24.8 days and would fire instantly; clamping
    // to zero is correct here since nothing legitimately schedules that far out.
    const delay = Math.max(0, Math.min(expiresAt.getTime() - Date.now(), 2 ** 31 - 1));

    const handle = setTimeout(() => {
      this.handles.delete(timerId);
      void this.fire(timerId, kind, expiresAt, payload);
    }, delay);

    this.handles.set(timerId, handle);
  }

  private async fire(timerId: string, kind: TimerKindValue, expiresAt: Date, payload: TimerPayload): Promise<void> {
    const event: DetectedEvent = {
      type: kind === TimerKind.OilRigCrateUnlock ? 'oil_rig_crate' : 'cargo_ship',
      phase: kind === TimerKind.OilRigCrateUnlock ? 'unlocked' : 'egress',
      markerId: payload.markerId,
      x: payload.x,
      y: payload.y,
      grid: payload.grid,
      ...(payload.monument ? { monument: payload.monument } : {}),
      // The scheduled time, not "now" -- a timer that fired late after a
      // restart should still report when the crate actually opened.
      at: expiresAt,
    };

    try {
      await this.onFired(event);
      await markTimerFired(timerId);
    } catch (error) {
      // Leave fired_at null so the next boot retries rather than dropping it.
      logger.error({ err: error, timerId, kind }, 'timer handler failed');
    }
  }

  /** Cancel all in-memory timers. Persisted rows survive for the next boot. */
  stop(): void {
    this.stopped = true;
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
  }
}
