import { describe, expect, it } from "vitest";
import type { EmptyProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  deriveProjectsFromReplica,
  type ProjectHostReplica,
  type ProjectHostRuntimeState,
} from "@/hooks/use-projects";

function runtimeState(input: {
  serverId: string;
  isOnline: boolean;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: string | null;
}): ProjectHostRuntimeState {
  return {
    serverId: input.serverId,
    isOnline: input.isOnline,
    isLoading: input.isLoading ?? false,
    isFetching: input.isFetching ?? false,
    error: input.error ?? null,
  };
}

function workspace(input: {
  id: string;
  projectKey: string;
  projectName: string;
  cwd: string;
  remoteUrl: string | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectKey,
    projectDisplayName: input.projectName,
    projectCustomName: null,
    projectRootPath: input.cwd,
    workspaceDirectory: input.cwd,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.id,
    title: null,
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: {
      currentBranch: "main",
      remoteUrl: input.remoteUrl,
      isPaseoOwnedWorktree: false,
      isDirty: false,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
    },
    githubRuntime: null,
    project: {
      projectKey: input.projectKey,
      projectName: input.projectName,
      checkout: {
        cwd: input.cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: input.remoteUrl,
        worktreeRoot: input.cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function emptyProject(input: {
  projectKey: string;
  projectName: string;
  cwd: string;
}): EmptyProjectDescriptor {
  return {
    projectId: input.projectKey,
    projectDisplayName: input.projectName,
    projectCustomName: null,
    projectRootPath: input.cwd,
    projectKind: "git",
  };
}

describe("deriveProjectsFromReplica", () => {
  it("aggregates store workspaces and empty projects sorted by display name", () => {
    const replicas: ProjectHostReplica[] = [
      {
        serverId: "local",
        serverName: "Local",
        workspaces: [
          workspace({
            id: "z-main",
            projectKey: "remote:github.com/acme/zeta",
            projectName: "acme/zeta",
            cwd: "/repo/zeta",
            remoteUrl: "https://github.com/acme/zeta.git",
          }),
        ],
        emptyProjects: [],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        workspaces: [],
        emptyProjects: [
          emptyProject({
            projectKey: "remote:github.com/acme/alpha",
            projectName: "acme/alpha",
            cwd: "/repo/alpha",
          }),
        ],
      },
    ];

    const result = deriveProjectsFromReplica({
      replicas,
      runtimeStates: [
        runtimeState({ serverId: "local", isOnline: true }),
        runtimeState({ serverId: "laptop", isOnline: false }),
      ],
    });

    expect(result.projects.map((project) => project.projectName)).toEqual([
      "acme/alpha",
      "acme/zeta",
    ]);
    expect(result.projects[0]?.hosts).toEqual([
      expect.objectContaining({
        serverId: "laptop",
        isOnline: false,
        repoRoot: "/repo/alpha",
        workspaceCount: 0,
      }),
    ]);
    expect(result.hostErrors).toEqual([]);
  });

  it("maps runtime directory status into loading and host errors", () => {
    const replicas: ProjectHostReplica[] = [
      {
        serverId: "local",
        serverName: "Local",
        workspaces: [
          workspace({
            id: "main",
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            cwd: "/repo/app",
            remoteUrl: "https://github.com/acme/app.git",
          }),
        ],
        emptyProjects: [],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        workspaces: [],
        emptyProjects: [],
      },
    ];

    const result = deriveProjectsFromReplica({
      replicas,
      runtimeStates: [
        runtimeState({ serverId: "local", isOnline: true, isFetching: true }),
        runtimeState({
          serverId: "laptop",
          isOnline: true,
          isLoading: true,
          error: "laptop unavailable",
        }),
      ],
    });

    expect(result.projects).toEqual([
      expect.objectContaining({ projectKey: "remote:github.com/acme/app" }),
    ]);
    expect(result.hostErrors).toEqual([
      {
        serverId: "laptop",
        serverName: "Laptop",
        message: "laptop unavailable",
      },
    ]);
    expect(result.isLoading).toBe(true);
    expect(result.isFetching).toBe(true);
  });

  it("returns only the stable public project and host entry shapes", () => {
    const result = deriveProjectsFromReplica({
      replicas: [
        {
          serverId: "local",
          serverName: "Local",
          workspaces: [
            workspace({
              id: "main",
              projectKey: "remote:github.com/acme/app",
              projectName: "acme/app",
              cwd: "/repo/app",
              remoteUrl: "https://github.com/acme/app.git",
            }),
          ],
          emptyProjects: [],
        },
      ],
      runtimeStates: [runtimeState({ serverId: "local", isOnline: true })],
    });

    expect(Object.keys(result.projects[0] ?? {}).sort()).toEqual([
      "githubUrl",
      "hostCount",
      "hosts",
      "onlineHostCount",
      "projectCustomName",
      "projectKey",
      "projectName",
      "totalWorkspaceCount",
    ]);
    expect(Object.keys(result.projects[0]?.hosts[0] ?? {}).sort()).toEqual([
      "gitRuntime",
      "githubRuntime",
      "isOnline",
      "repoRoot",
      "serverId",
      "serverName",
      "workspaceCount",
      "workspaces",
    ]);
    expect(Object.keys(result.projects[0]?.hosts[0]?.workspaces[0] ?? {}).sort()).toEqual([
      "currentBranch",
      "id",
      "name",
      "status",
      "workspaceKind",
    ]);
  });
});
