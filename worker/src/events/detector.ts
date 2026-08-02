/**
 * Turns successive getMapMarkers() snapshots into domain events.
 *
 * Deliberately pure and synchronous: no network, no database, no timers. That
 * makes the whole of v1's event logic testable by replaying recorded marker
 * snapshots, instead of waiting for a real Patrol Helicopter to spawn.
 *
 * Three judgement calls live here and are worth understanding before tuning:
 *
 *  - A CH47 is classified as an oil rig delivery purely by proximity to a rig
 *    monument, checked continuously for the Chinook's whole flight. There is no
 *    flag in the API saying "heavy scientists were called"; the Chinook
 *    reaching a rig *is* the signal. Get the monument cache wrong and every map
 *    crossing becomes a false rig alert.
 *
 *  - A Patrol Helicopter that vanishes was either shot down or flew off the
 *    map edge, and the API does not say which. It is inferred from *where* it
 *    vanished: inland means destroyed, at the boundary means departed.
 *
 *  - A locked crate drop is invisible, since crate markers were removed. It is
 *    inferred from the Chinook slowing to a hover beside a monument, which is
 *    what it does while lowering the crate.
 *
 * All three are inferences, not facts the game reports, and each is documented
 * where it is implemented. What remains genuinely unknowable — whether a crate
 * is sitting on an oil rig, and the Deep Sea zone — is in the README.
 */

import { formatGridPosition, getCorrectedMapSize, isOutsideGridSystem, distance } from '../rustplus/grid.js';
import type { MonumentIndex } from '../rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../rustplus/types.js';
import { OIL_RIG_CRATE_UNLOCK_MS } from './constants.js';
import { EventStateStore, EventSubject, type EventSubjectValue } from './state.js';
import type { DetectedEvent } from './types.js';

// Re-exported so existing callers keep a single import site for detection.
export { OIL_RIG_CRATE_UNLOCK_MS, CARGO_SHIP_EGRESS_MS } from './constants.js';

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
 * How close a Chinook must get to a rig to count as delivering Heavy
 * Scientists.
 *
 * Wider than the general monument radius because the marker is only sampled
 * every few seconds while the Chinook is moving fast, so it can cross a tight
 * radius entirely between two polls. False positives are unlikely: the rigs
 * sit alone offshore, and a Chinook bound for a land monument has no reason to
 * pass this close to one.
 */
export const OIL_RIG_CHINOOK_RADIUS = 300;

/**
 * How long an Explosion stays relevant. The crash marker usually appears in
 * the same poll the heli disappears, but ordering is not guaranteed, so recent
 * explosions are remembered rather than only read from the current snapshot.
 *
 * Note that Explosion markers appear to have been removed from the companion
 * API along with crate markers, so in practice this evidence is rarely if ever
 * available — see the position heuristic below, which is the primary signal.
 */
export const EXPLOSION_MEMORY_MS = 90_000;

/**
 * How close to the map edge a helicopter must vanish to count as having flown
 * away rather than been destroyed.
 *
 * The Patrol Helicopter leaves by flying out over the boundary, so its last
 * seen position is at or beyond the edge. One destroyed in a fight drops where
 * it was fighting, which is inland. Roughly two grid cells of tolerance covers
 * the gap between polls as it crosses out.
 */
export const HELI_EDGE_MARGIN = 300;

/**
 * Inferring a locked crate drop from Chinook movement.
 *
 * Crate markers were removed from the companion API, so a dropped crate is
 * invisible. What remains visible is the Chinook, and its behaviour gives the
 * drop away: it cruises to a monument, slows to a near-stop while it lowers
 * the crate, then departs. A sustained hover beside a monument is therefore a
 * strong proxy for "a crate was just dropped here".
 *
 * These thresholds are reasoned from observed cruise speed rather than
 * measured from a live drop, and are the first thing to tune if the inference
 * proves noisy. `scripts/analyse-chinooks.mjs` prints speed profiles from
 * recorded feeds for exactly that purpose.
 */

/** Below this speed (units/second) the Chinook is considered stationary. */
export const CHINOOK_HOVER_SPEED = 5;

/**
 * Consecutive stationary samples required before calling it a drop.
 *
 * One sample could be a poll landing either side of a turn. Two consecutive
 * samples is roughly ten seconds of not moving, which cruising never produces.
 */
export const CHINOOK_HOVER_SAMPLES = 2;

/** How close the hover must be to a monument to attribute the drop to it. */
export const CHINOOK_DROP_MONUMENT_RADIUS = 250;

interface TrackedMarker {
  marker: RustMapMarker;
  firstSeen: Date;
  lastSeen: Date;
  /** Set for a CH47 that was announced as an oil rig crate call. */
  oilRig?: string;
  /** Previous sample, for computing speed between polls. */
  previous?: { x: number; y: number; at: Date };
  /** Consecutive samples below the hover threshold. */
  hoverSamples: number;
  /** Set once a crate drop has been inferred, so it fires only once. */
  droppedCrate?: boolean;
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
        this.tracked.set(marker.id, { marker, firstSeen: now, lastSeen: now, hoverSamples: 0, previous: { x: marker.x, y: marker.y, at: now } });

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

        // A Chinook is watched for its whole flight, not just judged where it
        // appeared. It spawns at the map edge and flies to its destination, so
        // checking only on arrival in the feed missed every oil rig delivery.
        events.push(...this.checkChinookReachedRig(marker, existing, now));
        events.push(...this.checkChinookDroppedCrate(marker, existing, now));

        // Recorded after the checks above, which need the prior sample.
        existing.previous = { x: marker.x, y: marker.y, at: now };

        const subject = this.subjectFor(marker, markers);
        if (subject) this.state.markSeen(subject, now, this.grid(marker.x, marker.y));
        continue;
      }

      const tracker: TrackedMarker = { marker, firstSeen: now, lastSeen: now, hoverSamples: 0, previous: { x: marker.x, y: marker.y, at: now } };
      this.tracked.set(marker.id, tracker);
      events.push(...this.onAppeared(marker, tracker, now, markers));
    }

    /**
     * An empty snapshot is a feed glitch, not the map emptying.
     *
     * A live server always has players and vending machines in the feed, so
     * zero markers means the response was malformed or the server was
     * mid-restart. Processing it as disappearances would report the helicopter
     * as destroyed and the cargo as departed, all at once and all wrong.
     */
    if (markers.length === 0 && this.tracked.size > 0) {
      return events;
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

  /**
   * Has this Chinook arrived at an oil rig?
   *
   * Called on every poll for as long as the Chinook exists, because it flies
   * in from the map edge and only reaches the rig some way into its life.
   * Judging it once, where it first appeared, missed every real delivery: four
   * Chinooks reached the rigs in a single evening and all four were logged as
   * ordinary map crossings.
   *
   * Fires at most once per Chinook — `tracker.oilRig` records that the
   * delivery has been reported, so hovering over the rig for several polls
   * does not re-announce it or re-arm the countdown.
   */
  private checkChinookReachedRig(
    marker: RustMapMarker,
    tracker: TrackedMarker,
    now: Date,
  ): DetectedEvent[] {
    if (marker.type !== MarkerType.CH47) return [];
    if (tracker.oilRig) return [];

    const rig = this.monuments.oilRigAt(marker.x, marker.y, OIL_RIG_CHINOOK_RADIUS);
    if (!rig) return [];

    tracker.oilRig = rig.monument.displayName;

    const subject = rig.kind === 'large' ? EventSubject.LargeOilRig : EventSubject.SmallOilRig;
    const rigGrid = this.grid(rig.monument.x, rig.monument.y);

    // The countdown is anchored to the Chinook's arrival at the rig, which is
    // the moment the game actually reveals.
    const unlocksAt = new Date(now.getTime() + OIL_RIG_CRATE_UNLOCK_MS);
    this.state.markOilRigTriggered(subject, now, unlocksAt, rigGrid);

    return [
      {
        type: 'oil_rig_crate',
        phase: 'called',
        markerId: String(marker.id),
        monument: rig.monument.displayName,
        // Report the rig's own position rather than the Chinook's, which may
        // still be slightly out as it settles.
        x: rig.monument.x,
        y: rig.monument.y,
        grid: rigGrid,
        at: now,
        opensAt: unlocksAt,
      },
    ];
  }

  /**
   * Has this Chinook just dropped a locked crate?
   *
   * Inferred from movement, because the crate itself is invisible: crate
   * markers were removed from the companion API, so nothing appears on the map
   * when one lands. What is still visible is the Chinook, which slows to a
   * hover over the monument while lowering the crate and then flies on.
   *
   * Requiring several consecutive stationary samples beside a monument
   * separates that from cruising, which never produces near-zero movement.
   * This is an inference and is labelled as such in the alert — a hover is
   * strong evidence of a drop, not proof of one.
   *
   * Oil rig deliveries also hover, so those are excluded: they have already
   * been reported through the rig lifecycle.
   */
  private checkChinookDroppedCrate(
    marker: RustMapMarker,
    tracker: TrackedMarker,
    now: Date,
  ): DetectedEvent[] {
    if (marker.type !== MarkerType.CH47) return [];
    if (tracker.oilRig || tracker.droppedCrate) return [];

    const previous = tracker.previous;
    if (!previous) return [];

    const seconds = (now.getTime() - previous.at.getTime()) / 1000;
    if (seconds <= 0) return [];

    const speed = distance(previous.x, previous.y, marker.x, marker.y) / seconds;

    if (speed > CHINOOK_HOVER_SPEED) {
      tracker.hoverSamples = 0;
      return [];
    }

    tracker.hoverSamples += 1;
    if (tracker.hoverSamples < CHINOOK_HOVER_SAMPLES) return [];

    /**
     * Crate drops happen on the mainland.
     *
     * Both Oil Rigs sit outside the grid entirely — on this map at y≈4330
     * against a corrected size of 3948.75 — so an in-grid hover separates a
     * monument drop from a rig delivery on position alone. That matters
     * because the only other thing keeping them apart is the 300u rig radius
     * on tracker.oilRig, and a single missed sample on approach would leak a
     * rig delivery through as a phantom crate drop.
     *
     * Measured: the two recorded Chinooks hovered at (-335, 4296) and
     * (3271, 4358). Both are off-grid, and both were rig deliveries.
     */
    if (isOutsideGridSystem(marker.x, marker.y, this.mapSize)) return [];

    // A hover in open ground is not a drop worth reporting; crates land at
    // monuments, and naming the monument is most of the value of the alert.
    const monument = this.monuments.nearest(marker.x, marker.y, CHINOOK_DROP_MONUMENT_RADIUS);
    if (!monument) return [];

    tracker.droppedCrate = true;

    return [
      {
        type: 'locked_crate',
        phase: 'dropped',
        markerId: String(marker.id),
        monument: monument.displayName,
        x: marker.x,
        y: marker.y,
        grid: this.grid(marker.x, marker.y),
        at: now,
      },
    ];
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
         * A Chinook's purpose is not knowable when it appears.
         *
         * It spawns at the map edge and flies onward, so at this moment it is
         * simply "a Chinook entered the map". Whether it is delivering Heavy
         * Scientists to Large Oil Rig, to Small Oil Rig, or crossing to drop a
         * locked crate at a monument only becomes clear from where it goes —
         * which is tracked by checkChinookReachedRig on later polls.
         *
         * It can still be at a rig already on the poll it appears, so that
         * check runs here too.
         */
        const reached = this.checkChinookReachedRig(marker, tracker, now);
        if (reached.length > 0) return reached;

        return [{ ...base, type: 'ch47', phase: 'entered_map' }];
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
        const downed = this.wasDowned(marker.x, marker.y);
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

  /**
   * Was the helicopter destroyed, or did it fly away?
   *
   * The API says neither, so this is inference from where it vanished. A heli
   * leaves by flying out over the map boundary, so its last position is at or
   * past the edge; one that is destroyed falls where it was fighting, inland.
   *
   * This replaced an explosion-marker check as the primary signal, because
   * Explosion markers appear to have been removed from the companion API in
   * the same change that removed crate markers — meaning the old logic could
   * never fire and every downed heli was reported as having left. An explosion
   * is still accepted as corroboration on the rare chance one shows up.
   */
  private wasDowned(x: number, y: number): boolean {
    const nearExplosion = this.explosions.some((e) => distance(x, y, e.x, e.y) <= this.heliDownedRadius);
    if (nearExplosion) return true;

    const corrected = getCorrectedMapSize(this.mapSize);
    const distanceToEdge = Math.min(x, y, corrected - x, corrected - y);

    return distanceToEdge > HELI_EDGE_MARGIN;
  }
}
