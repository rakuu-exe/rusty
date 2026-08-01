/**
 * Worker entry point.
 *
 * Loads .env, validates configuration, starts the app, and shuts down cleanly
 * on SIGINT/SIGTERM so Fly.io or systemd restarts do not leave sockets open.
 */

import { existsSync } from 'node:fs';
import { App } from './app.js';
import { loadConfig } from './config.js';
import { loadItems } from './vending/items.js';
import { logger } from './logger.js';

/**
 * Load .env if present, using Node's built-in reader (20.12+).
 *
 * Done here rather than via the --env-file flag so `npm start` and `npm run
 * dev` work unmodified, and so a missing .env is a clear config error from
 * loadConfig rather than an unexplained crash.
 */
function loadDotEnv(): void {
  if (!existsSync('.env')) return;

  if (typeof process.loadEnvFile !== 'function') {
    logger.warn('Node is too old to read .env natively; pass --env-file=.env instead');
    return;
  }

  process.loadEnvFile('.env');
}

async function main(): Promise<void> {
  loadDotEnv();

  const settings = loadConfig();
  loadItems();
  logger.info({ timezone: settings.TIMEZONE, pollMs: settings.POLL_INTERVAL_MS }, 'starting worker');

  const app = new App(settings);
  await app.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    try {
      await app.stop();
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A rejected promise that reaches here means a bug, not a transient network
  // problem -- those are handled at their call sites. Log loudly, keep running.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });

  /**
   * Survive exceptions thrown from inside dependencies.
   *
   * rustplus.js decodes protobuf inside its own WebSocket 'message' handler.
   * When Facepunch changes the schema, protobufjs throws from there — outside
   * any promise or try/catch this code owns — and the process dies. That took
   * the bot down in production the first time it connected to a live server.
   *
   * Swallowing uncaught exceptions is normally wrong: process state may be
   * corrupt. Here it is the lesser evil, because the realistic cause is one
   * malformed packet and the alternative is the bot silently dying overnight.
   * The crash-loop guard below still exits if it turns out to be systemic,
   * so a supervisor can restart cleanly rather than spin.
   */
  const recentCrashes: number[] = [];
  const CRASH_WINDOW_MS = 60_000;
  const CRASH_LIMIT = 10;

  process.on('uncaughtException', (error) => {
    logger.error({ err: error.message, stack: error.stack }, 'uncaught exception -- continuing');

    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length > 0 && now - recentCrashes[0]! > CRASH_WINDOW_MS) {
      recentCrashes.shift();
    }

    if (recentCrashes.length >= CRASH_LIMIT) {
      logger.fatal(
        { count: recentCrashes.length },
        'too many uncaught exceptions in a short window -- exiting for a clean restart',
      );
      process.exit(1);
    }
  });
}

main().catch((error) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, 'worker failed to start');
  process.exit(1);
});
