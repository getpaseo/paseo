import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { DaemonClientV2 } from "@server/client/daemon-client-v2";

function runDaemonRequest(label: string, promise: Promise<unknown>): void {
  void promise.catch((error) => {
    console.warn(`[DaemonClient] ${label} failed`, error);
  });
}

export function useDaemonClient(url: string, conversationId?: string | null): DaemonClientV2 {
  const client = useMemo(
    () =>
      new DaemonClientV2({
        url,
        conversationId: conversationId ?? null,
        suppressSendErrors: true,
      }),
    [url, conversationId]
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
