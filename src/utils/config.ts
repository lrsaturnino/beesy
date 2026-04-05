/** Valid log levels ordered by verbosity (most verbose first). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  redisUrl: string;
  githubToken: string;
  logLevel: LogLevel;
}

/** Names of all required environment variables. */
const REQUIRED_VARS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "GITHUB_TOKEN",
] as const;

/** Default values for optional environment variables. */
const OPTIONAL_DEFAULTS = {
  SLACK_SIGNING_SECRET: "",
  REDIS_URL: "redis://localhost:6379",
  LOG_LEVEL: "info" as LogLevel,
} as const;

/**
 * Read a required environment variable or throw a descriptive error.
 * Centralizes validation so each required variable is handled uniformly.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Load configuration from environment variables.
 * Required variables throw an error if missing.
 * Optional variables use sensible defaults.
 */
export function loadConfig(): Config {
  const required = Object.fromEntries(
    REQUIRED_VARS.map((name) => [name, requireEnv(name)]),
  );

  return {
    slackBotToken: required.SLACK_BOT_TOKEN,
    slackAppToken: required.SLACK_APP_TOKEN,
    githubToken: required.GITHUB_TOKEN,
    slackSigningSecret:
      process.env.SLACK_SIGNING_SECRET ?? OPTIONAL_DEFAULTS.SLACK_SIGNING_SECRET,
    redisUrl: process.env.REDIS_URL ?? OPTIONAL_DEFAULTS.REDIS_URL,
    logLevel: (process.env.LOG_LEVEL ?? OPTIONAL_DEFAULTS.LOG_LEVEL) as LogLevel,
  };
}

let _config: Config | undefined;

/** Lazy-initialized configuration singleton for production use. */
export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
