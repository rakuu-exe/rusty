import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, formatEventLine, isHighSignal } from '../src/format/message.js';
import type { DetectedEvent } from '../src/events/types.js';

const options = { timezone: 'UTC' };

function event(partial: Partial<DetectedEvent>): DetectedEvent {
  return {
    type: 'patrol_helicopter',
    phase: 'entered_map',
    markerId: '1',
    x: 3300,
    y: 3300,
    grid: 'W4',
    at: new Date('2026-08-01T14:41:00Z'),
    ...partial,
  } as DetectedEvent;
}

describe('formatEventLine', () => {
  it('renders the oil rig crate call exactly as specified', () => {
    // This is the reference format the whole bot is built around.
    const line = formatEventLine(
      event({
        type: 'oil_rig_crate',
        phase: 'called',
        monument: 'Large Oil Rig',
        opensAt: new Date('2026-08-01T14:56:00Z'),
      }),
      options,
    );

    expect(line).toBe('LARGE OIL RIG CRATE CALLED 14:41 OPENS 14:56 @ W4');
  });

  it('renders the small rig variant', () => {
    const line = formatEventLine(
      event({
        type: 'oil_rig_crate',
        phase: 'called',
        monument: 'Small Oil Rig',
        opensAt: new Date('2026-08-01T14:56:00Z'),
        grid: 'D18',
      }),
      options,
    );

    expect(line).toBe('SMALL OIL RIG CRATE CALLED 14:41 OPENS 14:56 @ D18');
  });

  it('renders the unlock without an OPENS clause', () => {
    const line = formatEventLine(
      event({ type: 'oil_rig_crate', phase: 'unlocked', monument: 'Large Oil Rig' }),
      options,
    );

    expect(line).toBe('LARGE OIL RIG CRATE UNLOCKED 14:41 @ W4');
  });

  it('renders helicopter phases', () => {
    expect(formatEventLine(event({}), options)).toBe('PATROL HELICOPTER ENTERED MAP 14:41 @ W4');
    expect(formatEventLine(event({ phase: 'downed' }), options)).toBe('PATROL HELICOPTER DOWNED 14:41 @ W4');
    expect(formatEventLine(event({ phase: 'left_map' }), options)).toBe('PATROL HELICOPTER LEFT MAP 14:41 @ W4');
  });

  it('renders cargo ship spawning at sea', () => {
    const line = formatEventLine(
      event({ type: 'cargo_ship', phase: 'entered_map', grid: 'DEEP SEA, BOTTOM RIGHT' }),
      options,
    );

    expect(line).toBe('CARGO SHIP ENTERED MAP 14:41 @ DEEP SEA, BOTTOM RIGHT');
  });

  it('renders an oil rig by region, since rigs sit outside the grid', () => {
    const line = formatEventLine(
      event({
        type: 'oil_rig_crate',
        phase: 'called',
        monument: 'Large Oil Rig',
        opensAt: new Date('2026-08-01T14:56:00Z'),
        grid: 'TOP RIGHT',
      }),
      options,
    );

    expect(line).toBe('LARGE OIL RIG CRATE CALLED 14:41 OPENS 14:56 @ TOP RIGHT');
  });

  it('renders a locked crate with and without a monument', () => {
    expect(formatEventLine(event({ type: 'locked_crate', phase: 'dropped', monument: 'Launch Site' }), options)).toBe(
      'LOCKED CRATE DROPPED AT LAUNCH SITE 14:41 @ W4',
    );
    expect(formatEventLine(event({ type: 'locked_crate', phase: 'dropped' }), options)).toBe(
      'LOCKED CRATE DROPPED 14:41 @ W4',
    );
  });

  it('respects the configured timezone', () => {
    const line = formatEventLine(
      event({ type: 'oil_rig_crate', phase: 'called', monument: 'Large Oil Rig', opensAt: new Date('2026-08-01T14:56:00Z') }),
      { timezone: 'Europe/Tallinn' },
    );

    // UTC+3 in August.
    expect(line).toBe('LARGE OIL RIG CRATE CALLED 17:41 OPENS 17:56 @ W4');
  });
});

describe('formatClock', () => {
  it('pads to two digits and uses a 24 hour clock', () => {
    expect(formatClock(new Date('2026-08-01T09:05:00Z'), 'UTC')).toBe('09:05');
    expect(formatClock(new Date('2026-08-01T23:59:00Z'), 'UTC')).toBe('23:59');
    expect(formatClock(new Date('2026-08-01T00:00:00Z'), 'UTC')).toBe('00:00');
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(3 * 60_000)).toBe('3m');
    expect(formatDuration(72 * 60_000)).toBe('1h 12m');
    expect(formatDuration(52 * 3600_000)).toBe('2d 4h');
  });

  it('clamps negatives to zero rather than rendering nonsense', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('isHighSignal', () => {
  it('announces everything except a Chinook leaving', () => {
    // A Chinook entering means a locked crate is inbound -- suppressing it
    // meant a real detected event produced no alert at all.
    expect(isHighSignal('ch47', 'entered_map')).toBe(true);
    expect(isHighSignal('ch47', 'left_map')).toBe(false);

    expect(isHighSignal('patrol_helicopter', 'entered_map')).toBe(true);
    expect(isHighSignal('patrol_helicopter', 'downed')).toBe(true);
    expect(isHighSignal('patrol_helicopter', 'left_map')).toBe(true);
    expect(isHighSignal('cargo_ship', 'entered_map')).toBe(true);
    expect(isHighSignal('cargo_ship', 'egress')).toBe(true);
    expect(isHighSignal('oil_rig_crate', 'called')).toBe(true);
    expect(isHighSignal('oil_rig_crate', 'unlocked')).toBe(true);
    expect(isHighSignal('locked_crate', 'dropped')).toBe(true);
  });
});
