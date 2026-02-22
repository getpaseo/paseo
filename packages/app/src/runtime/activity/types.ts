export type AgentLastActivityUpdates = Map<string, Date>;

export type AgentLastActivityCommitter = (
  updates: AgentLastActivityUpdates
) => void;

export interface ActivityFlushHandle {
  cancel: () => void;
}

export interface AgentLastActivityCoalescer {
  setCommitter: (committer: AgentLastActivityCommitter | null) => void;
  enqueue: (agentId: string, timestamp: Date) => void;
  flushNow: () => void;
  deletePending: (agentId: string) => void;
  dispose: () => void;
}
