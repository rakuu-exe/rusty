/**
 * End-to-end proof of the oil rig chain, from raw markers to chat reply.
 *
 * Every oil rig bug so far survived because the pieces were tested separately
 * and the seam between them was not: the detector was right, the formatter was
 * right, and no rig event ever fired because a Chinook was judged in the wrong
 * place. This walks the whole path a real delivery takes.
 */

import { describe, expect, it } from 'vitest';
import { EventDetector, OIL_RIG_CRATE_UNLOCK_MS } from '../src/events/detector.js';
import { EventSubject, describeState } from '../src/events/state.js';
import { formatClock, formatDuration, formatEventLine, formatEventLineInGame, isHighSignal } from '../src/format/message.js';

const fmt = { duration: formatDuration, clock: (d: Date) => formatClock(d, 'UTC') };
import { MonumentIndex } from '../src/rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../src/rustplus/types.js';

const MAP_SIZE = 4000;

// Real coordinates from Rustafied EU Trio.
const LARGE_RIG = { token: 'large_oil_rig', x: 3275, y: 4329 };
const SMALL_RIG = { token: 'oil_rig_small', x: -324, y: 4334 };

function marker(id: number, type: number, x: number, y: number): RustMapMarker {
  return { id, type: type as RustMapMarker['type'], x, y };
}

/** A live feed always carries players, so snapshots are never empty. */
const filler = () => marker(999, MarkerType.Player, 2000, 2000);

function detector() {
  return new EventDetector({
    mapSize: MAP_SIZE,
    monuments: new MonumentIndex([LARGE_RIG, SMALL_RIG]),
  });
}

const t0 = new Date('2026-08-01T20:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe('a real Large Oil Rig delivery, start to finish', () => {
  it('walks markers -> event -> announcement -> status -> unlock', () => {
    const d = detector();

    // 1. Bot connects. Nothing is announced for what is already there.
    expect(d.update([filler()], t0)).toEqual([]);
    expect(describeState(d.state.get(EventSubject.LargeOilRig), fmt, t0)).toBe(
      'Large Oil Rig: no Heavy Scientists called this session',
    );

    // 2. A Chinook appears at the map edge, nowhere near the rig. Its purpose
    //    is not knowable yet, so it is reported neutrally.
    const entry = d.update([filler(), marker(20, MarkerType.CH47, 4200, 4600)], at(5));
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ type: 'ch47', phase: 'entered_map' });
    expect(formatEventLine(entry[0]!, { timezone: 'UTC' })).toContain('CHINOOK 47 ENTERED MAP');

    // 3. It flies in. Still not at the rig, so nothing new.
    expect(d.update([filler(), marker(20, MarkerType.CH47, 3800, 4450)], at(20))).toEqual([]);

    // 4. It arrives. This is the moment the game reveals its purpose.
    const arrival = d.update([filler(), marker(20, MarkerType.CH47, 3290, 4320)], at(35));
    expect(arrival).toHaveLength(1);

    const called = arrival[0]!;
    expect(called).toMatchObject({
      type: 'oil_rig_crate',
      phase: 'called',
      monument: 'Large Oil Rig',
      grid: 'TOP RIGHT',
    });

    // The countdown is anchored to arrival, not to entering the map.
    expect(called.opensAt!.getTime()).toBe(at(35).getTime() + OIL_RIG_CRATE_UNLOCK_MS);

    // 5. Both outputs read correctly.
    expect(isHighSignal(called.type, called.phase)).toBe(true);
    expect(formatEventLine(called, { timezone: 'UTC' })).toBe(
      'LARGE OIL RIG HEAVY SCIENTISTS CALLED 20:00 OPENS 20:15 @ TOP RIGHT',
    );
    expect(formatEventLineInGame(called, { timezone: 'UTC' })).toBe(
      'Large Oil Rig Heavy Scientists called @ TOP RIGHT, unlocks 20:15',
    );

    // 6. !large now counts down, which is the whole point.
    const fourMinutesLater = new Date(at(35).getTime() + 4 * 60_000);
    expect(describeState(d.state.get(EventSubject.LargeOilRig), fmt, fourMinutesLater)).toBe(
      'Large Oil Rig: Heavy Scientists called 4m ago, crate unlocks in 11m @ TOP RIGHT',
    );

    // 7. Small Oil Rig is entirely untouched by this.
    expect(describeState(d.state.get(EventSubject.SmallOilRig), fmt, fourMinutesLater)).toBe(
      'Small Oil Rig: no Heavy Scientists called this session',
    );

    // 8. The Chinook hovers, then leaves. Neither re-announces the delivery
    //    nor reports a departure -- the rig event already told the story.
    expect(d.update([filler(), marker(20, MarkerType.CH47, 3280, 4330)], at(60))).toEqual([]);
    expect(d.update([filler()], at(120))).toEqual([]);

    // 9. The unlock timer fires 15 minutes after arrival.
    const unlockAt = new Date(at(35).getTime() + OIL_RIG_CRATE_UNLOCK_MS);
    d.state.markOilRigUnlocked(EventSubject.LargeOilRig, unlockAt);

    const afterUnlock = new Date(unlockAt.getTime() + 3 * 60_000);
    expect(describeState(d.state.get(EventSubject.LargeOilRig), fmt, afterUnlock)).toBe(
      'Large Oil Rig: crate UNLOCKED @ TOP RIGHT (called 18m ago)',
    );
  });

  it('routes a Small Oil Rig delivery to the small rig only', () => {
    const d = detector();
    d.update([filler()], t0);
    d.update([filler(), marker(21, MarkerType.CH47, -900, 4500)], at(5));

    const arrival = d.update([filler(), marker(21, MarkerType.CH47, -330, 4340)], at(40));
    expect(arrival[0]).toMatchObject({
      type: 'oil_rig_crate',
      phase: 'called',
      monument: 'Small Oil Rig',
      grid: 'TOP LEFT',
    });

    expect(d.state.get(EventSubject.SmallOilRig).oilRig?.phase).toBe('triggered');
    expect(d.state.get(EventSubject.LargeOilRig).oilRig?.phase).toBe('unknown');
  });

  it('runs both rigs concurrently without interference', () => {
    // Both rigs can be triggered at once, each with its own countdown.
    const d = detector();
    d.update([filler()], t0);

    d.update(
      [filler(), marker(20, MarkerType.CH47, 3290, 4320), marker(21, MarkerType.CH47, -330, 4340)],
      at(10),
    );

    const large = d.state.get(EventSubject.LargeOilRig).oilRig!;
    const small = d.state.get(EventSubject.SmallOilRig).oilRig!;

    expect(large.phase).toBe('triggered');
    expect(small.phase).toBe('triggered');
    expect(large.unlocksAt).toEqual(small.unlocksAt);

    // Unlocking one must not unlock the other.
    d.state.markOilRigUnlocked(EventSubject.LargeOilRig, at(910));
    expect(d.state.get(EventSubject.LargeOilRig).oilRig?.phase).toBe('unlocked');
    expect(d.state.get(EventSubject.SmallOilRig).oilRig?.phase).toBe('triggered');
  });

  it('reports an elapsed countdown as unlocked even if the timer never fired', () => {
    // Covers a restart or a poll gap: the state must not keep counting down
    // past zero or show a negative time.
    const d = detector();
    d.update([filler()], t0);
    d.update([filler(), marker(20, MarkerType.CH47, 3290, 4320)], at(10));

    const wellPast = new Date(at(10).getTime() + OIL_RIG_CRATE_UNLOCK_MS + 5 * 60_000);
    expect(describeState(d.state.get(EventSubject.LargeOilRig), fmt, wellPast)).toBe(
      'Large Oil Rig: crate UNLOCKED @ TOP RIGHT',
    );
  });
});
