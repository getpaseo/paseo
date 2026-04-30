import { describe, expect, it } from "vitest";
import type { ProjectPlacementPayload } from "@server/shared/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildProjects } from "./projects";

function placement(input: {
  projectKey: string;
  projectName: string;
  cwd: string;
  remoteUrl: string | null;
  mainRepoRoot?: string | null;
}): ProjectPlacementPayload {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName,
    checkout: {
      cwd: input.cwd,
      isGit: true,
      currentBranch: "main",
      remoteUrl: input.remoteUrl,
      worktreeRoot: input.cwd,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: input.mainRepoRoot ?? null,
    },
  };
}

function workspace(input: {
  id: string;
  repoRoot: string;
  project?: ProjectPlacementPayload;
  projectId?: string;
  projectName?: string;
  remoteUrl?: string | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? input.project?.projectKey ?? input.repoRoot,
    projectDisplayName: input.projectName ?? input.project?.projectName ?? "Project",
    projectRootPath: input.repoRoot,
    workspaceDirectory: input.repoRoot,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.id,
    status: "done",
    archivingAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: {
      currentBranch: "main",
      remoteUrl: input.remoteUrl ?? input.project?.checkout.remoteUrl ?? null,
      isPaseoOwnedWorktree: false,
      isDirty: false,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
    },
    githubRuntime: null,
    project: input.project,
  };
}

describe("buildProjects", () => {
  it("groups two daemons with the same GitHub project key into one project with one host entry per daemon", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "main",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
            workspace({
              id: "feature-a",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app/feature-a",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
            workspace({
              id: "feature-b",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app/feature-b",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
          ],
        },
        {
          serverId: "laptop",
          serverName: "Laptop",
          isOnline: true,
          workspaces: [
            workspace({
              id: "main",
              repoRoot: "/work/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/work/app",
                remoteUrl: "git@github.com:acme/app.git",
              }),
            }),
            workspace({
              id: "feature",
              repoRoot: "/work/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/work/app/feature",
                remoteUrl: "git@github.com:acme/app.git",
              }),
            }),
          ],
        },
      ],
    });

    expect(result.projects).toHaveLength(1);
    const summary = result.projects[0];
    expect(summary?.projectKey).toBe("remote:github.com/acme/app");
    expect(summary?.projectName).toBe("acme/app");
    expect(summary?.hostCount).toBe(2);
    expect(summary?.onlineHostCount).toBe(2);
    expect(summary?.totalWorkspaceCount).toBe(5);
    expect(summary?.githubUrl).toBe("https://github.com/acme/app");
    expect(summary?.hosts).toHaveLength(2);
    const local = summary?.hosts.find((host) => host.serverId === "local");
    const laptop = summary?.hosts.find((host) => host.serverId === "laptop");
    expect(local?.workspaceCount).toBe(3);
    expect(laptop?.workspaceCount).toBe(2);
    expect(local?.workspaces.map((entry) => entry.id)).toEqual(["main", "feature-a", "feature-b"]);
    expect(laptop?.workspaces.map((entry) => entry.id)).toEqual(["main", "feature"]);
  });

  it("collapses five workspaces on one host into a single host entry whose workspaceCount is five", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: Array.from({ length: 5 }, (_, index) =>
            workspace({
              id: `ws-${index}`,
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: `/repo/app/ws-${index}`,
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
          ),
        },
      ],
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.hosts).toHaveLength(1);
    expect(result.projects[0]?.hosts[0]?.workspaceCount).toBe(5);
    expect(result.projects[0]?.totalWorkspaceCount).toBe(5);
    expect(result.projects[0]?.hostCount).toBe(1);
  });

  it("prefers placement mainRepoRoot for the host repoRoot and falls back to projectRootPath when placement is absent", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "main",
              repoRoot: "/worktrees/app/main",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/worktrees/app/main",
                remoteUrl: "https://github.com/acme/app.git",
                mainRepoRoot: "/repo/app",
              }),
            }),
          ],
        },
        {
          serverId: "legacy",
          serverName: "Legacy",
          isOnline: true,
          workspaces: [
            workspace({
              id: "legacy",
              repoRoot: "/repo/legacy",
              projectId: "legacy-project",
              projectName: "Legacy",
            }),
          ],
        },
      ],
    });

    const acme = result.projects.find(
      (project) => project.projectKey === "remote:github.com/acme/app",
    );
    const legacy = result.projects.find((project) => project.projectKey === "legacy-project");

    expect(acme?.hosts[0]?.repoRoot).toBe("/repo/app");
    expect(legacy?.hosts[0]?.repoRoot).toBe("/repo/legacy");
  });

  it("derives githubUrl only when projectKey matches remote:github.com/{owner}/{repo}", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "github",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
            workspace({
              id: "local",
              repoRoot: "/repo/local",
              project: placement({
                projectKey: "/repo/local",
                projectName: "local",
                cwd: "/repo/local",
                remoteUrl: null,
              }),
            }),
          ],
        },
      ],
    });

    const github = result.projects.find(
      (project) => project.projectKey === "remote:github.com/acme/app",
    );
    const local = result.projects.find((project) => project.projectKey === "/repo/local");

    expect(github?.githubUrl).toBe("https://github.com/acme/app");
    expect(local?.githubUrl).toBeUndefined();
  });

  it("totals hostCount across all hosts and counts only online ones in onlineHostCount", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "online",
          serverName: "Online",
          isOnline: true,
          workspaces: [
            workspace({
              id: "ws",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
          ],
        },
        {
          serverId: "offline",
          serverName: "Offline",
          isOnline: false,
          workspaces: [
            workspace({
              id: "ws",
              repoRoot: "/repo/app",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/app",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
          ],
        },
      ],
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.hostCount).toBe(2);
    expect(result.projects[0]?.onlineHostCount).toBe(1);
    expect(result.projects[0]?.hosts.find((host) => host.serverId === "online")?.isOnline).toBe(
      true,
    );
    expect(result.projects[0]?.hosts.find((host) => host.serverId === "offline")?.isOnline).toBe(
      false,
    );
  });

  it("does not merge fallback repo-root-keyed projects with different roots", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "one",
              repoRoot: "/repo/one",
              project: placement({
                projectKey: "/repo/one",
                projectName: "one",
                cwd: "/repo/one",
                remoteUrl: null,
              }),
            }),
            workspace({
              id: "two",
              repoRoot: "/repo/two",
              project: placement({
                projectKey: "/repo/two",
                projectName: "two",
                cwd: "/repo/two",
                remoteUrl: null,
              }),
            }),
          ],
        },
      ],
    });

    expect(result.projects.map((project) => project.projectKey)).toEqual([
      "/repo/one",
      "/repo/two",
    ]);
  });

  it("filters non-GitHub remote projects while keeping GitHub and local projects", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "github",
              repoRoot: "/repo/github",
              project: placement({
                projectKey: "remote:github.com/acme/app",
                projectName: "acme/app",
                cwd: "/repo/github",
                remoteUrl: "https://github.com/acme/app.git",
              }),
            }),
            workspace({
              id: "gitlab",
              repoRoot: "/repo/gitlab",
              project: placement({
                projectKey: "remote:gitlab.com/acme/app",
                projectName: "app",
                cwd: "/repo/gitlab",
                remoteUrl: "https://gitlab.com/acme/app.git",
              }),
            }),
            workspace({
              id: "local",
              repoRoot: "/repo/local",
              project: placement({
                projectKey: "/repo/local",
                projectName: "local",
                cwd: "/repo/local",
                remoteUrl: null,
              }),
            }),
          ],
        },
      ],
    });

    expect(result.hiddenUnsupportedRemoteCount).toBe(1);
    expect(result.projects.map((project) => project.projectKey)).toEqual([
      "remote:github.com/acme/app",
      "/repo/local",
    ]);
  });

  it("produces the unsupported empty-state signal when only non-GitHub remote projects are present", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "local",
          serverName: "Local",
          isOnline: true,
          workspaces: [
            workspace({
              id: "gitlab",
              repoRoot: "/repo/gitlab",
              project: placement({
                projectKey: "remote:gitlab.com/acme/app",
                projectName: "app",
                cwd: "/repo/gitlab",
                remoteUrl: "https://gitlab.com/acme/app.git",
              }),
            }),
          ],
        },
      ],
    });

    expect(result.projects).toEqual([]);
    expect(result.hiddenUnsupportedRemoteCount).toBe(1);
  });

  it("falls back conservatively for mixed-version daemons whose descriptors lack project", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "old-daemon",
          serverName: "Old daemon",
          isOnline: true,
          workspaces: [
            workspace({
              id: "legacy",
              repoRoot: "/repo/legacy",
              projectId: "legacy-project",
              projectName: "Legacy",
              remoteUrl: "https://gitlab.com/acme/legacy.git",
            }),
          ],
        },
      ],
    });

    expect(result.projects).toHaveLength(1);
    const summary = result.projects[0];
    expect(summary?.projectKey).toBe("legacy-project");
    expect(summary?.projectName).toBe("Legacy");
    expect(summary?.githubUrl).toBeUndefined();
    expect(summary?.hosts).toHaveLength(1);
    expect(summary?.hosts[0]?.repoRoot).toBe("/repo/legacy");
    expect(summary?.hosts[0]?.workspaceCount).toBe(1);
    expect(result.hiddenUnsupportedRemoteCount).toBe(0);
  });
});
