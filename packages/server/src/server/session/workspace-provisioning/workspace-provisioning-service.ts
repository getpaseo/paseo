import { basename, resolve } from "node:path";
import type { Logger } from "pino";
import {
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  generateWorkspaceId,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../../../utils/path.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
}

export interface ImportWorkspaceInput {
  cwd: string;
  requestedWorkspaceId?: string;
}

export interface ImportWorkspaceResult<T> {
  value: T;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface WorkspaceProvisioningService {
  runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>>;
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(input: ResolveOrCreateWorkspaceIdInput): Promise<string>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

export function createWorkspaceProvisioningService(deps: {
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout" | "peekSnapshot">;
  logger: Logger;
}): WorkspaceProvisioningService {
  const { workspaceRegistry, projectRegistry, workspaceGitService, logger } = deps;

  async function runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>> {
    if (input.requestedWorkspaceId) {
      const workspace = await workspaceRegistry.get(input.requestedWorkspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${input.requestedWorkspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${workspace.projectId}`);
      }
      if (!createRealpathAwarePathMatcher(workspace.cwd)(input.cwd)) {
        throw new Error(`Import cwd does not match workspace: ${workspace.workspaceId}`);
      }
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    }

    const projectsBeforeImport = await projectRegistry.list();
    const workspace = await createWorkspaceForDirectory(input.cwd);
    const previousProject =
      projectsBeforeImport.find((project) => project.projectId === workspace.projectId) ?? null;

    try {
      return {
        value: await operation(workspace),
        createdWorkspace: workspace,
      };
    } catch (error) {
      await rollbackFailedImportWorkspace(workspace, previousProject);
      throw error;
    }
  }

  async function rollbackFailedImportWorkspace(
    workspace: PersistedWorkspaceRecord,
    previousProject: PersistedProjectRecord | null,
  ): Promise<void> {
    try {
      await workspaceRegistry.remove(workspace.workspaceId);
      const projectHasActiveWorkspace = (await workspaceRegistry.list()).some(
        (candidate) => candidate.projectId === workspace.projectId && !candidate.archivedAt,
      );
      if (projectHasActiveWorkspace) {
        return;
      }
      if (previousProject?.archivedAt) {
        await projectRegistry.upsert(previousProject);
      } else if (!previousProject) {
        await projectRegistry.remove(workspace.projectId);
      }
    } catch (error) {
      logger.error(
        { err: error, workspaceId: workspace.workspaceId, projectId: workspace.projectId },
        "Failed to restore workspace state after provider import failure",
      );
    }
  }

  async function findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const rootPath = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    const timestamp = new Date().toISOString();
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      timestamp,
    });
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const project = projectId
      ? await refreshProjectKind(await requireActiveProject(projectId), normalizedCwd, checkout)
      : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
        await findOrCreateProjectForDirectory(normalizedCwd);
    const timestamp = new Date().toISOString();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: generateWorkspaceId(),
      projectId: project.projectId,
      cwd: normalizedCwd,
      kind: deriveWorkspaceKind(checkout),
      displayName: deriveWorkspaceDisplayName({ cwd: normalizedCwd, checkout }),
      branch:
        checkout.currentBranch && checkout.currentBranch.toUpperCase() !== "HEAD"
          ? checkout.currentBranch
          : null,
      isPaseoOwnedWorktree: checkout.isGit && checkout.isPaseoOwnedWorktree,
      mainRepoRoot: checkout.isGit ? checkout.mainRepoRoot : null,
      title: title?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await workspaceRegistry.upsert(workspace);
    return workspace;
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const workspaces = await workspaceRegistry.list();
    const active = workspaces
      .filter(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, normalizedCwd),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (active) return refreshWorkspaceRecord(active);
    const archived = workspaces
      .filter(
        (workspace) => workspace.archivedAt && areEquivalentPaths(workspace.cwd, normalizedCwd),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      )[0];
    if (archived) {
      const project = await projectRegistry.get(archived.projectId);
      if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
    }
    return createWorkspaceForDirectory(normalizedCwd);
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<string> {
    if (input.createdWorktree) return input.createdWorktree.workspace.workspaceId;
    if (input.requestedWorkspaceId) return input.requestedWorkspaceId;
    return (await createWorkspaceForDirectory(input.cwd, input.initialTitle)).workspaceId;
  }

  async function ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await projectRegistry.get(workspace.projectId);
    if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
    const timestamp = new Date().toISOString();
    const checkout =
      workspace.archivedAt || project.archivedAt
        ? await workspaceGitService.getCheckout(workspace.cwd)
        : null;
    let next: PersistedWorkspaceRecord | null = null;
    if (workspace.archivedAt && checkout) {
      next = {
        ...workspace,
        ...checkoutDerivedWorkspaceFields(workspace, checkout),
        archivedAt: null,
        updatedAt: timestamp,
      };
    }
    if (checkout && (project.archivedAt || workspace.archivedAt)) {
      const projectCheckout = areEquivalentPaths(project.rootPath, workspace.cwd)
        ? checkout
        : await workspaceGitService.getCheckout(project.rootPath);
      const kind = projectCheckout.isGit ? "git" : "non_git";
      if (project.archivedAt || project.kind !== kind) {
        await projectRegistry.upsert({ ...project, kind, archivedAt: null, updatedAt: timestamp });
      }
    }
    if (!next) return workspace;
    await workspaceRegistry.upsert(next);
    return next;
  }

  async function refreshWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const checkout = await workspaceGitService.getCheckout(workspace.cwd);
    const project = await projectRegistry.get(workspace.projectId);
    if (project && !project.archivedAt) {
      await refreshProjectKind(project, workspace.cwd, checkout);
    }
    const derived = checkoutDerivedWorkspaceFields(workspace, checkout);
    if (
      workspace.kind === derived.kind &&
      workspace.branch === derived.branch &&
      workspace.displayName === derived.displayName &&
      workspace.isPaseoOwnedWorktree === derived.isPaseoOwnedWorktree &&
      workspace.mainRepoRoot === derived.mainRepoRoot
    ) {
      return workspace;
    }
    const next = {
      ...workspace,
      ...derived,
      updatedAt: new Date().toISOString(),
    };
    await workspaceRegistry.upsert(next);
    return next;
  }

  function checkoutDerivedWorkspaceFields(
    workspace: PersistedWorkspaceRecord,
    checkout: Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>,
  ): Pick<
    PersistedWorkspaceRecord,
    "kind" | "branch" | "displayName" | "isPaseoOwnedWorktree" | "mainRepoRoot"
  > {
    return {
      kind: deriveWorkspaceKind(checkout),
      branch:
        checkout.currentBranch && checkout.currentBranch.toUpperCase() !== "HEAD"
          ? checkout.currentBranch
          : null,
      displayName: deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout }),
      isPaseoOwnedWorktree: checkout.isGit && checkout.isPaseoOwnedWorktree,
      mainRepoRoot: checkout.isGit ? checkout.mainRepoRoot : null,
    };
  }

  async function refreshProjectKind(
    project: PersistedProjectRecord,
    workspaceCwd: string,
    workspaceCheckout: Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>,
  ): Promise<PersistedProjectRecord> {
    const projectCheckout = areEquivalentPaths(project.rootPath, workspaceCwd)
      ? workspaceCheckout
      : await workspaceGitService.getCheckout(project.rootPath);
    const kind: PersistedProjectRecord["kind"] = projectCheckout.isGit ? "git" : "non_git";
    if (project.kind === kind) return project;
    const refreshed = { ...project, kind, updatedAt: new Date().toISOString() };
    await projectRegistry.upsert(refreshed);
    return refreshed;
  }

  return {
    runInImportWorkspace,
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    createWorkspaceForDirectory,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
