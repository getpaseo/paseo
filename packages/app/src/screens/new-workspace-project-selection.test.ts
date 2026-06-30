import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import {
  createInitialNewWorkspaceProjectSelection,
  reconcileNewWorkspaceProjectSelection,
  resolveNewWorkspaceProjectSelection,
  type NewWorkspaceProjectSelection,
  type NewWorkspaceProjectSelectionContext,
} from "./new-workspace-project-selection";

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
  input: Partial<NewWorkspaceProjectSelectionContext> & {
    initialProject: HostProjectListItem | null;
    projects: HostProjectListItem[];
  },
): NewWorkspaceProjectSelectionContext {
  return {
    contextKey: "host:",
    routeProject: null,
    lastActiveProject: null,
    ...input,
  };
}

describe("reconcileNewWorkspaceProjectSelection", () => {
  it("keeps a still-selectable project when the default moves after archive", () => {
    const remembered = project("remembered");
    const other = project("other");
    const current = createInitialNewWorkspaceProjectSelection(
      context({ initialProject: remembered, projects: [remembered, other] }),
    );
    const afterArchive = context({
      initialProject: other,
      projects: [other, remembered],
    });

    const reconciled = reconcileNewWorkspaceProjectSelection(current, afterArchive);

    expect(reconciled).toEqual({
      contextKey: "host:",
      projectKey: remembered.projectKey,
      source: "initial",
    });
    expect(resolveNewWorkspaceProjectSelection(reconciled, afterArchive)).toEqual(remembered);
  });

  it("resets stale selection when the route project context changes", () => {
    const manual = project("manual");
    const routeProject = project("route-project");
    const current: NewWorkspaceProjectSelection = {
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

    expect(reconcileNewWorkspaceProjectSelection(current, nextContext)).toEqual({
      contextKey: "host:route-project",
      projectKey: routeProject.projectKey,
      source: "initial",
    });
  });

  it("falls back only when the selected project disappears", () => {
    const remembered = project("remembered");
    const fallback = project("fallback");
    const current = createInitialNewWorkspaceProjectSelection(
      context({ initialProject: remembered, projects: [remembered] }),
    );
    const withoutRemembered = context({
      initialProject: fallback,
      projects: [fallback],
    });

    expect(reconcileNewWorkspaceProjectSelection(current, withoutRemembered)).toEqual({
      contextKey: "host:",
      projectKey: fallback.projectKey,
      source: "initial",
    });
  });

  it("resolves manual selections from selectable projects, not route or remembered projects", () => {
    const manual = project("manual");
    const routeProject = project("route-project");
    const remembered = project("remembered");
    const current: NewWorkspaceProjectSelection = {
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

    expect(resolveNewWorkspaceProjectSelection(current, selectionContext)).toEqual(manual);
  });
});
