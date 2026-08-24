import { describe, expect, it } from "vitest";
import type { ProjectDescriptor } from "@/stores/session-store";
import {
  deriveProjectsFromReplica,
  type ProjectHostReplica,
  type ProjectHostRuntimeState,
} from "@/hooks/use-projects";

function project(id: string, name: string, root: string): ProjectDescriptor {
  return {
    projectId: id,
    projectKey: `remote:github.com/${name}`,
    projectDisplayName: name,
    projectCustomName: null,
    projectRootPath: root,
    projectKind: "git",
  };
}

function runtimeState(input: Partial<ProjectHostRuntimeState> & { serverId: string }) {
  return {
    serverId: input.serverId,
    isOnline: input.isOnline ?? true,
    isLoading: input.isLoading ?? false,
    isFetching: input.isFetching ?? false,
    error: input.error ?? null,
  };
}

describe("deriveProjectsFromReplica", () => {
  it("derives projects from the project descriptor replica", () => {
    const replicas: ProjectHostReplica[] = [
      {
        serverId: "local",
        serverName: "Local",
        workspaces: [],
        projects: [project("prj_zeta", "acme/zeta", "/repo/zeta")],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        workspaces: [],
        projects: [project("prj_alpha", "acme/alpha", "/repo/alpha")],
      },
    ];

    const result = deriveProjectsFromReplica({
      replicas,
      runtimeStates: [
        runtimeState({ serverId: "local" }),
        runtimeState({ serverId: "laptop", isOnline: false }),
      ],
    });

    expect(result.projects.map((item) => item.projectName)).toEqual(["acme/alpha", "acme/zeta"]);
    expect(result.projects[0]?.hosts[0]).toMatchObject({
      serverId: "laptop",
      projectId: "prj_alpha",
      repoRoot: "/repo/alpha",
      workspaceCount: 0,
    });
  });

  it("preserves runtime loading and error state", () => {
    const result = deriveProjectsFromReplica({
      replicas: [
        {
          serverId: "local",
          serverName: "Local",
          workspaces: [],
          projects: [project("prj_app", "acme/app", "/repo/app")],
        },
      ],
      runtimeStates: [
        runtimeState({
          serverId: "local",
          isLoading: true,
          isFetching: true,
          error: "unavailable",
        }),
      ],
    });

    expect(result.isLoading).toBe(true);
    expect(result.isFetching).toBe(true);
    expect(result.hostErrors).toEqual([
      { serverId: "local", serverName: "Local", message: "unavailable" },
    ]);
  });
});
