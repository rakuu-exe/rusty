/**
 * In-game team chat commands.
 *
 * Commands are strictly read-only. They report current session state and never
 * arm a timer, record an event, or start tracking something. If the bot has
 * not observed something, the honest answer is that it has not — an invented
 * countdown is worse than no answer.
 *
 * Next-spawn estimates are the one thing computed at query time, and only from
 * spawns the bot actually watched happen. Nothing is fabricated: with too few
 * observations the estimate is simply omitted. That keeps the spirit of the
 * rule — do not invent — while still answering "when is the next one".
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
import { EventSubject, describeState, type EventStateStore, type EventSubjectValue } from '../events/state.js';
import { describeEstimate, estimateRespawn, type RespawnEstimate } from '../events/respawn.js';
import { getRecentEvents } from '../db.js';
import { DIRECTION_COMPASS, deepSeaState, type DeepSeaAnchor } from '../events/deepSea.js';
import { VENDING_COMMAND_USAGE, resolveVendingCommand } from '../vending/commands.js';
import type { VendingStore } from '../vending/store.js';
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
  /** Vending session state, when the vending system is enabled. */
  vending?: VendingStore;
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

  // The zone covers a fixed half of the map for the whole wipe, so the
  // direction is worth repeating on every reply rather than assumed known.
  const where = anchor.direction
    ? ` @ ${anchor.direction} (${DIRECTION_COMPASS[anchor.direction]})`
    : '';

  if (state.open) {
    const warning = state.radiationPhase ? ' (RADIATION - closing)' : '';
    return `Deep Sea: OPEN${where}, closes in ~${formatDuration(state.closesInMs!)}${warning}`;
  }
  return `Deep Sea: closed${where}, opens in ~${formatDuration(state.opensInMs!)}`;
}

/**
 * Which subjects have a spawn cycle worth measuring.
 *
 * Oil rigs are deliberately absent: a rig is triggered when a *player* chooses
 * to swipe a card, so there is no natural interval and an average of past
 * triggers would describe player habits, not a game timer. Deep Sea is absent
 * because its cycle is exact once anchored, not estimated.
 */
const ESTIMABLE: Partial<Record<EventSubjectValue, { type: string; phase: string }>> = {
  [EventSubject.PatrolHelicopter]: { type: 'patrol_helicopter', phase: 'entered_map' },
  [EventSubject.CargoShip]: { type: 'cargo_ship', phase: 'entered_map' },
  [EventSubject.MonumentChinook]: { type: 'ch47', phase: 'entered_map' },
  [EventSubject.TravellingVendor]: { type: 'travelling_vendor', phase: 'entered_map' },
};

/**
 * Measured next-spawn estimate for a subject, or null if there is not enough
 * observed history to say anything honest.
 *
 * History comes from the event log, which persists across restarts, so the
 * estimate keeps improving over a wipe even though session state does not.
 */
async function estimateFor(
  deps: InGameCommandDeps,
  subject: EventSubjectValue,
): Promise<RespawnEstimate | null> {
  const spec = ESTIMABLE[subject];
  if (!spec) return null;

  try {
    const rows = await getRecentEvents(deps.serverId, spec.type, spec.phase, { limit: 12 });
    return estimateRespawn(rows.map((row) => new Date(row.created_at)));
  } catch {
    // A status reply is more useful without an estimate than not at all.
    return null;
  }
}

/**
 * When the event log last recorded this subject arriving, or null.
 *
 * Uses the same spec as the estimate above, so anything estimable is also
 * reportable. Rigs are deliberately absent: their history is per-monument and
 * they have their own lifecycle description, which already carries timings.
 */
async function lastSeenFor(
  deps: InGameCommandDeps,
  subject: EventSubjectValue,
): Promise<{ at: Date; grid: string | null } | null> {
  const spec = ESTIMABLE[subject];
  if (!spec) return null;

  try {
    const [row] = await getRecentEvents(deps.serverId, spec.type, spec.phase, { limit: 1 });
    return row ? { at: new Date(row.created_at), grid: row.grid ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * What a command handler is given. Everything a reply can need, already
 * resolved, so handlers stay one-liners.
 */
interface CommandContext {
  deps: InGameCommandDeps;
  /** Text after the command word, original case preserved. */
  args: string;
  /** Status line for a subject: state, last-seen history, next-spawn estimate. */
  status: (subject: EventSubjectValue) => Promise<string>;
  client: RustPlusClient;
  timezone: string;
}

interface ChatCommand {
  /** Trigger words. The first is canonical and the one `!help` lists. */
  names: readonly string[];
  /** Argument hint for `!help`, e.g. "item". */
  usage?: string;
  run: (ctx: CommandContext) => Promise<string | null> | string | null;
}

/**
 * Every in-game command, in one table.
 *
 * To add one, append an entry — nothing else needs touching, because dispatch
 * and `!help` are both derived from this list. The previous switch statement
 * kept its help text as a separate hand-written array, which had already
 * drifted: `!vendsearch` worked but was not listed anywhere.
 *
 * Handlers must stay read-only. Commands answer questions about state; they
 * never change it.
 */
const COMMANDS: readonly ChatCommand[] = [
  // ---- event status ---------------------------------------------------------
  { names: ['heli'], run: (c) => c.status(EventSubject.PatrolHelicopter) },
  { names: ['cargo'], run: (c) => c.status(EventSubject.CargoShip) },
  { names: ['large'], run: (c) => c.status(EventSubject.LargeOilRig) },
  { names: ['small'], run: (c) => c.status(EventSubject.SmallOilRig) },
  { names: ['chinook', 'ch47'], run: (c) => c.status(EventSubject.MonumentChinook) },
  { names: ['vendor'], run: (c) => c.status(EventSubject.TravellingVendor) },
  { names: ['crate'], run: (c) => c.status(EventSubject.LockedCrate) },
  { names: ['deepsea'], run: (c) => describeDeepSea(c.deps) },

  {
    names: ['oil'],
    // Both rigs at once, since they are tracked independently.
    run: async (c) => {
      const [large, small] = await Promise.all([
        c.status(EventSubject.LargeOilRig),
        c.status(EventSubject.SmallOilRig),
      ]);
      return `${large} | ${small}`;
    },
  },

  {
    names: ['events'],
    // Everything at a glance, for when you have just logged in.
    run: async (c) => {
      const subjects = [
        EventSubject.PatrolHelicopter,
        EventSubject.CargoShip,
        EventSubject.LargeOilRig,
        EventSubject.SmallOilRig,
        EventSubject.MonumentChinook,
        EventSubject.TravellingVendor,
      ];
      return (await Promise.all(subjects.map(c.status))).join(' | ');
    },
  },

  // ---- live server queries --------------------------------------------------
  {
    names: ['time'],
    run: async (c) => {
      const time = await c.client.getTime();
      // Rust reports time as a float where the integer part is the hour.
      const hours = Math.floor(time.time);
      const minutes = Math.floor((time.time - hours) * 60);
      return `In-game time: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    },
  },
  {
    names: ['pop'],
    run: async (c) => {
      const info = await c.client.getInfo();
      // Some servers omit queuedPlayers entirely, so absent != zero.
      const queue = info.queuedPlayers ? ` (+${info.queuedPlayers} queued)` : '';
      return `Population: ${info.players}/${info.maxPlayers}${queue}`;
    },
  },
  {
    names: ['wipe'],
    run: async (c) => {
      const info = await c.client.getInfo();
      return `Wiped ${formatDuration(Date.now() - info.wipeTime * 1000)} ago`;
    },
  },
  {
    names: ['status'],
    run: async (c) => {
      const info = await c.client.getInfo();
      return `${info.name} — ${info.players}/${info.maxPlayers} online`;
    },
  },

  // ---- meta -----------------------------------------------------------------
  { names: ['help'], run: (c) => helpText(c.deps.prefix) },
];

/** Trigger word to command, including aliases. Built once. */
const BY_NAME = new Map<string, ChatCommand>(
  COMMANDS.flatMap((command) => command.names.map((name) => [name, command] as const)),
);

/** `!help` text, derived from the tables so it cannot drift out of date. */
function helpText(prefix: string): string {
  const own = COMMANDS.map((c) => (c.usage ? `${c.names[0]} ${c.usage}` : c.names[0]!));
  return `Commands: ${[...own, ...VENDING_COMMAND_USAGE].map((c) => prefix + c).join(' ')}`;
}

/**
 * Resolve a command to a reply, or null when the message is not a command.
 *
 * Pure with respect to bot state: it reads the store, the event log and the
 * server, and writes nothing.
 */
export async function resolveInGameCommand(
  message: string,
  deps: InGameCommandDeps,
): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith(deps.prefix)) return null;

  const body = trimmed.slice(deps.prefix.length).trim();
  const [rawCommand] = body.toLowerCase().split(/\s+/);
  if (!rawCommand) return null;

  // Arguments keep their original case: item names are searched
  // case-insensitively, but a grid like "D12" reads better as typed.
  const args = body.slice(rawCommand.length).trim();

  const { client, state } = deps;
  const timezone = deps.timezone ?? 'UTC';
  const formatters = {
    duration: formatDuration,
    clock: (date: Date) => formatClock(date, timezone),
  };

  /** Status, with last-seen history and a next-spawn estimate where they exist. */
  const status = async (subject: EventSubjectValue): Promise<string> => {
    const current = state.get(subject);
    const parts = [describeState(current, formatters)];

    /**
     * Session state only knows what this connection has watched, so after a
     * restart everything reads "not observed this session" even when the
     * event log has hours of history. Fill that gap from the log, which
     * survives restarts, rather than claiming to know nothing.
     */
    if (current.state === 'unknown') {
      const seen = await lastSeenFor(deps, subject);
      if (seen) {
        const ago = formatDuration(Date.now() - seen.at.getTime());
        const where = seen.grid ? ` @ ${seen.grid}` : '';
        parts.push(`last seen ${ago} ago at ${formatClock(seen.at, timezone)}${where}`);
      }
    }

    const estimate = await estimateFor(deps, subject);
    if (estimate) parts.push(describeEstimate(estimate, formatDuration));

    return parts.join(' — ');
  };

  // Vending owns its own command set. Returns null for anything else, so this
  // falls through to the event commands below.
  if (deps.vending) {
    const vendingReply = resolveVendingCommand(rawCommand, args, {
      store: deps.vending,
      formatClock: formatters.clock,
    });
    if (vendingReply !== null) return vendingReply;
  }

  const command = BY_NAME.get(rawCommand);

  // Unknown text starting with the prefix is ignored rather than answered, so
  // ordinary team chat using "!" does not draw a reply every time.
  if (!command) return null;

  return command.run({ deps, args, status, client, timezone });
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
