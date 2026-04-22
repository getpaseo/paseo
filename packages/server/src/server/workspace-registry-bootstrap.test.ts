import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";

function createNoopWorkspaceGitService(): WorkspaceGitService {
  return {
    subscribe: async (params) => ({
      initial: {
        cwd: params.cwd,
        git: {
          isGit: false,
          repoRoot: null,
          mainRepoRoot: null,
          currentBranch: null,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          isDirty: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          diffStat: null,
        },
        github: {
          featuresEnabled: false,
          pullRequest: null,
          error: null,
        },
      },
      unsubscribe: () => {},
    }),
    peekSnapshot: () => null,
    getSnapshot: async (cwd) => ({
      cwd,
      git: {
        isGit: false,
        repoRoot: null,
        mainRepoRoot: null,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        isDirty: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        diffStat: null,
      },
      github: {
        featuresEnabled: false,
        pullRequest: null,
        error: null,
      },
    }),
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({
      repoRoot: null,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    dispose: () => {},
  };
}

describe("bootstrapWorkspaceRegistries", () => {
  let tmpDir: string;
  let paseoHome: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let workspaceGitService: WorkspaceGitService;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-bootstrap-"));
    paseoHome = path.join(tmpDir, ".paseo");
    agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    projectRegistry = new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "projects", "workspaces.json"),
      logger,
    );
    workspaceGitService = createNoopWorkspaceGitService();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("materializes workspace registries from non-archived agent records", async () => {
    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/non-git-project",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      lastActivityAt: "2026-03-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "idle",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });
    await agentStorage.upsert({
      id: "agent-2",
      provider: "codex",
      cwd: "/tmp/non-git-project",
      createdAt: "2026-03-01T01:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
      lastActivityAt: "2026-03-03T00:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "running",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });
    await agentStorage.upsert({
      id: "agent-archived",
      provider: "codex",
      cwd: "/tmp/archived-project",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "idle",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: "2026-03-02T00:00:00.000Z",
    });

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspaceId).toBe("/tmp/non-git-project");
    expect(workspaces[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(workspaces[0]?.updatedAt).toBe("2026-03-03T00:00:00.000Z");

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe("/tmp/non-git-project");
    expect(projects[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(projects[0]?.updatedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  test("does not rematerialize when registry files already exist", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    await projectRegistry.upsert({
      projectId: "/tmp/existing",
      rootPath: "/tmp/existing",
      kind: "non_git",
      displayName: "existing",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "/tmp/existing",
      projectId: "/tmp/existing",
      cwd: "/tmp/existing",
      kind: "directory",
      displayName: "existing",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });

    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/another-project",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      lastActivityAt: "2026-03-02T00:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "idle",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    expect(await projectRegistry.list()).toHaveLength(1);
    expect(await workspaceRegistry.list()).toHaveLength(1);
    expect((await workspaceRegistry.list())[0]?.workspaceId).toBe("/tmp/existing");
  });
});
