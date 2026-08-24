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
    const host = getDesktopHost();
    const ready = host?.agentNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<OpenAgentEventPayload>("open-agent", openAgent);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          openAgent(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
