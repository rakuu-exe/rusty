/**
 * Session state for every tracked event.
 *
 * The event system is a state tracker, not a collection of timer commands.
 * This module holds the single source of truth for "what is happening right
 * now", and it obeys two rules absolutely:
 *
 *  1. **Only real observations mutate it.** Marker transitions from the game
 *     write here. Commands never do. A command that has to write something in
 *     order to answer is a command that is inventing the answer.
 *
 *  2. **Startup is not an observation of a spawn.** Whatever is on the map
 *     when the bot connects is recorded as active, but with no start time,
 *     because the bot genuinely does not know when it spawned. It is reported
 *     as "detected after startup" rather than given a fabricated timestamp.
 *
 * State is per-session and in-memory by design. "Not observed this session" is
 * an honest answer; persisting it across restarts would let the bot imply
 * knowledge of a world it was not watching.
 */

/** Which things the bot tracks. Oil rigs are tracked independently. */
export const EventSubject = {
  PatrolHelicopter: 'patrol_helicopter',
  CargoShip: 'cargo_ship',
  /** Map-crossing Chinook that drops a locked crate at a monument. */
  MonumentChinook: 'monument_chinook',
  TravellingVendor: 'travelling_vendor',
  LargeOilRig: 'oil_rig_large',
  SmallOilRig: 'oil_rig_small',
  LockedCrate: 'locked_crate',
} as const;

export type EventSubjectValue = (typeof EventSubject)[keyof typeof EventSubject];

export const SUBJECT_LABELS: Record<EventSubjectValue, string> = {
  patrol_helicopter: 'Patrol Helicopter',
  cargo_ship: 'Cargo Ship',
  monument_chinook: 'Chinook',
  travelling_vendor: 'Travelling Vendor',
  oil_rig_large: 'Large Oil Rig',
  oil_rig_small: 'Small Oil Rig',
  locked_crate: 'Locked Crate',
};

/**
 * Session status.
 *
 * `active_at_startup` is deliberately distinct from `active`: both mean it is
 * on the map, but only `active` carries a trustworthy start time.
 */
export type SessionState = 'unknown' | 'active' | 'active_at_startup' | 'completed';

/**
 * Where an oil rig sits in its lifecycle.
 *
 *   available -> triggered -> unlocked -> completed -> (reset on respawn)
 *
 * `available` means the crate is present and untouched. `triggered` means a
 * Chinook delivered Heavy Scientists and the 15 minute countdown is running.
 */
export type OilRigPhase = 'unknown' | 'available' | 'triggered' | 'unlocked' | 'completed';

export interface EventState {
  subject: EventSubjectValue;
  label: string;
  state: SessionState;
  /** When it was observed to start. Null when it was already there at startup. */
  startedAt: Date | null;
  /** Last poll in which it was seen. */
  lastSeenAt: Date | null;
  /** When it was observed to end. */
  endedAt: Date | null;
  /** Most recent known position. */
  grid: string | null;
  /** Oil rigs only. */
  oilRig?: {
    phase: OilRigPhase;
    /** When Heavy Scientists were called. */
    triggeredAt: Date | null;
    /** When the locked crate unlocks, 15 minutes after triggering. */
    unlocksAt: Date | null;
  };
}

function blank(subject: EventSubjectValue): EventState {
  const base: EventState = {
    subject,
    label: SUBJECT_LABELS[subject],
    state: 'unknown',
    startedAt: null,
    lastSeenAt: null,
    endedAt: null,
    grid: null,
  };

  if (subject === EventSubject.LargeOilRig || subject === EventSubject.SmallOilRig) {
    base.oilRig = { phase: 'unknown', triggeredAt: null, unlocksAt: null };
  }

  return base;
}

/**
 * Mutable session state.
 *
 * Every mutator corresponds to something that actually happened in game. There
 * is deliberately no method a command could call.
 */
export class EventStateStore {
  private readonly states = new Map<EventSubjectValue, EventState>();

  constructor() {
    for (const subject of Object.values(EventSubject)) {
      this.states.set(subject, blank(subject));
    }
  }

  get(subject: EventSubjectValue): EventState {
    return this.states.get(subject)!;
  }

  all(): EventState[] {
    return [...this.states.values()];
  }

  /**
   * Something was already on the map when the bot connected.
   *
   * Records it as active but leaves startedAt null — the spawn time is
   * genuinely unknown and must not be guessed from the connection time.
   */
  markPresentAtStartup(subject: EventSubjectValue, at: Date, grid: string | null): void {
    const state = this.get(subject);
    state.state = 'active_at_startup';
    state.startedAt = null;
    state.lastSeenAt = at;
    state.endedAt = null;
    if (grid) state.grid = grid;

    // A rig crate already sitting there is available; how it got there is
    // unknown, so no trigger time is invented.
    if (state.oilRig) state.oilRig.phase = 'available';
  }

  /** Observed appearing after monitoring started. This is a real spawn. */
  markSpawned(subject: EventSubjectValue, at: Date, grid: string | null): void {
    const state = this.get(subject);
    state.state = 'active';
    state.startedAt = at;
    state.lastSeenAt = at;
    state.endedAt = null;
    if (grid) state.grid = grid;

    if (state.oilRig) {
      state.oilRig.phase = 'available';
      state.oilRig.triggeredAt = null;
      state.oilRig.unlocksAt = null;
    }
  }

  /** Still present in this poll. */
  markSeen(subject: EventSubjectValue, at: Date, grid: string | null): void {
    const state = this.get(subject);
    if (state.state === 'unknown' || state.state === 'completed') return;
    state.lastSeenAt = at;
    if (grid) state.grid = grid;
  }

  /** Observed leaving, being destroyed, or being looted. */
  markEnded(subject: EventSubjectValue, at: Date): void {
    const state = this.get(subject);
    state.state = 'completed';
    state.endedAt = at;

    if (state.oilRig) {
      state.oilRig.phase = 'completed';
      state.oilRig.triggeredAt = null;
      state.oilRig.unlocksAt = null;
    }
  }

  /**
   * Heavy Scientists were delivered to a rig, starting the crate countdown.
   *
   * The timer is anchored to the Chinook's arrival, which is the only moment
   * the game actually tells us about.
   */
  markOilRigTriggered(subject: EventSubjectValue, at: Date, unlocksAt: Date, grid: string | null): void {
    const state = this.get(subject);
    if (!state.oilRig) return;

    // Triggering proves it is active even if the crate marker was missed.
    if (state.state === 'unknown' || state.state === 'completed') {
      state.state = 'active_at_startup';
    }
    state.lastSeenAt = at;
    if (grid) state.grid = grid;

    state.oilRig.phase = 'triggered';
    state.oilRig.triggeredAt = at;
    state.oilRig.unlocksAt = unlocksAt;
  }

  /** The 15 minute countdown elapsed. */
  markOilRigUnlocked(subject: EventSubjectValue, at: Date): void {
    const state = this.get(subject);
    if (!state.oilRig) return;
    if (state.oilRig.phase !== 'triggered') return;

    state.oilRig.phase = 'unlocked';
    state.lastSeenAt = at;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One-line status for team chat.
 *
 * `formatDuration` is injected rather than imported to keep this module free
 * of dependencies on the Discord-facing formatter.
 */
export function describeState(
  state: EventState,
  formatDuration: (ms: number) => string,
  now: Date = new Date(),
): string {
  const label = state.label;
  const at = state.grid ? ` @ ${state.grid}` : '';

  if (state.oilRig) return describeOilRig(state, formatDuration, now);

  switch (state.state) {
    case 'unknown':
      return `${label}: not observed this session`;

    case 'active_at_startup':
      // The honest answer: it is here, but the bot did not see it arrive.
      return `${label}: ACTIVE${at} — detected after startup, spawn time unknown`;

    case 'active': {
      const since = state.startedAt ? ` (${formatDuration(now.getTime() - state.startedAt.getTime())} ago)` : '';
      return `${label}: ACTIVE${at}${since}`;
    }

    case 'completed': {
      const ended = state.endedAt ? formatDuration(now.getTime() - state.endedAt.getTime()) : null;
      return ended ? `${label}: ended ${ended} ago${at}` : `${label}: not currently active${at}`;
    }
  }
}

function describeOilRig(state: EventState, formatDuration: (ms: number) => string, now: Date): string {
  const rig = state.oilRig!;
  const label = state.label;
  const at = state.grid ? ` @ ${state.grid}` : '';

  switch (rig.phase) {
    case 'unknown':
      /**
       * Deliberately specific about what is being reported.
       *
       * Rust+ does not publish a marker for the crate sitting on an oil rig —
       * verified against a live server, where the feed contained no Crate
       * markers at all while crates were plainly visible in game. So the bot
       * cannot see a rig become available; the only rig event it can observe
       * is a Chinook arriving with Heavy Scientists.
       *
       * Saying "not observed this session" would imply the bot is watching
       * for something it can never see.
       */
      return `${label}: no Heavy Scientists called this session`;

    case 'available': {
      const detected =
        state.state === 'active_at_startup' ? ' — detected after startup' : '';
      return `${label}: crate AVAILABLE${at}${detected}`;
    }

    case 'triggered': {
      const ago = rig.triggeredAt ? ` ${formatDuration(now.getTime() - rig.triggeredAt.getTime())} ago` : '';
      const remaining = rig.unlocksAt ? rig.unlocksAt.getTime() - now.getTime() : null;

      if (remaining === null) return `${label}: Heavy Scientists called${ago}${at}`;
      if (remaining > 0) {
        return `${label}: Heavy Scientists called${ago}, crate unlocks in ${formatDuration(remaining)}${at}`;
      }
      // The countdown elapsed but the timer has not fired yet (a restart, or a
      // poll gap). Reporting it as still counting down would be wrong.
      return `${label}: crate UNLOCKED${at}`;
    }

    case 'unlocked': {
      const since = rig.triggeredAt
        ? ` (called ${formatDuration(now.getTime() - rig.triggeredAt.getTime())} ago)`
        : '';
      return `${label}: crate UNLOCKED${at}${since}`;
    }

    case 'completed': {
      const ended = state.endedAt ? formatDuration(now.getTime() - state.endedAt.getTime()) : null;
      return ended ? `${label}: crate taken ${ended} ago${at}` : `${label}: no crate present${at}`;
    }
  }
}
