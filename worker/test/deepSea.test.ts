import { describe, expect, it } from 'vitest';
import {
  DEEP_SEA_OPEN_MS,
  anchorFromClosesIn,
  deepSeaState,
  parseDuration,
} from '../src/events/deepSea.js';

const now = new Date('2026-08-01T12:00:00Z');

describe('parseDuration', () => {
  it('reads the formats people actually type', () => {
    expect(parseDuration('2h6m')).toBe(2 * 3600_000 + 6 * 60_000);
    expect(parseDuration('2h 6m')).toBe(2 * 3600_000 + 6 * 60_000);
    expect(parseDuration('90m')).toBe(90 * 60_000);
    expect(parseDuration('1h')).toBe(3600_000);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('1h30m15s')).toBe(3600_000 + 30 * 60_000 + 15_000);
  });

  it('treats a bare number as minutes', () => {
    expect(parseDuration('90')).toBe(90 * 60_000);
  });

  it('rejects nonsense', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('anchorFromClosesIn', () => {
  it('works backwards from the in-game countdown', () => {
    // Reported as closing in 2h6m, with a 3h open window, so it opened 54m ago.
    const anchor = anchorFromClosesIn(parseDuration('2h6m')!, now);
    expect(anchor.openedAt).toEqual(new Date(now.getTime() - 54 * 60_000));
  });

  it('round-trips through deepSeaState', () => {
    // The whole point: anchoring from the countdown must reproduce it exactly.
    const closesIn = parseDuration('2h6m')!;
    const anchor = anchorFromClosesIn(closesIn, now);
    expect(deepSeaState(anchor.openedAt, now).closesInMs).toBe(closesIn);
  });

  it('handles a countdown equal to the full window', () => {
    const anchor = anchorFromClosesIn(DEEP_SEA_OPEN_MS, now);
    expect(anchor.openedAt).toEqual(now);
  });

  it('reproduces the reported mismatch', () => {
    // The bot said 1h16m while the game said 2h6m -- a 50 minute error from
    // an anchor set during testing rather than at a real open. Re-anchoring
    // from the countdown must correct it exactly.
    const wrongAnchor = new Date(now.getTime() - (DEEP_SEA_OPEN_MS - 76 * 60_000));
    expect(deepSeaState(wrongAnchor, now).closesInMs).toBe(76 * 60_000);

    const corrected = anchorFromClosesIn(126 * 60_000, now);
    expect(deepSeaState(corrected.openedAt, now).closesInMs).toBe(126 * 60_000);
  });
});
