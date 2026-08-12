import { randomUUID } from "node:crypto";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { type CollectionRead, VersionedCollection } from "./internal/versioned-collection.js";

export interface AgentDirectoryEntry {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
}

export interface DirectorySyncCursor {
  generation?: string;
  afterSeq?: number;
}

export interface DirectoryVersion {
  generation: string;
  seq: number;
}

type ProjectUpdate = Extract<SessionOutboundMessage, { type: "project.update" }>;

/** Daemon-global latest-state sequence owner for the active app directory. */
export class DirectorySyncService {
  readonly generation: string;
  private readonly projects = new VersionedCollection<WorkspaceProjectDescriptorPayload>({
    getId: (project) => project.projectId,
  });
  private readonly workspaces = new VersionedCollection<WorkspaceDescriptorPayload>({
    getId: (workspace) => workspace.id,
  });
  private readonly agents = new VersionedCollection<AgentDirectoryEntry>({
    getId: (entry) => entry.agent.id,
  });

  constructor(generation = randomUUID()) {
    this.generation = generation;
  }

  readProjects(
    snapshot: Iterable<WorkspaceProjectDescriptorPayload>,
    cursor: DirectorySyncCursor,
  ): CollectionRead<WorkspaceProjectDescriptorPayload> {
    this.projects.replaceAll(snapshot);
    return this.read(this.projects, cursor);
  }

  readWorkspaces(
    snapshot: Iterable<WorkspaceDescriptorPayload>,
    cursor: DirectorySyncCursor,
  ): CollectionRead<WorkspaceDescriptorPayload> {
    this.workspaces.replaceAll(snapshot);
    return this.read(this.workspaces, cursor);
  }

  readAgents(
    snapshot: Iterable<AgentDirectoryEntry>,
    cursor: DirectorySyncCursor,
  ): CollectionRead<AgentDirectoryEntry> {
    this.agents.replaceAll(snapshot);
    return this.read(this.agents, cursor);
  }

  versionProject(update: ProjectUpdate["payload"]): DirectoryVersion | null {
    if (update.kind === "upsert") {
      this.projects.replace(update.project);
    } else {
      this.projects.remove(update.projectId);
    }
    const id = update.kind === "upsert" ? update.project.projectId : update.projectId;
    return this.version(this.projects, id);
  }

  versionWorkspace(value: WorkspaceDescriptorPayload | null, id: string): DirectoryVersion | null {
    if (value) {
      this.workspaces.replace(value);
    } else {
      this.workspaces.remove(id);
    }
    return this.version(this.workspaces, id);
  }

  versionAgent(value: AgentDirectoryEntry | null, id: string): DirectoryVersion | null {
    if (value) {
      this.agents.replace(value);
    } else {
      this.agents.remove(id);
    }
    return this.version(this.agents, id);
  }

  private read<T>(
    collection: VersionedCollection<T>,
    cursor: DirectorySyncCursor,
  ): CollectionRead<T> {
    if (cursor.generation !== this.generation) {
      return collection.readSnapshot(
        cursor.generation === undefined ? "no_cursor" : "generation_changed",
      );
    }
    if (cursor.afterSeq === undefined) {
      return collection.readSnapshot("no_cursor");
    }
    return collection.readAfter(cursor.afterSeq);
  }

  private version<T>(collection: VersionedCollection<T>, id: string): DirectoryVersion | null {
    const seq = collection.sequenceFor(id);
    return seq === null ? null : { generation: this.generation, seq };
  }
}
