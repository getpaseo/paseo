import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import pretty from "pino-pretty";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import type { PersistedConfig } from "./persisted-config.js";
import { resolvePaseoHome } from "./paseo-home.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogFormat = "pretty" | "json";

export interface ResolvedLogConfig {
  level: LogLevel;
  console: {
    level: LogLevel;
    format: LogFormat;
  };
  file: {
    level: LogLevel;
    path: string;
    rotate: {
      maxSize: string;
      maxFiles: number;
    };
  };
}

type LegacyLogConfig = {
  level?: LogLevel;
  format?: LogFormat;
};

type LoggerConfigInput = PersistedConfig | LegacyLogConfig | undefined;

type ResolveLogConfigOptions = {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
};

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const LOG_FORMATS: LogFormat[] = ["pretty", "json"];
const LOG_LEVEL_PRIORITIES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const DEFAULT_CONSOLE_LEVEL: LogLevel = "info";
const DEFAULT_CONSOLE_FORMAT: LogFormat = "pretty";
const DEFAULT_FILE_LEVEL: LogLevel = "debug";
const DEFAULT_FILE_ROTATE_SIZE = "10m";
const DEFAULT_FILE_ROTATE_MAX_FILES = 2;
const DEFAULT_DAEMON_LOG_FILENAME = "daemon.log";

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value || !LOG_LEVELS.includes(value as LogLevel)) {
    return undefined;
  }
  return value as LogLevel;
}

function parseLogFormat(value: string | undefined): LogFormat | undefined {
  if (!value || !LOG_FORMATS.includes(value as LogFormat)) {
    return undefined;
  }
  return value as LogFormat;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function resolveFilePath(paseoHome: string, configuredPath: string | undefined): string {
  const fallback = path.join(paseoHome, DEFAULT_DAEMON_LOG_FILENAME);
  if (!configuredPath) {
    return fallback;
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.resolve(paseoHome, configuredPath);
}

function minLogLevel(levels: LogLevel[]): LogLevel {
  let minLevel = levels[0];

  for (const level of levels) {
    if (LOG_LEVEL_PRIORITIES[level] < LOG_LEVEL_PRIORITIES[minLevel]) {
      minLevel = level;
    }
  }

  return minLevel;
}

function resolveConfiguredPaseoHome(options: ResolveLogConfigOptions | undefined): string {
  if (options?.paseoHome) {
    return options.paseoHome;
  }
  return resolvePaseoHome(options?.env ?? process.env);
}

function normalizeLoggerConfigInput(config: LoggerConfigInput): PersistedConfig | undefined {
  if (!config) {
    return undefined;
  }

  if ("log" in config) {
    return config as PersistedConfig;
  }

  if ("level" in config || "format" in config) {
    const legacy = config as LegacyLogConfig;
    return {
      log: {
        ...(legacy.level ? { level: legacy.level } : {}),
        ...(legacy.format ? { format: legacy.format } : {}),
      },
    };
  }

  return config as PersistedConfig;
}

function rotateOnRestart(filePath: string, maxFiles: number): void {
  if (!existsSync(filePath)) return;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  try {
    renameSync(filePath, path.join(dir, `${ts}-00-${base}`));
  } catch {
    return;
  }

  // Clean up old rotated logs beyond maxFiles.
  // Both our restart-rotated files (YYYYMMDD-HHMM-00-daemon.log) and
  // rotating-file-stream's size-rotated files (YYYYMMDD-HHMM-NN-daemon.log)
  // end with -${base} and sort chronologically by name.
  const rotatedFiles = readdirSync(dir)
    .filter((f) => f.endsWith(`-${base}`) && f !== base)
    .sort()
    .reverse();

  for (const file of rotatedFiles.slice(maxFiles)) {
    try {
      unlinkSync(path.join(dir, file));
    } catch {}
  }
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

export function resolveLogConfig(
  configInput: LoggerConfigInput,
  options?: ResolveLogConfigOptions,
): ResolvedLogConfig {
  const persistedConfig = normalizeLoggerConfigInput(configInput);
  const env = options?.env ?? process.env;
  const paseoHome = resolveConfiguredPaseoHome(options);
  const persistedLog = persistedConfig?.log;

  const envGlobalLevel = parseLogLevel(env.PASEO_LOG);
  const persistedGlobalLevel = persistedLog?.level;
  const consoleLevel: LogLevel =
    parseLogLevel(env.PASEO_LOG_CONSOLE_LEVEL) ??
    envGlobalLevel ??
    persistedLog?.console?.level ??
    persistedGlobalLevel ??
    DEFAULT_CONSOLE_LEVEL;

  const fileLevel: LogLevel =
    parseLogLevel(env.PASEO_LOG_FILE_LEVEL) ??
    envGlobalLevel ??
    persistedLog?.file?.level ??
    persistedGlobalLevel ??
    DEFAULT_FILE_LEVEL;

  const consoleFormat: LogFormat =
    parseLogFormat(env.PASEO_LOG_FORMAT) ??
    persistedLog?.console?.format ??
    persistedLog?.format ??
    DEFAULT_CONSOLE_FORMAT;

  const filePath = resolveFilePath(paseoHome, env.PASEO_LOG_FILE_PATH ?? persistedLog?.file?.path);

  const rotateMaxSize =
    env.PASEO_LOG_FILE_ROTATE_SIZE?.trim() ||
    persistedLog?.file?.rotate?.maxSize ||
    DEFAULT_FILE_ROTATE_SIZE;

  const rotateMaxFiles =
    parsePositiveInteger(env.PASEO_LOG_FILE_ROTATE_COUNT) ??
    persistedLog?.file?.rotate?.maxFiles ??
    DEFAULT_FILE_ROTATE_MAX_FILES;

  return {
    level: minLogLevel([consoleLevel, fileLevel]),
    console: {
      level: consoleLevel,
      format: consoleFormat,
    },
    file: {
      level: fileLevel,
      path: filePath,
      rotate: {
        maxSize: rotateMaxSize,
        maxFiles: rotateMaxFiles,
      },
    },
  };
}

export function createRootLogger(
  configInput: LoggerConfigInput,
  options?: ResolveLogConfigOptions,
): pino.Logger {
  const config = resolveLogConfig(configInput, options);

  mkdirSync(path.dirname(config.file.path), { recursive: true });

  const consoleStream =
    config.console.format === "pretty"
      ? pretty({
          colorize: true,
          singleLine: true,
          ignore: "pid,hostname",
        })
      : pino.destination({ dest: 1, sync: false });

  rotateOnRestart(config.file.path, config.file.rotate.maxFiles);

  const fileStream = createRotatingFileStream(path.basename(config.file.path), {
    path: path.dirname(config.file.path),
    size: toRotatingFileStreamSize(config.file.rotate.maxSize),
    maxFiles: config.file.rotate.maxFiles,
  });

  return pino(
    { level: config.level },
    pino.multistream([
      { level: config.console.level, stream: consoleStream },
      { level: config.file.level, stream: fileStream },
    ]),
  );
}

export function createChildLogger(parent: pino.Logger, name: string): pino.Logger {
  return parent.child({ name });
}
