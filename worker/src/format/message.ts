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

    case 'cargo_crate':
      return 'CARGO SHIP CRATE SPAWNED';

    case 'travelling_vendor':
      return event.phase === 'entered_map' ? 'TRAVELLING VENDOR ENTERED MAP' : 'TRAVELLING VENDOR LEFT MAP';

    case 'deep_sea':
      return event.phase === 'opened' ? 'DEEP SEA OPENED' : 'DEEP SEA CLOSED';

    case 'ch47':
      // Neutral on purpose: when a Chinook appears there is no way to know
      // whether it is bound for an oil rig or a monument. If it reaches a rig,
      // a separate Heavy Scientists event follows.
      return event.phase === 'entered_map' ? 'CHINOOK 47 ENTERED MAP' : 'CHINOOK 47 LEFT MAP';

    case 'oil_rig_crate': {
      const rig = monument ?? 'OIL RIG';
      // "Heavy Scientists called" names what actually happened; the crate was
      // already there, and a Chinook has just delivered its guards.
      if (event.phase === 'called') return `${rig} HEAVY SCIENTISTS CALLED`;
      // A spawn is the rig's crate becoming available again on its own.
      if (event.phase === 'spawned') return `${rig} AVAILABLE`;
      return `${rig} LOCKED CRATE UNLOCKED`;
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

/**
 * Compact form for in-game team chat.
 *
 * Rust chat lines are short and read in a firefight, so this drops the
 * shouted caps and the wall-clock time that Discord shows — the message is
 * arriving as it happens, so "when" is now. The one time that survives is a
 * rig crate's unlock, which is the whole point of that alert.
 */
export function formatEventLineInGame(event: DetectedEvent, options: FormatOptions): string {
  const at = `@ ${event.grid}`;

  switch (event.type) {
    case 'patrol_helicopter':
      if (event.phase === 'entered_map') return `Heli entered ${at}`;
      if (event.phase === 'downed') return `Heli DOWNED ${at}`;
      return `Heli left ${at}`;

    case 'cargo_ship':
      if (event.phase === 'entered_map') return `Cargo spawned ${at}`;
      if (event.phase === 'egress') return `Cargo leaving ${at}`;
      return `Cargo left ${at}`;

    case 'cargo_crate':
      return `Cargo crate spawned ${at}`;

    case 'travelling_vendor':
      return event.phase === 'entered_map' ? `Vendor entered ${at}` : `Vendor left ${at}`;

    case 'deep_sea':
      // No position: Deep Sea is a whole hemisphere, not a point on the map.
      return event.phase === 'opened' ? 'Deep Sea OPEN' : 'Deep Sea closed';

    case 'ch47':
      return event.phase === 'entered_map' ? `Chinook entered ${at}` : `Chinook left ${at}`;

    case 'oil_rig_crate': {
      const rig = event.monument ?? 'Oil Rig';
      if (event.phase === 'called') {
        const opens = event.opensAt ? `, unlocks ${formatClock(event.opensAt, options.timezone)}` : '';
        return `${rig} Heavy Scientists called ${at}${opens}`;
      }
      if (event.phase === 'spawned') return `${rig} available ${at}`;
      return `${rig} locked crate UNLOCKED ${at}`;
    }

    case 'locked_crate':
      return event.monument ? `Locked crate dropped at ${event.monument} ${at}` : `Locked crate dropped ${at}`;
  }
}

/** Colour-coded accent per event type, for Discord embeds. */
export function eventColor(event: DetectedEvent): number {
  switch (event.type) {
    case 'patrol_helicopter':
      return event.phase === 'downed' ? 0x2ecc71 : 0xe74c3c;
    case 'cargo_ship':
      return 0x3498db;
    case 'cargo_crate':
      return 0x1abc9c;
    case 'travelling_vendor':
      return 0x8e44ad;
    case 'deep_sea':
      return event.phase === 'opened' ? 0x16a085 : 0x7f8c8d;
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
    case 'cargo_crate':
      return '🧰';
    case 'travelling_vendor':
      return '🛒';
    case 'deep_sea':
      return '🌊';
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
 * Everything is recorded to event_log regardless, so the in-game "!heli" style
 * commands can still answer for suppressed events. This only decides what
 * reaches the Discord channel.
 *
 * Only one thing is suppressed: a Chinook leaving. Its arrival already told
 * the story, and by the time it departs the crate it dropped is what matters.
 * An earlier version also suppressed Chinook *arrivals* and all departures,
 * which was wrong -- a Chinook entering means a locked crate is inbound, and a
 * helicopter or cargo leaving is exactly the kind of thing people ask about.
 */
export function isHighSignal(type: RustEventType, phase: RustEventPhase): boolean {
  return !(type === 'ch47' && phase === 'left_map');
}
