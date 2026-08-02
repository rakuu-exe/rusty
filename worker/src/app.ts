/**
 * Worker lifecycle and the wiring between Discord, Rust+ and Supabase.
 *
 * Holds one ServerRuntime per paired server, owns the FCM pairing listener,
 * and implements the BotContext the slash commands talk to.
 */

import { loadConfig, type Config } from './config.js';
import {
  deactivateServer,
  decryptedFcmCredentials,
  decryptedPlayerToken,
  getActiveServers,
  getGuildConfig,
  getPairingCredentials,
  markExpiryWarned,
  savePairingCredentials,
  setPairingSteamId,
  upsertGuildConfig,
  upsertServer,
  type DiscordConfigRow,
} from './db.js';
import { DiscordBot } from './discord/bot.js';
import { anchorFromClosesIn, deepSeaState } from './events/deepSea.js';
import type { BotContext, PairingStatus, ServerStatus } from './discord/context.js';
import type { DeepSeaDirection } from './events/deepSea.js';
import { logger } from './logger.js';
import {
  PairingListener,
  isSteamTokenExpiring,
  parseFcmCredentials,
  steamTokenExpiry,
} from './rustplus/pairing.js';
import type { PairingNotification } from './rustplus/types.js';
import { ServerRuntime } from './serverRuntime.js';

/** How often to re-check whether the Steam token is close to expiring. */
const EXPIRY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum gap between rebuilding a server runtime.
 *
 * Each rebuild resets the reconnect backoff, so without this a burst of
 * pairings keeps the client retrying aggressively against a server that is
 * already refusing it.
 */
const RUNTIME_RESTART_COOLDOWN_MS = 60_000;

export class App implements BotContext {
  readonly guildId: string;
  readonly timezone: string;

  private readonly config: Config;
  private readonly bot: DiscordBot;
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** playerToken currently in use per server, to spot genuine re-pairing. */
  private readonly activeTokens = new Map<string, string>();
  /** When each runtime was last (re)built, to avoid thrashing the backoff. */
  private readonly lastRuntimeStart = new Map<string, number>();

  private guildConfig: DiscordConfigRow | null = null;
  private pairingListener: PairingListener | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(config: Config = loadConfig()) {
    this.config = config;
    this.guildId = config.DISCORD_GUILD_ID;
    this.timezone = config.TIMEZONE;

    this.bot = new DiscordBot({
      token: config.DISCORD_TOKEN,
      guildId: config.DISCORD_GUILD_ID,
      timezone: config.TIMEZONE,
    });
  }

  async start(): Promise<void> {
    this.bot.setContext(this);
    await this.bot.login();

    this.guildConfig = await getGuildConfig(this.guildId);
    if (!this.guildConfig) {
      logger.warn('no guild config yet -- run /setup to choose an event channel');
    }

    // Resume from stored credentials so a restart does not require re-pairing.
    await this.resumePairingListener();
    await this.startPairedServers();

    this.expiryTimer = setInterval(() => void this.checkTokenExpiry(), EXPIRY_CHECK_INTERVAL_MS);
    await this.checkTokenExpiry();

    logger.info({ servers: this.runtimes.size }, 'worker ready');
  }

  async stop(): Promise<void> {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.pairingListener?.stop();

    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop()));
    this.runtimes.clear();

    await this.bot.destroy();
  }

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  private async startPairedServers(): Promise<void> {
    const servers = await getActiveServers(this.guildId);

    for (const row of servers) {
      try {
        await this.startServer(row.id, row);
      } catch (error) {
        // One unreachable server must not stop the others from coming up.
        logger.error(
          { err: error instanceof Error ? error.message : String(error), server: row.name },
          'failed to start server runtime',
        );
      }
    }
  }

  private async startServer(id: string, row: Awaited<ReturnType<typeof getActiveServers>>[number]): Promise<void> {
    await this.runtimes.get(id)?.stop();

    // Record the token in use so a redelivered pairing push for the same
    // token is recognised as a no-op rather than a re-pair.
    this.activeTokens.set(id, decryptedPlayerToken(row));

    const runtime = new ServerRuntime({
      row,
      bot: this.bot,
      pollIntervalMs: this.config.POLL_INTERVAL_MS,
      commandPrefix: this.guildConfig?.command_prefix ?? this.config.INGAME_COMMAND_PREFIX,
      timezone: this.timezone,
      getEventChannelId: () => this.guildConfig?.event_channel_id ?? null,
      getTeamChatChannelId: () => this.guildConfig?.team_chat_channel_id ?? null,
      useEmbeds: () => this.guildConfig?.use_embeds ?? true,
    });

    this.runtimes.set(id, runtime);
    this.lastRuntimeStart.set(id, Date.now());
    await runtime.start();
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  private async resumePairingListener(): Promise<void> {
    const stored = await getPairingCredentials(this.guildId);
    if (!stored) return;

    try {
      const credentials = parseFcmCredentials(decryptedFcmCredentials(stored));
      await this.startPairingListener(credentials);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'stored FCM credentials could not be used -- run /connect again',
      );
    }
  }

  private async startPairingListener(credentials: ReturnType<typeof parseFcmCredentials>): Promise<void> {
    this.pairingListener?.stop();

    const listener = new PairingListener(credentials);
    listener.on('serverPaired', (notification) => void this.onServerPaired(notification));
    listener.on('entityPaired', (notification) =>
      logger.info({ name: notification.name }, 'ignoring smart device pairing (not supported in v1)'),
    );
    listener.on('error', (error) => logger.error({ err: error.message }, 'pairing listener error'));

    await listener.start();
    this.pairingListener = listener;
  }

  private async onServerPaired(notification: PairingNotification): Promise<void> {
    try {
      const row = await upsertServer({
        guildId: this.guildId,
        name: notification.name,
        ...(notification.desc ? { description: notification.desc } : {}),
        serverIp: notification.ip,
        appPort: Number(notification.port),
        playerId: notification.playerId,
        playerToken: notification.playerToken,
      });

      await setPairingSteamId(this.guildId, notification.playerId);

      const existing = this.runtimes.get(row.id);
      const address = `${notification.ip}:${notification.port}`;

      /**
       * A moved server always forces a rebuild.
       *
       * The client fixes its address at construction, so a running runtime
       * keeps dialing wherever it started. When the server moved and the token
       * happened to be unchanged, the guard below discarded the pairing and
       * the bot spent the rest of its life sending SYNs to a host that no
       * longer existed -- ETIMEDOUT on every retry, backoff climbing to five
       * minutes, and nothing in the logs above debug to say why.
       */
      const moved = existing != null && existing.address !== address;
      if (moved) {
        logger.warn({ server: row.name, from: existing.address, to: address }, 'server moved; reconnecting');
      }

      /**
       * FCM redelivers stored pushes whenever the listener reconnects, so on
       * every boot the original pairing arrives again. Tearing the runtime
       * down and rebuilding it for an unchanged pairing caused a needless
       * disconnect/reconnect cycle and a second (expensive) getMap.
       */
      if (existing && !moved && this.activeTokens.get(row.id) === notification.playerToken) {
        logger.debug({ server: row.name }, 'ignoring redelivered pairing for an unchanged token');
        return;
      }

      this.activeTokens.set(row.id, notification.playerToken);

      /**
       * Rebuilding the runtime resets the reconnect backoff, so a burst of
       * pairings drags the client back to aggressive retries exactly when it
       * should be easing off. Observed live: backoff had climbed to 16s and
       * repeated pairings knocked it back to 3s each time, adding pressure to
       * a connection that was already being refused.
       *
       * Handing the credentials to the live client instead gets the same
       * result on its next scheduled reconnect. That is what this used to
       * claim to do while doing nothing at all -- the options were fixed at
       * construction, so a deferred re-pair was silently dropped.
       *
       * A move is exempt: the backoff being protected belongs to a dead
       * address and is worth nothing.
       */
      const lastStart = this.lastRuntimeStart.get(row.id) ?? 0;
      const sinceLastStart = Date.now() - lastStart;
      if (existing && !moved && sinceLastStart < RUNTIME_RESTART_COOLDOWN_MS) {
        existing.updateCredentials(notification.playerId, notification.playerToken);
        logger.info(
          { server: row.name, sinceLastStartMs: sinceLastStart },
          'pairing accepted; applying on the next reconnect so backoff is not reset',
        );
        return;
      }

      await this.startServer(row.id, row);

      logger.info({ server: row.name, address }, 'paired and connected');
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to handle server pairing',
      );
    }
  }

  /**
   * Warn in Discord before the Steam token behind FCM registration lapses.
   *
   * When it expires, pairing pushes simply stop arriving with no other symptom
   * — so without this the failure mode is silent.
   */
  private async checkTokenExpiry(): Promise<void> {
    try {
      const stored = await getPairingCredentials(this.guildId);
      if (!stored?.expires_at || stored.last_warned_at) return;

      const expiresAt = new Date(stored.expires_at);
      if (!isSteamTokenExpiring(expiresAt)) return;

      const channel = this.guildConfig?.event_channel_id;
      if (channel) {
        const expired = expiresAt.getTime() <= Date.now();
        await this.bot.postText(
          channel,
          expired
            ? '⚠️ The Rust+ Steam token has **expired**. Pairing pushes will not arrive until you re-run `npm run fcm-register` and `/connect` again.'
            : `⚠️ The Rust+ Steam token expires on **${expiresAt.toDateString()}**. Re-run \`npm run fcm-register\` and \`/connect\` before then.`,
        );
      }

      await markExpiryWarned(this.guildId);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'token expiry check failed');
    }
  }

  // -------------------------------------------------------------------------
  // BotContext
  // -------------------------------------------------------------------------

  async getServerStatuses(): Promise<ServerStatus[]> {
    return Promise.all([...this.runtimes.values()].map((runtime) => runtime.status()));
  }

  async getPairingStatus(): Promise<PairingStatus> {
    const stored = await getPairingCredentials(this.guildId);
    if (!stored) return { listening: false, expiringSoon: false };

    const expiresAt = stored.expires_at ? new Date(stored.expires_at) : null;

    return {
      listening: this.pairingListener !== null,
      ...(stored.steam_id ? { steamId: stored.steam_id } : {}),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      expiringSoon: expiresAt ? isSteamTokenExpiring(expiresAt) : false,
    };
  }

  async beginPairing(credentialsJson: string): Promise<void> {
    // Throws with a user-facing message if the blob is not what fcm-register
    // produces; commands.ts surfaces that text directly.
    const credentials = parseFcmCredentials(credentialsJson);

    await savePairingCredentials({
      guildId: this.guildId,
      credentialsJson,
      ...(credentials.expo_push_token ? { expoPushToken: credentials.expo_push_token } : {}),
      expiresAt: steamTokenExpiry(new Date()),
    });

    await this.startPairingListener(credentials);
  }

  async disconnectServer(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) throw new Error(`No such server: ${serverId}`);

    await runtime.stop();
    this.runtimes.delete(serverId);
    await deactivateServer(serverId);
  }

  async setEventChannel(channelId: string): Promise<void> {
    this.guildConfig = await upsertGuildConfig(this.guildId, {
      event_channel_id: channelId,
      timezone: this.timezone,
    });
  }

  async setTeamChatChannel(channelId: string | null): Promise<void> {
    this.guildConfig = await upsertGuildConfig(this.guildId, { team_chat_channel_id: channelId });
  }

  async recordDeepSeaOpened(
    closesInMs: number | null,
    direction: DeepSeaDirection | null,
  ): Promise<{ server: string; closesInMs: number; direction?: DeepSeaDirection }[]> {
    const now = new Date();
    // Work backwards from the in-game countdown when one was given, so the
    // anchor is correct even though the open moment was not witnessed.
    const anchor = closesInMs === null ? { openedAt: now } : anchorFromClosesIn(closesInMs, now);

    const results: { server: string; closesInMs: number; direction?: DeepSeaDirection }[] = [];

    for (const runtime of this.runtimes.values()) {
      await runtime.recordDeepSeaOpened(anchor.openedAt, direction);
      const resolved = runtime.deepSeaDirectionValue;
      results.push({
        server: (await runtime.status()).name,
        closesInMs: deepSeaState(anchor.openedAt, now).closesInMs ?? 0,
        ...(resolved ? { direction: resolved } : {}),
      });
    }

    return results;
  }
}
