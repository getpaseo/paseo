import pino from "pino";
import { expect, test, vi } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createPersistedWorkspaceRecord, type WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceGitWorkspace } from "./workspace-git-service.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("auto-name preserves workspace archival that lands during its metadata write", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const mutationStarted = deferred();
  const allowMutation = deferred();
  const updateEmitted = deferred();
  const workspaceRegistry = {
    get: async () => workspace,
    update: async (_workspaceId, updater) => {
      mutationStarted.resolve();
      await allowMutation.promise;
      workspace = updater(workspace);
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "update">;
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry,
    workspaceGitDirectory: {
      bindRecord: () => ({ readHeadFile: async () => null }) as WorkspaceGitWorkspace,
    },
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => updateEmitted.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => ({ title: "generated", branch: null }),
  });

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await mutationStarted.promise;
  const archivedAt = "2026-08-08T00:01:00.000Z";
  workspace = { ...workspace, updatedAt: archivedAt, archivedAt };
  allowMutation.resolve();
  await updateEmitted.promise;

  expect(workspace).toMatchObject({
    title: "generated",
    archivedAt,
  });
});

test.each([
  ["selected", { runtimeId: "bubblewrap" }, "workspace-auto-name"],
  ["legacy", undefined, undefined],
] as const)(
  "auto-name binds %s workspace identity",
  async (_kind, runtime, expectedWorkspaceId) => {
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "workspace-auto-name",
      projectId: "project-auto-name",
      cwd: "/workspace/project",
      kind: "directory",
      displayName: "project",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      ...(runtime ? { runtime } : {}),
    });
    const generated = deferred();
    const workspaceGit = { readHeadFile: async () => null } as WorkspaceGitWorkspace;
    const bindRecord = vi.fn(() => workspaceGit);
    const generateWorkspaceName = vi.fn(async () => {
      generated.resolve();
      return { title: null, branch: null };
    });
    const autoName = new WorkspaceAutoName({
      agentManager: {} as AgentManager,
      workspaceRegistry: {
        get: async () => workspace,
        update: async () => workspace,
      },
      workspaceGitDirectory: { bindRecord },
      providerSnapshotManager: {} as ProviderSnapshotManager,
      readDaemonConfig: () => ({}),
      gitMutation: { notifyGitMutation: async () => {} },
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async () => {},
      logger: pino({ level: "silent" }),
      generateWorkspaceName,
    });

    autoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Name this workspace" },
    });
    await generated.promise;

    expect(bindRecord).toHaveBeenCalledWith(workspace);
    expect(generateWorkspaceName).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: workspace.cwd,
        workspaceGit,
        ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}),
      }),
    );
    if (!expectedWorkspaceId) {
      expect(generateWorkspaceName.mock.calls[0]?.[0]).not.toHaveProperty("workspaceId");
    }
  },
);

test("selected worktree auto-name renames through bound runtime Git", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace/project",
    kind: "worktree",
    displayName: "project",
    title: "Initial prompt",
    branch: "placeholder-branch",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    runtime: { runtimeId: "bubblewrap" },
  });
  let currentBranch = "placeholder-branch";
  const renamed = vi.fn(async (branch: string) => {
    const previousBranch = currentBranch;
    currentBranch = branch;
    return { previousBranch, currentBranch };
  });
  const refresh = vi.fn(async () => ({}));
  const workspaceGit = {
    cwd: workspace.cwd,
    readHeadFile: async () => null,
    getCheckout: async () => ({ currentBranch }),
    hasLocalBranch: async () => false,
    renameBranch: renamed,
    getSnapshot: refresh,
  } as unknown as WorkspaceGitWorkspace;
  const emitted = deferred();
  const generateWorkspaceName = vi.fn(async () => ({
    title: "Generated title",
    branch: "generated-branch",
  }));
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry: {
      get: async () => workspace,
      update: async (_workspaceId, updater) => {
        workspace = updater(workspace);
        return workspace;
      },
    },
    workspaceGitDirectory: { bindRecord: () => workspaceGit },
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: vi.fn(async () => {}) },
    emitWorkspaceUpdateForCwd: async () => emitted.resolve(),
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger: pino({ level: "silent" }),
    generateWorkspaceName,
  });

  autoName.scheduleForWorktree({
    workspace,
    firstAgentContext: { prompt: "Initial prompt" },
  });
  await emitted.promise;

  expect(generateWorkspaceName).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: workspace.workspaceId, workspaceGit }),
  );
  expect(renamed).toHaveBeenCalledWith("generated-branch");
  expect(refresh).toHaveBeenCalledWith({ force: true, reason: "rename-branch" });
  expect(workspace).toMatchObject({ title: "Generated title", branch: "generated-branch" });
});

test("invalid committed metadata is logged and skips selected workspace auto-name", async () => {
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace/project",
    kind: "directory",
    displayName: "project",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    runtime: { runtimeId: "bubblewrap" },
  });
  const generationFailed = deferred();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(() => generationFailed.resolve()),
  } as unknown as pino.Logger;
  const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry: {
      get: async () => workspace,
      update: async () => workspace,
    },
    workspaceGitDirectory: {
      bindRecord: () =>
        ({ readHeadFile: async () => "{ nope" }) as unknown as WorkspaceGitWorkspace,
    },
    providerSnapshotManager: {
      listProviders: vi.fn(async () => []),
    } as unknown as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId,
    logger,
  });

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await generationFailed.promise;

  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ err: expect.any(Error) }),
    "Branch name generation failed",
  );
  expect(emitWorkspaceUpdateForWorkspaceId).not.toHaveBeenCalled();
});
