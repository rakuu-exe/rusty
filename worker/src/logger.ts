import pino from 'pino';

/**
 * Shared logger.
 *
 * `redact` is not decoration here: playerToken and the FCM credential blob
 * grant control of the paired Rust+ account's smart devices, so they must
 * never reach a log sink even at trace level.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'playerToken',
      '*.playerToken',
      'player_token',
      '*.player_token',
      'fcm_credentials',
      '*.fcm_credentials',
      'fcmCredentials',
      '*.fcmCredentials',
      'DISCORD_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'CREDENTIALS_ENCRYPTION_KEY',
    ],
    censor: '[redacted]',
  },
  /**
   * Pretty-print only for an interactive terminal.
   *
   * pino-pretty runs in a worker thread via thread-stream, which buffers when
   * stdout is a file or pipe. Redirected to a log file that made the worker
   * look hung — it had connected and cached 68 monuments while the log sat
   * frozen several minutes behind. Plain JSON straight to stdout writes
   * promptly, which matters far more than colour when reading a captured log.
   */
  transport:
    process.stdout.isTTY && process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

export type Logger = typeof logger;
