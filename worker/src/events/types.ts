/** Domain events produced by the detector and consumed by Discord/in-game output. */

export type RustEventType =
  | 'patrol_helicopter'
  | 'cargo_ship'
  | 'ch47'
  | 'oil_rig_crate'
  | 'locked_crate';

export type RustEventPhase =
  | 'entered_map'
  | 'left_map'
  | 'downed'
  | 'called'
  | 'unlocked'
  | 'egress'
  | 'dropped';

export interface DetectedEvent {
  type: RustEventType;
  phase: RustEventPhase;
  /** Rust+ marker id, or null for timer-driven events that have no marker. */
  markerId: string | null;
  x: number;
  y: number;
  /** Rendered grid label, e.g. "W4" or "outside grid, SE". */
  grid: string;
  /** Monument display name when the event is tied to one, e.g. "Large Oil Rig". */
  monument?: string;
  at: Date;
  /** For oil rig crates: when the 15 minute unlock completes. */
  opensAt?: Date;
}

/** Timer kinds persisted in active_timers. */
export const TimerKind = {
  OilRigCrateUnlock: 'oil_rig_crate_unlock',
  CargoShipEgress: 'cargo_ship_egress',
} as const;

export type TimerKindValue = (typeof TimerKind)[keyof typeof TimerKind];
