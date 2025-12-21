import type { AgentLifecycleStatus } from "@server/server/agent/agent-manager";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";

export interface AgentDirectoryEntry {
  id: string;
  serverId: string;
  title: string | null;
  status: AgentLifecycleStatus;
  lastActivityAt: Date;
  cwd: string;
  provider: AgentProvider;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: Date | null;
  parentAgentId?: string;
}
