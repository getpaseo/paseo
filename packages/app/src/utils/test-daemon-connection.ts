import { DaemonClient } from "@server/client/daemon-client";
import type { ConnectionState } from "@server/client/daemon-client";
import { buildDaemonWebSocketUrl } from "./daemon-endpoints";

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

export async function testDaemonEndpointConnection(
  endpoint: string,
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 6000;
  const url = buildDaemonWebSocketUrl(endpoint);

  const client = new DaemonClient({
    url,
    suppressSendErrors: true,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let cleanedUp = false;
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timeout);
        unsubscribe?.();
      };

      const finishOk = () => {
        cleanup();
        resolve();
      };

      const finishErr = (error: Error) => {
        cleanup();
        reject(error);
      };

      const timeout = setTimeout(() => {
        finishErr(
          new DaemonConnectionTestError("Connection timed out", {
            reason: "Connection timed out",
            lastError: client.lastError ?? null,
          })
        );
      }, timeoutMs);

      unsubscribe = client.subscribeConnectionStatus((state) => {
        if (state.status === "connected") {
          finishOk();
          return;
        }
        if (state.status === "disconnected") {
          const reason = normalizeNonEmptyString(state.reason);
          const lastError = normalizeNonEmptyString(client.lastError);
          const message = pickBestReason(reason, lastError);
          finishErr(new DaemonConnectionTestError(message, { reason, lastError }));
        }
      });

      void client.connect().catch(() => undefined);
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}
