import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  attemptFirstAgentBranchAutoName,
  createPaseoWorktree,
  type CreatePaseoWorktreeDeps,
} from "./paseo-worktree-service.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { createWorktree, getPaseoWorktreesRoot } from "../utils/worktree.js";
import { isPlatform } from "../test-utils/platform.js";
import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../utils/path.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

test("creates a worktree and registers it in the source workspace project without git snapshot lookup", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const events: string[] = [];
  const deps = createDeps({ events });
  const sourceProject = createPersistedProjectRecordForTest({
    projectId: "remote:github.com/acme/repo",
    rootPath: repoDir,
    displayName: "acme/repo",
  });
  const sourceWorkspace = createPersistedWorkspaceRecordForTest({
    workspaceId: "ws-main-checkout",
    projectId: sourceProject.projectId,
    cwd: repoDir,
    kind: "local_checkout",
    displayName: "main",
  });
  deps.projects.set(sourceProject.projectId, sourceProject);
  deps.workspaces.set(sourceWorkspace.workspaceId, sourceWorkspace);
  deps.workspaceGitService.getSnapshot = vi.fn(deps.workspaceGitService.getSnapshot);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "feature-one",
      title: "Feature One",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.created).toBe(true);
  expect(result.workspace.cwd).toBe(result.worktree.worktreePath);
  expect(result.workspace.kind).toBe("worktree");
  expect(result.workspace.workspaceId).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(result.workspace.projectId).toBe("remote:github.com/acme/repo");
  expect(result.workspace.displayName).toBe("feature-one");
  expect(result.workspace.baseBranch).toBe("main");
  expect(result.workspace.title).toBe("Feature One");
  expect(deps.workspaceGitService.getSnapshot).not.toHaveBeenCalled();
  expect(deps.projects.get(sourceProject.projectId)).toEqual(sourceProject);
  expect(events).toEqual([`workspace:${result.workspace.workspaceId}`]);
});

test("refreshes a source project that became Git while creating a worktree", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();
  const sourceProject = {
    ...createPersistedProjectRecordForTest({
      projectId: "prj_existing-source",
      rootPath: repoDir,
      displayName: "Repository",
    }),
    kind: "non_git" as const,
    customName: "My project",
  };
  const sourceWorkspace = createPersistedWorkspaceRecordForTest({
    workspaceId: "ws-main-checkout",
    projectId: sourceProject.projectId,
    cwd: repoDir,
    kind: "local_checkout",
    displayName: "main",
  });
  deps.projects.set(sourceProject.projectId, sourceProject);
  deps.workspaces.set(sourceWorkspace.workspaceId, sourceWorkspace);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "project-became-git",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace.projectId).toBe(sourceProject.projectId);
  expect(deps.projects.get(sourceProject.projectId)).toMatchObject({
    projectId: sourceProject.projectId,
    rootPath: repoDir,
    kind: "git",
    displayName: "Repository",
    customName: "My project",
    archivedAt: null,
  });
});

test("repairs a legacy source workspace whose project record is missing", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();
  const sourceWorkspace = createPersistedWorkspaceRecordForTest({
    workspaceId: "ws-missing-project",
    projectId: "project-missing",
    cwd: repoDir,
    kind: "local_checkout",
    displayName: "main",
  });
  deps.workspaces.set(sourceWorkspace.workspaceId, sourceWorkspace);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "repaired-source",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  expect(result.workspace.projectId).not.toBe(sourceWorkspace.projectId);
  const repairedProject = deps.projects.get(result.workspace.projectId);
  expect(repairedProject).toMatchObject({
    projectId: result.workspace.projectId,
    kind: "git",
    archivedAt: null,
  });
  expect(createRealpathAwarePathMatcher(repoDir)(repairedProject?.rootPath ?? "")).toBe(true);
});

test("uses an equivalent source workspace path when creating a worktree", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const sourceDir = path.join(repoDir, "app");
  mkdirSync(sourceDir);
  writeFileSync(path.join(repoDir, "app", ".gitkeep"), "");
  commitAll(repoDir, "add app");
  const deps = createDeps();
  const sourceProject = createPersistedProjectRecordForTest({
    projectId: "prj_source-folder",
    rootPath: sourceDir,
    displayName: "app",
  });
  const sourceWorkspace = createPersistedWorkspaceRecordForTest({
    workspaceId: "ws-source-folder",
    projectId: sourceProject.projectId,
    cwd: `${sourceDir}${path.sep}`,
    kind: "local_checkout",
    displayName: "app",
  });
  deps.projects.set(sourceProject.projectId, sourceProject);
  deps.workspaces.set(sourceWorkspace.workspaceId, sourceWorkspace);

  const result = await createPaseoWorktree(
    {
      cwd: sourceDir,
      worktreeSlug: "equivalent-source",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace.projectId).toBe(sourceProject.projectId);
});

test("creates a worktree workspace at the selected project subdirectory", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const sourceDir = path.join(repoDir, "packages", "app");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "package.json"), "{}\n");
  commitAll(repoDir, "add subproject");
  const deps = createDeps();
  const project = createPersistedProjectRecordForTest({
    projectId: "prj_selected-subdirectory",
    rootPath: sourceDir,
    displayName: "app",
  });
  deps.projects.set(project.projectId, project);

  const result = await createPaseoWorktree(
    {
      cwd: sourceDir,
      projectId: project.projectId,
      worktreeSlug: "selected-subdirectory",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace).toMatchObject({
    projectId: project.projectId,
    cwd: path.join(result.worktree.worktreePath, "packages", "app"),
    worktreeRoot: result.worktree.worktreePath,
    kind: "worktree",
  });
});

test("seeds an uncommitted exact-project config into the mapped worktree directory", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const sourceDir = path.join(repoDir, "packages", "app");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "package.json"), "{}\n");
  commitAll(repoDir, "add subproject");
  const config = JSON.stringify({ worktree: { setup: ["npm install"] } });
  writeFileSync(path.join(sourceDir, "paseo.json"), config);

  const result = await createPaseoWorktree(
    {
      cwd: sourceDir,
      worktreeSlug: "seed-nested-config",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  expect(readFileSync(path.join(result.workspace.cwd, "paseo.json"), "utf8")).toBe(config);
  expect(existsSync(path.join(result.worktree.worktreePath, "paseo.json"))).toBe(false);
});

test("removes a new worktree when its ref does not contain the selected project directory", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  execFileSync("git", ["branch", "without-subproject"], { cwd: repoDir, stdio: "pipe" });
  const sourceDir = path.join(repoDir, "packages", "app");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "package.json"), "{}\n");
  commitAll(repoDir, "add subproject");
  const deps = createDeps();
  const paseoHome = path.join(tempDir, ".paseo");
  const worktreePath = path.join(
    await getPaseoWorktreesRoot(repoDir, paseoHome),
    "missing-subproject",
  );

  await expect(
    createPaseoWorktree(
      {
        cwd: sourceDir,
        action: "checkout",
        refName: "without-subproject",
        worktreeSlug: "missing-subproject",
        runSetup: false,
        paseoHome,
      },
      deps,
    ),
  ).rejects.toThrow("Selected project directory is missing from the worktree");

  expect(deps.workspaces.size).toBe(0);
  expect(existsSync(worktreePath)).toBe(false);
  expect(
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, stdio: "pipe" })
      .toString()
      .includes("missing-subproject"),
  ).toBe(false);
});

test("removes a new worktree when workspace persistence fails", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const paseoHome = path.join(tempDir, ".paseo");
  const worktreePath = path.join(
    await getPaseoWorktreesRoot(repoDir, paseoHome),
    "persistence-failure",
  );

  await expect(
    createPaseoWorktree(
      {
        cwd: repoDir,
        projectId: "missing-project",
        worktreeSlug: "persistence-failure",
        runSetup: false,
        paseoHome,
      },
      createDeps(),
    ),
  ).rejects.toThrow("Unknown project: missing-project");

  expect(existsSync(worktreePath)).toBe(false);
  expect(
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, stdio: "pipe" })
      .toString()
      .includes("persistence-failure"),
  ).toBe(false);
});

test("maps a nested cwd from an existing Paseo worktree into the next worktree", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const paseoHome = path.join(tempDir, ".paseo");
  const projectDir = path.join(repoDir, "packages", "app");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "package.json"), "{}\n");
  commitAll(repoDir, "add subproject");
  const deps = createDeps();
  const source = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "source-worktree",
      runSetup: false,
      paseoHome,
    },
    deps,
  );
  const sourceCwd = path.join(source.worktree.worktreePath, "packages", "app");

  const created = await createPaseoWorktree(
    {
      cwd: sourceCwd,
      worktreeSlug: "nested-worktree",
      runSetup: false,
      paseoHome,
    },
    deps,
  );

  expect(created.workspace.cwd).toBe(path.join(created.worktree.worktreePath, "packages", "app"));
  expect(deps.workspaces.get(created.workspace.workspaceId)).toEqual(created.workspace);
});

test("rejects source checkout planning before creating a worktree", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const paseoHome = path.join(tempDir, ".paseo");
  const deps = createDeps();
  deps.workspaceGitService.getCheckout = async () => {
    throw new Error("source checkout unavailable");
  };

  await expect(
    createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "must-not-create",
        runSetup: false,
        paseoHome,
      },
      deps,
    ),
  ).rejects.toThrow("source checkout unavailable");

  expect(existsSync(path.join(paseoHome, "worktrees"))).toBe(false);
  expect(Array.from(deps.workspaces.values())).toEqual([]);
});

test("registers a new worktree in the existing root project after the main checkout workspace is removed", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();
  const sourceProject = createPersistedProjectRecordForTest({
    projectId: "remote:github.com/acme/repo",
    rootPath: repoDir,
    displayName: "acme/repo",
  });
  const existingWorktree = createPersistedWorkspaceRecordForTest({
    workspaceId: "ws-existing-worktree",
    projectId: sourceProject.projectId,
    cwd: path.join(tempDir, "existing-worktree"),
    kind: "worktree",
    displayName: "existing-worktree",
  });
  deps.projects.set(sourceProject.projectId, sourceProject);
  deps.workspaces.set(existingWorktree.workspaceId, existingWorktree);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      projectId: sourceProject.projectId,
      worktreeSlug: "second-worktree",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace.projectId).toBe("remote:github.com/acme/repo");
  expect(Array.from(deps.projects.keys()).sort()).toEqual(["remote:github.com/acme/repo"]);
});

test("an explicit project FK remains unchanged when its worktree comes from another checkout", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();
  const project = {
    ...createPersistedProjectRecordForTest({
      projectId: "prj_explicitproject",
      rootPath: path.join(tempDir, "unrelated"),
      displayName: "unrelated",
    }),
    kind: "non_git" as const,
  };
  deps.projects.set(project.projectId, project);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      projectId: project.projectId,
      worktreeSlug: "attached-worktree",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.workspace.projectId).toBe(project.projectId);
  expect(deps.projects.get(project.projectId)).toEqual(project);
});

// POSIX-only: Windows git worktree paths need separate canonicalization coverage.
test.skipIf(isPlatform("win32"))(
  "reuses an existing worktree and still upserts the workspace",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const firstDeps = createDeps();
    const first = await createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "reuse-me",
        runSetup: false,
        paseoHome,
      },
      firstDeps,
    );
    const events: string[] = [];
    const deps = createDeps({
      events,
      projects: firstDeps.projects,
      workspaces: firstDeps.workspaces,
    });

    const second = await createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "reuse-me",
        runSetup: false,
        paseoHome,
      },
      deps,
    );

    expect(second.created).toBe(false);
    expect(second.worktree.worktreePath).toBe(first.worktree.worktreePath);
    expect(events).toContain(`workspace:${second.workspace.workspaceId}`);
    // Creation never dedupes by directory: the same worktree path yields a
    // distinct workspace record on the second call.
    expect(second.workspace.workspaceId).not.toBe(first.workspace.workspaceId);
  },
);

test("renames an eligible unnamed branch-off worktree once on first agent context", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "pending",
      placeholderBranchName: "dazzling-yak",
    },
  });

  const first = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Build the agent context name" },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.prompt ? "renamed-from-agent-context" : null,
  });
  const branchAfterFirst = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(first).toEqual({
    attempted: true,
    renamed: true,
    branchName: "renamed-from-agent-context",
  });
  expect(branchAfterFirst).toBe("renamed-from-agent-context");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: "dazzling-yak",
    },
  });

  const second = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Try another name" },
    generateBranchNameFromContext: async () => "second-agent-name",
  });
  const branchAfterSecond = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(second).toEqual({ attempted: false, renamed: false, branchName: null });
  expect(branchAfterSecond).toBe("renamed-from-agent-context");
});

test("falls back to a numeric suffix when the desired branch name already exists", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);

  execFileSync("git", ["branch", "renamed-from-agent-context"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "renamed-from-agent-context-2"], { cwd: repoDir, stdio: "pipe" });

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  const result = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Build the agent context name" },
    generateBranchNameFromContext: async () => "renamed-from-agent-context",
  });

  expect(result).toEqual({
    attempted: true,
    renamed: true,
    branchName: "renamed-from-agent-context-3",
  });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("renamed-from-agent-context-3");
});

test("renames the branch even when the app supplies a random placeholder slug", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: { prompt: "Investigate the failing login flow" },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");
  expect(created.workspace.displayName).toBe("dazzling-yak");

  await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Investigate the failing login flow" },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.prompt === "Investigate the failing login flow"
        ? "renamed-from-prompt"
        : null,
  });

  const branchAfter = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(branchAfter).toBe("renamed-from-prompt");
});

test("renames the branch from a github_pr attachment when no prompt is supplied", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: {
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 42,
            title: "Investigate flaky checkout test",
            url: "https://github.com/acme/repo/pull/42",
          },
        ],
      },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");

  await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: {
      attachments: [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 42,
          title: "Investigate flaky checkout test",
          url: "https://github.com/acme/repo/pull/42",
        },
      ],
    },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.attachments?.[0]?.type === "github_pr"
        ? "renamed-from-pr-attachment"
        : null,
  });

  const branchAfter = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(branchAfter).toBe("renamed-from-pr-attachment");
});

test("leaves the branch alone when generated branch text is invalid", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: { prompt: "Name this branch" },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Name this branch" },
      generateBranchNameFromContext: async () => "Invalid Branch Name",
    }),
  ).resolves.toEqual({ attempted: true, renamed: false, branchName: null });

  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("dazzling-yak");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: "dazzling-yak",
    },
  });
});

test("does not mark checkout branch worktrees as eligible for first-agent rename", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  execFileSync("git", ["checkout", "-b", "dev"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "dev branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "dev"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      action: "checkout",
      refName: "dev",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 1,
    baseRefName: "dev",
  });
  // A checkout-branch worktree has no distinct base, so the workspace records a
  // null baseBranch even though worktree.json's baseRefName is the branch itself.
  expect(created.workspace.baseBranch).toBe(null);
  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Rename checkout branch" },
      generateBranchNameFromContext: async () => "must-not-rename",
    }),
  ).resolves.toEqual({ attempted: false, renamed: false, branchName: null });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("dev");
});

test("does not mark GitHub PR checkout worktrees as eligible for first-agent rename", async () => {
  const { repoDir, tempDir } = createGitHubPrRemoteRepo();
  cleanupPaths.push(tempDir);

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      action: "checkout",
      githubPrNumber: 123,
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 1,
    baseRefName: "main",
  });
  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Rename PR checkout" },
      generateBranchNameFromContext: async () => "must-not-rename",
    }),
  ).resolves.toEqual({ attempted: false, renamed: false, branchName: null });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("pr-123");
});

test("does not mutate registries or broadcast when core worktree creation fails", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-worktree-service-"));
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  await expect(
    createPaseoWorktree(
      {
        cwd: tempDir,
        worktreeSlug: "not-git",
        runSetup: false,
        paseoHome: path.join(tempDir, ".paseo"),
      },
      deps,
    ),
  ).rejects.toThrow("Create worktree requires a git repository");

  expect(deps.projects.size).toBe(0);
  expect(deps.workspaces.size).toBe(0);
});

// Worktree restore (Unit 3): recreate a deleted Paseo-owned worktree from its
// kept branch via createWorktree's checkout-branch source.
test.skipIf(isPlatform("win32"))(
  "recreates a deleted worktree on the same kept branch without creating a suffixed branch",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");

    execFileSync("git", ["branch", "restore-me"], { cwd: repoDir, stdio: "pipe" });

    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "restore-me",
      source: { kind: "checkout-branch", branchName: "restore-me" },
      runSetup: false,
      paseoHome,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    execFileSync("git", ["worktree", "remove", created.worktreePath, "--force"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    expect(existsSync(created.worktreePath)).toBe(false);

    const recreated = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "restore-me",
      source: { kind: "checkout-branch", branchName: "restore-me" },
      runSetup: false,
      paseoHome,
    });

    expect(recreated.worktreePath).toBe(created.worktreePath);
    expect(existsSync(recreated.worktreePath)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: recreated.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim(),
    ).toBe("restore-me");
    const branches = execFileSync("git", ["branch", "--list", "restore-me*"], {
      cwd: repoDir,
      stdio: "pipe",
    })
      .toString()
      .split("\n")
      .map((line) => line.replace(/^[*+ ]+/, "").trim())
      .filter(Boolean);
    expect(branches).toEqual(["restore-me"]);
  },
);

// The default archive path (scope "workspace", worktreePath only) resolves
// repoRoot=null, so deletePaseoWorktree's `git worktree remove`/`prune` is
// skipped: the directory is rm-ed but the admin registration survives, pinning
// the branch as "already checked out". Restore must self-heal by pruning the
// stale registration before recreating, regardless of how it was archived.
test.skipIf(isPlatform("win32"))(
  "recreates a worktree whose dir was rm-ed without git worktree remove (stale registration)",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");

    execFileSync("git", ["branch", "restore-me"], { cwd: repoDir, stdio: "pipe" });

    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "restore-me",
      source: { kind: "checkout-branch", branchName: "restore-me" },
      runSetup: false,
      paseoHome,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    // Simulate the default-archive teardown: remove the working directory but
    // leave the git worktree registration intact.
    rmSync(created.worktreePath, { recursive: true, force: true });
    expect(existsSync(created.worktreePath)).toBe(false);

    const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      stdio: "pipe",
    }).toString();
    expect(worktreeList).toContain(created.worktreePath);

    // Recreating without pruning fails with the stale registration pinning the
    // branch — this is the case restore must heal.
    await expect(
      createWorktree({
        cwd: repoDir,
        worktreeSlug: "restore-me",
        source: { kind: "checkout-branch", branchName: "restore-me" },
        runSetup: false,
        paseoHome,
      }),
    ).rejects.toMatchObject({ name: "BranchAlreadyCheckedOutError" });

    // The restore-side prune frees the stale registration; recreate then succeeds.
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const recreated = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "restore-me",
      source: { kind: "checkout-branch", branchName: "restore-me" },
      runSetup: false,
      paseoHome,
    });

    expect(recreated.worktreePath).toBe(created.worktreePath);
    expect(existsSync(recreated.worktreePath)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: recreated.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim(),
    ).toBe("restore-me");
  },
);

test.skipIf(isPlatform("win32"))(
  "rejects with UnknownBranchError when the kept branch no longer exists",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    await expect(
      createWorktree({
        cwd: repoDir,
        worktreeSlug: "gone-branch",
        source: { kind: "checkout-branch", branchName: "gone-branch" },
        runSetup: false,
        paseoHome: path.join(tempDir, ".paseo"),
      }),
    ).rejects.toMatchObject({ name: "UnknownBranchError" });
  },
);

test.skipIf(isPlatform("win32"))(
  "rejects with BranchAlreadyCheckedOutError when the kept branch is checked out elsewhere",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");

    execFileSync("git", ["branch", "busy-branch"], { cwd: repoDir, stdio: "pipe" });
    const first = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "busy-branch",
      source: { kind: "checkout-branch", branchName: "busy-branch" },
      runSetup: false,
      paseoHome,
    });
    expect(existsSync(first.worktreePath)).toBe(true);

    await expect(
      createWorktree({
        cwd: repoDir,
        worktreeSlug: "busy-branch-again",
        source: { kind: "checkout-branch", branchName: "busy-branch" },
        runSetup: false,
        paseoHome,
      }),
    ).rejects.toMatchObject({ name: "BranchAlreadyCheckedOutError" });
  },
);

interface TestDeps extends CreatePaseoWorktreeDeps {
  projects: Map<string, PersistedProjectRecord>;
  workspaces: Map<string, PersistedWorkspaceRecord>;
}

function createDeps(options?: {
  events?: string[];
  projects?: Map<string, PersistedProjectRecord>;
  workspaces?: Map<string, PersistedWorkspaceRecord>;
}): TestDeps {
  const events = options?.events ?? [];
  const projects = options?.projects ?? new Map<string, PersistedProjectRecord>();
  const workspaces = options?.workspaces ?? new Map<string, PersistedWorkspaceRecord>();
  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (projectId) => projects.get(projectId) ?? null,
    getOrCreateActiveByRoot: async (input) => {
      const existing = Array.from(projects.values()).find(
        (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, input.rootPath),
      );
      if (existing) return existing;
      const project = createPersistedProjectRecordForTest({
        projectId: `prj_${projects.size.toString().padStart(16, "0")}`,
        rootPath: input.rootPath,
        displayName: input.displayName,
      });
      projects.set(project.projectId, project);
      return project;
    },
    upsert: async (project) => {
      projects.set(project.projectId, project);
    },
    archive: async (projectId, archivedAt) => {
      const project = projects.get(projectId);
      if (project) projects.set(projectId, { ...project, archivedAt });
    },
    remove: async (projectId) => {
      projects.delete(projectId);
    },
  };
  const workspaceRegistry: WorkspaceRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(workspaces.values()),
    get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
    update: async (workspaceId, updater) => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return null;
      const updated = updater(workspace);
      workspaces.set(workspaceId, updated);
      return updated;
    },
    upsert: async (record) => {
      events.push(`workspace:${record.workspaceId}`);
      workspaces.set(record.workspaceId, record);
    },
    archive: async (workspaceId, archivedAt) => {
      const workspace = workspaces.get(workspaceId);
      if (workspace) workspaces.set(workspaceId, { ...workspace, archivedAt });
    },
    remove: async (workspaceId) => {
      workspaces.delete(workspaceId);
    },
  };
  const workspaceGitService = createWorkspaceGitServiceStub();
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger: createTestLogger(),
  });

  return {
    github: createGitHubServiceStub(),
    projects,
    workspaces,
    workspaceGitService,
    workspaceProvisioning,
  };
}

function createPersistedProjectRecordForTest(input: {
  projectId: string;
  rootPath: string;
  displayName: string;
}): PersistedProjectRecord {
  return {
    projectId: input.projectId,
    rootPath: input.rootPath,
    kind: "git",
    displayName: input.displayName,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    archivedAt: null,
  };
}

function createPersistedWorkspaceRecordForTest(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceRecord["kind"];
  displayName: string;
}): PersistedWorkspaceRecord {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    cwd: input.cwd,
    kind: input.kind,
    displayName: input.displayName,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    archivedAt: null,
  };
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    defaultCheckoutRefs: ({ changeRequestNumber }) => [
      { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
    ],
    buildPrLocalBranchName: ({ headRef, checkoutTarget }) => {
      const normalized = checkoutTarget.headOwnerLogin?.trim().toLowerCase() ?? "";
      const owner =
        checkoutTarget.isCrossRepository && /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
      return owner ? `${owner}/${headRef}` : headRef;
    },
    supportsCrossRepoCheckoutWithoutRefs: true,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createWorkspaceGitServiceStub(): WorkspaceGitService {
  return {
    registerWorkspace: () => ({
      unsubscribe: () => {},
    }),
    peekSnapshot: (cwd) => createWorkspaceGitSnapshot(cwd),
    getCheckout: async (cwd) => {
      try {
        const snapshot = createWorkspaceGitSnapshot(cwd);
        return {
          cwd,
          isGit: snapshot.git.isGit,
          currentBranch: snapshot.git.currentBranch,
          remoteUrl: snapshot.git.remoteUrl,
          worktreeRoot: snapshot.git.repoRoot,
          isPaseoOwnedWorktree: snapshot.git.isPaseoOwnedWorktree,
          mainRepoRoot: snapshot.git.mainRepoRoot,
        };
      } catch {
        return {
          cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        };
      }
    },
    getSnapshot: async (cwd) => createWorkspaceGitSnapshot(cwd),
    resolveForge: async () => null,
    resolveRepoRoot: async (cwd) => {
      try {
        return createWorkspaceGitSnapshot(cwd).git.repoRoot ?? cwd;
      } catch {
        throw new Error("Create worktree requires a git repository");
      }
    },
    resolveDefaultBranch: async () => "main",
    refresh: async () => {},
    requestWorkingTreeWatch: async (cwd) => ({
      repoRoot: cwd,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    onWorkspaceStateMayHaveChanged: () => {},
    invalidateForge: () => {},
    dispose: () => {},
  };
}

function createWorkspaceGitSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" })
    .toString()
    .trim();
  const mainRepoRoot = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      stdio: "pipe",
    },
  )
    .toString()
    .trim()
    .replace(/\/\.git$/, "");
  const currentBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

  return {
    cwd,
    git: {
      isGit: true,
      repoRoot,
      mainRepoRoot,
      currentBranch,
      remoteUrl: null,
      isPaseoOwnedWorktree: repoRoot !== mainRepoRoot,
      isDirty: false,
      baseRef: "main",
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    forge: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
    },
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-worktree-service-"));
  const repoDir = path.join(tempDir, "repo");
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

function commitAll(repoDir: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: repoDir, stdio: "pipe" });
}

function createGitHubPrRemoteRepo(): { tempDir: string; repoDir: string } {
  const { tempDir, repoDir } = createGitRepo();
  execFileSync("git", ["checkout", "-b", "pr-123"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "pr branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "pr-branch"], { cwd: repoDir, stdio: "pipe" });
  const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", "pr-123"], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/123/head", prHead], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}
