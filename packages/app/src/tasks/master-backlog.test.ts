import { describe, expect, it } from "vitest";
import type { TaskCard } from "@getpaseo/protocol/tasks/types";
import type { ProjectSummary } from "@/utils/projects";
import {
  annotateMasterBacklogTasks,
  buildMasterBacklogProjectFilterOptions,
  buildMasterBacklogProjectTargets,
  filterBacklogTasksByQuery,
  filterMasterBacklogTasksByProject,
  sortMasterBacklogTasks,
} from "./master-backlog";

describe("master backlog helpers", () => {
  it("builds one create target per online supported project host", () => {
    const targets = buildMasterBacklogProjectTargets({
      projects: [
        projectSummary({
          viewKey: "project-a",
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
          viewKey: "project-a",
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

  it("builds distinct project filter options and disambiguates duplicate names", () => {
    const options = buildMasterBacklogProjectFilterOptions([
      masterTask({
        id: "1",
        projectId: "app",
        projectName: "App",
        serverName: "Alpha",
      }),
      masterTask({
        id: "2",
        projectId: "app",
        projectName: "App",
        serverName: "Alpha",
      }),
      masterTask({
        id: "3",
        projectId: "app-b",
        projectName: "App",
        serverName: "Beta",
      }),
      masterTask({
        id: "4",
        projectId: "auth",
        projectName: "Auth",
        serverName: "Alpha",
      }),
    ]);

    expect(options).toEqual([
      { id: "app", label: "App · Alpha" },
      { id: "app-b", label: "App · Beta" },
      { id: "auth", label: "Auth" },
    ]);
  });

  it("filters master backlog tasks by selected project before search", () => {
    const tasks = [
      masterTask({ id: "1", projectId: "app", title: "Ship search", projectName: "App" }),
      masterTask({ id: "2", projectId: "auth", title: "Ship search", projectName: "Auth" }),
      masterTask({ id: "3", projectId: "app", title: "Fix login", projectName: "App" }),
    ];
    const projectFiltered = filterMasterBacklogTasksByProject(tasks, "app");
    expect(projectFiltered.map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(filterBacklogTasksByQuery(projectFiltered, "search").map((entry) => entry.id)).toEqual([
      "1",
    ]);
    expect(filterMasterBacklogTasksByProject(tasks, "all").map((entry) => entry.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(filterMasterBacklogTasksByProject(tasks, null).map((entry) => entry.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("filters backlog tasks by title description and project context", () => {
    const tasks = [
      masterTask({
        id: "1",
        title: "Ship search",
        description: "Add query box",
        projectName: "App",
      }),
      masterTask({
        id: "2",
        title: "Fix login",
        description: "Token refresh",
        projectName: "Auth",
        serverName: "Office",
      }),
    ];
    expect(filterBacklogTasksByQuery(tasks, "search").map((entry) => entry.id)).toEqual(["1"]);
    expect(filterBacklogTasksByQuery(tasks, "token").map((entry) => entry.id)).toEqual(["2"]);
    expect(filterBacklogTasksByQuery(tasks, "office").map((entry) => entry.id)).toEqual(["2"]);
    expect(filterBacklogTasksByQuery(tasks, "   ").map((entry) => entry.id)).toEqual(["1", "2"]);
  });
});

function projectSummary(input: {
  viewKey: string;
  projectName: string;
  hosts: Array<{
    serverId: string;
    serverName: string;
    isOnline: boolean;
    repoRoot: string;
  }>;
}): ProjectSummary {
  return {
    viewKey: input.viewKey,
    projectName: input.projectName,
    projectCustomName: null,
    hosts: input.hosts.map((host) => ({
      ...host,
      projectId: input.viewKey,
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
