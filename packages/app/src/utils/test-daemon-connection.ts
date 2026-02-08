import { DaemonClient } from "@server/client/daemon-client";
import type { DaemonClientConfig } from "@server/client/daemon-client";
import type { HostConnection } from "@/contexts/daemon-registry-context";
import { buildDaemonWebSocketUrl, buildRelayWebSocketUrl } from "./daemon-endpoints";
import { createTauriWebSocketTransportFactory } from "./tauri-daemon-transport";

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

function buildClientConfig(connection: HostConnection, serverId?: string): DaemonClientConfig {
  const tauriTransportFactory = createTauriWebSocketTransportFactory();
  const base = {
    suppressSendErrors: true,
    ...(tauriTransportFactory ? { transportFactory: tauriTransportFactory } : {}),
  };

  if (connection.type === "direct") {
    return { ...base, url: buildDaemonWebSocketUrl(connection.endpoint) };
  }

  if (!serverId) {
    throw new Error("serverId is required to probe a relay connection");
  }

  return {
    ...base,
    url: buildRelayWebSocketUrl({ endpoint: connection.relayEndpoint, serverId }),
    e2ee: { enabled: true, daemonPublicKeyB64: connection.daemonPublicKeyB64 },
  };
}

function connectAndProbe(
  config: DaemonClientConfig,
  timeoutMs: number,
): Promise<{ client: DaemonClient; serverId: string; hostname: string | null }> {
  const client = new DaemonClient(config);

  return new Promise<{ client: DaemonClient; serverId: string; hostname: string | null }>((resolve, reject) => {
    let cleanedUp = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeStatus: (() => void) | null = null;
    let serverId: string | null = null;
    let hostname: string | null = null;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribeStatus?.();
    };

    const maybeFinishOk = () => {
      if (!serverId) return;
      cleanup();
      resolve({ client, serverId, hostname });
    };

    const finishErr = (error: Error) => {
      if (cleanedUp) return;
      cleanup();
      client.close().catch(() => undefined);
      reject(error);
    };

    const timer = setTimeout(() => {
      finishErr(
        new DaemonConnectionTestError("Connection timed out", {
          reason: "Connection timed out",
          lastError: client.lastError ?? null,
        })
      );
    }, timeoutMs);

    unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "disconnected") {
        const reason = normalizeNonEmptyString(state.reason);
        const lastError = normalizeNonEmptyString(client.lastError);
        const message = pickBestReason(reason, lastError);
        finishErr(new DaemonConnectionTestError(message, { reason, lastError }));
      }
    });

    unsubscribeStatus = client.on("status", (message) => {
      if (message.type !== "status") return;
      const payload = message.payload as { status?: unknown; serverId?: unknown; hostname?: unknown };
      if (payload?.status !== "server_info") return;
      const raw = typeof payload.serverId === "string" ? payload.serverId.trim() : "";
      if (!raw) return;
      serverId = raw;
      hostname = typeof payload.hostname === "string" ? payload.hostname.trim() : null;
      if (hostname && hostname.length === 0) {
        hostname = null;
      }
      maybeFinishOk();
    });

    void client.connect().catch(() => undefined);
  });
}

interface ProbeOptions {
  serverId?: string;
  timeoutMs?: number;
}

function resolveTimeout(connection: HostConnection, options?: ProbeOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  return connection.type === "relay" ? 10_000 : 6_000;
}

export async function probeConnection(
  connection: HostConnection,
  options?: ProbeOptions,
): Promise<{ serverId: string; hostname: string | null }> {
  const config = buildClientConfig(connection, options?.serverId);
  const { client, serverId, hostname } = await connectAndProbe(config, resolveTimeout(connection, options));
  await client.close().catch(() => undefined);
  return { serverId, hostname };
}

export async function measureConnectionLatency(
  connection: HostConnection,
  options?: ProbeOptions,
): Promise<number> {
  const config = buildClientConfig(connection, options?.serverId);
  const { client } = await connectAndProbe(config, resolveTimeout(connection, options));
  try {
    const { rttMs } = await client.ping({ timeoutMs: 5000 });
    return rttMs;
  } finally {
    await client.close().catch(() => undefined);
  }
}
