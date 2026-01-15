import pino from "pino";
import type { PersistedConfig } from "./persisted-config.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogFormat = "pretty" | "json";

export interface ResolvedLogConfig {
  level: LogLevel;
  format: LogFormat;
}

export function resolveLogConfig(
  persistedConfig: PersistedConfig | undefined
): ResolvedLogConfig {
  const envLevel = process.env.PASEO_LOG as LogLevel | undefined;
  const envFormat = process.env.PASEO_LOG_FORMAT as LogFormat | undefined;

  const level: LogLevel =
    envLevel ?? persistedConfig?.log?.level ?? "info";
  const format: LogFormat =
    envFormat ?? persistedConfig?.log?.format ?? "pretty";

  return { level, format };
}

let rootLogger: pino.Logger | undefined;

export function createRootLogger(
  persistedConfig: PersistedConfig | undefined
): pino.Logger {
  const config = resolveLogConfig(persistedConfig);

  const transport =
    config.format === "pretty"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            ignore: "pid,hostname",
          },
        }
      : undefined;

  rootLogger = pino({
    level: config.level,
    transport,
  });

  return rootLogger;
}

export function getRootLogger(): pino.Logger {
  if (!rootLogger) {
    throw new Error("Root logger not initialized. Call createRootLogger first.");
  }
  return rootLogger;
}

export function createChildLogger(name: string): pino.Logger {
  return getRootLogger().child({ name });
}
