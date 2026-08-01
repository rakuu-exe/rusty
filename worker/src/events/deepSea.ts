/**
 * Deep Sea zone cycle.
 *
 * Deep Sea is the one tracked event that cannot be observed at all. It is a
 * zone rather than an entity, so it never appears in the Rust+ marker feed —
 * there is no packet to watch for, and no amount of polling will reveal it.
 *
 * What makes it predictable anyway is that its cycle is fixed by server
 * convars. Given one confirmed open time, every subsequent open and close
 * follows arithmetically. That anchor has to come from a human, which is why
 * it is recorded through an explicit admin command rather than inferred:
 * status commands stay read-only, and the bot never invents an anchor.
 *
 * Without an anchor the honest answer is "not observed this session".
 */

/** deepsea.wipeduration — how long the zone stays open. */
export const DEEP_SEA_OPEN_MS = 10_800_000; // 3h

/** deepsea.wipecooldown — how long it stays closed. */
export const DEEP_SEA_COOLDOWN_MS = 5_400_000; // 90m

/** deepsea.wiperadiationphaseduration — radiation ramp before close. */
export const DEEP_SEA_RADIATION_MS = 300_000; // 5m

export const DEEP_SEA_CYCLE_MS = DEEP_SEA_OPEN_MS + DEEP_SEA_COOLDOWN_MS;

export interface DeepSeaAnchor {
  /** A confirmed time at which the zone opened. */
  openedAt: Date;
}

export interface DeepSeaState {
  open: boolean;
  /** ms until it closes, when open. */
  closesInMs: number | null;
  /** ms until it opens, when closed. */
  opensInMs: number | null;
  /** True during the radiation ramp before close. */
  radiationPhase: boolean;
}

/**
 * Where the cycle currently sits, given a known open time.
 *
 * The anchor may be any past open; the cycle is projected forward with modulo
 * arithmetic so an anchor from days ago remains valid, provided the convars
 * have not changed. A server running non-default durations will drift, which
 * is why re-anchoring is always allowed.
 */
export function deepSeaState(
  anchorOpenedAt: Date,
  now: Date = new Date(),
  cycle: { openMs?: number; cooldownMs?: number; radiationMs?: number } = {},
): DeepSeaState {
  const openMs = cycle.openMs ?? DEEP_SEA_OPEN_MS;
  const cooldownMs = cycle.cooldownMs ?? DEEP_SEA_COOLDOWN_MS;
  const radiationMs = cycle.radiationMs ?? DEEP_SEA_RADIATION_MS;
  const cycleMs = openMs + cooldownMs;

  const elapsed = now.getTime() - anchorOpenedAt.getTime();

  // The extra cycleMs keeps this correct for an anchor slightly in the future
  // (clock skew), where a bare modulo would go negative.
  const phase = ((elapsed % cycleMs) + cycleMs) % cycleMs;

  if (phase < openMs) {
    const closesInMs = openMs - phase;
    return { open: true, closesInMs, opensInMs: null, radiationPhase: closesInMs <= radiationMs };
  }

  return { open: false, closesInMs: null, opensInMs: cycleMs - phase, radiationPhase: false };
}
