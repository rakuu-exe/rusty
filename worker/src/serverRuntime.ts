/**
 * Everything the bot does for one paired Rust server.
 *
 * Owns the Rust+ socket, the marker poller, the detector, the timer scheduler
 * and the in-game chat handler, and routes detected events to Discord and the
 * event log. One instance per row in rust_servers.
 */

import {
  decryptedPlayerToken,
  getMonuments,
  getPendingTimers,
  recordEvent,
  replaceMonuments,
  updateServerInfo,
  type RustServerRow,
} from './db.js';
import { CARGO_SHIP_EGRESS_MS, EventDetector } from './events/detector.js';
import { MarkerPoller } from './events/poller.js';
import { TimerScheduler } from './events/timers.js';
import type { DetectedEvent } from './events/types.js';
import { isHighSignal } from './format/message.js';
import { InGameChatHandler } from './ingame/chat.js';
import { logger } from './logger.js';
import { RustPlusClient } from './rustplus/client.js';
import { formatGridPosition } from './rustplus/grid.js';
import { MonumentIndex } from './rustplus/monuments.js';
import type { DiscordBot } from './discord/bot.js';
import type { ServerStatus } from './discord/context.js';

export interface ServerRuntimeOptions {
  row: RustServerRow;
  bot: DiscordBot;
  pollIntervalMs: number;
  commandPrefix: string;
  getEventChannelId: () => string | null;
  getTeamChatChannelId: () => string | null;
  useEmbeds: () => boolean;
}

export class ServerRuntime {
  private readonly client: RustPlusClient;
  private readonly timers: TimerScheduler;
  private poller: MarkerPoller | null = null;
  private chat: InGameChatHandler | null = null;
  private mapSize: number | null = null;
  private lastInfo: { players: number; maxPlayers: number } | null = null;

  constructor(private readonly options: ServerRuntimeOptions) {
    const { row } = options;

    this.client = new RustPlusClient({
      serverIp: row.server_ip,
      appPort: row.app_port,
      playerId: row.player_id,
      playerToken: decryptedPlayerToken(row),
      label: row.name,
    });

    this.timers = new TimerScheduler(row.id, (event) => this.emit(event));
  }

  get serverId(): string {
    return this.options.row.id;
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  async start(): Promise<void> {
    const { row } = this.options;

    this.client.on('teamMessage', (message) => {
      void this.onTeamMessage(message.steamId, message.name, message.message);
    });

    this.client.on('connected', () => void this.onConnected());
    this.client.on('disconnected', () => {
      const channel = this.options.getEventChannelId();
      if (channel) void this.options.bot.postText(channel, `🔴 Lost connection to **${row.name}**. Retrying…`);
    });

    await this.client.connect();
  }

  /**
   * Runs on every (re)connection.
   *
   * Refreshing server info and monuments here rather than once at startup is
   * what makes a wipe survivable: seed, map size and monument positions all
   * change, and stale oil rig coordinates would silently break crate detection.
   */
  private async onConnected(): Promise<void> {
    const { row, bot } = this.options;

    try {
      const info = await this.client.getInfo();
      this.mapSize = info.mapSize;
      this.lastInfo = { players: info.players, maxPlayers: info.maxPlayers };

      await updateServerInfo(row.id, {
        mapSize: info.mapSize,
        ...(info.seed !== undefined ? { seed: info.seed } : {}),
        ...(info.salt !== undefined ? { salt: info.salt } : {}),
        wipeTime: info.wipeTime,
        name: info.name,
      });

      const monuments = await this.loadMonuments(info.wipeTime);
      const index = new MonumentIndex(monuments);
      const detector = new EventDetector({ mapSize: info.mapSize, monuments: index });

      // Positive confirmation that the pieces event detection depends on are
      // actually in place. Without this the worker looks identical whether it
      // cached monuments successfully or silently has none, and missing oil
      // rig positions would quietly turn every crate call into "chinook
      // entered map".
      const rigs = ['large_oil_rig', 'oil_rig_small'].flatMap((token) =>
        index.byToken(token).map((m) => `${m.displayName} @ ${formatGridPosition(m.x, m.y, info.mapSize)}`),
      );
      logger.info(
        { monuments: monuments.length, rigs, mapSize: info.mapSize, pollMs: this.options.pollIntervalMs },
        'event detection ready',
      );

      // Rehydrate before polling starts so a crate armed before a restart
      // still fires, and is not re-armed by the first snapshot.
      await this.timers.rehydrate();

      this.chat = new InGameChatHandler({
        serverId: row.id,
        client: this.client,
        prefix: this.options.commandPrefix,
      });

      this.poller?.stop();
      this.poller = new MarkerPoller(this.client, detector, this.options.pollIntervalMs);
      this.poller.on('events', (events) => void this.onEvents(events));
      this.poller.start();

      const channel = this.options.getEventChannelId();
      if (channel) {
        await bot.postText(channel, `🟢 Connected to **${info.name}** (${info.players}/${info.maxPlayers} online).`);
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), server: row.name },
        'failed to initialise server after connect',
      );
    }
  }

  /**
   * Monument positions, from cache when the wipe has not changed.
   *
   * getMap() costs 5 of 25 rate-limit tokens, so it is avoided on ordinary
   * reconnects (a server restart mid-wipe) and only paid on a fresh wipe.
   */
  private async loadMonuments(wipeTime: number): Promise<{ token: string; x: number; y: number }[]> {
    const { row } = this.options;
    const knownWipe = row.wipe_time ? Math.floor(new Date(row.wipe_time).getTime() / 1000) : null;
    const sameWipe = knownWipe !== null && knownWipe === wipeTime;

    if (sameWipe) {
      const cached = await getMonuments(row.id);
      if (cached.length > 0) {
        logger.debug({ count: cached.length }, 'using cached monuments');
        return cached;
      }
    }

    logger.info({ server: row.name }, 'fetching map for monument positions');
    const map = await this.client.getMap();
    const monuments = map.monuments.map((m) => ({ token: m.token, x: m.x, y: m.y }));
    await replaceMonuments(row.id, monuments);
    return monuments;
  }

  private async onEvents(events: DetectedEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.emit(event);
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error), type: event.type, phase: event.phase },
          'failed to handle event',
        );
      }
    }
  }

  /**
   * Persist an event, arm any follow-up timer, and announce it.
   *
   * recordEvent returns false for a duplicate (unique index on marker+phase),
   * which is how a reconnect avoids re-announcing markers it already reported.
   */
  private async emit(event: DetectedEvent): Promise<void> {
    const isNew = await recordEvent({
      serverId: this.serverId,
      eventType: event.type,
      phase: event.phase,
      grid: event.grid,
      worldX: event.x,
      worldY: event.y,
      opensAt: event.opensAt ?? null,
      markerId: event.markerId,
      // monument is stored here so "!large" / "!small" can tell the rigs apart.
      raw: event.monument ? { monument: event.monument } : {},
    });

    if (!isNew) return;

    if (event.type === 'oil_rig_crate' && event.phase === 'called') {
      await this.timers.armCrateUnlock(event);
    }
    if (event.type === 'cargo_ship' && event.phase === 'entered_map') {
      await this.timers.armCargoEgress(event, new Date(event.at.getTime() + CARGO_SHIP_EGRESS_MS));
    }

    if (!isHighSignal(event.type, event.phase)) return;

    const channel = this.options.getEventChannelId();
    if (!channel) {
      logger.warn('no event channel configured; run /setup');
      return;
    }

    await this.options.bot.postEvent(channel, event, this.options.useEmbeds());
  }

  private async onTeamMessage(steamId: string, name: string, message: string): Promise<void> {
    // Logged so it is possible to tell "the bot never heard you" (nothing here,
    // usually because the message went to global chat, or you are not in a
    // team) apart from "it heard you but did not answer".
    logger.info({ from: name, message }, 'team chat received');

    const mirrorChannel = this.options.getTeamChatChannelId();
    if (mirrorChannel) {
      await this.options.bot.postText(mirrorChannel, `**${name}:** ${message}`);
    }

    await this.chat?.handle(steamId, message);
  }

  async status(): Promise<ServerStatus> {
    const { row } = this.options;
    const pending = await getPendingTimers(row.id);

    return {
      id: row.id,
      name: row.name,
      address: `${row.server_ip}:${row.app_port}`,
      connected: this.client.isConnected,
      mapSize: this.mapSize ?? row.map_size,
      wipeTime: row.wipe_time,
      ...(this.lastInfo ?? {}),
      pendingTimers: pending.map((t) => ({ kind: t.kind, expiresAt: t.expires_at })),
    };
  }

  async stop(): Promise<void> {
    this.poller?.stop();
    this.timers.stop();
    await this.client.disconnect();
  }
}
