import { describe, expect, it } from 'vitest';
import { EventStateStore, EventSubject, describeState } from '../src/events/state.js';
import { formatClock, formatDuration } from '../src/format/message.js';

const fmt = { duration: formatDuration, clock: (d: Date) => formatClock(d, 'UTC') };

const now = new Date('2026-08-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('EventStateStore', () => {
  it('starts every subject as unobserved', () => {
    const store = new EventStateStore();
    for (const state of store.all()) {
      expect(state.state, state.subject).toBe('unknown');
      expect(state.startedAt, state.subject).toBeNull();
    }
  });

  it('never invents a start time for something found at startup', () => {
    // This is the whole point of the distinction: the bot did not see it
    // spawn, so it must not imply a spawn time.
    const store = new EventStateStore();
    store.markPresentAtStartup(EventSubject.CargoShip, now, 'BOTTOM RIGHT');

    const state = store.get(EventSubject.CargoShip);
    expect(state.state).toBe('active_at_startup');
    expect(state.startedAt).toBeNull();
    expect(state.lastSeenAt).toEqual(now);
  });

  it('records a real start time for an observed spawn', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.CargoShip, now, 'P14');

    expect(store.get(EventSubject.CargoShip)).toMatchObject({ state: 'active', startedAt: now });
  });

  it('promotes a startup sighting to a real spawn on respawn', () => {
    const store = new EventStateStore();
    store.markPresentAtStartup(EventSubject.PatrolHelicopter, minutesAgo(60), 'D18');
    store.markEnded(EventSubject.PatrolHelicopter, minutesAgo(30));
    store.markSpawned(EventSubject.PatrolHelicopter, minutesAgo(5), 'W4');

    expect(store.get(EventSubject.PatrolHelicopter)).toMatchObject({
      state: 'active',
      startedAt: minutesAgo(5),
      endedAt: null,
    });
  });

  it('does not resurrect a completed subject via markSeen', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.CargoShip, minutesAgo(60), 'P14');
    store.markEnded(EventSubject.CargoShip, minutesAgo(10));
    store.markSeen(EventSubject.CargoShip, now, 'P14');

    expect(store.get(EventSubject.CargoShip).state).toBe('completed');
  });

  it('keeps the two oil rigs completely independent', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.LargeOilRig, now, 'TOP RIGHT');

    expect(store.get(EventSubject.LargeOilRig).oilRig?.phase).toBe('available');
    expect(store.get(EventSubject.SmallOilRig).oilRig?.phase).toBe('unknown');
  });
});

describe('oil rig lifecycle', () => {
  it('runs available -> triggered -> unlocked -> completed', () => {
    const store = new EventStateStore();
    const rig = EventSubject.LargeOilRig;

    store.markSpawned(rig, minutesAgo(40), 'TOP RIGHT');
    expect(store.get(rig).oilRig?.phase).toBe('available');

    const triggered = minutesAgo(20);
    const unlocksAt = new Date(triggered.getTime() + 15 * 60_000);
    store.markOilRigTriggered(rig, triggered, unlocksAt, 'TOP RIGHT');
    expect(store.get(rig).oilRig).toMatchObject({ phase: 'triggered', triggeredAt: triggered, unlocksAt });

    store.markOilRigUnlocked(rig, minutesAgo(5));
    expect(store.get(rig).oilRig?.phase).toBe('unlocked');

    store.markEnded(rig, now);
    expect(store.get(rig).oilRig?.phase).toBe('completed');
  });

  it('resets the trigger when the crate respawns', () => {
    const store = new EventStateStore();
    const rig = EventSubject.SmallOilRig;

    store.markOilRigTriggered(rig, minutesAgo(30), minutesAgo(15), 'TOP LEFT');
    store.markEnded(rig, minutesAgo(10));
    store.markSpawned(rig, minutesAgo(2), 'TOP LEFT');

    expect(store.get(rig).oilRig).toMatchObject({
      phase: 'available',
      triggeredAt: null,
      unlocksAt: null,
    });
  });

  it('will not unlock a rig that was never triggered', () => {
    // The countdown only exists because a Chinook was observed arriving.
    const store = new EventStateStore();
    store.markSpawned(EventSubject.LargeOilRig, minutesAgo(10), 'TOP RIGHT');
    store.markOilRigUnlocked(EventSubject.LargeOilRig, now);

    expect(store.get(EventSubject.LargeOilRig).oilRig?.phase).toBe('available');
  });

  it('treats a trigger as proof the rig is active even if the crate was missed', () => {
    const store = new EventStateStore();
    store.markOilRigTriggered(EventSubject.LargeOilRig, now, new Date(now.getTime() + 900_000), 'TOP RIGHT');

    expect(store.get(EventSubject.LargeOilRig).state).not.toBe('unknown');
  });
});

describe('describeState', () => {
  const render = (store: EventStateStore, subject: Parameters<EventStateStore['get']>[0]) =>
    describeState(store.get(subject), fmt, now);

  it('says plainly when nothing is known', () => {
    expect(render(new EventStateStore(), EventSubject.PatrolHelicopter)).toBe(
      'Patrol Helicopter: not observed this session',
    );
  });

  it('flags a startup detection rather than implying a spawn', () => {
    const store = new EventStateStore();
    store.markPresentAtStartup(EventSubject.CargoShip, minutesAgo(1), 'BOTTOM RIGHT');
    expect(render(store, EventSubject.CargoShip)).toBe(
      'Cargo Ship: ACTIVE @ BOTTOM RIGHT — detected after startup, spawn time unknown',
    );
  });

  it('gives cargo a spawn clock time, current location and egress countdown', () => {
    // Cargo has a known 50 minute lifespan, so "how long is left" is the
    // useful question, and the grid is refreshed on every poll as it sails.
    const store = new EventStateStore();
    store.markSpawned(EventSubject.CargoShip, minutesAgo(12), 'P14');
    expect(render(store, EventSubject.CargoShip)).toBe(
      'Cargo Ship: ACTIVE @ P14 — spawned 11:48 (12m ago), egress in 38m',
    );
  });

  it('says egress has started once cargo is past its window', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.CargoShip, minutesAgo(58), 'AA20');
    expect(render(store, EventSubject.CargoShip)).toBe(
      'Cargo Ship: ACTIVE @ AA20 — spawned 11:02 (58m ago), egress started 8m ago',
    );
  });

  it('follows cargo as it moves', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.CargoShip, minutesAgo(12), 'BOTTOM RIGHT');
    store.markSeen(EventSubject.CargoShip, minutesAgo(1), 'P14');
    expect(render(store, EventSubject.CargoShip)).toContain('@ P14');
  });

  it('gives a spawn time for other events without an egress clause', () => {
    const store = new EventStateStore();
    store.markSpawned(EventSubject.PatrolHelicopter, minutesAgo(5), 'D18');
    expect(render(store, EventSubject.PatrolHelicopter)).toBe(
      'Patrol Helicopter: ACTIVE @ D18 — spawned 11:55 (5m ago)',
    );
  });

  it('counts down an armed rig crate', () => {
    const store = new EventStateStore();
    store.markOilRigTriggered(
      EventSubject.LargeOilRig,
      minutesAgo(5),
      new Date(now.getTime() + 10 * 60_000),
      'TOP RIGHT',
    );
    expect(render(store, EventSubject.LargeOilRig)).toBe(
      'Large Oil Rig: Heavy Scientists called 5m ago, crate unlocks in 10m @ TOP RIGHT',
    );
  });

  it('reports an elapsed countdown as unlocked rather than a negative time', () => {
    const store = new EventStateStore();
    store.markOilRigTriggered(
      EventSubject.SmallOilRig,
      minutesAgo(30),
      minutesAgo(15),
      'TOP LEFT',
    );
    expect(render(store, EventSubject.SmallOilRig)).toBe('Small Oil Rig: crate UNLOCKED @ TOP LEFT');
  });
});
