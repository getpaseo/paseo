import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import { fetchAgentTimeline, getHostClient } from "@/runtime/host-runtime";

export async function listAgentTimelinePrompts(
  serverId: string,
  agentId: string,
): Promise<AgentTimelinePromptIndexPayload | null> {
  return (await getHostClient(serverId)?.listAgentTimelinePrompts(agentId)) ?? null;
}

export function subscribeToAgentTimelinePrompts(
  serverId: string,
  agentId: string,
  refresh: () => void,
): () => void {
  const client = getHostClient(serverId);
  if (!client) return () => undefined;
  return client.on("agent_stream", (message) => {
    if (
      message.type === "agent_stream" &&
      message.payload.agentId === agentId &&
      message.payload.event.type === "timeline" &&
      message.payload.event.item.type === "user_message"
    ) {
      refresh();
    }
  });
}

export function loadAgentTimelineWindow(
  serverId: string,
  agentId: string,
  request: Parameters<typeof fetchAgentTimeline>[2],
) {
  return fetchAgentTimeline(serverId, agentId, request);
}
