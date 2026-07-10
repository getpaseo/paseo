import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/utils/projects";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
  describeScheduleCwd,
} from "./schedule-project-targets";

function makeProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    projectKey: "proj",
    projectName: "Project",
    hosts: [],
    totalWorkspaceCount: 0,
    hostCount: 0,
    onlineHostCount: 0,
    ...overrides,
  };
}

function makeHost(overrides: Partial<ProjectSummary["hosts"][number]>) {
  return {
    serverId: "host-1",
    serverName: "Host 1",
    isOnline: true,
    repoRoot: "/tmp/project",
    workspaceCount: 0,
    workspaces: [],
    ...overrides,
  };
}

describe("buildScheduleProjectTargets", () => {
  it("emits one target per online host with a repo root", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        projectName: "Alpha",
        hosts: [makeHost({ repoRoot: "/tmp/alpha" }), makeHost({ serverId: "host-2" })],
      }),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      serverId: "host-1",
      cwd: "/tmp/alpha",
      projectName: "Alpha",
    });
  });

  it("skips offline hosts and blank repo roots", () => {
    const targets = buildScheduleProjectTargets([
      makeProject({
        hosts: [makeHost({ isOnline: false }), makeHost({ serverId: "host-3", repoRoot: "   " })],
      }),
    ]);
    expect(targets).toHaveLength(0);
  });
});

describe("describeScheduleCwd", () => {
  it("prefers a matched project name and shortens unmatched paths", () => {
    const byCwd = buildProjectNameByCwd(
      buildScheduleProjectTargets([
        makeProject({ projectName: "Alpha", hosts: [makeHost({ repoRoot: "/tmp/alpha" })] }),
      ]),
    );
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/tmp/alpha", projectNameByCwd: byCwd }),
    ).toBe("Alpha");
    expect(
      describeScheduleCwd({ serverId: "host-1", cwd: "/Users/sam/api", projectNameByCwd: byCwd }),
    ).toBe("~/api");
  });
});
