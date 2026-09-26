import {
  DaemonAuthenticationError,
  DaemonClient,
  getDaemonAuthFailureReason,
  type DaemonAuthFailureReason,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { HostConnection } from "@/types/host-connection";
import { getOrCreateClientId } from "./client-id";
import { resolveAppVersion } from "./app-version";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "./daemon-endpoints";
import {
  buildDesktopDaemonTransportUrl,
  createDesktopDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import type { DesktopDaemonTransportTarget } from "@/desktop/daemon/desktop-daemon";

export interface DaemonProbeClient {
  readonly lastError: string | null;
  readonly authFailureReason?: DaemonAuthFailureReason | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { serverId: string; hostname: string | null } | null;
}

export interface DaemonConnectionDependencies<TClient extends DaemonProbeClient> {
  getClientId(): Promise<string>;
  resolveAppVersion(): string | null;
  createDesktopTransportFactory(): DaemonClientConfig["transportFactory"] | null;
  buildDesktopTransportUrl(input: DesktopDaemonTransportTarget): string;
  createClient(config: DaemonClientConfig): TClient;
}

const defaultDaemonConnectionDependencies: DaemonConnectionDependencies<DaemonClient> = {
  getClientId: getOrCreateClientId,
  resolveAppVersion,
  createDesktopTransportFactory: createDesktopDaemonTransportFactory,
  buildDesktopTransportUrl: buildDesktopDaemonTransportUrl,
  createClient: (config) => new DaemonClient(config),
};

function buildRemoteSshClientConfig(input: {
  connection: Extract<HostConnection, { type: "remoteSsh" }>;
  base: Omit<DaemonClientConfig, "url">;
  desktopTransportFactory: DaemonClientConfig["transportFactory"] | null;
  buildDesktopTransportUrl: (target: DesktopDaemonTransportTarget) => string;
}): DaemonClientConfig {
  if (!input.desktopTransportFactory) {
    throw new Error("Remote SSH is only available in the desktop app.");
  }
  return {
    ...input.base,
    transportFactory: input.desktopTransportFactory,
    url: input.buildDesktopTransportUrl({
      transportType: "ssh",
      host: input.connection.host,
      ...(input.connection.sshPort !== undefined ? { sshPort: input.connection.sshPort } : {}),
      ...(input.connection.daemonPort !== undefined
        ? { daemonPort: input.connection.daemonPort }
        : {}),
    }),
  };
}

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

export class DaemonConnectionTestError extends Error {
  reason: string | null;
  lastError: string | null;
  authFailureReason: DaemonAuthFailureReason | null;

  constructor(
    message: string,
    details: {
      reason: string | null;
      lastError: string | null;
      authFailureReason?: DaemonAuthFailureReason | null;
    },
  ) {
    super(message);
    this.name = "DaemonConnectionTestError";
    this.reason = details.reason;
    this.lastError = details.lastError;
    this.authFailureReason = details.authFailureReason ?? null;
  }
}

export function getConnectionAuthFailureReason(error: unknown): DaemonAuthFailureReason | null {
  if (error instanceof DaemonConnectionTestError) return error.authFailureReason;
  return getDaemonAuthFailureReason(error);
}

function resolveConnectionCredentials(
  connection: HostConnection,
  options:
    | { password?: string; localCredential?: DaemonClientConfig["localCredential"] }
    | undefined,
): Pick<DaemonClientConfig, "password" | "localCredential"> {
  const password = options?.password;
  return {
    ...(password ? { password } : {}),
    ...(options?.localCredential ? { localCredential: options.localCredential } : {}),
  };
}

export async function buildClientConfig(
  connection: HostConnection,
  serverId?: string,
  options?: {
    capabilities?: DaemonClientConfig["capabilities"];
    trace?: DaemonClientConfig["trace"];
    password?: string;
    localCredential?: DaemonClientConfig["localCredential"];
  },
  deps: Pick<
    DaemonConnectionDependencies<DaemonProbeClient>,
    | "getClientId"
    | "resolveAppVersion"
    | "createDesktopTransportFactory"
    | "buildDesktopTransportUrl"
  > = defaultDaemonConnectionDependencies,
): Promise<DaemonClientConfig> {
  const clientId = await deps.getClientId();
  const desktopTransportFactory = deps.createDesktopTransportFactory();
  const base = {
    clientId,
    clientType: "mobile" as const,
    appVersion: deps.resolveAppVersion() ?? undefined,
    suppressSendErrors: true,
    reconnect: { enabled: false },
    ...resolveConnectionCredentials(connection, options),
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    ...((connection.type === "directSocket" || connection.type === "directPipe") &&
    desktopTransportFactory
      ? { transportFactory: desktopTransportFactory }
      : {}),
  };

  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return {
      ...base,
      url: deps.buildDesktopTransportUrl({
        transportType: connection.type === "directSocket" ? "socket" : "pipe",
        transportPath: connection.path,
      }),
    };
  }

  if (connection.type === "remoteSsh") {
    return buildRemoteSshClientConfig({
      connection,
      base,
      desktopTransportFactory,
      buildDesktopTransportUrl: deps.buildDesktopTransportUrl,
    });
  }

  if (connection.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    };
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
          const authFailureReason =
            getDaemonAuthFailureReason(error) ?? client.authFailureReason ?? null;
          const message = authFailureReason
            ? new DaemonAuthenticationError(authFailureReason).message
            : pickBestReason(reason, lastError);
          void client.close().catch(() => undefined);
          reject(new DaemonConnectionTestError(message, { reason, lastError, authFailureReason }));
        });
    },
  );
}

interface ProbeOptions {
  serverId?: string;
  timeoutMs?: number;
  password?: string;
  localCredential?: DaemonClientConfig["localCredential"];
  capabilities?: DaemonClientConfig["capabilities"];
  trace?: DaemonClientConfig["trace"];
}

function resolveTimeout(connection: HostConnection, options?: ProbeOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  if (connection.type === "relay") return 10_000;
  if (connection.type === "remoteSsh") return 15_000;
  return 6_000;
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
  const config = await buildClientConfig(connection, options?.serverId, options, deps);
  return connectAndProbe(config, resolveTimeout(connection, options), deps);
}
