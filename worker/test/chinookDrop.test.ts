/**
 * Inferring locked crate drops from Chinook movement.
 *
 * Crate markers no longer exist in the companion API, so the drop itself is
 * invisible. These tests drive synthetic flight paths through the detector to
 * check that a hover beside a monument is recognised as a drop, and that
 * cruising, turning and oil rig deliveries are not.
 */

import { describe, expect, it } from 'vitest';
import {
  CHINOOK_HOVER_SAMPLES,
  CHINOOK_HOVER_SPEED,
  EventDetector,
} from '../src/events/detector.js';
import { MonumentIndex } from '../src/rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../src/rustplus/types.js';
import type { DetectedEvent } from '../src/events/types.js';

const MAP_SIZE = 4000;
const LAUNCH_SITE = { token: 'launchsite', x: 2000, y: 2000 };
const LARGE_RIG = { token: 'large_oil_rig', x: 3275, y: 4329 };

function detector() {
  return new EventDetector({
    mapSize: MAP_SIZE,
    monuments: new MonumentIndex([LAUNCH_SITE, LARGE_RIG]),
  });
}

const filler = (): RustMapMarker => ({ id: 999, type: MarkerType.Player, x: 100, y: 100 });
const chinook = (x: number, y: number): RustMapMarker => ({ id: 20, type: MarkerType.CH47, x, y });

const t0 = new Date('2026-08-01T20:00:00Z');
const POLL_S = 5;

/**
 * Fly a Chinook through a series of positions, one poll apart, collecting
 * everything the detector emits.
 */
function fly(d: EventDetector, path: { x: number; y: number }[]): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  d.update([filler()], t0);

  path.forEach((p, i) => {
    const at = new Date(t0.getTime() + (i + 1) * POLL_S * 1000);
    events.push(...d.update([filler(), chinook(p.x, p.y)], at));
  });

  return events;
}

/** A straight run at cruising speed, ending at the given point. */
function approach(toX: number, toY: number, steps = 5, perStep = 100): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  for (let i = steps; i >= 1; i--) path.push({ x: toX - i * perStep, y: toY });
  return path;
}

/** Sitting still at a point for n polls, with a little GPS-style jitter. */
function hover(x: number, y: number, polls: number): { x: number; y: number }[] {
  return Array.from({ length: polls }, (_, i) => ({ x: x + (i % 2), y: y - (i % 2) }));
}

describe('crate drop inference', () => {
  it('reports a drop when the Chinook hovers beside a monument', () => {
    const events = fly(detector(), [
      ...approach(LAUNCH_SITE.x, LAUNCH_SITE.y),
      ...hover(LAUNCH_SITE.x, LAUNCH_SITE.y, 4),
    ]);

    const drops = events.filter((e) => e.type === 'locked_crate');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ phase: 'dropped', monument: 'Launch Site' });
  });

  it('does not report a drop while merely cruising over a monument', () => {
    // Passing straight over at speed is not a delivery.
    const events = fly(detector(), [
      { x: 1600, y: 2000 },
      { x: 1800, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 2200, y: 2000 },
      { x: 2400, y: 2000 },
    ]);

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(0);
  });

  it('needs sustained stillness, not one slow sample', () => {
    // A single low-speed sample can happen either side of a turn.
    const events = fly(detector(), [
      ...approach(LAUNCH_SITE.x, LAUNCH_SITE.y),
      { x: LAUNCH_SITE.x, y: LAUNCH_SITE.y },
      { x: LAUNCH_SITE.x + 150, y: LAUNCH_SITE.y },
      { x: LAUNCH_SITE.x + 300, y: LAUNCH_SITE.y },
    ]);

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(0);
  });

  it('reports a drop only once however long it hovers', () => {
    const events = fly(detector(), [
      ...approach(LAUNCH_SITE.x, LAUNCH_SITE.y),
      ...hover(LAUNCH_SITE.x, LAUNCH_SITE.y, 12),
    ]);

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(1);
  });

  it('ignores a hover in open ground away from any monument', () => {
    // Without a monument to name, the alert would carry no useful information.
    const events = fly(detector(), [...approach(600, 600), ...hover(600, 600, 5)]);

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(0);
  });

  it('does not double-report an oil rig delivery as a crate drop', () => {
    // Rig deliveries hover too, but are already reported through the rig
    // lifecycle -- announcing both would describe one event twice.
    const events = fly(detector(), [
      ...approach(LARGE_RIG.x, LARGE_RIG.y),
      ...hover(LARGE_RIG.x, LARGE_RIG.y, 5),
    ]);

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'oil_rig_crate' && e.phase === 'called')).toHaveLength(1);
  });

  it('still reports a later drop by a different Chinook', () => {
    const d = detector();
    d.update([filler()], t0);

    const step = (i: number) => new Date(t0.getTime() + i * POLL_S * 1000);
    const events: DetectedEvent[] = [];

    // First Chinook drops at Launch Site.
    [1400, 1600, 1800, 2000, 2000, 2000].forEach((x, i) => {
      events.push(...d.update([filler(), { id: 20, type: MarkerType.CH47, x, y: 2000 }], step(i + 1)));
    });
    // It leaves, a second arrives and drops at the same place.
    events.push(...d.update([filler()], step(10)));
    [1400, 1600, 1800, 2000, 2000, 2000].forEach((x, i) => {
      events.push(...d.update([filler(), { id: 21, type: MarkerType.CH47, x, y: 2000 }], step(i + 11)));
    });

    expect(events.filter((e) => e.type === 'locked_crate')).toHaveLength(2);
  });
});

describe('thresholds', () => {
  it('are set where cruising and hovering are clearly separable', () => {
    // Cruising covers roughly 80-125 units per 5s poll (16-25 u/s); hovering
    // is near zero. The threshold sits well below cruising with room to spare.
    expect(CHINOOK_HOVER_SPEED).toBeLessThan(16);
    expect(CHINOOK_HOVER_SAMPLES).toBeGreaterThanOrEqual(2);
  });
});
