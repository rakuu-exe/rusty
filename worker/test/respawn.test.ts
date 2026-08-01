import { describe, expect, it } from 'vitest';
import {
  DEEP_SEA_COOLDOWN_MS,
  DEEP_SEA_OPEN_MS,
  MAX_PLAUSIBLE_INTERVAL_MS,
  deepSeaState,
  estimateRespawn,
} from '../src/events/respawn.js';

const now = new Date('2026-08-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('estimateRespawn', () => {
  it('reports nothing usable with no history', () => {
    const e = estimateRespawn([], { active: false, now });
    expect(e).toMatchObject({ observations: 0, intervalMs: null, nextInMs: null, sinceLastMs: null });
  });

  it('refuses to guess from a single sighting', () => {
    // One spawn gives no interval, so any prediction would be invented.
    const e = estimateRespawn([minutesAgo(30)], { active: false, now });
    expect(e.observations).toBe(1);
    expect(e.intervalMs).toBeNull();
    expect(e.nextInMs).toBeNull();
    expect(e.sinceLastMs).toBe(30 * 60_000);
  });

  it('predicts from the observed interval', () => {
    // Spawns every 60 minutes, last one 20 minutes ago -> 40 minutes to go.
    const e = estimateRespawn([minutesAgo(20), minutesAgo(80), minutesAgo(140)], { active: false, now });
    expect(e.intervalMs).toBe(60 * 60_000);
    expect(e.nextInMs).toBe(40 * 60_000);
    expect(e.observations).toBe(3);
  });

  it('uses the median so one odd gap does not skew it', () => {
    // Intervals of 60, 60 and 300 minutes; the mean would be badly wrong.
    const e = estimateRespawn([minutesAgo(10), minutesAgo(70), minutesAgo(130), minutesAgo(430)], {
      active: false,
      now,
    });
    expect(e.intervalMs).toBe(60 * 60_000);
  });

  it('discards implausibly long gaps as downtime, not cycles', () => {
    // The bot being offline overnight must not be read as a huge spawn cycle.
    // The gap from the 80-minute-ago spawn back to this one exceeds the limit.
    const longAgo = new Date(minutesAgo(80).getTime() - MAX_PLAUSIBLE_INTERVAL_MS - 60 * 60_000);
    const e = estimateRespawn([minutesAgo(20), minutesAgo(80), longAgo], { active: false, now });
    expect(e.intervalMs).toBe(60 * 60_000);
  });

  it('reports overdue as a negative interval', () => {
    const e = estimateRespawn([minutesAgo(90), minutesAgo(150)], { active: false, now });
    expect(e.intervalMs).toBe(60 * 60_000);
    expect(e.nextInMs).toBe(-30 * 60_000);
  });

  it('passes through whether it is currently on the map', () => {
    expect(estimateRespawn([minutesAgo(5)], { active: true, now }).active).toBe(true);
  });
});

describe('deepSeaState', () => {
  const opened = new Date('2026-08-01T09:00:00Z');

  it('is open during the open window', () => {
    // Default open duration is 3 hours.
    const state = deepSeaState(opened, new Date('2026-08-01T10:00:00Z'));
    expect(state.open).toBe(true);
    expect(state.closesInMs).toBe(2 * 60 * 60_000);
    expect(state.radiationPhase).toBe(false);
  });

  it('flags the radiation phase before close', () => {
    // Radiation ramp is the last 5 minutes.
    const state = deepSeaState(opened, new Date('2026-08-01T11:57:00Z'));
    expect(state.open).toBe(true);
    expect(state.radiationPhase).toBe(true);
  });

  it('is closed during the cooldown', () => {
    const state = deepSeaState(opened, new Date('2026-08-01T13:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.opensInMs).toBe(30 * 60_000); // 3h open + 90m cooldown = 13:30
  });

  it('projects forward from a stale anchor', () => {
    // An anchor from three days ago must still land on the right phase.
    const cycles = 3 * 24 * 60 * 60_000;
    const fresh = deepSeaState(opened, new Date(opened.getTime() + 60 * 60_000));
    const stale = deepSeaState(
      opened,
      new Date(opened.getTime() + 60 * 60_000 + Math.floor(cycles / (DEEP_SEA_OPEN_MS + DEEP_SEA_COOLDOWN_MS)) * (DEEP_SEA_OPEN_MS + DEEP_SEA_COOLDOWN_MS)),
    );
    expect(stale).toEqual(fresh);
  });

  it('handles an anchor slightly in the future without going negative', () => {
    const state = deepSeaState(opened, new Date(opened.getTime() - 60_000));
    expect(state.open === true || state.open === false).toBe(true);
    if (state.closesInMs !== null) expect(state.closesInMs).toBeGreaterThan(0);
    if (state.opensInMs !== null) expect(state.opensInMs).toBeGreaterThan(0);
  });

  it('respects overridden convar durations', () => {
    const state = deepSeaState(opened, new Date('2026-08-01T10:00:00Z'), {
      openMs: 30 * 60_000,
      cooldownMs: 30 * 60_000,
    });
    // 1 hour after open with a 1 hour cycle -> back at the start, open again.
    expect(state.open).toBe(true);
  });
});
