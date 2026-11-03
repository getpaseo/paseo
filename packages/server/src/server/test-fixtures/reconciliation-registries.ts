import type pino from "pino";
import { createPersistedProjectRecord } from "../workspace-registry.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";

export function createTestRegistries() {
  let archiveGate: {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  const holdNextArchive = () => {
    archiveGate = { started: deferred(), release: deferred() };
    return archiveGate;
  };
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();

  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (id: string) => projects.get(id) ?? null,
    getOrCreateActiveByRoot: async (input) => {
      const existing = Array.from(projects.values()).find(
        (project) => !project.archivedAt && project.rootPath === input.rootPath,
      );
      if (existing) return existing;
      const record = createPersistedProjectRecord({
        projectId: `prj_${projects.size}`,
        rootPath: input.rootPath,
        kind: input.kind,
        displayName: input.displayName,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      });
      projects.set(record.projectId, record);
      return record;
    },
    update: async (id, updater) => {
      const current = projects.get(id);
      if (!current) return null;
      const updated = updater(current);
      projects.set(id, updated);
      return updated;
    },
    upsert: async (record: PersistedProjectRecord) => {
      projects.set(record.projectId, record);
    },
    archive: async (id: string, archivedAt: string) => {
      const existing = projects.get(id);
      if (existing) {
        projects.set(id, { ...existing, archivedAt, updatedAt: archivedAt });
      }
    },
    remove: async (id: string) => {
      projects.delete(id);
    },
  };

  const workspaceRegistry: WorkspaceRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(workspaces.values()),
    get: async (id: string) => workspaces.get(id) ?? null,
    update: async (id, updater) => {
      const existing = workspaces.get(id);
      if (!existing) return null;
      const updated = updater(existing);
      workspaces.set(id, updated);
      return updated;
    },
    upsert: async (record: PersistedWorkspaceRecord) => {
      workspaces.set(record.workspaceId, record);
    },
    archive: async (id: string, archivedAt: string) => {
      const gate = archiveGate;
      archiveGate = null;
      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }
      const existing = workspaces.get(id);
      if (!existing || existing.archivedAt) return false;
      workspaces.set(id, { ...existing, archivedAt, updatedAt: archivedAt });
      return true;
    },
    remove: async (id: string) => {
      workspaces.delete(id);
    },
  };

  return { projects, workspaces, projectRegistry, workspaceRegistry, holdNextArchive };
}

export function createTestLogger() {
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
