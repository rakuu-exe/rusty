/**
 * Monument positions, cached from getMap().
 *
 * getMap() costs 5 rate-limit tokens against a 25-token bucket, so it is called
 * once per connection (and again on wipe) rather than per poll. The cached oil
 * rig positions are what let the detector tell "a Chinook flew to Large Oil Rig
 * to drop heavy scientists" apart from "a Chinook is crossing the map to drop a
 * normal locked crate" — proximity is the only signal that distinguishes them.
 */

import { distance } from './grid.js';
import type { RustMapMonument } from './types.js';

/** Monument tokens the event detector cares about. */
export const OIL_RIG_TOKENS = {
  large: 'large_oil_rig',
  small: 'oil_rig_small',
} as const;

export type OilRigKind = keyof typeof OIL_RIG_TOKENS;

/**
 * How close a marker must be to a monument to count as "at" it.
 *
 * Large Oil Rig is roughly 100 units across and the Chinook marker appears
 * while still approaching, so this is deliberately generous. Too small and
 * rig crate calls get misreported as ordinary map crossings; too large and
 * a Chinook merely passing near the rig triggers a false alarm.
 */
export const MONUMENT_PROXIMITY_RADIUS = 200;

export interface Monument extends RustMapMonument {
  /** Display name, e.g. "Large Oil Rig". */
  displayName: string;
}

const DISPLAY_NAMES: Record<string, string> = {
  large_oil_rig: 'Large Oil Rig',
  oil_rig_small: 'Small Oil Rig',
  launchsite: 'Launch Site',
  airfield: 'Airfield',
  military_tunnels_display_name: 'Military Tunnel',
  water_treatment_plant_display_name: 'Water Treatment Plant',
  train_yard_display_name: 'Train Yard',
  power_plant_display_name: 'Power Plant',
  satellite_dish_display_name: 'Satellite Dish',
  sphere_tank: 'The Dome',
  harbor_display_name: 'Harbor',
  harbor_2_display_name: 'Harbor',
  bandit_camp: 'Bandit Camp',
  excavator: 'Giant Excavator Pit',
  junkyard_display_name: 'Junkyard',
  arctic_base_a: 'Arctic Research Base',
  ferryterminal: 'Ferry Terminal',
  nuclear_missile_silo: 'Missile Silo',
};

/** Turn a monument token into something readable, falling back to the token. */
export function monumentDisplayName(token: string): string {
  const known = DISPLAY_NAMES[token];
  if (known) return known;

  // Unknown tokens still read better with the boilerplate suffix stripped.
  return token
    .replace(/_display_name$/, '')
    .split('_')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * In-memory monument index for one server.
 *
 * A map can carry more than one of some monuments, and since the Oil Rig
 * lookup drives event classification it must consider every instance rather
 * than assuming a single position.
 */
export class MonumentIndex {
  private readonly monuments: Monument[];

  constructor(raw: RustMapMonument[]) {
    this.monuments = raw.map((m) => ({ ...m, displayName: monumentDisplayName(m.token) }));
  }

  get all(): readonly Monument[] {
    return this.monuments;
  }

  /** Every monument matching a token (maps may contain duplicates). */
  byToken(token: string): Monument[] {
    return this.monuments.filter((m) => m.token === token);
  }

  /**
   * Which oil rig, if any, a position is at.
   *
   * Returns the closest rig within MONUMENT_PROXIMITY_RADIUS, so a position
   * between two rigs resolves to the nearer one instead of whichever happened
   * to be listed first.
   */
  oilRigAt(x: number, y: number, radius = MONUMENT_PROXIMITY_RADIUS): { kind: OilRigKind; monument: Monument } | null {
    let best: { kind: OilRigKind; monument: Monument; dist: number } | null = null;

    for (const [kind, token] of Object.entries(OIL_RIG_TOKENS) as [OilRigKind, string][]) {
      for (const monument of this.byToken(token)) {
        const dist = distance(x, y, monument.x, monument.y);
        if (dist <= radius && (best === null || dist < best.dist)) {
          best = { kind, monument, dist };
        }
      }
    }

    return best ? { kind: best.kind, monument: best.monument } : null;
  }

  /** Closest monument of any kind within `radius`, or null. */
  nearest(x: number, y: number, radius = MONUMENT_PROXIMITY_RADIUS): Monument | null {
    let best: { monument: Monument; dist: number } | null = null;

    for (const monument of this.monuments) {
      const dist = distance(x, y, monument.x, monument.y);
      if (dist <= radius && (best === null || dist < best.dist)) {
        best = { monument, dist };
      }
    }

    return best?.monument ?? null;
  }
}
