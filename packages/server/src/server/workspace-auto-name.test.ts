import pino from "pino";
import { expect, test, vi } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createPersistedWorkspaceRecord, type WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

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
    workspaceGitService: {} as WorkspaceGitService,
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

test("shares one metadata request for automatic workspace and agent names and skips initial setup", async () => {
  const emitted = deferred();
  const generated = vi.fn(async () => ({
    title: "Fix token refresh",
    branch: "fix-token-refresh",
  }));
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-fixture",
    projectId: "project-fixture",
    cwd: "/workspace",
    kind: "directory",
    displayName: "Fixture",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry: {
      update: async (_, mutate) => {
        workspace = mutate(workspace);
        return workspace;
      },
    },
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => emitted.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: generated,
  });
  expect(
    await autoName.generateContextualName({
      cwd: "/workspace",
      prompt: "hi",
      currentSelection: null,
    }),
  ).toBeNull();
  expect(
    await autoName.generateContextualName({
      cwd: "/workspace",
      prompt: "welche skills kannst du nutzen?",
      currentSelection: null,
    }),
  ).toBeNull();
  expect(generated).not.toHaveBeenCalled();
  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Fix token refresh" },
  });
  await autoName.generateContextualName({
    cwd: workspace.cwd,
    prompt: "Fix token refresh",
    currentSelection: null,
  });
  await emitted.promise;
  expect(generated).toHaveBeenCalledTimes(1);
  expect(workspace.title).toBe("Fix token refresh");
});
