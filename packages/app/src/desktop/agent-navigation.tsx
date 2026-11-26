import { useDesktopDeepLinkListener } from "@/desktop/deep-link-listener";
import type { DesktopHostBridge } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface OpenAgentEventPayload {
  serverId?: unknown;
  agentId?: unknown;
}

function agentNavigationReady(host: DesktopHostBridge) {
  return host.agentNavigation?.ready;
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

  useDesktopDeepLinkListener<OpenAgentEventPayload>({
    event: "open-agent",
    readyCall: agentNavigationReady,
    open: openAgent,
  });

  return null;
}
