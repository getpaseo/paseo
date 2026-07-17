import path from "node:path";
import { statSync } from "node:fs";

import type { Logger } from "pino";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { classifyDirectoryForProjectMembership } from "./workspace-registry-bootstrap-legacy.js";
import { generateWorkspaceId } from "./workspace-registry-model.js";
import { backfillWorkspaceIdForLegacyAgents } from "./migrations/backfill-workspace-id.migration.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
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
  workspaceGitService: WorkspaceGitService;
  logger: Logger;
}): Promise<void> {
  const [projectsExists, workspacesExists] = await Promise.all([
    options.projectRegistry.existsOnDisk(),
    options.workspaceRegistry.existsOnDisk(),
  ]);

  await Promise.all([options.projectRegistry.initialize(), options.workspaceRegistry.initialize()]);

  if (projectsExists && workspacesExists) {
    await backfillWorkspaceIdForLegacyAgents(options);
    return;
  }

  const existingWorkspaceIdsByCwd = new Map(
    (await options.workspaceRegistry.list()).map((workspace) => [
      path.resolve(workspace.cwd),
      workspace.workspaceId,
    ]),
  );
  const records = await options.agentStorage.list();
  // A legacy agent can outlive its working directory. Reconciliation treats a
  // missing directory as absent rather than asking Git about it; bootstrap must
  // do the same before materializing its first workspace record.
  const activeRecords = records.filter((record) => {
    if (record.archivedAt) return false;
    try {
      return statSync(record.cwd).isDirectory();
    } catch {
      return false;
    }
  });
  const recordsByDirectoryKey = new Map<
    string,
    {
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      records: StoredAgentRecord[];
    }
  >();
  const placements = await Promise.all(
    activeRecords.map(async (record) => {
      const normalizedCwd = path.resolve(record.cwd);
      const checkout = await options.workspaceGitService.getCheckout(normalizedCwd);
      const membership = classifyDirectoryForProjectMembership({
        cwd: normalizedCwd,
        checkout,
      });
      return { record, membership, directoryKey: membership.workspaceDirectoryKey };
    }),
  );
  for (const { record, membership, directoryKey } of placements) {
    const existing = recordsByDirectoryKey.get(directoryKey) ?? { membership, records: [] };
    existing.records.push(record);
    recordsByDirectoryKey.set(directoryKey, existing);
  }

  const projectRanges = new Map<string, { createdAt: string | null; updatedAt: string | null }>();
  const workspaceUpsertInputs: {
    workspaceId: string;
    membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
    workspaceCwd: string;
    createdAt: string;
    updatedAt: string;
  }[] = [];

  for (const entry of recordsByDirectoryKey.values()) {
    const { membership, records: workspaceRecords } = entry;
    const workspaceCwd = membership.checkout.cwd;
    let workspaceCreatedAt: string | null = null;
    let workspaceUpdatedAt: string | null = null;
    for (const record of workspaceRecords) {
      workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
      workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
    }

    const createdAt = workspaceCreatedAt ?? new Date().toISOString();
    const updatedAt = workspaceUpdatedAt ?? createdAt;

    const existingProjectRange = projectRanges.get(membership.projectKey) ?? {
      createdAt: null,
      updatedAt: null,
    };
    existingProjectRange.createdAt = minIsoDate(existingProjectRange.createdAt, createdAt);
    existingProjectRange.updatedAt = maxIsoDate(existingProjectRange.updatedAt, updatedAt);
    projectRanges.set(membership.projectKey, existingProjectRange);

    workspaceUpsertInputs.push({
      workspaceId: existingWorkspaceIdsByCwd.get(workspaceCwd) ?? generateWorkspaceId(),
      membership,
      workspaceCwd,
      createdAt,
      updatedAt,
    });
  }

  await Promise.all(
    workspaceUpsertInputs.flatMap(
      ({ workspaceId, membership, workspaceCwd, createdAt, updatedAt }) => {
        const projectRange = projectRanges.get(membership.projectKey) ?? {
          createdAt: null,
          updatedAt: null,
        };
        return [
          options.workspaceRegistry.upsert(
            createPersistedWorkspaceRecord({
              workspaceId,
              projectId: membership.projectKey,
              cwd: workspaceCwd,
              kind: membership.workspaceKind,
              displayName: membership.workspaceDisplayName,
              createdAt,
              updatedAt,
            }),
          ),
          options.projectRegistry.upsert(
            createPersistedProjectRecord({
              projectId: membership.projectKey,
              rootPath: membership.projectRootPath,
              kind: membership.projectKind,
              displayName: membership.projectName,
              createdAt: projectRange.createdAt ?? createdAt,
              updatedAt: projectRange.updatedAt ?? updatedAt,
            }),
          ),
        ];
      },
    ),
  );

  await backfillWorkspaceIdForLegacyAgents(options);

  options.logger.info(
    {
      projectsFile: path.join(options.paseoHome, "projects", "projects.json"),
      workspacesFile: path.join(options.paseoHome, "projects", "workspaces.json"),
      materializedProjects: projectRanges.size,
      materializedWorkspaces: recordsByDirectoryKey.size,
    },
    "Workspace registries bootstrapped from existing agent storage",
  );
}
