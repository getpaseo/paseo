import type {
  Agent,
  ProjectDescriptor,
  SessionReplicaTimeline,
  WorkspaceDescriptor,
} from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";

export interface ReplicaInput {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  projects: ReadonlyMap<string, ProjectDescriptor>;
  focusedAgentId: string | undefined;
  timelineItems: StreamItem[] | undefined;
  timelineRange: SessionReplicaTimeline["range"];
  timelineHasOlder: boolean;
}

interface EntityChanges<Entity> {
  upserts: Entity[];
  deletes: string[];
}

export interface ReplicaInputChanges {
  agents: EntityChanges<Agent>;
  workspaces: EntityChanges<WorkspaceDescriptor>;
  projects: EntityChanges<ProjectDescriptor>;
  timelineChanged: boolean;
}

export function diffMap<Entity>(
  previous: ReadonlyMap<string, Entity> | undefined,
  next: ReadonlyMap<string, Entity>,
): EntityChanges<Entity> {
  if (previous === next) return { upserts: [], deletes: [] };
  const upserts: Entity[] = [];
  const deletes: string[] = [];
  for (const [id, value] of next) {
    if (previous?.get(id) !== value) upserts.push(value);
  }
  if (previous) {
    for (const id of previous.keys()) {
      if (!next.has(id)) deletes.push(id);
    }
  }
  return { upserts, deletes };
}

export function diffReplicaInput(
  previous: ReplicaInput | undefined,
  next: ReplicaInput,
): ReplicaInputChanges {
  const timelineChanged =
    previous === undefined ||
    previous.focusedAgentId !== next.focusedAgentId ||
    previous.timelineItems !== next.timelineItems ||
    previous.timelineRange !== next.timelineRange ||
    previous.timelineHasOlder !== next.timelineHasOlder;
  return {
    agents: diffMap(previous?.agents, next.agents),
    workspaces: diffMap(previous?.workspaces, next.workspaces),
    projects: diffMap(previous?.projects, next.projects),
    timelineChanged,
  };
}

export function hasReplicaInputChanges(changes: ReplicaInputChanges): boolean {
  return (
    changes.agents.upserts.length > 0 ||
    changes.agents.deletes.length > 0 ||
    changes.workspaces.upserts.length > 0 ||
    changes.workspaces.deletes.length > 0 ||
    changes.projects.upserts.length > 0 ||
    changes.projects.deletes.length > 0 ||
    changes.timelineChanged
  );
}
