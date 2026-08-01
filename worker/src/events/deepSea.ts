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

/**
 * Parse a duration like "2h6m", "90m", "1h", "45s".
 *
 * Used to anchor from the countdown the game displays, which is far more
 * reliable than catching the exact moment the zone opens: anchoring on "it
 * just opened" silently produces wrong predictions forever if the moment was
 * missed by even a few minutes, and there is no way for the bot to notice.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g)];

  if (matches.length === 0) {
    // A bare number is read as minutes, the unit people mean by default here.
    // Empty input must not slip through as Number('') === 0.
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    return Number(text) * 60_000;
  }

  const unit = { h: 3_600_000, m: 60_000, s: 1000 } as const;
  let total = 0;
  for (const [, value, suffix] of matches) {
    total += Number(value) * unit[suffix as keyof typeof unit];
  }
  return total;
}

/**
 * Derive the open time from the in-game countdown to close.
 *
 * If the zone closes in `closesInMs` and stays open for `openMs`, then it
 * opened `openMs - closesInMs` ago.
 */
export function anchorFromClosesIn(
  closesInMs: number,
  now: Date = new Date(),
  openMs: number = DEEP_SEA_OPEN_MS,
): DeepSeaAnchor {
  return { openedAt: new Date(now.getTime() - (openMs - closesInMs)) };
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
