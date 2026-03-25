import path from "node:path";

import type { Logger } from "pino";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentSnapshotStore } from "./agent/agent-snapshot-store.js";
import {
  buildProjectPlacementForCwd,
  deriveProjectKind,
  deriveProjectRootPath,
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

function minIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function resolveAgentCreatedAt(record: StoredAgentRecord): string {
  return record.createdAt || record.updatedAt || new Date(0).toISOString();
}

function resolveAgentUpdatedAt(record: StoredAgentRecord): string {
  return record.lastActivityAt || record.updatedAt || record.createdAt || new Date(0).toISOString();
}

export async function bootstrapWorkspaceRegistries(options: {
  paseoHome: string;
  agentStorage: Pick<AgentSnapshotStore, "list">;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<void> {
  await Promise.all([options.projectRegistry.initialize(), options.workspaceRegistry.initialize()]);

  const [existingProjects, existingWorkspaces] = await Promise.all([
    options.projectRegistry.list(),
    options.workspaceRegistry.list(),
  ]);

  if (existingProjects.length > 0 || existingWorkspaces.length > 0) {
    return;
  }

  const records = await options.agentStorage.list();
  const activeRecords = records.filter((record) => !record.archivedAt);
  const recordsByWorkspaceId = new Map<string, StoredAgentRecord[]>();
  for (const record of activeRecords) {
    const workspaceId = normalizeWorkspaceId(record.cwd);
    const existing = recordsByWorkspaceId.get(workspaceId) ?? [];
    existing.push(record);
    recordsByWorkspaceId.set(workspaceId, existing);
  }

  const projectRanges = new Map<string, { createdAt: string | null; updatedAt: string | null }>();

  for (const [workspaceId, workspaceRecords] of recordsByWorkspaceId.entries()) {
    const placement = await buildProjectPlacementForCwd({
      cwd: workspaceId,
      paseoHome: options.paseoHome,
    });

    let workspaceCreatedAt: string | null = null;
    let workspaceUpdatedAt: string | null = null;
    for (const record of workspaceRecords) {
      workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
      workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
    }

    const createdAt = workspaceCreatedAt ?? new Date().toISOString();
    const updatedAt = workspaceUpdatedAt ?? createdAt;
    const existingProjectRange = projectRanges.get(placement.projectKey) ?? {
      createdAt: null,
      updatedAt: null,
    };
    existingProjectRange.createdAt = minIsoDate(existingProjectRange.createdAt, createdAt);
    existingProjectRange.updatedAt = maxIsoDate(existingProjectRange.updatedAt, updatedAt);
    projectRanges.set(placement.projectKey, existingProjectRange);

    await options.projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: placement.projectKey,
        rootPath: deriveProjectRootPath({
          cwd: workspaceId,
          checkout: placement.checkout,
        }),
        kind: deriveProjectKind(placement.checkout),
        displayName: placement.projectName,
        createdAt: existingProjectRange.createdAt ?? createdAt,
        updatedAt: existingProjectRange.updatedAt ?? updatedAt,
      }),
    );

    await options.workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: placement.projectKey,
        cwd: workspaceId,
        kind: deriveWorkspaceKind(placement.checkout),
        displayName: deriveWorkspaceDisplayName({
          cwd: workspaceId,
          checkout: placement.checkout,
        }),
        createdAt,
        updatedAt,
      }),
    );
  }

  options.logger.info(
    {
      projectsFile: path.join(options.paseoHome, "projects", "projects.json"),
      workspacesFile: path.join(options.paseoHome, "projects", "workspaces.json"),
      materializedProjects: projectRanges.size,
      materializedWorkspaces: recordsByWorkspaceId.size,
    },
    "Workspace registries bootstrapped from existing agent storage",
  );
}
