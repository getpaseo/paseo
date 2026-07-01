import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import {
  createProjectSelectionContextKey,
  createProjectSelection,
  reconcileProjectSelection,
  resolveProjectSelection,
  type ProjectSelection,
  type ProjectSelectionContext,
} from "./project-selection";

function project(projectKey: string, serverId = "host"): HostProjectListItem {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/work/${projectKey}`,
    hosts: [{ serverId, iconWorkingDir: `/work/${projectKey}`, canCreateWorktree: true }],
    workspaceKeys: [],
  };
}

function context(
  input: Partial<ProjectSelectionContext> & {
    initialProject: HostProjectListItem | null;
    projects: HostProjectListItem[];
  },
): ProjectSelectionContext {
  return {
    contextKey: "host:",
    routeProject: null,
    lastActiveProject: null,
    ...input,
  };
}

describe("reconcileProjectSelection", () => {
  it("keeps a still-selectable project when the default moves after archive", () => {
    const remembered = project("remembered");
    const other = project("other");
    const current = createProjectSelection(
      context({ initialProject: remembered, projects: [remembered, other] }),
    );
    const afterArchive = context({
      initialProject: other,
      projects: [other, remembered],
    });

    const reconciled = reconcileProjectSelection(current, afterArchive);

    expect(reconciled).toEqual({
      contextKey: "host:",
      projectKey: remembered.projectKey,
      source: "initial",
    });
    expect(resolveProjectSelection(reconciled, afterArchive)).toEqual(remembered);
  });

  it("resets stale selection when the route project context changes", () => {
    const manual = project("manual");
    const routeProject = project("route-project");
    const current: ProjectSelection = {
      contextKey: "host:previous-route",
      projectKey: manual.projectKey,
      source: "manual",
    };
    const nextContext = context({
      contextKey: "host:route-project",
      initialProject: routeProject,
      projects: [manual, routeProject],
      routeProject,
    });

    expect(reconcileProjectSelection(current, nextContext)).toEqual({
      contextKey: "host:route-project",
      projectKey: routeProject.projectKey,
      source: "initial",
    });
  });

  it("resets fallback selection when host project capability changes", () => {
    const fallback = project("git-fallback");
    const remembered = project("remembered-directory");
    const current = createProjectSelection(
      context({
        contextKey: createProjectSelectionContextKey({
          selectedServerId: "host",
          routeProjectKey: null,
          allowAllProjects: false,
        }),
        initialProject: fallback,
        projects: [fallback, remembered],
      }),
    );
    const afterCapabilityHydration = context({
      contextKey: createProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectKey: null,
        allowAllProjects: true,
      }),
      initialProject: remembered,
      projects: [fallback, remembered],
    });

    expect(reconcileProjectSelection(current, afterCapabilityHydration)).toEqual({
      contextKey: "host:all-projects:",
      projectKey: remembered.projectKey,
      source: "initial",
    });
  });

  it("falls back only when the selected project disappears", () => {
    const remembered = project("remembered");
    const fallback = project("fallback");
    const current = createProjectSelection(
      context({ initialProject: remembered, projects: [remembered] }),
    );
    const withoutRemembered = context({
      initialProject: fallback,
      projects: [fallback],
    });

    expect(reconcileProjectSelection(current, withoutRemembered)).toEqual({
      contextKey: "host:",
      projectKey: fallback.projectKey,
      source: "initial",
    });
  });

  it("resolves manual selections from selectable projects, not route or remembered projects", () => {
    const manual = project("manual");
    const routeProject = project("route-project");
    const remembered = project("remembered");
    const current: ProjectSelection = {
      contextKey: "host:route-project",
      projectKey: manual.projectKey,
      source: "manual",
    };
    const selectionContext = context({
      contextKey: "host:route-project",
      initialProject: routeProject,
      projects: [manual],
      routeProject,
      lastActiveProject: remembered,
    });

    expect(resolveProjectSelection(current, selectionContext)).toEqual(manual);
  });
});
