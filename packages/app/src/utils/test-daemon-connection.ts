import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { HostConnection } from "@/types/host-connection";
import { normalizeSshConnection } from "@getpaseo/protocol/host-connection-schema";
import { getOrCreateClientId } from "./client-id";
import { resolveAppVersion } from "./app-version";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "./daemon-endpoints";
import {
  buildLocalDaemonTransportUrl,
  createDesktopLocalDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import { getDesktopHost } from "@/desktop/host";

export interface DaemonProbeClient {
  readonly lastError: string | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { serverId: string; hostname: string | null } | null;
}

interface LocalTransportUrlInput {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface DaemonConnectionDependencies<TClient extends DaemonProbeClient> {
  getClientId(): Promise<string>;
  resolveAppVersion(): string | null;
  createLocalTransportFactory(): DaemonClientConfig["transportFactory"] | null;
  buildLocalTransportUrl(input: LocalTransportUrlInput): string;
  createClient(config: DaemonClientConfig): TClient;
}

const defaultDaemonConnectionDependencies: DaemonConnectionDependencies<DaemonClient> = {
  getClientId: getOrCreateClientId,
  resolveAppVersion,
  createLocalTransportFactory: createDesktopLocalDaemonTransportFactory,
  buildLocalTransportUrl: buildLocalDaemonTransportUrl,
  createClient: (config) => new DaemonClient(config),
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickBestReason(reason: string | null, lastError: string | null): string {
  const genericReason =
    reason &&
    (reason.toLowerCase() === "transport error" || reason.toLowerCase() === "transport closed");
  const genericLastError =
    lastError &&
    (lastError.toLowerCase() === "transport error" ||
      lastError.toLowerCase() === "transport closed" ||
      lastError.toLowerCase() === "unable to connect");

  if (genericReason && lastError && !genericLastError) {
    return lastError;
  }
  if (reason) return reason;
  if (lastError) return lastError;
  return "Unable to connect";
}

function isIncorrectPasswordFailure(input: {
  config: DaemonClientConfig;
  reason: string | null;
  lastError: string | null;
}): boolean {
  if (!input.config.password) {
    return false;
  }
  const details = [input.reason, input.lastError].filter(Boolean).join("\n").toLowerCase();
  return (
    details.includes("401") ||
    details.includes("4001") ||
    details.includes("unauthorized") ||
    details.includes("code 1006")
  );
}

export class DaemonConnectionTestError extends Error {
  reason: string | null;
  lastError: string | null;

  constructor(message: string, details: { reason: string | null; lastError: string | null }) {
    super(message);
    this.name = "DaemonConnectionTestError";
    this.reason = details.reason;
    this.lastError = details.lastError;
  }
}

export async function buildClientConfig(
  connection: HostConnection,
  serverId?: string,
  options?: { capabilities?: DaemonClientConfig["capabilities"] },
  deps: Pick<
    DaemonConnectionDependencies<DaemonProbeClient>,
    "getClientId" | "resolveAppVersion" | "createLocalTransportFactory" | "buildLocalTransportUrl"
  > = defaultDaemonConnectionDependencies,
): Promise<DaemonClientConfig> {
  const clientId = await deps.getClientId();
  const localTransportFactory = deps.createLocalTransportFactory();
  const base = {
    clientId,
    clientType: "mobile" as const,
    appVersion: deps.resolveAppVersion() ?? undefined,
    suppressSendErrors: true,
    reconnect: { enabled: false },
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
    ...((connection.type === "directSocket" || connection.type === "directPipe") &&
    localTransportFactory
      ? { transportFactory: localTransportFactory }
      : {}),
  };

  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return {
      ...base,
      url: deps.buildLocalTransportUrl({
        transportType: connection.type === "directSocket" ? "socket" : "pipe",
        transportPath: connection.path,
      }),
    };
  }

  if (connection.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
      ...(connection.password ? { password: connection.password } : {}),
    };
  }

  if (connection.type === "ssh") {
    throw new Error("SSH connections must be probed via connectToDaemonViaSsh");
  }

  if (!serverId) {
    throw new Error("serverId is required to probe a relay connection");
  }

  return {
    ...base,
    url: buildRelayWebSocketUrl({
      endpoint: connection.relayEndpoint,
      useTls: connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint),
      serverId,
    }),
    e2ee: { enabled: true, daemonPublicKeyB64: connection.daemonPublicKeyB64 },
  };
}

export function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>;
export function connectAndProbe<TClient extends DaemonProbeClient>(
  config: DaemonClientConfig,
  timeoutMs: number,
  deps: Pick<DaemonConnectionDependencies<TClient>, "createClient">,
): Promise<{ client: TClient; serverId: string; hostname: string | null }>;
export function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
  deps: Pick<
    DaemonConnectionDependencies<DaemonProbeClient>,
    "createClient"
  > = defaultDaemonConnectionDependencies,
): Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }> {
  const client = deps.createClient(config);

  return new Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        void client.close().catch(() => undefined);
        reject(
          new DaemonConnectionTestError("Connection timed out", {
            reason: "Connection timed out",
            lastError: client.lastError ?? null,
          }),
        );
      }, timeoutMs);

      void client
        .connect()
        .then(() => {
          clearTimeout(timer);
          const serverInfo = client.getLastServerInfoMessage();
          if (!serverInfo) {
            void client.close().catch(() => undefined);
            reject(
              new DaemonConnectionTestError("Missing server info message", {
                reason: "Missing server info message",
                lastError: client.lastError ?? null,
              }),
            );
            return;
          }
          resolve({
            client,
            serverId: serverInfo.serverId,
            hostname: serverInfo.hostname,
          });
          return;
        })
        .catch((error) => {
          clearTimeout(timer);
          const reason = normalizeNonEmptyString(
            error instanceof Error ? error.message : String(error),
          );
          const lastError = normalizeNonEmptyString(client.lastError);
          const message = isIncorrectPasswordFailure({ config, reason, lastError })
            ? "Incorrect password"
            : pickBestReason(reason, lastError);
          void client.close().catch(() => undefined);
          reject(new DaemonConnectionTestError(message, { reason, lastError }));
        });
    },
  );
}

interface ProbeOptions {
  serverId?: string;
  timeoutMs?: number;
  capabilities?: DaemonClientConfig["capabilities"];
}

function resolveTimeout(connection: HostConnection, options?: ProbeOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  if (connection.type === "ssh") return 30_000;
  return connection.type === "relay" ? 10_000 : 6_000;
}
async function connectToDaemonViaSsh(
  connection: Extract<HostConnection, { type: "ssh" }>,
  options: ProbeOptions | undefined,
  deps: DaemonConnectionDependencies<DaemonProbeClient>,
): Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }> {
  const sshBridge = getDesktopHost()?.ssh;
  if (!sshBridge) {
    throw new DaemonConnectionTestError("SSH connections require the Paseo desktop app.", {
      reason: "SSH not available",
      lastError: null,
    });
  }
  const sshConfig = normalizeSshConnection({
    id: connection.id,
    host: connection.host,
    user: connection.user,
    port: connection.port,
    remotePort: connection.remotePort,
    remoteHome: connection.remoteHome,
    installDir: connection.installDir,
  });
  const bridgeConfig = {
    host: sshConfig.host,
    port: sshConfig.port,
    user: sshConfig.user,
    remotePort: sshConfig.remotePort,
    remoteHome: sshConfig.remoteHome,
    installDir: sshConfig.installDir,
  };
  const { tunnelId, localPort } = await sshBridge.openTunnel(bridgeConfig);

  const config = await buildClientConfig(
    {
      id: connection.id,
      type: "directTcp",
      endpoint: `127.0.0.1:${localPort}`,
      useTls: false,
    },
    options?.serverId,
    options,
    deps,
  );

  try {
    const result = await connectAndProbe(config, resolveTimeout(connection, options), deps);
    // Attach the tunnelId to the client so it can be closed when the client closes.
    // The DaemonClient doesn't have a hook for this, so we store it on the client
    // and the host runtime closes the tunnel when disposing the client.
    (result.client as DaemonClient & { __sshTunnelId?: string }).__sshTunnelId = tunnelId;
    return result;
  } catch (error) {
    await sshBridge.closeTunnel(tunnelId).catch(() => undefined);
    throw error;
  }
}

export function connectToDaemon(
  connection: HostConnection,
  options?: ProbeOptions,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>;
export function connectToDaemon<TClient extends DaemonProbeClient>(
  connection: HostConnection,
  options: ProbeOptions | undefined,
  deps: DaemonConnectionDependencies<TClient>,
): Promise<{ client: TClient; serverId: string; hostname: string | null }>;
export async function connectToDaemon(
  connection: HostConnection,
  options?: ProbeOptions,
  deps: DaemonConnectionDependencies<DaemonProbeClient> = defaultDaemonConnectionDependencies,
): Promise<{ client: DaemonProbeClient; serverId: string; hostname: string | null }> {
  if (connection.type === "ssh") {
    return connectToDaemonViaSsh(connection, options, deps);
  }
  const config = await buildClientConfig(connection, options?.serverId, options, deps);
  return connectAndProbe(config, resolveTimeout(connection, options), deps);
}
