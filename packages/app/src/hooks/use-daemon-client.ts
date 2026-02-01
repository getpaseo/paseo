import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { DaemonClientV2 } from "@server/client/daemon-client-v2";
import { createTauriWebSocketTransportFactory } from "@/utils/tauri-daemon-transport";

function runDaemonRequest(label: string, promise: Promise<unknown>): void {
  void promise.catch((error) => {
    console.warn(`[DaemonClient] ${label} failed`, error);
  });
}

type DaemonClientOptions = {
  daemonPublicKeyB64?: string;
};

function isRelayWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("role") === "client" && parsed.searchParams.has("session");
  } catch {
    return false;
  }
}

export function useDaemonClient(
  url: string,
  options: DaemonClientOptions = {}
): DaemonClientV2 {
  const client = useMemo(
    () => {
      const tauriTransportFactory = createTauriWebSocketTransportFactory();
      const relayConnection = isRelayWebSocketUrl(url);
      return new DaemonClientV2({
        url,
        suppressSendErrors: true,
        ...(tauriTransportFactory
          ? { transportFactory: tauriTransportFactory }
          : {}),
        ...(relayConnection
          ? {
              e2ee: {
                enabled: true,
                daemonPublicKeyB64: options.daemonPublicKeyB64,
              },
            }
          : {}),
      });
    },
    [options.daemonPublicKeyB64, url]
  );

  useEffect(() => {
    runDaemonRequest("connect", client.connect());

    return () => {
      runDaemonRequest("close", client.close());
    };
  }, [client]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }
      client.ensureConnected();
    });

    return () => {
      subscription.remove();
    };
  }, [client]);

  return client;
}
