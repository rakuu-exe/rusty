/**
 * Event rendering.
 *
 * The headline format is fixed by what players expect to read at a glance:
 *
 *   LARGE OIL RIG CRATE CALLED 14:41 OPENS 14:56 @ W4
 *
 * Uppercase, event first, times in the middle, grid last after an "@". The
 * same string is used for Discord plain-text posts and in-game team chat, so
 * it must stay short enough for Rust's chat line.
 */

import type { DetectedEvent, RustEventPhase, RustEventType } from '../events/types.js';

export interface FormatOptions {
  /** IANA timezone used to render clock times, e.g. "Europe/Tallinn". */
  timezone: string;
}

/** HH:mm in the configured timezone. */
export function formatClock(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

/** Compact elapsed time, e.g. "3m", "1h 12m", "2d 4h". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Subject line for an event, without times or grid. */
function subject(event: DetectedEvent): string {
  const monument = event.monument?.toUpperCase();

  switch (event.type) {
    case 'patrol_helicopter':
      if (event.phase === 'entered_map') return 'PATROL HELICOPTER ENTERED MAP';
      if (event.phase === 'downed') return 'PATROL HELICOPTER DOWNED';
      return 'PATROL HELICOPTER LEFT MAP';

    case 'cargo_ship':
      if (event.phase === 'entered_map') return 'CARGO SHIP ENTERED MAP';
      if (event.phase === 'egress') return 'CARGO SHIP ENTERING EGRESS';
      return 'CARGO SHIP LEFT MAP';

    case 'ch47':
      return event.phase === 'entered_map' ? 'CHINOOK 47 ENTERED MAP' : 'CHINOOK 47 LEFT MAP';

    case 'oil_rig_crate': {
      const rig = monument ?? 'OIL RIG';
      return event.phase === 'called' ? `${rig} CRATE CALLED` : `${rig} CRATE UNLOCKED`;
    }

    case 'locked_crate':
      return monument ? `LOCKED CRATE DROPPED AT ${monument}` : 'LOCKED CRATE DROPPED';
  }
}

/**
 * The canonical one-line headline.
 *
 * Oil rig crate calls carry the unlock time inline, because "when does it
 * open" is the only thing anyone actually wants from that alert.
 */
export function formatEventLine(event: DetectedEvent, options: FormatOptions): string {
  const time = formatClock(event.at, options.timezone);
  const parts = [subject(event), time];

  if (event.opensAt) {
    parts.push('OPENS', formatClock(event.opensAt, options.timezone));
  }

  parts.push('@', event.grid);
  return parts.join(' ');
}

/** Colour-coded accent per event type, for Discord embeds. */
export function eventColor(event: DetectedEvent): number {
  switch (event.type) {
    case 'patrol_helicopter':
      return event.phase === 'downed' ? 0x2ecc71 : 0xe74c3c;
    case 'cargo_ship':
      return 0x3498db;
    case 'ch47':
      return 0x9b59b6;
    case 'oil_rig_crate':
      return event.phase === 'unlocked' ? 0xf1c40f : 0xe67e22;
    case 'locked_crate':
      return 0x95a5a6;
  }
}

export function eventEmoji(event: DetectedEvent): string {
  switch (event.type) {
    case 'patrol_helicopter':
      return event.phase === 'downed' ? '💥' : '🚁';
    case 'cargo_ship':
      return '🚢';
    case 'ch47':
      return '🚁';
    case 'oil_rig_crate':
      return event.phase === 'unlocked' ? '🔓' : '🛢️';
    case 'locked_crate':
      return '📦';
  }
}

/**
 * Whether an event is worth announcing at all.
 *
 * Departures are logged for "!heli"-style queries but are mostly noise in a
 * busy channel, so callers can filter on this rather than hard-coding a list.
 */
export function isHighSignal(type: RustEventType, phase: RustEventPhase): boolean {
  if (phase === 'left_map') return false;
  return !(type === 'ch47' && phase === 'entered_map');
}
