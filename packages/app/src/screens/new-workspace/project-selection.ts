import { resolveSelectedHostProject, type HostProjectListItem } from "@/projects/host-projects";

export type ProjectSelectionSource = "initial" | "manual";

export interface ProjectSelection {
  contextKey: string;
  projectKey: string | null;
  project: HostProjectListItem | null;
  source: ProjectSelectionSource;
}

export interface ProjectSelectionContext {
  contextKey: string;
  manualContextKey: string;
  initialProject: HostProjectListItem | null;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}

export function createProjectSelectionContextKey(input: {
  selectedServerId: string;
  routeProjectKey: string | null;
  allowAllProjects: boolean;
}): string {
  const projectScope = input.allowAllProjects ? "all-projects" : "worktree-projects";
  return `${input.selectedServerId}:${projectScope}:${input.routeProjectKey ?? ""}`;
}

export function createManualProjectSelectionContextKey(input: {
  selectedServerId: string;
  routeProjectKey: string | null;
}): string {
  return `${input.selectedServerId}:${input.routeProjectKey ?? ""}`;
}

export function createProjectSelection({
  contextKey,
  initialProject,
}: ProjectSelectionContext): ProjectSelection {
  return {
    contextKey,
    projectKey: initialProject?.projectKey ?? null,
    project: initialProject,
    source: "initial",
  };
}

function projectSelectionsAreEqual(left: ProjectSelection, right: ProjectSelection): boolean {
  return (
    left.contextKey === right.contextKey &&
    left.projectKey === right.projectKey &&
    left.project?.projectKey === right.project?.projectKey &&
    left.source === right.source
  );
}

export function resolveProjectSelection(
  selection: ProjectSelection,
  context: ProjectSelectionContext,
): HostProjectListItem | null {
  const routeProject = selection.source === "manual" ? null : context.routeProject;
  const lastActiveProject = selection.source === "manual" ? null : context.lastActiveProject;

  const selectedProject = resolveSelectedHostProject({
    selectedProjectKey: selection.projectKey,
    projects: context.projects,
    routeProject,
    lastActiveProject,
  });
  if (selectedProject) {
    return selectedProject;
  }

  return selection.project?.projectKey === selection.projectKey ? selection.project : null;
}

export function reconcileProjectSelection(
  current: ProjectSelection,
  context: ProjectSelectionContext,
): ProjectSelection {
  const initialSelection = createProjectSelection(context);
  const currentContextKey =
    current.source === "manual" ? context.manualContextKey : context.contextKey;
  if (current.contextKey !== currentContextKey) {
    return initialSelection;
  }

  if (resolveProjectSelection(current, context)) {
    return current;
  }

  if (current.projectKey) {
    return current;
  }

  return projectSelectionsAreEqual(current, initialSelection) ? current : initialSelection;
}
