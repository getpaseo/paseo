import { describe, expect, it } from "vitest";
import {
  createSidebarSessionWorkspaceLookup,
  deriveGroupedSidebarSessions,
  deriveSidebarSessionFilterAvailability,
  deriveSidebarSessionFilterProjects,
  shouldIncludeSidebarSessionAgent,
} from "./session-filtering";
import type { SidebarSessionAgent, SidebarSessionWorkspace } from "./types";

import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

type ProjectKind = WorkspaceDescriptor["projectKind"];

const WORKSPACES: SidebarSessionWorkspace[] = [
  {
    serverId: "server-1",
    workspaceId: "workspace-1",
    workspaceKey: "server-1:workspace-1",
    workspaceName: "Main",
    projectKey: "project-a",
    projectName: "Project A",
    projectIconKey: "/repo/main",
    workspaceDirectory: "/repo/main",
  },
  {
    serverId: "server-1",
    workspaceId: "workspace-2",
    workspaceKey: "server-1:workspace-2",
    workspaceName: "Docs",
    projectKey: "project-b",
    projectName: "Project B",
    projectIconKey: "/repo/docs",
    workspaceDirectory: "/repo/docs",
  },
  {
    serverId: "server-1",
    workspaceId: "workspace-3",
    workspaceKey: "server-1:workspace-3",
    workspaceName: "API",
    projectKey: "project-a",
    projectName: "Project A",
    projectIconKey: "/repo/main",
    workspaceDirectory: "/repo/api",
  },
];

const AGENTS: SidebarSessionAgent[] = [
  { id: "main", serverId: "server-1", cwd: "/repo/main/", archivedAt: null },
  { id: "docs", serverId: "server-1", cwd: "/repo/docs", archivedAt: null },
  { id: "api", serverId: "server-1", cwd: "/repo/api", archivedAt: null },
  { id: "unmapped", serverId: "server-1", cwd: "/repo/missing", archivedAt: null },
  { id: "other-server", serverId: "server-2", cwd: "/repo/main", archivedAt: null },
  {
    id: "archived",
    serverId: "server-1",
    cwd: "/repo/main",
    archivedAt: new Date("2026-05-08T10:00:00.000Z"),
  },
];

function projectWorkspaceKeys(project: {
  projectKey: string;
  workspaces: { workspaceKey: string }[];
}) {
  return {
    projectKey: project.projectKey,
    workspaceKeys: project.workspaces.map((workspace) => workspace.workspaceKey),
  };
}

function testProject(
  key: string,
  options: { name?: string; projectKind?: ProjectKind; workspaceCount?: number } = {},
): SidebarProjectEntry {
  const projectKind: ProjectKind = options.projectKind ?? "git";
  const workspaceCount = options.workspaceCount ?? (projectKind === "git" ? 2 : 1);
  return {
    projectKey: key,
    projectName: options.name ?? key,
    projectKind,
    iconWorkingDir: `/repo/${key}`,
    workspaces: Array.from({ length: workspaceCount }, (_, index) => ({
      workspaceKey: `server-1:${key}-${index}`,
      serverId: "server-1",
      workspaceId: `${key}-${index}`,
      projectKey: key,
      projectRootPath: `/repo/${key}`,
      workspaceDirectory: `/repo/${key}/${index}`,
      projectKind,
      workspaceKind: "checkout",
      name: `${key}-${index}`,
      statusBucket: "done",
      archivingAt: null,
      diffStat: null,
      scripts: [],
      hasRunningScripts: false,
    })),
  };
}

function agentProject(id: string, project: SidebarProjectEntry) {
  return { id, projectKey: project.projectKey };
}

function agentProjects(ids: readonly string[], project: SidebarProjectEntry) {
  return ids.map((id) => agentProject(id, project));
}

describe("sidebar session filtering", () => {
  it("hides unmapped agents and includes every mapped active agent for All", () => {
    const lookup = createSidebarSessionWorkspaceLookup(WORKSPACES);

    const visibleIds = AGENTS.filter((agent) =>
      shouldIncludeSidebarSessionAgent({
        agent,
        filter: { type: "all" },
        lookup,
      }),
    ).map((agent) => agent.id);

    expect(visibleIds).toEqual(["main", "docs", "api"]);
  });

  it("filters by project", () => {
    const lookup = createSidebarSessionWorkspaceLookup(WORKSPACES);

    const visibleIds = AGENTS.filter((agent) =>
      shouldIncludeSidebarSessionAgent({
        agent,
        filter: { type: "project", projectKey: "project-a" },
        lookup,
      }),
    ).map((agent) => agent.id);

    expect(visibleIds).toEqual(["main", "api"]);
  });

  it("derives filter options only from mapped active agents", () => {
    const lookup = createSidebarSessionWorkspaceLookup(WORKSPACES);
    const availability = deriveSidebarSessionFilterAvailability({
      agents: [
        AGENTS[0],
        AGENTS[3],
        {
          id: "archived-docs",
          serverId: "server-1",
          cwd: "/repo/docs",
          archivedAt: new Date("2026-05-08T10:00:00.000Z"),
        },
      ],
      lookup,
    });

    expect(availability).toEqual({
      projectKeys: ["project-a"],
    });
    const filterProjects = deriveSidebarSessionFilterProjects({
      projects: [
        {
          projectKey: "project-a",
          projectName: "Project A",
          projectKind: "git",
          iconWorkingDir: "/repo",
          workspaces: [
            {
              workspaceKey: "server-1:workspace-1",
              serverId: "server-1",
              workspaceId: "workspace-1",
              projectKey: "project-a",
              projectRootPath: "/repo",
              workspaceDirectory: "/repo/main",
              projectKind: "git",
              workspaceKind: "worktree",
              name: "Main",
              statusBucket: "done",
              archivingAt: null,
              diffStat: null,
              scripts: [],
              hasRunningScripts: false,
            },
            {
              workspaceKey: "server-1:workspace-3",
              serverId: "server-1",
              workspaceId: "workspace-3",
              projectKey: "project-a",
              projectRootPath: "/repo",
              workspaceDirectory: "/repo/api",
              projectKind: "git",
              workspaceKind: "worktree",
              name: "API",
              statusBucket: "done",
              archivingAt: null,
              diffStat: null,
              scripts: [],
              hasRunningScripts: false,
            },
          ],
        },
        {
          projectKey: "project-b",
          projectName: "Project B",
          projectKind: "git",
          iconWorkingDir: "/repo/docs",
          workspaces: [
            {
              workspaceKey: "server-1:workspace-2",
              serverId: "server-1",
              workspaceId: "workspace-2",
              projectKey: "project-b",
              projectRootPath: "/repo/docs",
              workspaceDirectory: "/repo/docs",
              projectKind: "git",
              workspaceKind: "worktree",
              name: "Docs",
              statusBucket: "done",
              archivingAt: null,
              diffStat: null,
              scripts: [],
              hasRunningScripts: false,
            },
          ],
        },
      ],
      availability,
    });

    expect(filterProjects.map(projectWorkspaceKeys)).toEqual([
      {
        projectKey: "project-a",
        workspaceKeys: ["server-1:workspace-1", "server-1:workspace-3"],
      },
    ]);
  });
});

describe("deriveGroupedSidebarSessions", () => {
  it("returns no groups for empty input", () => {
    expect(
      deriveGroupedSidebarSessions({
        agentsWithProjects: [],
        projects: [],
        previewExpandedProjects: new Set(),
      }),
    ).toEqual([]);
  });

  it("keeps a single project under the limit fully visible and collapsed", () => {
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2", "a3"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      limit: 6,
    });

    expect(groups).toEqual([
      {
        projectKey: "project-a",
        projectName: "project-a",
        projectIconKey: "/repo/project-a",
        visibleIds: ["a1", "a2", "a3"],
        hiddenCount: 0,
        isExpanded: false,
        isCollapsed: false,
        totalCount: 3,
      },
    ]);
  });

  it("caps a collapsed project over the limit", () => {
    const orderedIds = Array.from({ length: 10 }, (_, index) => `a${index + 1}`);
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(orderedIds, projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      limit: 6,
    });

    expect(groups[0]).toMatchObject({
      visibleIds: ["a1", "a2", "a3", "a4", "a5", "a6"],
      hiddenCount: 4,
      isExpanded: false,
      isCollapsed: false,
      totalCount: 10,
    });
  });

  it("shows every id for an expanded project over the limit", () => {
    const orderedIds = Array.from({ length: 10 }, (_, index) => `a${index + 1}`);
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(orderedIds, projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(["project-a"]),
      limit: 6,
    });

    expect(groups[0]).toMatchObject({
      visibleIds: orderedIds,
      hiddenCount: 0,
      isExpanded: true,
      isCollapsed: false,
      totalCount: 10,
    });
  });

  it("hides all rows when a project is collapsed", () => {
    const orderedIds = Array.from({ length: 10 }, (_, index) => `a${index + 1}`);
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(orderedIds, projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      collapsedProjectKeys: new Set(["project-a"]),
      limit: 6,
    });

    expect(groups[0]).toMatchObject({
      visibleIds: [],
      hiddenCount: 0,
      isExpanded: false,
      isCollapsed: true,
      totalCount: 10,
    });
  });

  it("collapsed wins over preview-expanded", () => {
    const orderedIds = Array.from({ length: 10 }, (_, index) => `a${index + 1}`);
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(orderedIds, projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(["project-a"]),
      collapsedProjectKeys: new Set(["project-a"]),
      limit: 6,
    });

    expect(groups[0]).toMatchObject({
      visibleIds: [],
      isExpanded: false,
      isCollapsed: true,
    });
  });

  it("orders projects by the canonical project list, ignoring agent first-occurrence", () => {
    const projectA = testProject("project-a");
    const projectB = testProject("project-b");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: [
        agentProject("b1", projectB),
        agentProject("a1", projectA),
        agentProject("b2", projectB),
        agentProject("a2", projectA),
      ],
      projects: [projectA, projectB],
      previewExpandedProjects: new Set(),
    });

    expect(groups.map((group) => ({ key: group.projectKey, ids: group.visibleIds }))).toEqual([
      { key: "project-a", ids: ["a1", "a2"] },
      { key: "project-b", ids: ["b1", "b2"] },
    ]);
  });

  it("preserves order within each project", () => {
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2", "a3"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
    });

    expect(groups[0]?.visibleIds).toEqual(["a1", "a2", "a3"]);
  });

  it("skips projects that have no agents", () => {
    const projectA = testProject("project-a");
    const projectB = testProject("project-b");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2"], projectA),
      projects: [projectA, projectB],
      previewExpandedProjects: new Set(),
    });

    expect(groups.map((group) => group.projectKey)).toEqual(["project-a"]);
  });

  it("keeps a single-workspace non-git project grouped and collapsible", () => {
    const projectA = testProject("project-a", { projectKind: "directory", workspaceCount: 1 });
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      collapsedProjectKeys: new Set(["project-a"]),
    });

    expect(groups[0]).toMatchObject({
      projectKey: "project-a",
      isCollapsed: true,
      visibleIds: [],
    });
  });

  it("renders a single-workspace non-git project group when expanded", () => {
    const projectA = testProject("project-a", { projectKind: "directory", workspaceCount: 1 });
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
    });

    expect(groups[0]).toMatchObject({
      projectKey: "project-a",
      projectName: "project-a",
      isCollapsed: false,
      visibleIds: ["a1", "a2"],
    });
  });

  it("renders multi-workspace non-git project groups too", () => {
    const projectA = testProject("project-a", { projectKind: "directory", workspaceCount: 2 });
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      collapsedProjectKeys: new Set(["project-a"]),
    });

    expect(groups[0]).toMatchObject({
      isCollapsed: true,
      visibleIds: [],
    });
  });

  it("keeps single-workspace git projects collapsible", () => {
    const projectA = testProject("project-a", { projectKind: "git", workspaceCount: 1 });
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      collapsedProjectKeys: new Set(["project-a"]),
    });

    expect(groups[0]).toMatchObject({
      isCollapsed: true,
    });
  });

  it("defaults the collapsed limit to 6", () => {
    const orderedIds = Array.from({ length: 7 }, (_, index) => `a${index + 1}`);
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(orderedIds, projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
    });

    expect(groups[0]?.visibleIds).toHaveLength(6);
    expect(groups[0]?.hiddenCount).toBe(1);
  });

  it("honors a custom collapsed limit", () => {
    const projectA = testProject("project-a");
    const groups = deriveGroupedSidebarSessions({
      agentsWithProjects: agentProjects(["a1", "a2", "a3", "a4"], projectA),
      projects: [projectA],
      previewExpandedProjects: new Set(),
      limit: 2,
    });

    expect(groups[0]).toMatchObject({
      visibleIds: ["a1", "a2"],
      hiddenCount: 2,
    });
  });
});
