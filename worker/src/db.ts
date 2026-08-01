/**
 * Supabase access layer.
 *
 * Every table has RLS enabled with no permissive policies, so this client's
 * service-role key is the only way in. It must never leave the worker.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { logger } from './logger.js';

export interface RustServerRow {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  server_ip: string;
  app_port: number;
  player_id: string;
  /** Ciphertext. Use `decryptedPlayerToken` rather than reading this directly. */
  player_token: string;
  map_size: number | null;
  seed: number | null;
  salt: number | null;
  wipe_time: string | null;
  is_active: boolean;
  connected_at: string | null;
}

export interface DiscordConfigRow {
  guild_id: string;
  event_channel_id: string | null;
  team_chat_channel_id: string | null;
  timezone: string;
  command_prefix: string;
  use_embeds: boolean;
}

export interface EventLogRow {
  id: string;
  server_id: string;
  event_type: string;
  phase: string;
  grid: string | null;
  world_x: number | null;
  world_y: number | null;
  opens_at: string | null;
  marker_id: string | null;
  raw: unknown;
  created_at: string;
}

export interface ActiveTimerRow {
  id: string;
  server_id: string;
  kind: string;
  expires_at: string;
  payload: Record<string, unknown>;
  fired_at: string | null;
}

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;

  const config = loadConfig();
  client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Decrypt a stored player token for use against the Rust+ API. */
export function decryptedPlayerToken(row: Pick<RustServerRow, 'player_token'>): string {
  return decrypt(row.player_token, loadConfig().CREDENTIALS_ENCRYPTION_KEY);
}

export function encryptSecret(plaintext: string): string {
  return encrypt(plaintext, loadConfig().CREDENTIALS_ENCRYPTION_KEY);
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export async function getActiveServers(guildId: string): Promise<RustServerRow[]> {
  const { data, error } = await db()
    .from('rust_servers')
    .select('*')
    .eq('guild_id', guildId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed to load servers: ${error.message}`);
  return (data ?? []) as RustServerRow[];
}

/**
 * Upsert a server captured from a pairing notification.
 *
 * Re-pairing the same server issues a fresh playerToken, so this must update
 * in place on (server_ip, app_port, player_id) rather than inserting a
 * duplicate that the poller would then connect to twice.
 */
export async function upsertServer(input: {
  guildId: string;
  name: string;
  description?: string;
  serverIp: string;
  appPort: number;
  playerId: string;
  playerToken: string;
}): Promise<RustServerRow> {
  const { data, error } = await db()
    .from('rust_servers')
    .upsert(
      {
        guild_id: input.guildId,
        name: input.name,
        description: input.description ?? null,
        server_ip: input.serverIp,
        app_port: input.appPort,
        player_id: input.playerId,
        player_token: encryptSecret(input.playerToken),
        is_active: true,
      },
      { onConflict: 'server_ip,app_port,player_id' },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save server: ${error.message}`);
  return data as RustServerRow;
}

/** Persist the server metadata that getInfo() returns once connected. */
export async function updateServerInfo(
  serverId: string,
  // seed and salt are optional: some servers omit them from AppInfo entirely.
  info: { mapSize: number; seed?: number; salt?: number; wipeTime: number; name: string },
): Promise<void> {
  const { error } = await db()
    .from('rust_servers')
    .update({
      map_size: info.mapSize,
      seed: info.seed ?? null,
      salt: info.salt ?? null,
      // Rust+ reports wipeTime as unix seconds.
      wipe_time: new Date(info.wipeTime * 1000).toISOString(),
      name: info.name,
      connected_at: new Date().toISOString(),
    })
    .eq('id', serverId);

  if (error) throw new Error(`Failed to update server info: ${error.message}`);
}

export async function deactivateServer(serverId: string): Promise<void> {
  const { error } = await db().from('rust_servers').update({ is_active: false }).eq('id', serverId);
  if (error) throw new Error(`Failed to deactivate server: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Guild config
// ---------------------------------------------------------------------------

export async function getGuildConfig(guildId: string): Promise<DiscordConfigRow | null> {
  const { data, error } = await db().from('discord_config').select('*').eq('guild_id', guildId).maybeSingle();
  if (error) throw new Error(`Failed to load guild config: ${error.message}`);
  return (data as DiscordConfigRow | null) ?? null;
}

export async function upsertGuildConfig(
  guildId: string,
  patch: Partial<Omit<DiscordConfigRow, 'guild_id'>>,
): Promise<DiscordConfigRow> {
  const { data, error } = await db()
    .from('discord_config')
    .upsert({ guild_id: guildId, ...patch }, { onConflict: 'guild_id' })
    .select()
    .single();

  if (error) throw new Error(`Failed to save guild config: ${error.message}`);
  return data as DiscordConfigRow;
}

// ---------------------------------------------------------------------------
// Monuments
// ---------------------------------------------------------------------------

/** Replace the cached monuments for a server (called on connect and on wipe). */
export async function replaceMonuments(
  serverId: string,
  monuments: { token: string; x: number; y: number }[],
): Promise<void> {
  const client = db();

  const { error: deleteError } = await client.from('monuments').delete().eq('server_id', serverId);
  if (deleteError) throw new Error(`Failed to clear monuments: ${deleteError.message}`);

  if (monuments.length === 0) return;

  const { error } = await client
    .from('monuments')
    .insert(monuments.map((m) => ({ server_id: serverId, token: m.token, x: m.x, y: m.y })));
  if (error) throw new Error(`Failed to cache monuments: ${error.message}`);
}

export async function getMonuments(serverId: string): Promise<{ token: string; x: number; y: number }[]> {
  const { data, error } = await db().from('monuments').select('token, x, y').eq('server_id', serverId);
  if (error) throw new Error(`Failed to load monuments: ${error.message}`);
  return (data ?? []) as { token: string; x: number; y: number }[];
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/**
 * Record an event.
 *
 * Returns false when the event was already recorded. A unique index on
 * (server_id, marker_id, event_type, phase) makes this idempotent, which is
 * what stops a worker restart from re-announcing every marker currently on
 * the map as though it had just appeared.
 */
export async function recordEvent(input: {
  serverId: string;
  eventType: string;
  phase: string;
  grid?: string | null;
  worldX?: number | null;
  worldY?: number | null;
  opensAt?: Date | null;
  markerId?: string | null;
  raw?: unknown;
}): Promise<boolean> {
  const { error } = await db().from('event_log').insert({
    server_id: input.serverId,
    event_type: input.eventType,
    phase: input.phase,
    grid: input.grid ?? null,
    world_x: input.worldX ?? null,
    world_y: input.worldY ?? null,
    opens_at: input.opensAt?.toISOString() ?? null,
    marker_id: input.markerId ?? null,
    raw: input.raw ?? null,
  });

  if (error) {
    // 23505 == unique_violation: this exact event is already logged.
    if (error.code === '23505') {
      logger.debug({ markerId: input.markerId, phase: input.phase }, 'duplicate event ignored');
      return false;
    }
    throw new Error(`Failed to record event: ${error.message}`);
  }

  return true;
}

/** Most recent event of a type, used by the in-game "!heli" style commands. */
export async function getLastEvent(
  serverId: string,
  eventType: string,
  phase?: string,
): Promise<EventLogRow | null> {
  let query = db()
    .from('event_log')
    .select('*')
    .eq('server_id', serverId)
    .eq('event_type', eventType)
    .order('created_at', { ascending: false })
    .limit(1);

  if (phase) query = query.eq('phase', phase);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load last event: ${error.message}`);
  return (data?.[0] as EventLogRow | undefined) ?? null;
}

/**
 * Most recent oil rig event for one specific rig.
 *
 * Both rigs share the 'oil_rig_crate' event type, so "!large" and "!small"
 * would otherwise answer with whichever rig fired most recently. The monument
 * name is stored in `raw` and filtered on here.
 */
export async function getLastOilRigEvent(
  serverId: string,
  monument: string,
  phase?: string,
): Promise<EventLogRow | null> {
  let query = db()
    .from('event_log')
    .select('*')
    .eq('server_id', serverId)
    .eq('event_type', 'oil_rig_crate')
    .eq('raw->>monument', monument)
    .order('created_at', { ascending: false })
    .limit(1);

  if (phase) query = query.eq('phase', phase);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load last oil rig event: ${error.message}`);
  return (data?.[0] as EventLogRow | undefined) ?? null;
}

/**
 * Recent occurrences of one event phase, newest first.
 *
 * Kept for historical queries and diagnostics. No command depends on it:
 * commands read live session state, not the event log.
 *
 * `monument` filters the two oil rigs apart, since they share an event type.
 */
export async function getRecentEvents(
  serverId: string,
  eventType: string,
  phase: string,
  options: { limit?: number; monument?: string } = {},
): Promise<EventLogRow[]> {
  let query = db()
    .from('event_log')
    .select('*')
    .eq('server_id', serverId)
    .eq('event_type', eventType)
    .eq('phase', phase)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 10);

  if (options.monument) query = query.eq('raw->>monument', options.monument);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load recent events: ${error.message}`);
  return (data ?? []) as EventLogRow[];
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/**
 * Arm a timer. Returns null when an identical pending timer already exists,
 * so a duplicate marker observation cannot double-arm the same crate.
 */
export async function armTimer(input: {
  serverId: string;
  kind: string;
  expiresAt: Date;
  payload: Record<string, unknown>;
}): Promise<ActiveTimerRow | null> {
  const { data, error } = await db()
    .from('active_timers')
    .insert({
      server_id: input.serverId,
      kind: input.kind,
      expires_at: input.expiresAt.toISOString(),
      payload: input.payload,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return null;
    throw new Error(`Failed to arm timer: ${error.message}`);
  }

  return data as ActiveTimerRow;
}

/** Pending timers, including ones already past due after a restart. */
export async function getPendingTimers(serverId: string): Promise<ActiveTimerRow[]> {
  const { data, error } = await db()
    .from('active_timers')
    .select('*')
    .eq('server_id', serverId)
    .is('fired_at', null)
    .order('expires_at', { ascending: true });

  if (error) throw new Error(`Failed to load timers: ${error.message}`);
  return (data ?? []) as ActiveTimerRow[];
}

// ---------------------------------------------------------------------------
// Pairing credentials
// ---------------------------------------------------------------------------

export interface PairingCredentialsRow {
  guild_id: string;
  steam_id: string | null;
  /** Ciphertext of the whole rustplus.config.json blob. */
  fcm_credentials: string;
  expo_push_token: string | null;
  issued_at: string;
  expires_at: string | null;
  last_warned_at: string | null;
}

export async function getPairingCredentials(guildId: string): Promise<PairingCredentialsRow | null> {
  const { data, error } = await db()
    .from('pairing_credentials')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load pairing credentials: ${error.message}`);
  return (data as PairingCredentialsRow | null) ?? null;
}

export async function savePairingCredentials(input: {
  guildId: string;
  credentialsJson: string;
  expoPushToken?: string;
  expiresAt: Date;
}): Promise<void> {
  const { error } = await db().from('pairing_credentials').upsert(
    {
      guild_id: input.guildId,
      fcm_credentials: encryptSecret(input.credentialsJson),
      expo_push_token: input.expoPushToken ?? null,
      issued_at: new Date().toISOString(),
      expires_at: input.expiresAt.toISOString(),
      // A fresh registration clears any prior expiry warning.
      last_warned_at: null,
    },
    { onConflict: 'guild_id' },
  );

  if (error) throw new Error(`Failed to save pairing credentials: ${error.message}`);
}

/** Decrypt a stored credentials blob back into its original JSON text. */
export function decryptedFcmCredentials(row: Pick<PairingCredentialsRow, 'fcm_credentials'>): string {
  return decrypt(row.fcm_credentials, loadConfig().CREDENTIALS_ENCRYPTION_KEY);
}

/** Record the Steam ID once the first pairing push reveals it. */
export async function setPairingSteamId(guildId: string, steamId: string): Promise<void> {
  const { error } = await db().from('pairing_credentials').update({ steam_id: steamId }).eq('guild_id', guildId);
  if (error) throw new Error(`Failed to record steam id: ${error.message}`);
}

export async function markExpiryWarned(guildId: string): Promise<void> {
  const { error } = await db()
    .from('pairing_credentials')
    .update({ last_warned_at: new Date().toISOString() })
    .eq('guild_id', guildId);
  if (error) throw new Error(`Failed to record expiry warning: ${error.message}`);
}

export async function markTimerFired(timerId: string): Promise<void> {
  const { error } = await db()
    .from('active_timers')
    .update({ fired_at: new Date().toISOString() })
    .eq('id', timerId);
  if (error) throw new Error(`Failed to mark timer fired: ${error.message}`);
}

export async function cancelTimer(timerId: string): Promise<void> {
  const { error } = await db().from('active_timers').delete().eq('id', timerId);
  if (error) throw new Error(`Failed to cancel timer: ${error.message}`);
}
