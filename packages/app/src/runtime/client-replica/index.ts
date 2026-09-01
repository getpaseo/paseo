import type {
  Agent,
  AgentTimelineCursorState,
  ProjectDescriptor,
  WorkspaceDescriptor,
} from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { ReplicaCache } from "./internal/cache";
import { createReplicaRowStore } from "./internal/cache/row-store-factory";

export type DirectoryReplicaMutation =
  | { kind: "agent"; type: "upsert"; id: string; value: Agent }
  | { kind: "agent"; type: "delete"; id: string }
  | { kind: "workspace"; type: "upsert"; id: string; value: WorkspaceDescriptor }
  | { kind: "workspace"; type: "delete"; id: string }
  | { kind: "project"; type: "upsert"; id: string; value: ProjectDescriptor }
  | { kind: "project"; type: "delete"; id: string };

export interface CachedDirectory {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
}

export interface CachedWorkspace {
  workspace: WorkspaceDescriptor;
  project?: ProjectDescriptor;
}

export interface DirectoryCursor {
  generation: string;
  afterSeq: number;
}

export interface DirectoryCheckpoint {
  projects?: DirectoryCursor;
  workspaces?: DirectoryCursor;
  agents?: DirectoryCursor;
}

export interface CachedTimeline {
  agentId: string;
  items: StreamItem[];
  range: AgentTimelineCursorState | null;
  hasOlder: boolean;
}

export interface ClientReplicaHostLifecycle {
  setHosts(serverIds: readonly string[]): void;
  reconcileServerId(oldServerId: string, newServerId: string): void;
  flush(): Promise<void>;
}

export interface ClientReplicaDirectory {
  readAgent(serverId: string, agentId: string): Promise<Agent | undefined>;
  readWorkspace(serverId: string, workspaceId: string): Promise<CachedWorkspace | undefined>;
  readDirectory(serverId: string): Promise<CachedDirectory>;
  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void;
  replaceDirectoryBaseline(serverId: string, directory: CachedDirectory): void;
}

export interface ClientReplicaTimeline {
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void;
}

export interface ClientReplica {
  hostLifecycle: ClientReplicaHostLifecycle;
  directory: ClientReplicaDirectory;
  timeline: ClientReplicaTimeline;
}

export function createClientReplica(): ClientReplica {
  const cache = new ReplicaCache(createReplicaRowStore());
  return {
    hostLifecycle: cache,
    directory: cache,
    timeline: cache,
  };
}
