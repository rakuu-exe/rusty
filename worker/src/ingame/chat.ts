/**
 * In-game team chat commands.
 *
 * Commands are strictly read-only. They report the current session state and
 * nothing else: they never arm a timer, never record an event, never start
 * tracking something, and never estimate a spawn simply because somebody
 * asked. If the bot has not observed something, the honest answer is that it
 * has not observed it — an invented countdown is worse than no answer.
 *
 * All state comes from EventStateStore, which is written only by the detector
 * in response to real marker transitions. There is deliberately no path from a
 * command back into that store.
 *
 * Hard constraint worth stating once: the Rust+ API only exposes the *team*
 * chat of the paired player. Global chat is invisible to the bot, and always
 * will be — this is a Facepunch limitation, not something to engineer around.
 */

import { formatClock, formatDuration } from '../format/message.js';
import { EventSubject, describeState, type EventStateStore } from '../events/state.js';
import { deepSeaState, type DeepSeaAnchor } from '../events/deepSea.js';
import { logger } from '../logger.js';
import type { RustPlusClient } from '../rustplus/client.js';

/** Minimum gap between replies to one team, in ms. */
export const REPLY_COOLDOWN_MS = 3_000;

export interface InGameCommandDeps {
  serverId: string;
  client: RustPlusClient;
  prefix: string;
  /** Read-only from here. Commands must not mutate session state. */
  state: EventStateStore;
  /** IANA timezone for rendering spawn times. */
  timezone?: string;
  /** Supplies the Deep Sea anchor, if one has been recorded. */
  getDeepSeaAnchor?: () => DeepSeaAnchor | null;
}

/**
 * Deep Sea status.
 *
 * Deep Sea is a zone rather than an entity, so it never appears in the Rust+
 * marker feed and genuinely cannot be observed. Its cycle is fixed by server
 * convars, so it can be projected from a recorded open — but only if one has
 * been recorded. Without an anchor the answer is "not observed", never a
 * guess.
 */
function describeDeepSea(deps: InGameCommandDeps): string {
  const anchor = deps.getDeepSeaAnchor?.() ?? null;
  if (!anchor) return 'Deep Sea: not observed this session';

  const state = deepSeaState(anchor.openedAt);

  if (state.open) {
    const warning = state.radiationPhase ? ' (RADIATION - closing)' : '';
    return `Deep Sea: OPEN, closes in ~${formatDuration(state.closesInMs!)}${warning}`;
  }
  return `Deep Sea: closed, opens in ~${formatDuration(state.opensInMs!)}`;
}

/**
 * Resolve a command to a reply, or null when the message is not a command.
 *
 * Pure with respect to bot state: it reads the store and the server, and
 * writes nothing.
 */
export async function resolveInGameCommand(
  message: string,
  deps: InGameCommandDeps,
): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith(deps.prefix)) return null;

  const [rawCommand] = trimmed.slice(deps.prefix.length).trim().toLowerCase().split(/\s+/);
  if (!rawCommand) return null;

  const { client, state } = deps;
  const timezone = deps.timezone ?? 'UTC';
  const formatters = {
    duration: formatDuration,
    clock: (date: Date) => formatClock(date, timezone),
  };
  const status = (subject: Parameters<EventStateStore['get']>[0]) =>
    describeState(state.get(subject), formatters);

  switch (rawCommand) {
    // ---- event status, all pure reads -------------------------------------
    case 'heli':
      return status(EventSubject.PatrolHelicopter);

    case 'cargo':
      return status(EventSubject.CargoShip);

    case 'large':
      return status(EventSubject.LargeOilRig);

    case 'small':
      return status(EventSubject.SmallOilRig);

    case 'chinook':
    case 'ch47':
      return status(EventSubject.MonumentChinook);

    case 'vendor':
      return status(EventSubject.TravellingVendor);

    case 'crate':
      return status(EventSubject.LockedCrate);

    case 'deepsea':
      return describeDeepSea(deps);

    case 'oil':
      // Both rigs, since they are tracked independently.
      return `${status(EventSubject.LargeOilRig)} | ${status(EventSubject.SmallOilRig)}`;

    case 'events': {
      // Everything at a glance, for when you have just logged in.
      const subjects = [
        EventSubject.PatrolHelicopter,
        EventSubject.CargoShip,
        EventSubject.LargeOilRig,
        EventSubject.SmallOilRig,
        EventSubject.MonumentChinook,
        EventSubject.TravellingVendor,
      ];
      return subjects.map((s) => describeState(state.get(s), formatters)).join(' | ');
    }

    // ---- live server queries, still read-only ------------------------------
    case 'time': {
      const time = await client.getTime();
      // Rust reports time as a float where the integer part is the hour.
      const hours = Math.floor(time.time);
      const minutes = Math.floor((time.time - hours) * 60);
      return `In-game time: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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

    case 'help':
      return `Commands: ${['heli', 'cargo', 'large', 'small', 'oil', 'chinook', 'vendor', 'crate', 'deepsea', 'events', 'time', 'pop', 'wipe', 'status']
        .map((c) => deps.prefix + c)
        .join(' ')}`;

    default:
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
