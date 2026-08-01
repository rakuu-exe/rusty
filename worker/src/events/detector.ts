/**
 * Turns successive getMapMarkers() snapshots into domain events.
 *
 * Deliberately pure and synchronous: no network, no database, no timers. That
 * makes the whole of v1's event logic testable by replaying recorded marker
 * snapshots, instead of waiting for a real Patrol Helicopter to spawn.
 *
 * Two judgement calls live here and are worth understanding before tuning:
 *
 *  - A CH47 is classified as an oil rig crate call purely by proximity to a
 *    rig monument. There is no flag in the API saying "heavy scientists were
 *    called"; the Chinook flying to a rig *is* the signal. Get the monument
 *    cache wrong and every map crossing becomes a false rig alert.
 *
 *  - A Patrol Helicopter that vanishes was either shot down or flew off the
 *    map edge. The API does not say which. An Explosion marker near its last
 *    known position is the only available evidence, so "downed" is a heuristic
 *    and can be fooled by a rocket landing nearby at the wrong moment.
 */

import { formatGridPosition, distance } from '../rustplus/grid.js';
import type { MonumentIndex } from '../rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../rustplus/types.js';
import { EventStateStore, EventSubject, type EventSubjectValue } from './state.js';
import type { DetectedEvent } from './types.js';

/** Locked crate at an oil rig unlocks 15 minutes after heavy scientists land. */
export const OIL_RIG_CRATE_UNLOCK_MS = 15 * 60 * 1000;

/** Cargo Ship begins leaving the map 50 minutes after it spawns. */
export const CARGO_SHIP_EGRESS_MS = 50 * 60 * 1000;

/**
 * How close an Explosion must be to the helicopter's last position to count as
 * its wreck. Generous, because the marker lands where debris settles rather
 * than where the heli was last polled -- up to a few hundred units away when
 * it was moving fast.
 */
export const HELI_DOWNED_RADIUS = 350;

/**
 * How close a Crate must be to a Cargo Ship marker to count as being aboard.
 *
 * The ship is roughly 200 units long and its crates sit along the deck, while
 * the marker is a single point at the centre. Generous enough to catch crates
 * at the bow and stern, tight enough that a crate on a nearby shore is not
 * mistaken for one on the ship.
 */
export const CARGO_CRATE_RADIUS = 200;

/**
 * How long an Explosion stays relevant. The crash marker usually appears in
 * the same poll the heli disappears, but ordering is not guaranteed, so recent
 * explosions are remembered rather than only read from the current snapshot.
 */
export const EXPLOSION_MEMORY_MS = 90_000;

interface TrackedMarker {
  marker: RustMapMarker;
  firstSeen: Date;
  lastSeen: Date;
  /** Set for a CH47 that was announced as an oil rig crate call. */
  oilRig?: string;
}

interface RememberedExplosion {
  x: number;
  y: number;
  at: Date;
}

export interface DetectorOptions {
  mapSize: number;
  monuments: MonumentIndex;
  heliDownedRadius?: number;
  explosionMemoryMs?: number;
}

export class EventDetector {
  private readonly tracked = new Map<number, TrackedMarker>();
  private readonly explosions: RememberedExplosion[] = [];
  private primed = false;

  /**
   * Session state, updated only from real marker transitions.
   *
   * Exposed for commands to read. Nothing outside this class writes to it
   * except the timer that resolves an oil rig unlock, which is itself driven
   * by an observed Chinook arrival rather than by anyone asking a question.
   */
  readonly state = new EventStateStore();

  private readonly mapSize: number;
  private readonly monuments: MonumentIndex;
  private readonly heliDownedRadius: number;
  private readonly explosionMemoryMs: number;

  constructor(options: DetectorOptions) {
    this.mapSize = options.mapSize;
    this.monuments = options.monuments;
    this.heliDownedRadius = options.heliDownedRadius ?? HELI_DOWNED_RADIUS;
    this.explosionMemoryMs = options.explosionMemoryMs ?? EXPLOSION_MEMORY_MS;
  }

  /** True once the first snapshot has seeded state. */
  get isPrimed(): boolean {
    return this.primed;
  }

  /**
   * Feed one snapshot and get the events it implies.
   *
   * The first call only seeds state and returns nothing: on connect the map is
   * already full of markers, and announcing them would spam "CARGO SHIP
   * ENTERED MAP" for a ship that has been sailing for half an hour.
   */
  update(markers: RustMapMarker[], now: Date = new Date()): DetectedEvent[] {
    const current = new Map<number, RustMapMarker>();
    for (const marker of markers) current.set(marker.id, marker);

    this.rememberExplosions(markers, now);

    if (!this.primed) {
      /**
       * Synchronise the world without announcing or inventing anything.
       *
       * Whatever is on the map now is recorded as active with **no start
       * time** — the bot did not see it spawn and must not imply otherwise.
       * No events are emitted and no timers are armed.
       */
      for (const marker of markers) {
        this.tracked.set(marker.id, { marker, firstSeen: now, lastSeen: now });

        const subject = this.subjectFor(marker, markers);
        if (subject) this.state.markPresentAtStartup(subject, now, this.grid(marker.x, marker.y));
      }
      this.primed = true;
      return [];
    }

    const events: DetectedEvent[] = [];

    for (const marker of markers) {
      const existing = this.tracked.get(marker.id);
      if (existing) {
        // Keep positions fresh so a despawn is compared against where the
        // marker actually was, not where it first appeared.
        existing.marker = marker;
        existing.lastSeen = now;

        const subject = this.subjectFor(marker, markers);
        if (subject) this.state.markSeen(subject, now, this.grid(marker.x, marker.y));
        continue;
      }

      const tracker: TrackedMarker = { marker, firstSeen: now, lastSeen: now };
      this.tracked.set(marker.id, tracker);
      events.push(...this.onAppeared(marker, tracker, now, markers));
    }

    for (const [id, tracker] of [...this.tracked]) {
      if (current.has(id)) continue;
      this.tracked.delete(id);
      events.push(...this.onDisappeared(tracker, now));
    }

    return events;
  }

  private rememberExplosions(markers: RustMapMarker[], now: Date): void {
    for (const marker of markers) {
      if (marker.type !== MarkerType.Explosion) continue;
      if (this.tracked.has(marker.id)) continue;
      this.explosions.push({ x: marker.x, y: marker.y, at: now });
    }

    const cutoff = now.getTime() - this.explosionMemoryMs;
    while (this.explosions.length > 0 && this.explosions[0]!.at.getTime() < cutoff) {
      this.explosions.shift();
    }
  }

  /** Cell when on the map, region when beyond its edge. */
  private grid(x: number, y: number): string {
    return formatGridPosition(x, y, this.mapSize);
  }

  /**
   * Which tracked subject a marker belongs to, if any.
   *
   * Crates are context-dependent: one at an oil rig belongs to that rig, one
   * on the Cargo Ship belongs to the ship, and one anywhere else is a monument
   * drop. That distinction is what keeps Large and Small Oil Rig independent.
   */
  private subjectFor(marker: RustMapMarker, snapshot: RustMapMarker[]): EventSubjectValue | null {
    switch (marker.type) {
      case MarkerType.PatrolHelicopter:
        return EventSubject.PatrolHelicopter;

      case MarkerType.CargoShip:
        return EventSubject.CargoShip;

      case MarkerType.TravellingVendor:
        return EventSubject.TravellingVendor;

      case MarkerType.CH47:
        // A Chinook at a rig is that rig's Heavy Scientist delivery and is
        // handled through the rig's lifecycle, not as a Chinook of its own.
        return this.monuments.oilRigAt(marker.x, marker.y) ? null : EventSubject.MonumentChinook;

      case MarkerType.Crate: {
        const rig = this.monuments.oilRigAt(marker.x, marker.y);
        if (rig) return rig.kind === 'large' ? EventSubject.LargeOilRig : EventSubject.SmallOilRig;
        if (this.cargoShipAt(marker.x, marker.y, snapshot)) return null;
        return EventSubject.LockedCrate;
      }

      default:
        return null;
    }
  }

  /** Cargo Ship marker nearest this position, if the crate is aboard one. */
  private cargoShipAt(x: number, y: number, snapshot: RustMapMarker[]): RustMapMarker | null {
    let best: { marker: RustMapMarker; dist: number } | null = null;

    for (const candidate of snapshot) {
      if (candidate.type !== MarkerType.CargoShip) continue;
      const dist = distance(x, y, candidate.x, candidate.y);
      if (dist <= CARGO_CRATE_RADIUS && (best === null || dist < best.dist)) {
        best = { marker: candidate, dist };
      }
    }

    return best?.marker ?? null;
  }

  private onAppeared(
    marker: RustMapMarker,
    tracker: TrackedMarker,
    now: Date,
    snapshot: RustMapMarker[],
  ): DetectedEvent[] {
    const base = {
      markerId: String(marker.id),
      x: marker.x,
      y: marker.y,
      grid: this.grid(marker.x, marker.y),
      at: now,
    };

    // Anything with a plain lifecycle records its spawn here. Crates and rig
    // Chinooks are handled in their own branches below, where the context
    // needed to identify the subject is available.
    const simple = this.subjectFor(marker, snapshot);
    if (simple && marker.type !== MarkerType.Crate) {
      this.state.markSpawned(simple, now, base.grid);
    }

    switch (marker.type) {
      case MarkerType.PatrolHelicopter:
        return [{ ...base, type: 'patrol_helicopter', phase: 'entered_map' }];

      case MarkerType.CargoShip:
        return [{ ...base, type: 'cargo_ship', phase: 'entered_map' }];

      case MarkerType.TravellingVendor:
        return [{ ...base, type: 'travelling_vendor', phase: 'entered_map' }];

      case MarkerType.CH47: {
        /**
         * Three distinct events share this marker type and must never be
         * merged: a Chinook delivering Heavy Scientists to Large Oil Rig, the
         * same to Small Oil Rig, and a Chinook crossing the map to drop a
         * locked crate at a monument. Proximity to a rig is the only signal
         * that separates them.
         */
        const rig = this.monuments.oilRigAt(marker.x, marker.y);
        if (!rig) {
          return [{ ...base, type: 'ch47', phase: 'entered_map' }];
        }

        const subject = rig.kind === 'large' ? EventSubject.LargeOilRig : EventSubject.SmallOilRig;
        const rigGrid = this.grid(rig.monument.x, rig.monument.y);

        // The countdown is anchored to the Chinook's arrival, the only moment
        // the game actually reveals.
        const unlocksAt = new Date(now.getTime() + OIL_RIG_CRATE_UNLOCK_MS);
        this.state.markOilRigTriggered(subject, now, unlocksAt, rigGrid);

        tracker.oilRig = rig.monument.displayName;
        return [
          {
            ...base,
            type: 'oil_rig_crate',
            phase: 'called',
            monument: rig.monument.displayName,
            // Report the rig's own position rather than the Chinook's, which
            // may still be a hundred units out on approach.
            x: rig.monument.x,
            y: rig.monument.y,
            grid: rigGrid,
            opensAt: unlocksAt,
          },
        ];
      }

      case MarkerType.Crate: {
        /**
         * A crate appearing at an oil rig is that rig's locked crate
         * respawning, which makes the rig available again.
         *
         * An earlier version discarded these outright, worried that the crate
         * permanently sitting on a rig would be announced on every reconnect.
         * That guard was unnecessary — startup synchronisation already absorbs
         * whatever is on the map when the bot connects — so all it achieved was
         * throwing away every genuine respawn.
         */
        const rig = this.monuments.oilRigAt(marker.x, marker.y);
        if (rig) {
          const subject = rig.kind === 'large' ? EventSubject.LargeOilRig : EventSubject.SmallOilRig;
          const rigGrid = this.grid(rig.monument.x, rig.monument.y);
          this.state.markSpawned(subject, now, rigGrid);

          return [
            {
              ...base,
              type: 'oil_rig_crate',
              phase: 'spawned',
              monument: rig.monument.displayName,
              x: rig.monument.x,
              y: rig.monument.y,
              grid: rigGrid,
            },
          ];
        }

        if (!this.cargoShipAt(marker.x, marker.y, snapshot)) {
          this.state.markSpawned(EventSubject.LockedCrate, now, base.grid);
        }

        // A crate riding the Cargo Ship, rather than one dropped on land.
        // Checked before the monument lookup because the ship sails past
        // coastal monuments and would otherwise be attributed to them.
        if (this.cargoShipAt(marker.x, marker.y, snapshot)) {
          return [{ ...base, type: 'cargo_crate', phase: 'spawned' }];
        }

        const monument = this.monuments.nearest(marker.x, marker.y);
        return [
          {
            ...base,
            type: 'locked_crate',
            phase: 'dropped',
            ...(monument ? { monument: monument.displayName } : {}),
          },
        ];
      }

      default:
        // Players, vending machines, explosions and generic radii are not
        // announced. Explosions are still recorded, above, as heli evidence.
        return [];
    }
  }

  private onDisappeared(tracker: TrackedMarker, now: Date): DetectedEvent[] {
    const { marker } = tracker;
    const base = {
      markerId: String(marker.id),
      x: marker.x,
      y: marker.y,
      grid: this.grid(marker.x, marker.y),
      at: now,
    };

    // The snapshot no longer contains this marker, so pass an empty one: a
    // vanished crate cannot still be aboard a ship.
    const subject = this.subjectFor(marker, []);
    if (subject) this.state.markEnded(subject, now);

    switch (marker.type) {
      case MarkerType.PatrolHelicopter: {
        const downed = this.wasDownedNear(marker.x, marker.y);
        return [{ ...base, type: 'patrol_helicopter', phase: downed ? 'downed' : 'left_map' }];
      }

      case MarkerType.CargoShip:
        return [{ ...base, type: 'cargo_ship', phase: 'left_map' }];

      case MarkerType.TravellingVendor:
        return [{ ...base, type: 'travelling_vendor', phase: 'left_map' }];

      case MarkerType.CH47:
        // A Chinook that was announced as an oil rig call has already told the
        // story; its departure is noise. Only map crossings report leaving.
        if (tracker.oilRig) return [];
        return [{ ...base, type: 'ch47', phase: 'left_map' }];

      default:
        return [];
    }
  }

  /** True when a remembered explosion sits close to the given position. */
  private wasDownedNear(x: number, y: number): boolean {
    return this.explosions.some((e) => distance(x, y, e.x, e.y) <= this.heliDownedRadius);
  }
}
