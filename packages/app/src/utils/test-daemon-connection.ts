import { DaemonClient } from "@server/client/daemon-client";
import type { DaemonClientConfig } from "@server/client/daemon-client";
import type { HostConnection } from "@/types/host-connection";
import { getOrCreateClientId } from "./client-id";
import { resolveAppVersion } from "./app-version";
import { buildDaemonWebSocketUrl, buildRelayWebSocketUrl } from "./daemon-endpoints";
import {
  buildLocalDaemonTransportUrl,
  createDesktopLocalDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import { isDev } from "@/constants/platform";

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
): Promise<DaemonClientConfig> {
  const clientId = await getOrCreateClientId();
  const localTransportFactory = createDesktopLocalDaemonTransportFactory();
  const base = {
    clientId,
    clientType: "mobile" as const,
    appVersion: resolveAppVersion() ?? undefined,
    suppressSendErrors: true,
    reconnect: { enabled: false },
    ...(isDev ? { runtimeMetricsIntervalMs: 10_000 } : {}),
    ...(connection.type === "directSocket" || connection.type === "directPipe"
      ? localTransportFactory
        ? { transportFactory: localTransportFactory }
        : {}
      : {}),
  };

  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return {
      ...base,
      url: buildLocalDaemonTransportUrl({
        transportType: connection.type === "directSocket" ? "socket" : "pipe",
        transportPath: connection.path,
      }),
    };
  }

  if (connection.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(connection.endpoint),
    };
  }

  if (!serverId) {
    throw new Error("serverId is required to probe a relay connection");
  }

  return {
    ...base,
    url: buildRelayWebSocketUrl({
      endpoint: connection.relayEndpoint,
      serverId,
    }),
    e2ee: { enabled: true, daemonPublicKeyB64: connection.daemonPublicKeyB64 },
  };
}

export function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }> {
  const client = new DaemonClient(config);

  return new Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>(
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
        })
        .catch((error) => {
          clearTimeout(timer);
          const reason = normalizeNonEmptyString(
            error instanceof Error ? error.message : String(error),
          );
          const lastError = normalizeNonEmptyString(client.lastError);
          const message = pickBestReason(reason, lastError);
          void client.close().catch(() => undefined);
          reject(new DaemonConnectionTestError(message, { reason, lastError }));
        });
    },
  );
}

interface ProbeOptions {
  serverId?: string;
  timeoutMs?: number;
}

function resolveTimeout(connection: HostConnection, options?: ProbeOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  return connection.type === "relay" ? 10_000 : 6_000;
}

export async function connectToDaemon(
  connection: HostConnection,
  options?: ProbeOptions,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }> {
  const config = await buildClientConfig(connection, options?.serverId);
  return connectAndProbe(config, resolveTimeout(connection, options));
}
