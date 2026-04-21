import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  buildProjectPlacementForCwd,
  deriveProjectKind,
  deriveProjectRootPath,
  deriveWorkspaceDisplayName,
  deriveWorkspaceId,
  deriveWorkspaceKind,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import type { WorktreeConfig } from "../utils/worktree.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {}

export interface CreatePaseoWorktreeResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  workspace: PersistedWorkspaceRecord;
  repoRoot: string;
  created: boolean;
}

export type CreatePaseoWorktreeFn = (
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  },
) => Promise<CreatePaseoWorktreeResult>;

export interface CreatePaseoWorktreeDeps extends CreateWorktreeCoreDeps {
  projectRegistry: Pick<ProjectRegistry, "get" | "upsert">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  workspaceGitService: WorkspaceGitService;
  broadcastWorkspaceUpdate: (workspaceId: string) => Promise<void> | void;
  primeWorkspaceGitWatchFingerprints: (workspace: PersistedWorkspaceRecord) => Promise<void>;
}

export async function createPaseoWorktree(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const createdWorktree = await createWorktreeCore(input, deps);
  const workspace = await upsertWorkspaceForWorktree({
    worktree: createdWorktree.worktree,
    deps,
  });

  deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });
  await deps.primeWorkspaceGitWatchFingerprints(workspace);
  await deps.broadcastWorkspaceUpdate(workspace.workspaceId);

  return {
    worktree: createdWorktree.worktree,
    intent: createdWorktree.intent,
    workspace,
    repoRoot: createdWorktree.repoRoot,
    created: createdWorktree.created,
  };
}

async function upsertWorkspaceForWorktree(options: {
  worktree: WorktreeConfig;
  deps: Pick<
    CreatePaseoWorktreeDeps,
    "projectRegistry" | "workspaceRegistry" | "workspaceGitService"
  >;
}): Promise<PersistedWorkspaceRecord> {
  const normalizedCwd = normalizeWorkspaceId(options.worktree.worktreePath);
  const placement = await buildProjectPlacementForCwd({
    cwd: normalizedCwd,
    workspaceGitService: options.deps.workspaceGitService,
  });
  const workspaceId = deriveWorkspaceId(normalizedCwd, placement.checkout);
  const now = new Date().toISOString();
  const existingProject = await options.deps.projectRegistry.get(placement.projectKey);
  const existingWorkspace = await findWorkspaceByDirectory(
    normalizedCwd,
    options.deps.workspaceRegistry,
  );

  await options.deps.projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: placement.projectKey,
      rootPath: deriveProjectRootPath({
        cwd: normalizedCwd,
        checkout: placement.checkout,
      }),
      kind: deriveProjectKind(placement.checkout),
      displayName: placement.projectName,
      createdAt: existingProject?.createdAt ?? now,
      updatedAt: now,
      archivedAt: null,
    }),
  );

  const workspace = createPersistedWorkspaceRecord({
    workspaceId,
    projectId: placement.projectKey,
    cwd: normalizedCwd,
    kind: deriveWorkspaceKind(placement.checkout),
    displayName: deriveWorkspaceDisplayName({
      cwd: normalizedCwd,
      checkout: placement.checkout,
    }),
    createdAt: existingWorkspace?.createdAt ?? now,
    updatedAt: now,
    archivedAt: null,
  });

  await options.deps.workspaceRegistry.upsert(workspace);
  return (await options.deps.workspaceRegistry.get(workspace.workspaceId)) ?? workspace;
}

async function findWorkspaceByDirectory(
  cwd: string,
  workspaceRegistry: Pick<WorkspaceRegistry, "list">,
): Promise<PersistedWorkspaceRecord | null> {
  const workspaces = await workspaceRegistry.list();
  return workspaces.find((workspace) => workspace.cwd === cwd) ?? null;
}
