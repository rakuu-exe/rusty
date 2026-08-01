/**
 * In-game team chat commands.
 *
 * Hard constraint worth stating once: the Rust+ API only exposes the *team*
 * chat of the paired player. Global chat is invisible to the bot, and always
 * will be — this is a Facepunch limitation, not something to engineer around.
 * So these commands only work for people in the paired player's team.
 *
 * Replies cost 2 rate-limit tokens each and share the bucket with the marker
 * poller, so answers are terse and a cooldown keeps a bored teammate spamming
 * `!heli` from starving the polling loop.
 */

import { getLastEvent, getLastOilRigEvent, getRecentEvents, recordEvent } from '../db.js';
import type { EventLogRow } from '../db.js';
import { formatDuration } from '../format/message.js';
import { logger } from '../logger.js';
import type { RustPlusClient } from '../rustplus/client.js';
import { deepSeaState, estimateRespawn, type RespawnEstimate } from '../events/respawn.js';

/** Minimum gap between replies to one team, in ms. */
export const REPLY_COOLDOWN_MS = 3_000;

export interface InGameCommandDeps {
  serverId: string;
  client: RustPlusClient;
  prefix: string;
}

/**
 * Describes when something last happened, or says it hasn't.
 *
 * "yet" rather than "this wipe": the bot only knows what it observed while
 * connected. It cannot see events from before it started, so claiming nothing
 * happened all wipe would be an overstatement — it may simply not have been
 * watching.
 */
function since(row: EventLogRow | null, label: string, now = Date.now()): string {
  if (!row) return `${label}: nothing seen yet`;

  const ago = formatDuration(now - new Date(row.created_at).getTime());
  const where = row.grid ? ` @ ${row.grid}` : '';
  return `${label}: ${row.phase.replace(/_/g, ' ')} ${ago} ago${where}`;
}

async function describeEvent(serverId: string, eventType: string, label: string): Promise<string> {
  return since(await getLastEvent(serverId, eventType), label);
}

/** Oil rig answers include the unlock time, which is the point of asking. */
async function describeOilRig(serverId: string, label: string): Promise<string> {
  const called = await getLastOilRigEvent(serverId, label, 'called');
  if (!called) return `${label}: no crate called yet`;

  const ago = formatDuration(Date.now() - new Date(called.created_at).getTime());
  const where = called.grid ? ` @ ${called.grid}` : '';

  if (called.opens_at) {
    const opensIn = new Date(called.opens_at).getTime() - Date.now();
    if (opensIn > 0) return `${label}: crate called ${ago} ago${where}, opens in ${formatDuration(opensIn)}`;
    return `${label}: crate called ${ago} ago${where}, already open`;
  }

  return `${label}: crate called ${ago} ago${where}`;
}

/** Which event marks a "spawn" for each `!when-*` subject. */
const RESPAWN_SUBJECTS = {
  cargo: { label: 'Cargo', type: 'cargo_ship', phase: 'entered_map' },
  crate: { label: 'Chinook crate', type: 'ch47', phase: 'entered_map' },
  heli: { label: 'Heli', type: 'patrol_helicopter', phase: 'entered_map' },
  loil: { label: 'Large Oil Rig', type: 'oil_rig_crate', phase: 'called', monument: 'Large Oil Rig' },
  smoil: { label: 'Small Oil Rig', type: 'oil_rig_crate', phase: 'called', monument: 'Small Oil Rig' },
  oil: { label: 'Oil Rig', type: 'oil_rig_crate', phase: 'called' },
  vendor: { label: 'Vendor', type: 'travelling_vendor', phase: 'entered_map' },
} as const satisfies Record<string, { label: string; type: string; phase: string; monument?: string }>;

export type RespawnSubject = keyof typeof RESPAWN_SUBJECTS;

/**
 * Is the thing currently on the map?
 *
 * Derived from whether the most recent event for it was an arrival rather than
 * a departure, which avoids keeping separate live state that a restart loses.
 */
function isActive(latest: EventLogRow | null): boolean {
  if (!latest) return false;
  return latest.phase === 'entered_map' || latest.phase === 'called' || latest.phase === 'spawned';
}

/** Renders a respawn estimate as a short chat line. */
function describeRespawn(label: string, estimate: RespawnEstimate): string {
  const active = estimate.active ? `${label}: on the map now` : null;

  if (estimate.intervalMs === null) {
    // No usable history, so any number quoted would be invented.
    const seen =
      estimate.sinceLastMs === null
        ? 'never seen yet'
        : `last seen ${formatDuration(estimate.sinceLastMs)} ago`;
    return active
      ? `${active} (${seen}, still learning the cycle)`
      : `${label}: ${seen} — not enough history to estimate yet`;
  }

  const every = `~every ${formatDuration(estimate.intervalMs)}`;
  const basis = `from ${estimate.observations} spawns`;

  if (estimate.active) return `${active}, ${every} ${basis}`;

  const next = estimate.nextInMs!;
  if (next <= 0) return `${label}: due now (overdue ${formatDuration(-next)}, ${every})`;
  return `${label}: ~${formatDuration(next)} (${every}, ${basis})`;
}

async function describeSubjectRespawn(serverId: string, subject: RespawnSubject): Promise<string> {
  const spec = RESPAWN_SUBJECTS[subject];
  const monument = 'monument' in spec ? spec.monument : undefined;

  const [spawns, latest] = await Promise.all([
    getRecentEvents(serverId, spec.type, spec.phase, { limit: 10, ...(monument ? { monument } : {}) }),
    monument ? getLastOilRigEvent(serverId, monument) : getLastEvent(serverId, spec.type),
  ]);

  const estimate = estimateRespawn(
    spawns.map((row) => new Date(row.created_at)),
    { active: isActive(latest) },
  );

  return describeRespawn(spec.label, estimate);
}

/**
 * Deep Sea, which cannot be observed at all.
 *
 * It has no Rust+ map marker — it is a zone, not an entity — so nothing in the
 * marker feed reveals it. Its cycle is fixed by convars though, so one
 * confirmed open time is enough to project every open and close from then on.
 */
async function describeDeepSea(serverId: string): Promise<string> {
  const anchor = await getLastEvent(serverId, 'deep_sea', 'opened');
  if (!anchor) {
    return 'Deep Sea: no anchor set — type !deepsea-open the moment it opens and I can predict it from then on';
  }

  const state = deepSeaState(new Date(anchor.created_at));

  if (state.open) {
    const warning = state.radiationPhase ? ' (RADIATION - closing)' : '';
    return `Deep Sea: OPEN, closes in ~${formatDuration(state.closesInMs!)}${warning}`;
  }

  return `Deep Sea: closed, opens in ~${formatDuration(state.opensInMs!)}`;
}

/**
 * Resolve a command to a reply, or null when the message is not a command.
 *
 * Kept free of side effects other than reads so it can be tested directly.
 */
export async function resolveInGameCommand(
  message: string,
  deps: InGameCommandDeps,
): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith(deps.prefix)) return null;

  const [rawCommand] = trimmed.slice(deps.prefix.length).trim().toLowerCase().split(/\s+/);
  if (!rawCommand) return null;

  const { serverId, client } = deps;

  switch (rawCommand) {
    case 'heli':
      return describeEvent(serverId, 'patrol_helicopter', 'Heli');

    case 'cargo':
      return describeEvent(serverId, 'cargo_ship', 'Cargo');

    case 'chinook':
    case 'ch47':
      return describeEvent(serverId, 'ch47', 'Chinook');

    case 'crate':
      return describeEvent(serverId, 'locked_crate', 'Crate');

    case 'large':
    case 'small': {
      // Both rigs share an event type, so filter on the monument name.
      const label = rawCommand === 'large' ? 'Large Oil Rig' : 'Small Oil Rig';
      return describeOilRig(serverId, label);
    }

    case 'time': {
      const time = await client.getTime();
      // Rust reports time as a float where the integer part is the hour.
      const hours = Math.floor(time.time);
      const minutes = Math.floor((time.time - hours) * 60);
      const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      return `In-game time: ${clock}`;
    }

    case 'pop': {
      const info = await client.getInfo();
      // Some servers omit queuedPlayers entirely, so absent != zero.
      const queue = info.queuedPlayers ? ` (+${info.queuedPlayers} queued)` : '';
      return `Population: ${info.players}/${info.maxPlayers}${queue}`;
    }

    case 'wipe': {
      const info = await client.getInfo();
      return `Wiped ${formatDuration(Date.now() - info.wipeTime * 1000)} ago`;
    }

    case 'status': {
      const info = await client.getInfo();
      return `${info.name} — ${info.players}/${info.maxPlayers} online`;
    }

    case 'vendor':
      return describeEvent(serverId, 'travelling_vendor', 'Vendor');

    case 'deepsea':
      return describeDeepSea(serverId);

    /**
     * Anchors the Deep Sea cycle. Someone must say this the moment it opens,
     * because there is no marker for the bot to see it happen.
     */
    case 'deepsea-open':
    case 'deepsea-opened': {
      await recordEvent({ serverId, eventType: 'deep_sea', phase: 'opened' });
      const state = deepSeaState(new Date());
      return `Deep Sea anchored as open now — closes in ~${formatDuration(state.closesInMs!)}`;
    }

    case 'help':
      return `Commands: ${['heli', 'cargo', 'chinook', 'large', 'small', 'crate', 'vendor', 'deepsea', 'time', 'pop', 'wipe', 'status']
        .map((c) => deps.prefix + c)
        .join(' ')} | ${deps.prefix}when-<cargo|crate|heli|loil|smoil|oil|vendor|deepsea>`;

    default: {
      // !when-<subject> respawn estimates.
      const when = rawCommand.match(/^when-(.+)$/);
      if (when) {
        const subject = when[1]!;
        if (subject === 'deepsea') return describeDeepSea(serverId);
        if (subject in RESPAWN_SUBJECTS) {
          return describeSubjectRespawn(serverId, subject as RespawnSubject);
        }
        return null;
      }
    }
      // Unknown text starting with the prefix is ignored rather than answered,
      // so ordinary team chat using "!" does not draw a reply every time.
      return null;
  }
}

/**
 * Remembers what the bot itself said in team chat.
 *
 * sendTeamMessage posts as the *paired player* — there is no separate bot
 * identity in Rust. So everything the bot says arrives back carrying the
 * paired player's Steam ID, which is also the ID of the person most likely to
 * be typing commands. An earlier version ignored that Steam ID outright, which
 * silently discarded every command the owner typed: `!large` did nothing.
 *
 * Matching on content instead lets the bot recognise its own echo without
 * going deaf to the owner. Shared between command replies and event
 * announcements so neither is mirrored back into Discord as if a player
 * had typed it.
 */
export class SelfMessageTracker {
  private readonly recent: string[] = [];

  constructor(private readonly limit = 20) {}

  remember(message: string): void {
    this.recent.push(message.trim());
    if (this.recent.length > this.limit) this.recent.shift();
  }

  isSelf(message: string): boolean {
    return this.recent.includes(message.trim());
  }
}

/** Handles team chat messages: resolves commands and sends replies. */
export class InGameChatHandler {
  private lastReplyAt = 0;

  constructor(
    private readonly deps: InGameCommandDeps,
    private readonly self: SelfMessageTracker,
  ) {}

  async handle(steamId: string, message: string): Promise<void> {
    void steamId; // sender is deliberately not used -- see SelfMessageTracker

    if (this.self.isSelf(message)) return;

    let reply: string | null;
    try {
      reply = await resolveInGameCommand(message, this.deps);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'in-game command failed');
      return;
    }

    if (!reply) return;

    const now = Date.now();
    if (now - this.lastReplyAt < REPLY_COOLDOWN_MS) {
      logger.debug('in-game reply suppressed by cooldown');
      return;
    }
    this.lastReplyAt = now;

    try {
      this.self.remember(reply);
      await this.deps.client.sendTeamMessage(reply);
      logger.info({ command: message.trim() }, 'answered in-game command');
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'failed to send team message');
    }
  }
}
