/**
 * Game timings, shared between detection and status rendering.
 *
 * Kept apart from the detector so the status layer can use them without
 * importing detection logic, which would be a cycle.
 *
 * These are vanilla values. A server that overrides them will drift, and the
 * symptom is a countdown that does not match what the game shows.
 */

/** Locked crate at an oil rig unlocks 15 minutes after Heavy Scientists land. */
export const OIL_RIG_CRATE_UNLOCK_MS = 15 * 60 * 1000;

/** Cargo Ship begins leaving the map 50 minutes after it spawns. */
export const CARGO_SHIP_EGRESS_MS = 50 * 60 * 1000;
