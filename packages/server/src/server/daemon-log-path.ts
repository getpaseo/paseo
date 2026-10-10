import path from "node:path";

export const DEFAULT_DAEMON_LOG_FILENAME = "daemon.log";

/**
 * Minimal slice of the persisted config needed to locate the daemon log file.
 * Kept structural so callers can pass a full `PersistedConfig` without importing it.
 */
export interface DaemonLogPathConfig {
  log?: {
    file?: {
      path?: string;
    };
  };
}

/**
 * Supervisor, worker, and desktop all read and write the same daemon log, so they
 * have to agree on where it lives. Absolute `log.file.path` values are used as-is,
 * relative ones resolve against PASEO_HOME.
 */
export function resolveDaemonLogPath(paseoHome: string, config?: DaemonLogPathConfig): string {
  const configuredPath = config?.log?.file?.path;
  if (!configuredPath) {
    return path.join(paseoHome, DEFAULT_DAEMON_LOG_FILENAME);
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.resolve(paseoHome, configuredPath);
}
