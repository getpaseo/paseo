import { describe, expect, it } from "vitest";
import { filterWorkspaceProjectsForHost, type HostProjectListItem } from "@/projects/host-projects";
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
    viewKey: `view:${serverId}:${projectKey}`,
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/work/${projectKey}`,
    hosts: [
      {
        serverId,
        projectId: projectKey,
        iconWorkingDir: `/work/${projectKey}`,
        canCreateWorktree: true,
      },
    ],
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
    manualContextKey: input.manualContextKey ?? "",
    selectedServerId: input.selectedServerId ?? "host",
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
      project: remembered,
      source: "initial",
    });
    expect(resolveProjectSelection(reconciled, afterArchive)).toEqual(remembered);
  });

  it("resets stale selection when the route project context changes", () => {
    const manual = project("manual");
    const routeProject = { ...project("route-project"), projectKey: null };
    const current: ProjectSelection = {
      contextKey: "previous-route",
      project: manual,
      originProject: manual,
      source: "manual",
    };
    const nextContext = context({
      contextKey: "host:route-project",
      manualContextKey: routeProject.viewKey,
      initialProject: routeProject,
      projects: [manual, routeProject],
      routeProject,
    });

    expect(reconcileProjectSelection(current, nextContext)).toEqual({
      contextKey: "host:route-project",
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
      project: initialProject,
      source: "initial",
    });
  });

  it("adopts a routed project's hydrated cross-host key", () => {
    const routedProject = {
      ...project("local-project-id"),
      projectKey: null,
      hosts: [
        {
          serverId: "host",
          projectId: "local-project-id",
          iconWorkingDir: "/work/project",
          canCreateWorktree: true,
        },
      ],
    };
    const hydratedProject = {
      ...project("remote:github.com/acme/project"),
      hosts: [
        {
          serverId: "host",
          projectId: "local-project-id",
          iconWorkingDir: "/work/project",
          canCreateWorktree: false,
        },
      ],
    };
    const current = createProjectSelection(
      context({ initialProject: routedProject, projects: [], routeProject: routedProject }),
    );
    const hydratedContext = context({
      initialProject: hydratedProject,
      projects: [hydratedProject],
      routeProject: routedProject,
    });

    expect(reconcileProjectSelection(current, hydratedContext)).toEqual({
      contextKey: "host:",
      project: hydratedProject,
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
      project: remembered,
      source: "initial",
    });
  });

  it("keeps manual selections when the remembered project hydrates", () => {
    const manual = project("manual");
    const remembered = project("remembered");
    const current: ProjectSelection = {
      contextKey: "",
      project: manual,
      originProject: manual,
      source: "manual",
    };
    const afterRememberedHydration = context({
      initialProject: remembered,
      projects: [manual, remembered],
      lastActiveProject: remembered,
    });

    expect(reconcileProjectSelection(current, afterRememberedHydration)).toEqual(current);
  });

  it("resolves a manual selection on another host while retaining its origin snapshot", () => {
    const selected = project("shared", "host-a");
    const equivalent = project("shared", "host-b");
    const fallback = project("fallback", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const nextHost = context({
      selectedServerId: "host-b",
      initialProject: fallback,
      projects: [fallback, equivalent],
    });

    const reconciled = reconcileProjectSelection(current, nextHost);

    expect(reconciled).toEqual({
      contextKey: "",
      project: equivalent,
      originProject: selected,
      source: "manual",
    });
    expect(resolveProjectSelection(reconciled, nextHost)).toBe(equivalent);
  });

  it("ignores a stale placement view collision and selects the persisted equivalent", () => {
    const stalePlacementViewKey = JSON.stringify(["host-b", "opaque-project"]);
    const selected = {
      ...project("shared", "host-a"),
      viewKey: stalePlacementViewKey,
    };
    const unrelated = {
      ...project(stalePlacementViewKey, "host-b"),
      viewKey: stalePlacementViewKey,
    };
    const equivalent = project("shared", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const nextHost = context({
      selectedServerId: "host-b",
      initialProject: unrelated,
      projects: [unrelated, equivalent],
    });

    const reconciled = reconcileProjectSelection(current, nextHost);

    expect(reconciled).toEqual({
      contextKey: "",
      project: equivalent,
      originProject: selected,
      source: "manual",
    });
    expect(resolveProjectSelection(reconciled, nextHost)).toBe(equivalent);
  });

  it("chooses the same equivalent clone regardless of input order", () => {
    const selected = project("shared", "host-a");
    const cloneA = {
      ...project("shared", "host-b"),
      viewKey: "view:host-b:clone-a",
      projectName: "Shared",
      hosts: [
        {
          serverId: "host-b",
          projectId: "prj_a",
          iconWorkingDir: "/work/a",
          canCreateWorktree: true,
        },
      ],
    };
    const cloneB = {
      ...cloneA,
      viewKey: "view:host-b:clone-b",
      hosts: [{ ...cloneA.hosts[0]!, projectId: "prj_b", iconWorkingDir: "/work/b" }],
    };
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const resolve = (projects: HostProjectListItem[]) => {
      const nextHost = context({
        selectedServerId: "host-b",
        initialProject: cloneB,
        projects,
      });
      return resolveProjectSelection(reconcileProjectSelection(current, nextHost), nextHost);
    };

    expect(resolve([cloneB, cloneA])).toBe(cloneA);
    expect(resolve([cloneA, cloneB])).toBe(cloneA);
  });

  it("restores the exact manually selected clone after switching away and back", () => {
    const selected = {
      ...project("shared", "host-a"),
      viewKey: "view:host-a:selected",
      hosts: [
        {
          serverId: "host-a",
          projectId: "prj_b",
          iconWorkingDir: "/work/selected",
          canCreateWorktree: true,
        },
      ],
    };
    const sibling = {
      ...selected,
      viewKey: "view:host-a:sibling",
      hosts: [{ ...selected.hosts[0]!, projectId: "prj_a", iconWorkingDir: "/work/sibling" }],
    };
    const destination = project("shared", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const otherHost = context({
      selectedServerId: "host-b",
      initialProject: destination,
      projects: [destination],
    });

    const retained = reconcileProjectSelection(current, otherHost);
    expect(retained).toEqual({
      contextKey: "",
      project: destination,
      originProject: selected,
      source: "manual",
    });
    expect(resolveProjectSelection(retained, otherHost)).toBe(destination);

    const originHost = context({
      selectedServerId: "host-a",
      initialProject: sibling,
      projects: [sibling, selected],
    });
    const restored = reconcileProjectSelection(retained, originHost);

    expect(restored.project).toBe(selected);
    expect(restored.source === "manual" ? restored.originProject : null).toBe(selected);
    expect(resolveProjectSelection(restored, originHost)).toBe(selected);
  });

  it("preserves the current destination clone during its pending archive gap", () => {
    const selected = project("shared", "host-a");
    const destination = {
      ...project("shared", "host-b"),
      workspaceKeys: ["host-b:workspace"],
    };
    const fallback = project("fallback", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const destinationHost = context({
      selectedServerId: "host-b",
      initialProject: fallback,
      projects: [fallback, destination],
    });
    const resolvedDestination = reconcileProjectSelection(current, destinationHost);
    const archiveGap = context({
      selectedServerId: "host-b",
      initialProject: fallback,
      projects: [fallback],
      shouldPreserveMissingProject: (candidate) => candidate === destination,
    });

    expect(reconcileProjectSelection(resolvedDestination, archiveGap)).toBe(resolvedDestination);
    expect(resolveProjectSelection(resolvedDestination, archiveGap)).toBe(destination);
  });

  it("preserves the exact origin clone during its pending archive gap", () => {
    const selected = {
      ...project("shared", "host-a"),
      viewKey: "view:host-a:selected",
      workspaceKeys: ["host-a:workspace"],
      hosts: [
        {
          serverId: "host-a",
          projectId: "prj_b",
          iconWorkingDir: "/work/selected",
          canCreateWorktree: true,
        },
      ],
    };
    const sibling = {
      ...selected,
      viewKey: "view:host-a:sibling",
      workspaceKeys: [],
      hosts: [{ ...selected.hosts[0]!, projectId: "prj_a", iconWorkingDir: "/work/sibling" }],
    };
    const destination = project("shared", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const destinationHost = context({
      selectedServerId: "host-b",
      initialProject: destination,
      projects: [destination],
    });
    const resolvedDestination = reconcileProjectSelection(current, destinationHost);
    const archiveGap = context({
      selectedServerId: "host-a",
      initialProject: sibling,
      projects: [sibling],
      shouldPreserveMissingProject: (candidate) => candidate === selected,
    });

    const preservedOrigin = reconcileProjectSelection(resolvedDestination, archiveGap);

    expect(preservedOrigin.project).toBe(selected);
    expect(resolveProjectSelection(preservedOrigin, archiveGap)).toBe(selected);
  });

  it("falls back when the only equivalent project is not selectable", () => {
    const selected = project("shared", "host-a");
    const unselectableEquivalent = {
      ...project("shared", "host-b"),
      hosts: [
        {
          serverId: "host-b",
          projectId: "shared",
          iconWorkingDir: "/work/shared",
          canCreateWorktree: false,
        },
      ],
    };
    const fallback = project("fallback", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };
    const selectableProjects = filterWorkspaceProjectsForHost({
      projects: [unselectableEquivalent, fallback],
      serverId: "host-b",
      allowAllProjects: false,
    });
    const selectableContext = context({
      selectedServerId: "host-b",
      initialProject: fallback,
      projects: selectableProjects,
    });

    expect(reconcileProjectSelection(current, selectableContext).project).toBe(fallback);
  });

  it("does not equate projects without a persisted project key", () => {
    const selected = { ...project("selected", "host-a"), projectKey: null };
    const sameName = {
      ...project("same-name", "host-b"),
      projectKey: null,
      projectName: selected.projectName,
    };
    const fallback = project("fallback", "host-b");
    const current: ProjectSelection = {
      contextKey: "",
      project: selected,
      originProject: selected,
      source: "manual",
    };

    expect(
      reconcileProjectSelection(
        current,
        context({
          selectedServerId: "host-b",
          initialProject: fallback,
          projects: [sameName, fallback],
        }),
      ).project,
    ).toBe(fallback);
  });

  it("preserves an opaque project key ending in whitespace", () => {
    const selected = project("host:project ");
    const current = createProjectSelection(
      context({ initialProject: selected, projects: [selected] }),
    );
    const currentContext = context({ initialProject: selected, projects: [selected] });

    expect(resolveProjectSelection(current, currentContext)).toEqual(selected);
    expect(reconcileProjectSelection(current, currentContext)).toEqual(current);
  });

  it("resets fallback selection when host project capability changes", () => {
    const fallback = project("git-fallback");
    const remembered = project("remembered-directory");
    const current = createProjectSelection(
      context({
        contextKey: createProjectSelectionContextKey({
          selectedServerId: "host",
          routeProjectViewKey: null,
          allowAllProjects: false,
        }),
        initialProject: fallback,
        projects: [fallback, remembered],
      }),
    );
    const afterCapabilityHydration = context({
      contextKey: createProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectViewKey: null,
        allowAllProjects: true,
      }),
      initialProject: remembered,
      projects: [fallback, remembered],
    });

    expect(reconcileProjectSelection(current, afterCapabilityHydration)).toEqual({
      contextKey: "host:all-projects:",
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
        routeProjectViewKey: null,
      }),
      project: manual,
      originProject: manual,
      source: "manual",
    };
    const afterCapabilityHydration = context({
      contextKey: createProjectSelectionContextKey({
        selectedServerId: "host",
        routeProjectViewKey: null,
        allowAllProjects: true,
      }),
      manualContextKey: createManualProjectSelectionContextKey({
        routeProjectViewKey: null,
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

  it("keeps a pending archived clone instead of jumping to a same-host equivalent", () => {
    const remembered = project("shared");
    const sibling = {
      ...project("shared"),
      viewKey: "view:host:sibling",
      hosts: [
        {
          serverId: "host",
          projectId: "sibling",
          iconWorkingDir: "/work/sibling",
          canCreateWorktree: true,
        },
      ],
    };
    const fallback = project("fallback");
    const current = createProjectSelection(
      context({ initialProject: remembered, projects: [remembered, sibling] }),
    );
    const archiveGap = context({
      initialProject: fallback,
      projects: [sibling, fallback],
      shouldPreserveMissingProject: (candidate) => candidate.viewKey === remembered.viewKey,
    });

    expect(reconcileProjectSelection(current, archiveGap)).toEqual(current);
    expect(resolveProjectSelection(current, archiveGap)).toEqual(remembered);
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
      project: fallback,
      source: "initial",
    });
  });

  it("resolves manual selections from selectable projects, not route or remembered projects", () => {
    const manual = project("manual");
    const routeProject = project("route-project");
    const remembered = project("remembered");
    const current: ProjectSelection = {
      contextKey: routeProject.viewKey,
      project: manual,
      originProject: manual,
      source: "manual",
    };
    const selectionContext = context({
      contextKey: "host:route-project",
      manualContextKey: routeProject.viewKey,
      initialProject: routeProject,
      projects: [manual],
      routeProject,
      lastActiveProject: remembered,
    });

    expect(resolveProjectSelection(current, selectionContext)).toEqual(manual);
  });
});
