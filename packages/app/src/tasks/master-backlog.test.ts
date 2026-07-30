import { describe, expect, it } from "vitest";
import type { TaskCard } from "@getpaseo/protocol/tasks/types";
import type { ProjectSummary } from "@/utils/projects";
import {
  annotateMasterBacklogTasks,
  buildMasterBacklogProjectTargets,
  sortMasterBacklogTasks,
} from "./master-backlog";

describe("master backlog helpers", () => {
  it("builds one create target per online supported project host", () => {
    const targets = buildMasterBacklogProjectTargets({
      projects: [
        projectSummary({
          projectKey: "project-a",
          projectName: "Project A",
          hosts: [
            { serverId: "host-a", serverName: "Alpha", isOnline: true, repoRoot: "/repo/a" },
            { serverId: "host-b", serverName: "Beta", isOnline: false, repoRoot: "/repo/a" },
            { serverId: "host-c", serverName: "Gamma", isOnline: true, repoRoot: "" },
          ],
        }),
      ],
      supportsBacklogByServerId: new Map([
        ["host-a", true],
        ["host-b", true],
        ["host-c", true],
      ]),
    });

    expect(targets).toEqual([
      {
        optionId: "backlog-project:host-a:project-a",
        serverId: "host-a",
        serverName: "Alpha",
        projectId: "project-a",
        projectName: "Project A",
        repoRoot: "/repo/a",
      },
    ]);
  });

  it("annotates host tasks with project metadata and stable task keys", () => {
    const annotated = annotateMasterBacklogTasks({
      projects: [
        projectSummary({
          projectKey: "project-a",
          projectName: "Project A",
          hosts: [{ serverId: "host-a", serverName: "Alpha", isOnline: true, repoRoot: "/repo/a" }],
        }),
      ],
      hostTasks: [
        {
          serverId: "host-a",
          serverName: "Alpha",
          tasks: [task({ id: "task-1", projectId: "project-a", title: "First" })],
        },
      ],
    });

    expect(annotated).toMatchObject([
      {
        id: "task-1",
        taskKey: "host-a:project-a:task-1",
        serverId: "host-a",
        serverName: "Alpha",
        projectName: "Project A",
        projectRootPath: "/repo/a",
      },
    ]);
  });

  it("sorts active tasks first, then newest updated time", () => {
    const sorted = sortMasterBacklogTasks([
      masterTask({ id: "completed-new", status: "completed", updatedAt: "2026-07-07T10:00:00Z" }),
      masterTask({ id: "active-old", status: "active", updatedAt: "2026-07-07T08:00:00Z" }),
      masterTask({ id: "active-new", status: "active", updatedAt: "2026-07-07T09:00:00Z" }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["active-new", "active-old", "completed-new"]);
  });
});

function projectSummary(input: {
  projectKey: string;
  projectName: string;
  hosts: Array<{
    serverId: string;
    serverName: string;
    isOnline: boolean;
    repoRoot: string;
  }>;
}): ProjectSummary {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName,
    projectCustomName: null,
    hosts: input.hosts.map((host) => ({
      ...host,
      projectId: input.projectKey,
      projectName: input.projectName,
      projectCustomName: null,
      workspaceCount: 1,
      workspaces: [],
    })),
    totalWorkspaceCount: input.hosts.length,
    hostCount: input.hosts.length,
    onlineHostCount: input.hosts.filter((host) => host.isOnline).length,
  };
}

function task(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "task",
    projectId: "project",
    title: "Task",
    description: "",
    status: "active",
    attachments: [],
    createdAt: "2026-07-07T00:00:00Z",
    updatedAt: "2026-07-07T00:00:00Z",
    completedAt: null,
    order: 0,
    ...overrides,
  };
}

function masterTask(overrides: Partial<ReturnType<typeof sortMasterBacklogTasks>[number]> = {}) {
  const base = task(overrides);
  return {
    ...base,
    taskKey: `host:${base.projectId}:${base.id}`,
    serverId: "host",
    serverName: "Host",
    projectName: "Project",
    projectRootPath: "/repo/project",
    ...overrides,
  };
}
