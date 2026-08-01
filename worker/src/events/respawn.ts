/**
 * Approximate respawn predictions for the `!when-*` commands.
 *
 * Deliberately learns each server's cadence from what it has actually observed
 * rather than shipping hardcoded vanilla intervals. Rust randomises spawn
 * timers, and community servers routinely override them — Rustafied's cargo
 * and heli timings are not vanilla — so a hardcoded table would state a
 * confident number that is simply wrong. Saying "not enough history yet" is
 * less satisfying and considerably more honest.
 *
 * The median interval is used rather than the mean: one long gap because the
 * bot was offline, or one server restart, would drag a mean badly.
 *
 * Deep Sea is the exception and is handled separately — see deepSeaState().
 * It has no map marker at all, so nothing can be observed; its cycle is fixed
 * by server convars and must be predicted from a known anchor instead.
 */

/** Minimum observed spawns before an interval is worth quoting. */
export const MIN_OBSERVATIONS = 2;

/**
 * Intervals longer than this are treated as gaps in observation rather than
 * genuine spawn cycles — most likely the bot was down. No Rust event has a
 * natural period anywhere near 12 hours.
 */
export const MAX_PLAUSIBLE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface RespawnEstimate {
  /** Whether the thing is on the map right now. */
  active: boolean;
  /** ms until the next expected spawn. Negative means overdue. */
  nextInMs: number | null;
  /** ms since the last observed spawn. */
  sinceLastMs: number | null;
  /** Median observed interval, or null when there is not enough history. */
  intervalMs: number | null;
  /** How many spawns this estimate is based on. */
  observations: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Estimate the next spawn from observed spawn timestamps.
 *
 * `spawnTimes` must be newest first, matching how the event log is queried.
 */
export function estimateRespawn(
  spawnTimes: Date[],
  options: { active: boolean; now?: Date } = { active: false },
): RespawnEstimate {
  const now = options.now ?? new Date();

  if (spawnTimes.length === 0) {
    return { active: options.active, nextInMs: null, sinceLastMs: null, intervalMs: null, observations: 0 };
  }

  const last = spawnTimes[0]!;
  const sinceLastMs = now.getTime() - last.getTime();

  const intervals: number[] = [];
  for (let i = 0; i < spawnTimes.length - 1; i++) {
    const gap = spawnTimes[i]!.getTime() - spawnTimes[i + 1]!.getTime();
    if (gap > 0 && gap <= MAX_PLAUSIBLE_INTERVAL_MS) intervals.push(gap);
  }

  if (spawnTimes.length < MIN_OBSERVATIONS || intervals.length === 0) {
    return {
      active: options.active,
      nextInMs: null,
      sinceLastMs,
      intervalMs: null,
      observations: spawnTimes.length,
    };
  }

  const intervalMs = median(intervals);

  return {
    active: options.active,
    nextInMs: last.getTime() + intervalMs - now.getTime(),
    sinceLastMs,
    intervalMs,
    observations: spawnTimes.length,
  };
}

// ---------------------------------------------------------------------------
// Deep Sea
// ---------------------------------------------------------------------------

/**
 * Deep Sea zone cycle, from server convars.
 *
 * It is not an entity, so it never appears in the Rust+ marker feed — there is
 * nothing to detect. What makes it predictable anyway is that the cycle is
 * fixed: given one confirmed open time, every subsequent open and close
 * follows arithmetically.
 *
 * Defaults are the vanilla convar values. A server that has changed
 * deepsea.wipeduration or deepsea.wipecooldown will drift, which is why the
 * anchor can be re-set at any time.
 */
export const DEEP_SEA_OPEN_MS = 10_800_000; // deepsea.wipeduration, 3h
export const DEEP_SEA_COOLDOWN_MS = 5_400_000; // deepsea.wipecooldown, 90m
export const DEEP_SEA_RADIATION_MS = 300_000; // deepsea.wiperadiationphaseduration, 5m

export const DEEP_SEA_CYCLE_MS = DEEP_SEA_OPEN_MS + DEEP_SEA_COOLDOWN_MS;

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
 * The anchor may be any past open; the cycle is projected forward with
 * modulo arithmetic so an anchor from days ago is still valid, assuming the
 * convars have not changed.
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

  // Modulo keeps a stale anchor usable; the extra cycleMs makes it correct for
  // an anchor slightly in the future (clock skew, or a scheduled open).
  const phase = ((elapsed % cycleMs) + cycleMs) % cycleMs;

  if (phase < openMs) {
    const closesInMs = openMs - phase;
    return {
      open: true,
      closesInMs,
      opensInMs: null,
      radiationPhase: closesInMs <= radiationMs,
    };
  }

  return {
    open: false,
    closesInMs: null,
    opensInMs: cycleMs - phase,
    radiationPhase: false,
  };
}
