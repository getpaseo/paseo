import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";

let NON_GIT_PROJECT: string;
let ARCHIVED_PROJECT: string;
let GIT_PROJECT: string;
let GIT_CLONE: string;
let GIT_WORKTREE: string;

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
    NON_GIT_PROJECT = path.join(tmpDir, "non-git-project");
    ARCHIVED_PROJECT = path.join(tmpDir, "archived-project");
    GIT_PROJECT = path.join(tmpDir, "legacy-git-project");
    GIT_CLONE = path.join(tmpDir, "legacy-git-project-clone");
    GIT_WORKTREE = path.join(tmpDir, "legacy-git-project-feature");
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
    for (const directory of [
      NON_GIT_PROJECT,
      ARCHIVED_PROJECT,
      GIT_PROJECT,
      GIT_CLONE,
      GIT_WORKTREE,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("skips a legacy agent whose directory no longer exists", async () => {
    const missingDirectory = path.join(tmpDir, "missing-project");
    const getCheckout = async () => {
      throw new Error("Git must not inspect a missing directory");
    };
    workspaceGitService = { ...createNoopWorkspaceGitService(), getCheckout };
    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-missing-directory",
      provider: "codex",
      cwd: missingDirectory,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: null,
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

    expect(await projectRegistry.list()).toEqual([]);
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("skips a legacy agent whose cwd is a file", async () => {
    const cwd = path.join(tmpDir, "not-a-directory");
    writeFileSync(cwd, "not a directory");
    workspaceGitService = {
      ...createNoopWorkspaceGitService(),
      getCheckout: async () => {
        throw new Error("Git must not inspect a file");
      },
    };
    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-file-cwd",
      provider: "codex",
      cwd,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: null,
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

    expect(await projectRegistry.list()).toEqual([]);
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("propagates a Git failure for an existing legacy directory", async () => {
    const gitFailure = new Error("Git is unavailable");
    workspaceGitService = {
      ...createNoopWorkspaceGitService(),
      getCheckout: async () => {
        throw gitFailure;
      },
    };
    await agentStorage.initialize();
    await agentStorage.upsert({
      id: "agent-existing-directory",
      provider: "codex",
      cwd: NON_GIT_PROJECT,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: null,
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

    await expect(
      bootstrapWorkspaceRegistries({
        paseoHome,
        agentStorage,
        projectRegistry,
        workspaceRegistry,
        workspaceGitService,
        logger,
      }),
    ).rejects.toBe(gitFailure);
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

  test("repairs an existing remote-grouped project containing independent clones", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    await projectRegistry.upsert({
      projectId: "remote:github.com/acme/legacy-project",
      rootPath: GIT_PROJECT,
      kind: "git",
      displayName: "acme/legacy-project",
      customName: "My assistant",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: null,
    });
    for (const workspace of [
      {
        workspaceId: "ws-main",
        cwd: GIT_PROJECT,
        kind: "local_checkout" as const,
        displayName: "main",
        branch: "main",
        worktreeRoot: GIT_PROJECT,
        mainRepoRoot: null,
      },
      {
        workspaceId: "ws-worktree",
        cwd: GIT_WORKTREE,
        kind: "worktree" as const,
        displayName: "feature/plain",
        branch: "feature/plain",
        worktreeRoot: GIT_WORKTREE,
        mainRepoRoot: GIT_PROJECT,
      },
      {
        workspaceId: "ws-clone",
        cwd: GIT_CLONE,
        kind: "local_checkout" as const,
        displayName: "customer/fifi",
        branch: "customer/fifi",
        worktreeRoot: GIT_CLONE,
        mainRepoRoot: null,
      },
    ]) {
      await workspaceRegistry.upsert({
        ...workspace,
        projectId: "remote:github.com/acme/legacy-project",
        title: null,
        baseBranch: null,
        isPaseoOwnedWorktree: workspace.kind === "worktree",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
        archivedAt: null,
        pinnedAt: null,
      });
    }

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(2);
    expect(
      projects.find((project) => project.projectId === "remote:github.com/acme/legacy-project"),
    ).toMatchObject({
      rootPath: GIT_PROJECT,
      displayName: "legacy-git-project",
      customName: "My assistant",
    });
    const cloneProject = projects.find((project) => project.rootPath === GIT_CLONE);
    expect(cloneProject).toMatchObject({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{16}$/),
      rootPath: GIT_CLONE,
      displayName: "legacy-git-project-clone",
    });

    expect(
      (await workspaceRegistry.list())
        .map(({ workspaceId, projectId }) => ({ workspaceId, projectId }))
        .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    ).toEqual([
      { workspaceId: "ws-clone", projectId: cloneProject?.projectId },
      { workspaceId: "ws-main", projectId: "remote:github.com/acme/legacy-project" },
      { workspaceId: "ws-worktree", projectId: "remote:github.com/acme/legacy-project" },
    ]);

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    expect(await projectRegistry.list()).toEqual(projects);
    expect(
      (await workspaceRegistry.list())
        .map(({ workspaceId, projectId }) => ({ workspaceId, projectId }))
        .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    ).toEqual([
      { workspaceId: "ws-clone", projectId: cloneProject?.projectId },
      { workspaceId: "ws-main", projectId: "remote:github.com/acme/legacy-project" },
      { workspaceId: "ws-worktree", projectId: "remote:github.com/acme/legacy-project" },
    ]);
  });

  test("materializes a linked worktree under its source checkout project", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd) => ({
        cwd,
        isGit: true,
        currentBranch: cwd === GIT_PROJECT ? "main" : "feature/plain",
        remoteUrl: "git@github.com:acme/legacy-project.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: cwd === GIT_PROJECT ? null : GIT_PROJECT,
      }),
    });
    await agentStorage.initialize();
    for (const [id, cwd] of [
      ["main-agent", GIT_PROJECT],
      ["worktree-agent", GIT_WORKTREE],
    ]) {
      await agentStorage.upsert({
        id,
        provider: "codex",
        cwd,
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
    }

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectId: GIT_PROJECT,
      rootPath: GIT_PROJECT,
      kind: "git",
      displayName: "legacy-git-project",
    });

    const workspaces = await workspaceRegistry.list();
    expect(
      workspaces
        .map(({ projectId, cwd, kind, displayName }) => ({ projectId, cwd, kind, displayName }))
        .sort((left, right) => left.cwd.localeCompare(right.cwd)),
    ).toEqual([
      {
        projectId: GIT_PROJECT,
        cwd: GIT_PROJECT,
        kind: "local_checkout",
        displayName: "main",
      },
      {
        projectId: GIT_PROJECT,
        cwd: GIT_WORKTREE,
        kind: "worktree",
        displayName: "feature/plain",
      },
    ]);
  });

  test("materializes independent clones with the same remote as separate projects", async () => {
    workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd) => ({
        cwd,
        isGit: true,
        currentBranch: cwd === GIT_PROJECT ? "main" : "customer/fifi",
        remoteUrl: "git@github.com:acme/legacy-project.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    });
    await agentStorage.initialize();
    for (const [id, cwd] of [
      ["main-agent", GIT_PROJECT],
      ["clone-agent", GIT_CLONE],
    ]) {
      await agentStorage.upsert({
        id,
        provider: "codex",
        cwd,
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
    }

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });

    expect(
      (await projectRegistry.list())
        .map(({ projectId, rootPath, displayName }) => ({ projectId, rootPath, displayName }))
        .sort((left, right) => left.rootPath.localeCompare(right.rootPath)),
    ).toEqual([
      {
        projectId: GIT_PROJECT,
        rootPath: GIT_PROJECT,
        displayName: "legacy-git-project",
      },
      {
        projectId: GIT_CLONE,
        rootPath: GIT_CLONE,
        displayName: "legacy-git-project-clone",
      },
    ]);
    expect(
      (await workspaceRegistry.list())
        .map(({ projectId, cwd }) => ({ projectId, cwd }))
        .sort((left, right) => left.cwd.localeCompare(right.cwd)),
    ).toEqual([
      { projectId: GIT_PROJECT, cwd: GIT_PROJECT },
      { projectId: GIT_CLONE, cwd: GIT_CLONE },
    ]);
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
