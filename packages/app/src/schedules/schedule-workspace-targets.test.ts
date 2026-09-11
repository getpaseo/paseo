import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import { buildProjectOptionId } from "./schedule-project-targets";
import { buildScheduleWorkspaceTargets } from "./schedule-workspace-targets";

function projectWithWorkspaces(
  workspaces: ProjectSummary["hosts"][number]["workspaces"],
  isOnline = true,
): ProjectSummary {
  return {
    viewKey: "project-a",
    projectName: "Project A",
    hosts: [
      {
        serverId: "host-a",
        projectId: "project-a",
        projectName: "Project A",
        projectCustomName: null,
        serverName: "Host A",
        isOnline,
        repoRoot: "/repo/a",
        workspaceCount: workspaces.length,
        workspaces,
      },
    ],
    totalWorkspaceCount: workspaces.length,
    hostCount: 1,
    onlineHostCount: isOnline ? 1 : 0,
  };
}

function workspace(
  overrides: Partial<ProjectSummary["hosts"][number]["workspaces"][number]> = {},
): ProjectSummary["hosts"][number]["workspaces"][number] {
  return {
    id: "wks_a",
    name: "main",
    workspaceDirectory: "/repo/a",
    workspaceKind: "local_checkout",
    status: "done",
    currentBranch: "main",
    changeRequestNumber: null,
    ...overrides,
  };
}

describe("buildScheduleWorkspaceTargets", () => {
  it("maps active online workspaces to their schedule project", () => {
    expect(
      buildScheduleWorkspaceTargets([
        projectWithWorkspaces([
          workspace({ title: "Daily status", workspaceDirectory: "/repo/daily" }),
        ]),
      ]),
    ).toEqual([
      {
        workspaceId: "wks_a",
        serverId: "host-a",
        projectOptionId: buildProjectOptionId("host-a", "project-a"),
        workspaceName: "Daily status",
        cwd: "/repo/daily",
      },
    ]);
  });

  it("skips offline, archiving, and pathless workspaces", () => {
    expect(
      buildScheduleWorkspaceTargets([
        projectWithWorkspaces([workspace()], false),
        projectWithWorkspaces([workspace({ archivingAt: "2026-01-01T00:00:00.000Z" })]),
        projectWithWorkspaces([workspace({ workspaceDirectory: "" })]),
      ]),
    ).toEqual([]);
  });
});
