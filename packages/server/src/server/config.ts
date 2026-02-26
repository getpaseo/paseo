import path from "node:path";

import type { JunctionDaemonConfig } from "./bootstrap.js";
import { loadPersistedConfig } from "./persisted-config.js";
import {
  mergeAllowedHosts,
  parseAllowedHostsEnv,
  type AllowedHostsConfig,
} from "./allowed-hosts.js";

const DEFAULT_PORT = 6767;
const DEFAULT_RELAY_ENDPOINT = "relay.junction.sh:443";
const DEFAULT_APP_BASE_URL = "https://app.junction.sh";
function getDefaultListen(): string {
  // Main HTTP server defaults to TCP
  return `127.0.0.1:${DEFAULT_PORT}`;
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  mcpEnabled: boolean;
  allowedHosts: AllowedHostsConfig;
}>;

export function loadConfig(
  junctionHome: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
  }
): JunctionDaemonConfig {
  const env = options?.env ?? process.env;
  const persisted = loadPersistedConfig(junctionHome);

  // JUNCTION_LISTEN can be:
  // - host:port (TCP)
  // - /path/to/socket (Unix socket)
  // - unix:///path/to/socket (Unix socket)
  // Default is TCP at 127.0.0.1:6767
  const listen =
    options?.cli?.listen ??
    env.JUNCTION_LISTEN ??
    persisted.daemon?.listen ??
    getDefaultListen();

  const envCorsOrigins = env.JUNCTION_CORS_ORIGINS
    ? env.JUNCTION_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];

  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];

  const allowedHosts = mergeAllowedHosts([
    persisted.daemon?.allowedHosts,
    parseAllowedHostsEnv(env.JUNCTION_ALLOWED_HOSTS),
    options?.cli?.allowedHosts,
  ]);

  const mcpEnabled =
    options?.cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true;

  const relayEnabled =
    options?.cli?.relayEnabled ?? persisted.daemon?.relay?.enabled ?? true;

  const relayEndpoint =
    env.JUNCTION_RELAY_ENDPOINT ??
    persisted.daemon?.relay?.endpoint ??
    DEFAULT_RELAY_ENDPOINT;

  const relayPublicEndpoint =
    env.JUNCTION_RELAY_PUBLIC_ENDPOINT ??
    persisted.daemon?.relay?.publicEndpoint ??
    relayEndpoint;

  const appBaseUrl =
    env.JUNCTION_APP_BASE_URL ?? persisted.app?.baseUrl ?? DEFAULT_APP_BASE_URL;

  return {
    listen,
    junctionHome,
    corsAllowedOrigins: Array.from(
      new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0))
    ),
    allowedHosts,
    mcpEnabled,
    mcpDebug: env.MCP_DEBUG === "1",
    agentStoragePath: path.join(junctionHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabled,
    relayEndpoint,
    relayPublicEndpoint,
    appBaseUrl,
    agentProviderSettings: persisted.agents?.providers,
  };
}
