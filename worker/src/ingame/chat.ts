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

import { getLastEvent, getLastOilRigEvent } from '../db.js';
import type { EventLogRow } from '../db.js';
import { formatDuration } from '../format/message.js';
import { logger } from '../logger.js';
import type { RustPlusClient } from '../rustplus/client.js';

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

    case 'help':
      return `Commands: ${['heli', 'cargo', 'chinook', 'large', 'small', 'crate', 'time', 'pop', 'wipe', 'status']
        .map((c) => deps.prefix + c)
        .join(' ')}`;

    default:
      // Unknown text starting with the prefix is ignored rather than answered,
      // so ordinary team chat using "!" does not draw a reply every time.
      return null;
  }
}

/**
 * Handles team chat messages: resolves commands and sends replies.
 *
 * Loop prevention is by message content, not by sender.
 *
 * sendTeamMessage posts as the *paired player* — there is no separate bot
 * identity in Rust. So the bot's own replies arrive back carrying the paired
 * player's Steam ID, which is also the ID of the person most likely to be
 * typing commands. An earlier version ignored that ID outright, which silently
 * discarded every command the owner typed: `!large` did nothing at all.
 *
 * Instead, replies the bot just sent are remembered briefly and skipped when
 * they echo back. Commands must start with the prefix and replies never do,
 * so this is belt-and-braces rather than the only defence.
 */
export class InGameChatHandler {
  private lastReplyAt = 0;
  private readonly recentReplies: string[] = [];

  constructor(private readonly deps: InGameCommandDeps) {}

  private remember(reply: string): void {
    this.recentReplies.push(reply);
    // A handful is plenty; replies are answered one at a time behind a cooldown.
    if (this.recentReplies.length > 5) this.recentReplies.shift();
  }

  async handle(steamId: string, message: string): Promise<void> {
    void steamId; // sender is deliberately not used -- see class comment

    if (this.recentReplies.includes(message.trim())) return;

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
      this.remember(reply);
      await this.deps.client.sendTeamMessage(reply);
      logger.info({ command: message.trim() }, 'answered in-game command');
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'failed to send team message');
    }
  }
}
