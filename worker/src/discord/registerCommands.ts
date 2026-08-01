/**
 * Registers slash commands with Discord.
 *
 * Run via `npm run register-commands` after changing commandDefinitions.
 * Guild-scoped registration is used deliberately: it propagates instantly,
 * whereas global commands can take up to an hour to appear. This is a private
 * single-guild bot, so there is no reason to register globally.
 */

import { existsSync } from 'node:fs';
import { REST, Routes } from 'discord.js';
import { loadDiscordConfig } from '../config.js';
import { logger } from '../logger.js';
import { commandDefinitions } from './commands.js';

async function main(): Promise<void> {
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }

  // Only the Discord settings -- this talks to Discord's REST API and never
  // touches Supabase, so it must not require database configuration.
  const config = loadDiscordConfig();
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  logger.info({ count: commandDefinitions.length }, 'registering slash commands');

  await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), {
    body: commandDefinitions,
  });

  logger.info('slash commands registered');
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'failed to register commands');
  process.exitCode = 1;
});
