import { describe, expect, it } from 'vitest';
import { EventDetector, OIL_RIG_CRATE_UNLOCK_MS } from '../src/events/detector.js';
import { MonumentIndex } from '../src/rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../src/rustplus/types.js';

const MAP_SIZE = 4000;

const LARGE_RIG = { token: 'large_oil_rig', x: 3300, y: 3300 };
const SMALL_RIG = { token: 'oil_rig_small', x: 800, y: 900 };
const LAUNCH_SITE = { token: 'launchsite', x: 2000, y: 2000 };

function detector(): EventDetector {
  return new EventDetector({
    mapSize: MAP_SIZE,
    monuments: new MonumentIndex([LARGE_RIG, SMALL_RIG, LAUNCH_SITE]),
  });
}

function marker(id: number, type: number, x: number, y: number): RustMapMarker {
  return { id, type: type as RustMapMarker['type'], x, y };
}

const t0 = new Date('2026-08-01T14:41:00Z');
const at = (secondsLater: number) => new Date(t0.getTime() + secondsLater * 1000);

describe('priming', () => {
  it('announces nothing on the first snapshot', () => {
    // On connect the map is already populated. Announcing everything would
    // report a Cargo Ship that has been sailing for half an hour as new.
    const d = detector();
    const events = d.update(
      [
        marker(1, MarkerType.CargoShip, 500, 500),
        marker(2, MarkerType.PatrolHelicopter, 1000, 1000),
      ],
      t0,
    );

    expect(events).toEqual([]);
    expect(d.isPrimed).toBe(true);
  });

  it('does not re-announce markers that were present at priming', () => {
    const d = detector();
    d.update([marker(1, MarkerType.CargoShip, 500, 500)], t0);
    expect(d.update([marker(1, MarkerType.CargoShip, 520, 520)], at(5))).toEqual([]);
  });
});

describe('patrol helicopter', () => {
  /**
   * A live feed always carries players and vending machines, so a snapshot is
   * never truly empty. Including a filler keeps these fixtures realistic and
   * avoids tripping the guard that treats an empty snapshot as a feed glitch.
   */
  const filler = () => marker(999, MarkerType.Player, 2000, 2000);

  it('reports entering the map', () => {
    const d = detector();
    d.update([filler()], t0);

    const events = d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 3300, 3300)], at(5));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'patrol_helicopter',
      phase: 'entered_map',
      grid: 'W4',
    });
  });

  it('reports downed when it vanishes inland', () => {
    // Verified against a real event: a heli disappeared at R6, mid-map, and
    // had in fact been shot down there. Explosion markers no longer exist in
    // the feed, so position is the only available signal.
    const d = detector();
    d.update([filler()], t0);
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 2550, 3000)], at(5));

    const events = d.update([filler()], at(10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'patrol_helicopter', phase: 'downed' });
  });

  it('reports leaving when it vanishes at the map edge', () => {
    const d = detector();
    d.update([filler()], t0);
    // Just outside the grid, which is how a departing heli exits.
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 4100, 2000)], at(5));

    const events = d.update([filler()], at(10));
    expect(events[0]).toMatchObject({ type: 'patrol_helicopter', phase: 'left_map' });
  });

  it('treats the edge margin as departure, not a kill', () => {
    const d = detector();
    d.update([filler()], t0);
    // 100 units inside the boundary -- within the tolerance for crossing out.
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 100, 2000)], at(5));

    expect(d.update([filler()], at(10))[0]).toMatchObject({ phase: 'left_map' });
  });

  it('still accepts an explosion as corroboration if one appears', () => {
    const d = detector();
    d.update([filler()], t0);
    // Near the edge, so position alone would say "left".
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 100, 2000)], at(5));

    const events = d.update([filler(), marker(11, MarkerType.Explosion, 120, 2010)], at(10));
    expect(events[0]).toMatchObject({ phase: 'downed' });
  });

  it('uses the last known position, not the first', () => {
    const d = detector();
    d.update([filler()], t0);
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 4100, 2000)], at(5));
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 3300, 3300)], at(10));

    const events = d.update([filler()], at(15));
    expect(events[0]).toMatchObject({ grid: 'W4', phase: 'downed' });
  });

  it('ignores a snapshot that came back empty', () => {
    // A momentary bad response must not report everything as destroyed.
    const d = detector();
    d.update([filler()], t0);
    d.update([filler(), marker(10, MarkerType.PatrolHelicopter, 2550, 3000)], at(5));

    expect(d.update([], at(10))).toEqual([]);
    // The heli is still tracked, so a later genuine despawn still reports.
    expect(d.update([filler()], at(15))[0]).toMatchObject({ phase: 'downed' });
  });
});

describe('CH47 / oil rig', () => {
  it('reports a crate call when the Chinook reaches Large Oil Rig', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(20, MarkerType.CH47, 3310, 3290)], at(5));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'oil_rig_crate',
      phase: 'called',
      monument: 'Large Oil Rig',
      grid: 'W4',
    });
  });

  it('sets the unlock time 15 minutes out', () => {
    const d = detector();
    d.update([], t0);

    const called = at(5);
    const events = d.update([marker(20, MarkerType.CH47, 3310, 3290)], called);
    expect(events[0]!.opensAt!.getTime()).toBe(called.getTime() + OIL_RIG_CRATE_UNLOCK_MS);
  });

  it('reports the rig position rather than the approaching Chinook', () => {
    const d = detector();
    d.update([], t0);

    // Chinook is 150 units out on approach but the alert should name the rig.
    const events = d.update([marker(20, MarkerType.CH47, 3450, 3300)], at(5));
    expect(events[0]).toMatchObject({ type: 'oil_rig_crate', x: LARGE_RIG.x, y: LARGE_RIG.y });
  });

  it('distinguishes Small Oil Rig', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(20, MarkerType.CH47, 805, 895)], at(5));
    expect(events[0]).toMatchObject({ monument: 'Small Oil Rig' });
  });

  it('reports a plain map crossing when nowhere near a rig', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(20, MarkerType.CH47, 2000, 2000)], at(5));
    expect(events[0]).toMatchObject({ type: 'ch47', phase: 'entered_map' });
  });

  it('catches a Chinook that flies to a rig after entering the map', () => {
    // The real-world case that was being missed entirely: a Chinook spawns at
    // the map edge, is announced as a crossing, and only reaches the rig some
    // polls later. Judging it once on arrival lost every rig delivery.
    const d = detector();
    d.update([], t0);

    const entry = d.update([marker(20, MarkerType.CH47, 3900, 4600)], at(5));
    expect(entry[0]).toMatchObject({ type: 'ch47', phase: 'entered_map' });

    const arrival = d.update([marker(20, MarkerType.CH47, 3290, 3310)], at(30));
    expect(arrival).toHaveLength(1);
    expect(arrival[0]).toMatchObject({
      type: 'oil_rig_crate',
      phase: 'called',
      monument: 'Large Oil Rig',
    });
    expect(arrival[0]!.opensAt!.getTime()).toBe(at(30).getTime() + OIL_RIG_CRATE_UNLOCK_MS);
  });

  it('announces a rig delivery only once while the Chinook hovers', () => {
    const d = detector();
    d.update([], t0);
    d.update([marker(20, MarkerType.CH47, 3900, 4600)], at(5));
    d.update([marker(20, MarkerType.CH47, 3290, 3310)], at(30));

    // Still sitting on the rig several polls later.
    expect(d.update([marker(20, MarkerType.CH47, 3300, 3300)], at(35))).toEqual([]);
    expect(d.update([marker(20, MarkerType.CH47, 3305, 3295)], at(40))).toEqual([]);
  });

  it('routes an in-flight arrival to the correct rig', () => {
    const d = detector();
    d.update([], t0);
    d.update([marker(21, MarkerType.CH47, 100, 3000)], at(5));

    const arrival = d.update([marker(21, MarkerType.CH47, 810, 900)], at(30));
    expect(arrival[0]).toMatchObject({ monument: 'Small Oil Rig' });
    expect(d.state.get('oil_rig_large').oilRig?.phase).toBe('unknown');
    expect(d.state.get('oil_rig_small').oilRig?.phase).toBe('triggered');
  });

  it('announces departure for a crossing but not for a rig drop', () => {
    const d = detector();
    const filler = () => marker(999, MarkerType.Player, 2000, 2000);
    d.update([filler()], t0);

    d.update(
      [filler(), marker(20, MarkerType.CH47, 2000, 2000), marker(21, MarkerType.CH47, 3300, 3300)],
      at(5),
    );
    const events = d.update([filler()], at(10));

    // The rig call already told the story; only the crossing reports leaving.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ch47', phase: 'left_map', markerId: '20' });
  });
});

describe('crates', () => {
  it('announces a crate respawning on an oil rig', () => {
    // Regression: these were discarded outright, so rig respawns -- the thing
    // !when-loil is about -- were never announced at all.
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(30, MarkerType.Crate, 3300, 3300)], at(5));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'oil_rig_crate',
      phase: 'spawned',
      monument: 'Large Oil Rig',
    });
  });

  it('distinguishes the two rigs when a crate respawns', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(30, MarkerType.Crate, 805, 895)], at(5));
    expect(events[0]).toMatchObject({ type: 'oil_rig_crate', phase: 'spawned', monument: 'Small Oil Rig' });
  });

  it('does not re-announce the rig crate already there when the bot connected', () => {
    // Priming is what stops a reconnect reporting the standing crate as new.
    const d = detector();
    d.update([marker(30, MarkerType.Crate, 3300, 3300)], t0);

    expect(d.update([marker(30, MarkerType.Crate, 3300, 3300)], at(5))).toEqual([]);
  });

  it('reports a locked crate dropped elsewhere', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update([marker(30, MarkerType.Crate, 2010, 1990)], at(5));
    expect(events[0]).toMatchObject({
      type: 'locked_crate',
      phase: 'dropped',
      monument: 'Launch Site',
    });
  });

  it('reports a crate riding the cargo ship as a cargo crate', () => {
    const d = detector();
    d.update([marker(40, MarkerType.CargoShip, 1500, 1500)], t0);

    const events = d.update(
      [marker(40, MarkerType.CargoShip, 1500, 1500), marker(31, MarkerType.Crate, 1540, 1480)],
      at(5),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cargo_crate', phase: 'spawned' });
  });

  it('does not attribute a cargo crate to a monument the ship sails past', () => {
    // The ship passes coastal monuments; without the cargo check first, its
    // crates would be reported as "dropped at Launch Site".
    const d = detector();
    d.update([marker(40, MarkerType.CargoShip, 2000, 2000)], t0);

    const events = d.update(
      [marker(40, MarkerType.CargoShip, 2000, 2000), marker(31, MarkerType.Crate, 2020, 2010)],
      at(5),
    );

    expect(events[0]).toMatchObject({ type: 'cargo_crate' });
    expect(events[0]).not.toHaveProperty('monument');
  });

  it('still reports a land crate as dropped when cargo is far away', () => {
    const d = detector();
    d.update([marker(40, MarkerType.CargoShip, 100, 100)], t0);

    const events = d.update(
      [marker(40, MarkerType.CargoShip, 100, 100), marker(31, MarkerType.Crate, 2010, 1990)],
      at(5),
    );

    expect(events[0]).toMatchObject({ type: 'locked_crate', monument: 'Launch Site' });
  });
});

describe('cargo ship', () => {
  it('reports entry and exit, including from outside the grid', () => {
    const d = detector();
    const filler = () => marker(999, MarkerType.Player, 2000, 2000);
    d.update([filler()], t0);

    // Cargo spawns in the ocean margin, outside the grid system entirely.
    const entered = d.update([filler(), marker(40, MarkerType.CargoShip, -400, 2000)], at(5));
    expect(entered[0]).toMatchObject({
      type: 'cargo_ship',
      phase: 'entered_map',
      grid: 'LEFT MIDDLE',
    });

    const left = d.update([filler()], at(10));
    expect(left[0]).toMatchObject({ type: 'cargo_ship', phase: 'left_map' });
  });
});

describe('noise', () => {
  it('ignores players, vending machines and generic radii', () => {
    const d = detector();
    d.update([], t0);

    const events = d.update(
      [
        marker(50, MarkerType.Player, 100, 100),
        marker(51, MarkerType.VendingMachine, 200, 200),
        marker(52, MarkerType.GenericRadius, 300, 300),
      ],
      at(5),
    );

    expect(events).toEqual([]);
  });
});
