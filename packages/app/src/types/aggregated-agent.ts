import type { AgentDirectoryEntry } from "@/types/agent-directory";

export interface AggregatedAgent extends AgentDirectoryEntry {
  serverId: string;
  serverLabel: string;
}
