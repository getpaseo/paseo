import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import {
  createManualProjectSelectionContextKey,
  createProjectSelectionContextKey,
  createProjectSelection,
  reconcileProjectSelection,
  resolveInitialProjectSelectionSource,
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
  const contextKey = input.contextKey ?? "host:";
  const routeProject = input.routeProject ?? null;
  const lastActiveProject = input.lastActiveProject ?? null;
  return {
    contextKey,
    manualContextKey: input.manualContextKey ?? contextKey,
    routeProject,
    lastActiveProject,
    initialProjectSource:
      input.initialProjectSource ??
      resolveInitialProjectSelectionSource({
        initialProject: input.initialProject,
        routeProject,
        lastActiveProject,
      }),
    shouldPreserveMissingProject: () => false,
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
      project: remembered,
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
      project: manual,
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
      project: routeProject,
      source: "initial",
    });
  });

  it("hydrates an empty initial selection when projects arrive", () => {
    const initialProject = project("hydrated");
    const current = createProjectSelection(context({ initialProject: null, projects: [] }));
    const hydratedContext = context({
      initialProject,
      projects: [initialProject],
    });

    expect(reconcileProjectSelection(current, hydratedContext)).toEqual({
      contextKey: "host:",
      projectKey: initialProject.projectKey,
      project: initialProject,
      source: "initial",
    });
  });

  it("stores hydrated project snapshots before archive gaps", () => {
    const routeProject = project("route-project");
    const hydratedProject: HostProjectListItem = {
      ...routeProject,
      workspaceKeys: ["host:workspace"],
    };
    const current = createProjectSelection(
      context({ initialProject: routeProject, projects: [], routeProject }),
    );
    const afterHydration = context({
      initialProject: hydratedProject,
      projects: [hydratedProject],
      routeProject,
    });

    const hydratedSelection = reconcileProjectSelection(current, afterHydration);

    expect(hydratedSelection).toEqual({
      contextKey: "host:",
      projectKey: hydratedProject.projectKey,
      project: hydratedProject,
      source: "initial",
    });

    const archiveGap = context({
      initialProject: routeProject,
      projects: [],
      routeProject,
      shouldPreserveMissingProject: (candidate) =>
        candidate.workspaceKeys.includes("host:workspace"),
    });

    expect(resolveProjectSelection(hydratedSelection, archiveGap)).toEqual(hydratedProject);
  });

  it("resets an automatic fallback when the remembered project hydrates", () => {
    const fallback = project("fallback");
    const remembered = project("remembered");
    const current = createProjectSelection(
      context({ initialProject: fallback, projects: [fallback, remembered] }),
    );
    const afterRememberedHydration = context({
      initialProject: remembered,
      projects: [fallback, remembered],
      lastActiveProject: remembered,
    });

    expect(reconcileProjectSelection(current, afterRememberedHydration)).toEqual({
      contextKey: "host:",
      projectKey: remembered.projectKey,
      project: remembered,
      source: "initial",
    });
  });

  it("keeps manual selections when the remembered project hydrates", () => {
    const manual = project("manual");
    const remembered = project("remembered");
    const current: ProjectSelection = {
      contextKey: "host:",
      projectKey: manual.projectKey,
      project: manual,
      source: "manual",
    };
    const afterRememberedHydration = context({
      initialProject: remembered,
      projects: [manual, remembered],
      lastActiveProject: remembered,
    });

    expect(reconcileProjectSelection(current, afterRememberedHydration)).toEqual(current);
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
      project: remembered,
      source: "initial",
    });
  });

  it("keeps a still-selectable manual selection when host project capability changes", () => {
    const fallback = project("git-fallback");
    const manual = project("manual-choice");
    const remembered = project("remembered-directory");
    const current: ProjectSelection = {
      contextKey: createManualProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectKey: null,
      }),
      projectKey: manual.projectKey,
      project: manual,
      source: "manual",
    };
    const afterCapabilityHydration = context({
      contextKey: createProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectKey: null,
        allowAllProjects: true,
      }),
      manualContextKey: createManualProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectKey: null,
      }),
      initialProject: remembered,
      projects: [fallback, manual, remembered],
    });

    const reconciled = reconcileProjectSelection(current, afterCapabilityHydration);

    expect(reconciled).toEqual(current);
    expect(resolveProjectSelection(reconciled, afterCapabilityHydration)).toEqual(manual);
  });

  it("keeps the selected project snapshot during a pending archive gap", () => {
    const remembered = project("remembered");
    const fallback = project("fallback");
    const current = createProjectSelection(
      context({ initialProject: remembered, projects: [remembered] }),
    );
    const withoutRemembered = context({
      initialProject: fallback,
      projects: [fallback],
      shouldPreserveMissingProject: (candidate) => candidate.projectKey === remembered.projectKey,
    });

    const reconciled = reconcileProjectSelection(current, withoutRemembered);

    expect(reconciled).toEqual(current);
    expect(resolveProjectSelection(reconciled, withoutRemembered)).toEqual(remembered);
  });

  it("falls back when the selected project disappears without a pending archive", () => {
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
      project: fallback,
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
      project: manual,
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
