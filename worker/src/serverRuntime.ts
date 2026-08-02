/**
 * Everything the bot does for one paired Rust server.
 *
 * Owns the Rust+ socket, the marker poller, the detector, the timer scheduler
 * and the in-game chat handler, and routes detected events to Discord and the
 * event log. One instance per row in rust_servers.
 */

import {
  decryptedPlayerToken,
  getLastEvent,
  getMonuments,
  getPendingTimers,
  recordEvent,
  replaceMonuments,
  updateServerInfo,
  type RustServerRow,
} from './db.js';
import { CARGO_SHIP_EGRESS_MS, EventDetector } from './events/detector.js';
import { EventSubject, type EventStateStore } from './events/state.js';
import { isDeepSeaDirection, type DeepSeaDirection } from './events/deepSea.js';
import { MarkerPoller } from './events/poller.js';
import { TimerScheduler } from './events/timers.js';
import type { DetectedEvent } from './events/types.js';
import { formatEventLineInGame, isHighSignal } from './format/message.js';
import { InGameChatHandler, SelfMessageTracker } from './ingame/chat.js';
import { logger } from './logger.js';
import { RustPlusClient } from './rustplus/client.js';
import { formatGridPosition } from './rustplus/grid.js';
import { MonumentIndex } from './rustplus/monuments.js';
import type { RustMapMarker } from './rustplus/types.js';
import { VendingStore } from './vending/store.js';
import { toVendingMachines } from './vending/decode.js';
import { describeVendingEvent, isAnnounceableVendingEvent } from './vending/format.js';
import type { DiscordBot } from './discord/bot.js';
import type { ServerStatus } from './discord/context.js';

export interface ServerRuntimeOptions {
  row: RustServerRow;
  bot: DiscordBot;
  pollIntervalMs: number;
  commandPrefix: string;
  /** IANA timezone, used for the unlock time in in-game rig alerts. */
  timezone: string;
  getEventChannelId: () => string | null;
  getTeamChatChannelId: () => string | null;
  useEmbeds: () => boolean;
}

export class ServerRuntime {
  private readonly client: RustPlusClient;
  private readonly timers: TimerScheduler;
  private poller: MarkerPoller | null = null;
  private chat: InGameChatHandler | null = null;
  private readonly selfMessages = new SelfMessageTracker();
  /** Vending session state. In memory by design: history is session-scoped. */
  private readonly vending = new VendingStore();
  /** Rebuilt on every connection, since a wipe invalidates world state. */
  private detector: EventDetector | null = null;
  /**
   * Last confirmed Deep Sea open, supplied by an admin rather than observed.
   * Persisted, because the convar cycle keeps running across bot restarts.
   */
  private deepSeaAnchor: Date | null = null;
  /** Fixed for the whole wipe, so it outlives any single anchor. */
  private deepSeaDirection: DeepSeaDirection | null = null;
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

  /** Where the client is dialing, as `ip:port`. Changes when the server moves. */
  get address(): string {
    return this.client.address;
  }

  /** Adopt a re-pairing's credentials in place; applied on the next reconnect. */
  updateCredentials(playerId: string, playerToken: string): boolean {
    return this.client.updateCredentials({ playerId, playerToken });
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
      this.detector = detector;

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

      // Deep Sea's cycle keeps running while the bot is down, so a previously
      // recorded anchor stays valid and is restored rather than re-asked for.
      const anchor = await getLastEvent(row.id, 'deep_sea', 'opened');
      this.deepSeaAnchor = anchor ? new Date(anchor.created_at) : null;
      this.deepSeaDirection =
        anchor?.grid && isDeepSeaDirection(anchor.grid) ? anchor.grid : null;

      this.chat = new InGameChatHandler(
        {
          serverId: row.id,
          client: this.client,
          prefix: this.options.commandPrefix,
          timezone: this.options.timezone,
          // Commands read these and never write to them.
          state: detector.state,
          vending: this.vending,
          getDeepSeaAnchor: () =>
            this.deepSeaAnchor
              ? { openedAt: this.deepSeaAnchor, ...(this.deepSeaDirection ? { direction: this.deepSeaDirection } : {}) }
              : null,
        },
        this.selfMessages,
      );

      this.poller?.stop();
      this.poller = new MarkerPoller(this.client, detector, this.options.pollIntervalMs);
      this.poller.on('events', (events) => void this.onEvents(events));
      this.poller.on('markers', (markers) => void this.onVendingSnapshot(markers, info.mapSize));
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

  /**
   * Feed vending machines from the same snapshot the detector uses.
   *
   * Costs no extra rate-limit tokens, since it is the poll that already
   * happened. Only tracked-item hits are announced: a busy server churns
   * hundreds of stock changes an hour, and announcing them all would bury the
   * channel. Everything else is still recorded for the commands to read.
   */
  private async onVendingSnapshot(markers: RustMapMarker[], mapSize: number): Promise<void> {
    const machines = toVendingMachines(markers, mapSize);
    const events = this.vending.update(machines);

    for (const event of events.filter((e) => isAnnounceableVendingEvent(e.kind))) {
      const line = describeVendingEvent(event);
      try {
        const channel = this.options.getEventChannelId();
        if (channel) await this.options.bot.postText(channel, `🛒 ${line}`);

        if (this.client.isConnected) {
          this.selfMessages.remember(line);
          await this.client.sendTeamMessage(line);
        }
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'failed to announce vending change',
        );
      }
    }
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

    // Advance the rig lifecycle when its countdown resolves. Driven by the
    // timer that the observed Chinook arrival armed -- never by a command.
    if (event.type === 'oil_rig_crate' && event.phase === 'unlocked' && event.monument) {
      const subject =
        event.monument === 'Large Oil Rig' ? EventSubject.LargeOilRig : EventSubject.SmallOilRig;
      this.detector?.state.markOilRigUnlocked(subject, event.at);
    }
    if (event.type === 'cargo_ship' && event.phase === 'entered_map') {
      await this.timers.armCargoEgress(event, new Date(event.at.getTime() + CARGO_SHIP_EGRESS_MS));
    }

    if (!isHighSignal(event.type, event.phase)) return;

    const channel = this.options.getEventChannelId();
    if (channel) {
      await this.options.bot.postEvent(channel, event, this.options.useEmbeds());
    } else {
      logger.warn('no event channel configured; run /setup');
    }

    await this.announceInGame(event);
  }

  /**
   * Mirror the alert into Rust team chat.
   *
   * Uses the compact wording rather than the Discord line, which is too long
   * for a chat message read mid-fight. Failures are logged and swallowed: the
   * Discord alert is the primary channel, and a team chat hiccup (server
   * restarting, rate limit) must not lose the event.
   */
  private async announceInGame(event: DetectedEvent): Promise<void> {
    if (!this.client.isConnected) return;

    const line = formatEventLineInGame(event, { timezone: this.options.timezone });

    try {
      // Remember before sending: the echo can arrive before the await resolves.
      this.selfMessages.remember(line);
      await this.client.sendTeamMessage(line);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), event: event.type },
        'failed to announce event in game',
      );
    }
  }

  private async onTeamMessage(steamId: string, name: string, message: string): Promise<void> {
    // The bot's own alerts and replies come back over team chat under the
    // paired player's name. Mirroring those to Discord would duplicate every
    // alert into the chat channel, so drop them here.
    if (this.selfMessages.isSelf(message)) return;

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

  /**
   * Record a confirmed Deep Sea open.
   *
   * Called from the admin Discord command, never from a status command: Deep
   * Sea has no marker, so this is a human observation being entered, not the
   * bot inferring anything.
   */
  async recordDeepSeaOpened(at: Date, direction: DeepSeaDirection | null): Promise<void> {
    // The direction is fixed for the whole wipe, so re-anchoring the countdown
    // without restating it keeps the one already known.
    const resolved = direction ?? this.deepSeaDirection;

    await recordEvent({
      serverId: this.serverId,
      eventType: 'deep_sea',
      phase: 'opened',
      // Reuses the grid column: Deep Sea has no cell, but it does have a half.
      grid: resolved,
    });

    this.deepSeaAnchor = at;
    this.deepSeaDirection = resolved;
  }

  /** Current session state, for read-only reporting. */
  get eventState(): EventStateStore | null {
    return this.detector?.state ?? null;
  }

  get deepSeaOpenedAt(): Date | null {
    return this.deepSeaAnchor;
  }

  get deepSeaDirectionValue(): DeepSeaDirection | null {
    return this.deepSeaDirection;
  }

  /**
   * Re-read the population before reporting it.
   *
   * getInfo() otherwise runs once per connection, so /status showed the
   * figure as it stood at connect time. After an overnight reconnect that
   * meant a reading hours old -- and because the bot reconnected the moment
   * the server came back from an outage, the frozen value was 0/300.
   *
   * One token, only when somebody asks, against a marker poll that spends one
   * every five seconds. A failure keeps the cached figure rather than failing
   * the command, since a stale number is still more useful than an error.
   */
  private async refreshInfo(): Promise<void> {
    if (!this.client.isConnected) return;

    try {
      const info = await this.client.getInfo();
      this.mapSize = info.mapSize;
      this.lastInfo = { players: info.players, maxPlayers: info.maxPlayers };
    } catch (error) {
      logger.debug(
        { err: error instanceof Error ? error.message : String(error), server: this.options.row.name },
        'could not refresh server info for status',
      );
    }
  }

  async status(): Promise<ServerStatus> {
    const { row } = this.options;
    await this.refreshInfo();
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
