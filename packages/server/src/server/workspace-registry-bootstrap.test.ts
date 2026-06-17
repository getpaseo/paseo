import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";

const NON_GIT_PROJECT = path.resolve("/tmp/non-git-project");
const ARCHIVED_PROJECT = path.resolve("/tmp/archived-project");

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
      cwd: NON_GIT_PROJECT,
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
      cwd: NON_GIT_PROJECT,
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
      cwd: ARCHIVED_PROJECT,
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
    expect(workspaces[0]?.workspaceId).toMatch(/^wks_[0-9a-f]{16}$/);
    expect(workspaces[0]?.cwd).toBe(NON_GIT_PROJECT);
    expect(workspaces[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(workspaces[0]?.updatedAt).toBe("2026-03-03T00:00:00.000Z");

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe(NON_GIT_PROJECT);
    expect(projects[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(projects[0]?.updatedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  test("does not rematerialize when registry files already exist", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    await projectRegistry.upsert({
      projectId: "proj-existing",
      rootPath: "/tmp/existing",
      kind: "non_git",
      displayName: "existing",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "ws-existing",
      projectId: "proj-existing",
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
    expect((await workspaceRegistry.list())[0]?.workspaceId).toBe("ws-existing");
  });

  test("migrates cwd-only agents to the oldest existing same-cwd workspace", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    await projectRegistry.upsert({
      projectId: NON_GIT_PROJECT,
      rootPath: NON_GIT_PROJECT,
      kind: "non_git",
      displayName: "non-git-project",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "ws-newer",
      projectId: NON_GIT_PROJECT,
      cwd: NON_GIT_PROJECT,
      kind: "directory",
      displayName: "newer",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "ws-older",
      projectId: NON_GIT_PROJECT,
      cwd: NON_GIT_PROJECT,
      kind: "directory",
      displayName: "older",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });

    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "legacy-agent",
      provider: "codex",
      cwd: NON_GIT_PROJECT,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
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

    expect((await agentStorage.get("legacy-agent"))?.workspaceId).toBe("ws-older");
    expect(await workspaceRegistry.list()).toHaveLength(2);
  });

  test("migrated legacy agents stay owned by the deterministic workspace when a same-cwd workspace is added later", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    await projectRegistry.upsert({
      projectId: NON_GIT_PROJECT,
      rootPath: NON_GIT_PROJECT,
      kind: "non_git",
      displayName: "non-git-project",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "ws-original-owner",
      projectId: NON_GIT_PROJECT,
      cwd: NON_GIT_PROJECT,
      kind: "directory",
      displayName: "original",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });

    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "legacy-agent",
      provider: "codex",
      cwd: NON_GIT_PROJECT,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
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
    await workspaceRegistry.upsert({
      workspaceId: "ws-created-later",
      projectId: NON_GIT_PROJECT,
      cwd: NON_GIT_PROJECT,
      kind: "directory",
      displayName: "created later",
      createdAt: "2026-03-04T00:00:00.000Z",
      updatedAt: "2026-03-04T00:00:00.000Z",
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

    expect((await agentStorage.get("legacy-agent"))?.workspaceId).toBe("ws-original-owner");
    expect(await workspaceRegistry.get("ws-created-later")).toMatchObject({
      cwd: NON_GIT_PROJECT,
    });
  });

  test("preserves existing workspace IDs when only the projects file is missing", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert({
      workspaceId: "ws-existing",
      projectId: NON_GIT_PROJECT,
      cwd: NON_GIT_PROJECT,
      kind: "directory",
      displayName: "non-git-project",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });

    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-1",
      provider: "codex",
      cwd: NON_GIT_PROJECT,
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

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspaceId).toBe("ws-existing");
    expect(workspaces[0]?.cwd).toBe(NON_GIT_PROJECT);

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe(NON_GIT_PROJECT);
  });
});
