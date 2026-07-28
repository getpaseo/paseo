import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceStructureProjects } from "./workspace-structure";

function workspace(input: {
  id: string;
  projectName: string;
  projectCustomName: string | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: `project-${input.id}`,
    projectGroupKey: "remote:github.com/acme/app",
    projectDisplayName: input.projectName,
    projectCustomName: input.projectCustomName,
    projectRootPath: `/repo/${input.id}`,
    workspaceDirectory: `/repo/${input.id}`,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("buildWorkspaceStructureProjects", () => {
  it("promotes a later grouped host's custom project name", () => {
    const projects = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "host-a",
          workspaces: [workspace({ id: "a", projectName: "acme/app", projectCustomName: null })],
        },
        {
          serverId: "host-b",
          workspaces: [
            workspace({ id: "b", projectName: "acme/app", projectCustomName: "My App" }),
          ],
        },
      ],
    });

    expect(projects).toEqual([
      expect.objectContaining({
        projectKey: "remote:github.com/acme/app",
        projectName: "My App",
      }),
    ]);
  });
});
