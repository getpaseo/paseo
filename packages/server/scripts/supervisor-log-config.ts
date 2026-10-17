import { resolveDaemonLogPath } from "../src/server/daemon-log-path.js";
import type { loadPersistedConfig } from "../src/server/persisted-config.js";

const DEFAULT_LOG_ROTATE_SIZE = "10m";
const DEFAULT_LOG_ROTATE_MAX_FILES = 3;

export function resolveSupervisorLogFile(
  paseoHome: string,
  persistedConfig: ReturnType<typeof loadPersistedConfig>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuredFile = persistedConfig.log?.file;
  const envRotateSize = env.PASEO_LOG_ROTATE_SIZE?.trim();
  const envRotateMaxFiles = parseOptionalPositiveInteger(env.PASEO_LOG_ROTATE_COUNT);

  return {
    path: resolveDaemonLogPath(paseoHome, persistedConfig),
    rotate: {
      maxSize: configuredFile?.rotate?.maxSize ?? envRotateSize ?? DEFAULT_LOG_ROTATE_SIZE,
      maxFiles:
        configuredFile?.rotate?.maxFiles ?? envRotateMaxFiles ?? DEFAULT_LOG_ROTATE_MAX_FILES,
    },
  };
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
