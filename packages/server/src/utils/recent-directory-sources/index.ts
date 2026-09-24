import { ZoxideRecentDirectorySource, type ZoxideRecentSourceConfig } from "./zoxide.js";

export type { ZoxideRecentSourceConfig } from "./zoxide.js";

/**
 * A frecency-ranked source of directories the user has actually visited. Sources are best-effort:
 * an unavailable source returns `[]` instead of throwing, so the caller can always fall back to
 * discovery through the normal filesystem scan.
 */
export interface RecentDirectorySource {
  readonly id: string;
  isAvailable(): boolean;
  query(input: { query: string; root: string; limit: number }): Promise<string[]>;
}

/** Minimal pino-compatible surface; the session logger satisfies it. */
export interface RecentDirectorySourceLogger {
  debug(bindings: Record<string, unknown>, message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
}

export interface RecentDirectorySourcesDeps {
  env?: NodeJS.ProcessEnv;
  logger?: RecentDirectorySourceLogger;
}

export interface RecentDirectorySourcesConfig {
  zoxide?: ZoxideRecentSourceConfig;
}

export function createRecentDirectorySources(
  config: RecentDirectorySourcesConfig | undefined,
  deps: RecentDirectorySourcesDeps = {},
): RecentDirectorySource[] {
  return [new ZoxideRecentDirectorySource(config?.zoxide, deps)];
}
