export interface SnapshotRecord {
  id: string;
  sourceSessionId: string;
}

export interface SessionState {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  phase:
    | "intent"
    | "creating"
    | "created"
    | "bootstrapping"
    | "ready"
    | "stopping"
    | "stopped"
    | "resuming"
    | "exporting"
    | "destroying"
    | "destroyed"
    | "failed";
  sandboxName: string;
  sandboxStatus?: string;
  region: string;
  image: string;
  teamId: string;
  projectId: string;
  owner: string;
  paseoHome: string;
  workspacePath: string;
  repoPath: string;
  repoUrl?: string;
  agentProvider: string;
  agentModel: string;
  agentId?: string;
  workspaceId?: string;
  sessionIds: string[];
  snapshotIds: string[];
  snapshots: SnapshotRecord[];
  pairingUrl?: string;
  lastError?: string;
  logs: string[];
}
