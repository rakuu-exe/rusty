import { describe, expect, it } from 'vitest';
import {
  MAX_PLAUSIBLE_INTERVAL_MS,
  MIN_OBSERVATIONS,
  describeEstimate,
  estimateRespawn,
} from '../src/events/respawn.js';
import { formatDuration } from '../src/format/message.js';

const now = new Date('2026-08-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('estimateRespawn', () => {
  it('refuses to estimate without enough observations', () => {
    // The guardrail: too little evidence means say nothing, not guess.
    expect(estimateRespawn([], now)).toBeNull();
    expect(estimateRespawn([minutesAgo(10)], now)).toBeNull();
    expect(estimateRespawn([minutesAgo(10), minutesAgo(70)], now)).toBeNull();
    expect(MIN_OBSERVATIONS).toBeGreaterThanOrEqual(3);
  });

  it('measures the interval once there is enough history', () => {
    // Spawns every 60 minutes, last one 20 minutes ago.
    const e = estimateRespawn([minutesAgo(20), minutesAgo(80), minutesAgo(140)], now)!;
    expect(e.intervalMs).toBe(60 * 60_000);
    expect(e.nextInMs).toBe(40 * 60_000);
    expect(e.observations).toBe(3);
  });

  it('uses the median so one odd gap does not skew it', () => {
    const e = estimateRespawn(
      [minutesAgo(10), minutesAgo(70), minutesAgo(130), minutesAgo(430)],
      now,
    )!;
    expect(e.intervalMs).toBe(60 * 60_000);
  });

  it('discards downtime rather than reading it as a cycle', () => {
    const longAgo = new Date(minutesAgo(140).getTime() - MAX_PLAUSIBLE_INTERVAL_MS - 60_000);
    const e = estimateRespawn([minutesAgo(20), minutesAgo(80), minutesAgo(140), longAgo], now)!;
    expect(e.intervalMs).toBe(60 * 60_000);
  });

  it('reports overdue as a negative interval', () => {
    const e = estimateRespawn([minutesAgo(90), minutesAgo(150), minutesAgo(210)], now)!;
    expect(e.nextInMs).toBe(-30 * 60_000);
  });
});

describe('describeEstimate', () => {
  it('always says what the estimate is based on', () => {
    // Nobody should mistake a measured average for a published server timing.
    const e = estimateRespawn([minutesAgo(20), minutesAgo(80), minutesAgo(140)], now)!;
    const text = describeEstimate(e, formatDuration);
    expect(text).toBe('next in ~40m (~every 1h 0m from 3)');
  });

  it('phrases an overdue spawn differently', () => {
    const e = estimateRespawn([minutesAgo(90), minutesAgo(150), minutesAgo(210)], now)!;
    expect(describeEstimate(e, formatDuration)).toContain('overdue by 30m');
  });
});
