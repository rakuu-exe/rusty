/**
 * Next-occurrence estimates, derived only from observed spawns.
 *
 * This sits deliberately at the edge of the "commands never estimate" rule.
 * The rule exists to stop the bot inventing timers it has no basis for, and
 * that still holds: nothing here fabricates anything. An estimate appears only
 * when the bot has watched the same thing spawn several times and can measure
 * the gap itself. With fewer than two observations there is no estimate, and
 * the status says so rather than guessing.
 *
 * No hardcoded vanilla intervals, because community servers override them —
 * Rustafied's timings are not vanilla, so a built-in table would confidently
 * state the wrong number. Measuring beats assuming.
 *
 * Reading history to answer a question mutates nothing, so commands stay
 * read-only.
 */

/** Minimum observed spawns before an interval is worth quoting. */
export const MIN_OBSERVATIONS = 3;

/**
 * Gaps longer than this are treated as the bot having been offline rather than
 * a genuine spawn cycle. No Rust event has a natural period near 12 hours.
 */
export const MAX_PLAUSIBLE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface RespawnEstimate {
  /** Median observed gap between spawns. */
  intervalMs: number;
  /** ms until the next expected spawn; negative means overdue. */
  nextInMs: number;
  /** How many spawns this is based on. */
  observations: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Estimate the next spawn from observed spawn times, newest first.
 *
 * Returns null whenever there is not enough evidence — the caller must then
 * say nothing about timing rather than fall back to a guess.
 *
 * Uses the median gap rather than the mean so one outage, or one unusually
 * long quiet spell, does not drag the estimate.
 */
export function estimateRespawn(spawnTimes: Date[], now: Date = new Date()): RespawnEstimate | null {
  if (spawnTimes.length < MIN_OBSERVATIONS) return null;

  const intervals: number[] = [];
  for (let i = 0; i < spawnTimes.length - 1; i++) {
    const gap = spawnTimes[i]!.getTime() - spawnTimes[i + 1]!.getTime();
    if (gap > 0 && gap <= MAX_PLAUSIBLE_INTERVAL_MS) intervals.push(gap);
  }

  // Needs at least two gaps, so a single pair cannot masquerade as a cycle.
  if (intervals.length < MIN_OBSERVATIONS - 1) return null;

  const intervalMs = median(intervals);
  const last = spawnTimes[0]!;

  return {
    intervalMs,
    nextInMs: last.getTime() + intervalMs - now.getTime(),
    observations: spawnTimes.length,
  };
}

/**
 * Render an estimate as a short clause for a chat line.
 *
 * Always carries how it was derived, so nobody mistakes a measured average for
 * a published server timing.
 */
export function describeEstimate(
  estimate: RespawnEstimate,
  formatDuration: (ms: number) => string,
): string {
  const every = `~every ${formatDuration(estimate.intervalMs)} from ${estimate.observations}`;

  if (estimate.nextInMs > 0) {
    return `next in ~${formatDuration(estimate.nextInMs)} (${every})`;
  }
  return `overdue by ${formatDuration(-estimate.nextInMs)} (${every})`;
}
