import type { ManagedAgent } from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";

export interface AgentSnapshotStore {
  initialize(): Promise<void>;
  list(): Promise<StoredAgentRecord[]>;
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
  beginDelete(agentId: string): void;
  remove(agentId: string): Promise<void>;
  applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void>;
  setTitle(agentId: string, title: string): Promise<void>;
  flush(): Promise<void>;
}
