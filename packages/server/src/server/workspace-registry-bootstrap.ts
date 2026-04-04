import path from "node:path";

import type { Logger } from "pino";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  buildProjectPlacementForCwd,
  deriveWorkspaceId,
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
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<void> {
  const [projectsExists, workspacesExists] = await Promise.all([
    options.projectRegistry.existsOnDisk(),
    options.workspaceRegistry.existsOnDisk(),
  ]);

  await Promise.all([options.projectRegistry.initialize(), options.workspaceRegistry.initialize()]);

  if (projectsExists && workspacesExists) {
    return;
  }

  const records = await options.agentStorage.list();
  const activeRecords = records.filter((record) => !record.archivedAt);
  const recordsByWorkspaceId = new Map<
    string,
    { placement: Awaited<ReturnType<typeof buildProjectPlacementForCwd>>; records: StoredAgentRecord[] }
  >();
  for (const record of activeRecords) {
    const normalizedCwd = normalizeWorkspaceId(record.cwd);
    const placement = await buildProjectPlacementForCwd({
      cwd: normalizedCwd,
      paseoHome: options.paseoHome,
    });
    const workspaceId = deriveWorkspaceId(normalizedCwd, placement.checkout);
    const existing = recordsByWorkspaceId.get(workspaceId) ?? { placement, records: [] };
    existing.records.push(record);
    recordsByWorkspaceId.set(workspaceId, existing);
  }

  const projectRanges = new Map<string, { createdAt: string | null; updatedAt: string | null }>();

  for (const [workspaceId, entry] of recordsByWorkspaceId.entries()) {
    const { placement, records: workspaceRecords } = entry;
    let workspaceCreatedAt: string | null = null;
    let workspaceUpdatedAt: string | null = null;
    for (const record of workspaceRecords) {
      workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
      workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
    }

    const createdAt = workspaceCreatedAt ?? new Date().toISOString();
    const updatedAt = workspaceUpdatedAt ?? createdAt;
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
