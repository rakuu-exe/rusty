/**
 * Environment configuration, validated once at boot.
 *
 * Failing fast here beats discovering a missing token when the first oil rig
 * crate is called at 3am.
 */

import { z } from 'zod';

/**
 * Discord settings, split out because registering slash commands needs only
 * these. Demanding a database URL to talk to Discord's REST API would block a
 * step that has nothing to do with the database.
 */
const discordSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),
});

export type DiscordConfig = z.infer<typeof discordSchema>;

const schema = discordSchema.extend({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // 32 bytes hex-encoded. Anything shorter weakens AES-256-GCM to no purpose.
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  // A 5s poll costs 0.2 tokens/sec against a 3 tokens/sec refill. The floor of
  // 1000ms keeps a misconfiguration from burning the per-playerId bucket.
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),

  TIMEZONE: z.string().default('UTC'),
  INGAME_COMMAND_PREFIX: z.string().min(1).max(3).default('!'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }

  // Surface a bad timezone now rather than when formatting the first alert.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: parsed.data.TIMEZONE });
  } catch {
    throw new Error(`Invalid configuration:\n  - TIMEZONE: "${parsed.data.TIMEZONE}" is not a known IANA timezone`);
  }

  cached = parsed.data;
  return cached;
}

/** Just the Discord settings, for tools that never touch the database. */
export function loadDiscordConfig(env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  const parsed = discordSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid Discord configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}

/** Test hook -- forces the next loadConfig() to re-read the environment. */
export function resetConfigCache(): void {
  cached = null;
}
