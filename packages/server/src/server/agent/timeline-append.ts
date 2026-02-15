import type { AgentManager } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export interface AppendTimelineItemIfAgentKnownOptions {
  agentManager: AgentManager;
  agentId: string;
  item: AgentTimelineItem;
}

export async function appendTimelineItemIfAgentKnown(
  options: AppendTimelineItemIfAgentKnownOptions
): Promise<boolean> {
  try {
    await options.agentManager.appendTimelineItem(options.agentId, options.item);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unknown agent")) {
      return false;
    }
    throw error;
  }
}
