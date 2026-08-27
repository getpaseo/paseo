import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import { toPluginProjectSnapshots } from "./project-catalog";

describe("toPluginProjectSnapshots", () => {
  it("preserves cross-host project placement and freezes the plugin snapshot", () => {
    const source: ProjectSummary[] = [
      {
        viewKey: "remote:github.com/acme/app",
        projectName: "acme/app",
        hosts: [
          {
            serverId: "host-a",
            projectId: "project-a",
            projectName: "acme/app",
            projectCustomName: null,
            projectKind: "git",
            serverName: "Laptop",
            isOnline: true,
            repoRoot: "/code/app",
            workspaceCount: 0,
            workspaces: [],
          },
        ],
        totalWorkspaceCount: 0,
        hostCount: 1,
        onlineHostCount: 1,
      },
    ];

    const result = toPluginProjectSnapshots(source);

    expect(result).toEqual([
      {
        projectKey: "remote:github.com/acme/app",
        projectName: "acme/app",
        placements: [
          {
            serverId: "host-a",
            serverName: "Laptop",
            projectId: "project-a",
            projectName: "acme/app",
            projectRootPath: "/code/app",
            projectKind: "git",
            isOnline: true,
          },
        ],
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.placements)).toBe(true);
    expect(Object.isFrozen(result[0]?.placements[0])).toBe(true);
  });
});
