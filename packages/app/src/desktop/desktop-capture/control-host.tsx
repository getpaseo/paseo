import { useEffect } from "react";
import type {
  DesktopExecuteRequest,
  DesktopExecuteResponse,
} from "@getpaseo/protocol/desktop-capture";
import { getDesktopHost } from "@/desktop/host";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function DesktopControlHost({ serverId, deviceId }: { serverId: string; deviceId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  useEffect(() => {
    const bridge = getDesktopHost()?.desktopCapture;
    if (
      !client ||
      !bridge ||
      !connected ||
      !client.getLastServerInfoMessage()?.features?.desktopHostRegistration
    )
      return;
    const sessions = new Set<string>();
    const observation = client.registerDesktopHost(deviceId);
    let disposed = false;
    async function execute(message: DesktopExecuteRequest) {
      let response: DesktopExecuteResponse;
      try {
        response = await bridge!.execute(message);
      } catch {
        response = {
          type: "desktop.control.execute.response",
          payload: {
            requestId: message.requestId,
            sessionId: message.sessionId,
            ok: false,
            error: "Mac disconnected. Outcome unknown; do not replay.",
          },
        };
      }
      if (disposed) return;
      try {
        client!.sendDesktopExecuteResponse(response);
      } catch {
        await bridge!.revoke(message.sessionId);
      }
    }
    const off = observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "desktop.control.revoked") {
          sessions.delete(message.sessionId);
          void bridge.revoke(message.sessionId);
        }
        if (message.type !== "desktop.control.execute.request") return;
        sessions.add(message.sessionId);
        void execute(message);
      },
    });
    const offStop = bridge.onStop(() => {
      void client.stopDesktopControl(deviceId).catch(() => {});
    });
    void observation.ready.catch(() => {});
    return () => {
      disposed = true;
      off();
      offStop();
      for (const session of sessions) void bridge.revoke(session);
      void observation.release().catch(() => {});
    };
  }, [client, connected, serverId, deviceId]);
  return null;
}
