import type { LogLevel } from "./config.js";

/** Numeric priority for each log level (higher = more severe). */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Default level when none is specified or the value is unrecognized. */
const DEFAULT_LEVEL: LogLevel = "info";

/** Levels that route to console.error instead of console.log. */
const ERROR_CHANNEL_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Format a log entry as a structured string.
 * Output: [ISO_TIMESTAMP] [LEVEL] message {optional context}
 */
function formatMessage(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const tag = level.toUpperCase();
  const base = `[${timestamp}] [${tag}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    return `${base} ${JSON.stringify(context)}`;
  }
  return base;
}

/**
 * Create a structured logger that respects log level hierarchy.
 * Messages below the configured threshold are silenced.
 */
export function createLogger(level: string = DEFAULT_LEVEL): Logger {
  const threshold =
    LOG_LEVEL_PRIORITY[level as LogLevel] ?? LOG_LEVEL_PRIORITY[DEFAULT_LEVEL];

  function emit(
    lvl: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_PRIORITY[lvl] < threshold) {
      return;
    }
    const formatted = formatMessage(lvl, message, context);
    if (ERROR_CHANNEL_LEVELS.has(lvl)) {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}

export const logger: Logger = createLogger(process.env.LOG_LEVEL ?? DEFAULT_LEVEL);
