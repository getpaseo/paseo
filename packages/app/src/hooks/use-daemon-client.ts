import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { DaemonClient } from "@server/client/daemon-client";
import { createTauriWebSocketTransportFactory } from "@/utils/tauri-daemon-transport";

function runDaemonRequest(label: string, promise: Promise<unknown>): void {
  void promise.catch((error) => {
    console.warn(`[DaemonClient] ${label} failed`, error);
  });
}

export function useDaemonClient(url: string): DaemonClient {
  const client = useMemo(
    () => {
      const tauriTransportFactory = createTauriWebSocketTransportFactory();
      return new DaemonClient({
        url,
        suppressSendErrors: true,
        ...(tauriTransportFactory
          ? { transportFactory: tauriTransportFactory }
          : {}),
      });
    },
    [url]
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
