import { useEffect } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface OpenAgentEventPayload {
  serverId?: unknown;
  agentId?: unknown;
}

export function AgentNavigationListener() {
  const openAgent = useStableEvent((payload: OpenAgentEventPayload | null) => {
    const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
    const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
    if (!serverId || !agentId) {
      return;
    }
    navigateToAgent({ serverId, agentId });
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToDesktopEvent<OpenAgentEventPayload>("open-agent", openAgent)
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return undefined;
        }
        unlisten = dispose;
        const pending = await getDesktopHost()?.agentNavigation?.ready?.();
        if (!disposed && pending) {
          openAgent(pending);
        }
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
