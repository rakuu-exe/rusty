/**
 * What the slash commands are allowed to ask of the worker.
 *
 * Declared as an interface so the command handlers do not import the
 * orchestrator directly -- that would be circular, since the orchestrator owns
 * the Discord client that dispatches the commands.
 */

export interface ServerStatus {
  id: string;
  name: string;
  address: string;
  connected: boolean;
  mapSize: number | null;
  wipeTime: string | null;
  players?: number;
  maxPlayers?: number;
  /** Pending timers, e.g. a crate unlocking in 4 minutes. */
  pendingTimers: { kind: string; expiresAt: string }[];
}

export interface PairingStatus {
  /** Whether FCM credentials are stored and the push listener is running. */
  listening: boolean;
  steamId?: string;
  expiresAt?: string;
  expiringSoon: boolean;
}

export interface BotContext {
  guildId: string;
  timezone: string;

  getServerStatuses(): Promise<ServerStatus[]>;
  getPairingStatus(): Promise<PairingStatus>;

  /**
   * Store FCM credentials and start listening for pairing pushes.
   * The user then pairs in game, which is what actually creates the server.
   */
  beginPairing(credentialsJson: string): Promise<void>;

  disconnectServer(serverId: string): Promise<void>;

  setEventChannel(channelId: string): Promise<void>;
  setTeamChatChannel(channelId: string | null): Promise<void>;
}
