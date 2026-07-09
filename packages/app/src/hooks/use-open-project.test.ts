import { describe, expect, it } from "vitest";
import {
  getOpenProjectFailureReason,
  openProjectDirectly,
  type OpenProjectDirectlyInput,
} from "@/hooks/open-project";
import type {
  EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
  WorkspaceDescriptor,
} from "@/stores/session-store";
import type { CheckoutStatusResponse, WorkspaceCreateResponse } from "@getpaseo/protocol/messages";

const SERVER_ID = "server-1";
const PROJECT_PATH = "/repo/project";
const WORKTREE_PATH = "/repo-worktrees/feature-a";

type TestClient = NonNullable<OpenProjectDirectlyInput["client"]>;

function buildProjectPayload() {
  return {
    projectId: "project-1",
    projectDisplayName: "project",
    projectRootPath: PROJECT_PATH,
    projectKind: "git" as const,
  };
}

function buildCheckoutStatus(mainRepoRoot: string | null): CheckoutStatusResponse["payload"] {
  return {
    cwd: mainRepoRoot ? WORKTREE_PATH : PROJECT_PATH,
    requestId: "checkout-status",
    error: null,
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: mainRepoRoot ? WORKTREE_PATH : PROJECT_PATH,
    mainRepoRoot,
    currentBranch: mainRepoRoot ? "feature-a" : "main",
    isDirty: false,
    baseRef: null,
    aheadBehind: null,
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
  };
}

function buildWorkspaceCreatePayload(): WorkspaceCreateResponse["payload"] {
  return {
    requestId: "request-worktree",
    error: null,
    setupTerminalId: null,
    workspace: {
      id: "wks_feature_a",
      projectId: "project-1",
      projectDisplayName: "project",
      projectCustomName: null,
      projectRootPath: PROJECT_PATH,
      workspaceDirectory: WORKTREE_PATH,
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature-a",
      title: null,
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
      gitRuntime: null,
      githubRuntime: null,
    },
  };
}

function createClient(overrides: Partial<TestClient> = {}): TestClient {
  return {
    getCheckoutStatus: async () => buildCheckoutStatus(null),
    createWorkspace: async () => {
      throw new Error("createWorkspace should not be called");
    },
    addProject: async () => ({
      requestId: "request-1",
      error: null,
      project: buildProjectPayload(),
    }),
    ...overrides,
  };
}

interface RecordedProject {
  serverId: string;
  project: ProjectWithoutWorkspacesDescriptor;
}

interface RecordedWorkspace {
  serverId: string;
  workspaces: WorkspaceDescriptor[];
}

interface RecordedHydrated {
  serverId: string;
  hydrated: boolean;
}

function createFakeSession() {
  const projects: RecordedProject[] = [];
  const workspaces: RecordedWorkspace[] = [];
  const hydrated: RecordedHydrated[] = [];
  return {
    projects,
    workspaces,
    hydrated,
    addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => {
      projects.push({ serverId, project });
    },
    mergeWorkspaces: (serverId: string, nextWorkspaces: WorkspaceDescriptor[]) => {
      workspaces.push({ serverId, workspaces: nextWorkspaces });
    },
    setHasHydratedWorkspaces: (serverId: string, value: boolean) => {
      hydrated.push({ serverId, hydrated: value });
    },
  };
}

describe("openProjectDirectly", () => {
  it("adds the project and marks workspaces hydrated without opening a workspace", async () => {
    const session = createFakeSession();
    const projectPayload = buildProjectPayload();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: createClient({
        addProject: async () => ({
          requestId: "request-1",
          error: null,
          project: projectPayload,
        }),
      }),
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, workspaceId: null });
    expect(session.projects).toEqual([
      {
        serverId: SERVER_ID,
        project: {
          projectId: "project-1",
          projectDisplayName: "project",
          projectCustomName: null,
          projectKind: "git",
          projectRootPath: PROJECT_PATH,
        },
      },
    ]);
    expect(session.workspaces).toEqual([]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("opens an existing git worktree as a workspace instead of adding the project again", async () => {
    const session = createFakeSession();
    let addProjectCalled = false;

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: WORKTREE_PATH,
      isConnected: true,
      canAddProject: true,
      client: createClient({
        getCheckoutStatus: async () => buildCheckoutStatus(PROJECT_PATH),
        createWorkspace: async () => buildWorkspaceCreatePayload(),
        addProject: async () => {
          addProjectCalled = true;
          return {
            requestId: "request-unexpected",
            error: null,
            project: buildProjectPayload(),
          };
        },
      }),
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, workspaceId: "wks_feature_a" });
    expect(addProjectCalled).toBe(false);
    expect(session.projects).toEqual([]);
    expect(session.workspaces).toEqual([
      {
        serverId: SERVER_ID,
        workspaces: [
          expect.objectContaining({
            id: "wks_feature_a",
            workspaceDirectory: WORKTREE_PATH,
            workspaceKind: "worktree",
          }),
        ],
      },
    ]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("fails before sending when the host does not support adding projects without workspaces", async () => {
    const session = createFakeSession();
    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: false,
      client: createClient({
        getCheckoutStatus: async () => {
          throw new Error("getCheckoutStatus should not be called");
        },
        addProject: async () => ({
          requestId: "request-unsupported",
          error: null,
          project: buildProjectPayload(),
        }),
      }),
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });

  it("does not add a project when addProject fails", async () => {
    const session = createFakeSession();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: createClient({
        addProject: async () => ({
          requestId: "request-2",
          error: "Directory not found: /repo/project",
          errorCode: "directory_not_found" as const,
          project: null,
        }),
      }),
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "directory_not_found",
      error: "Directory not found: /repo/project",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });
});

describe("getOpenProjectFailureReason", () => {
  it("keeps the known directory-not-found failure reason", () => {
    expect(
      getOpenProjectFailureReason({
        ok: false,
        errorCode: "directory_not_found",
        error: "Directory not found: /missing",
      }),
    ).toBe("directory_not_found");
  });

  it("uses the generic failure reason for untyped project-open failures", () => {
    expect(getOpenProjectFailureReason({ ok: false, errorCode: null, error: "boom" })).toBe(
      "open_failed",
    );
  });
});
