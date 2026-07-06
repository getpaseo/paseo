import { describe, expect, it } from "vitest";
import type { EmptyProjectDescriptor } from "@/stores/session-store";
import { buildWorkspaceStructureProjects } from "./workspace-structure";

function emptyProject(input: {
  projectId: string;
  remoteKey: string | null;
  projectRootPath: string;
  projectDisplayName?: string;
}): EmptyProjectDescriptor {
  return {
    projectId: input.projectId,
    remoteKey: input.remoteKey,
    projectDisplayName: input.projectDisplayName ?? "acme/app",
    projectCustomName: null,
    projectRootPath: input.projectRootPath,
    projectKind: "git",
  };
}

describe("buildWorkspaceStructureProjects", () => {
  it("keeps two clones of one remote as two distinct projects within a host (#987)", () => {
    // The reported bug: adding a second clone of the same repo failed. Both folders
    // are now distinct projects (keyed by repo-root identity) that share a remote
    // grouping key.
    const projects = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "local",
          workspaces: [],
          emptyProjects: [
            emptyProject({
              projectId: "/home/me/work/app",
              remoteKey: "remote:github.com/acme/app",
              projectRootPath: "/home/me/work/app",
            }),
            emptyProject({
              projectId: "/home/me/scratch/app",
              remoteKey: "remote:github.com/acme/app",
              projectRootPath: "/home/me/scratch/app",
            }),
          ],
        },
      ],
    });

    // Two distinct identities → two sidebar projects, even though they share a remote.
    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.projectKey).sort()).toEqual([
      "/home/me/scratch/app",
      "/home/me/work/app",
    ]);
  });
});
