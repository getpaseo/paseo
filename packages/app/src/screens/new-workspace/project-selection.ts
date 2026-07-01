import { resolveSelectedHostProject, type HostProjectListItem } from "@/projects/host-projects";

export type ProjectSelectionSource = "initial" | "manual";

export interface ProjectSelection {
  contextKey: string;
  projectKey: string | null;
  source: ProjectSelectionSource;
}

export interface ProjectSelectionContext {
  contextKey: string;
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

export function createProjectSelection({
  contextKey,
  initialProject,
}: ProjectSelectionContext): ProjectSelection {
  return {
    contextKey,
    projectKey: initialProject?.projectKey ?? null,
    source: "initial",
  };
}

function projectSelectionsAreEqual(left: ProjectSelection, right: ProjectSelection): boolean {
  return (
    left.contextKey === right.contextKey &&
    left.projectKey === right.projectKey &&
    left.source === right.source
  );
}

export function resolveProjectSelection(
  selection: ProjectSelection,
  context: ProjectSelectionContext,
): HostProjectListItem | null {
  const routeProject = selection.source === "manual" ? null : context.routeProject;
  const lastActiveProject = selection.source === "manual" ? null : context.lastActiveProject;

  return resolveSelectedHostProject({
    selectedProjectKey: selection.projectKey,
    projects: context.projects,
    routeProject,
    lastActiveProject,
  });
}

export function reconcileProjectSelection(
  current: ProjectSelection,
  context: ProjectSelectionContext,
): ProjectSelection {
  const initialSelection = createProjectSelection(context);
  if (current.contextKey !== context.contextKey) {
    return initialSelection;
  }

  if (resolveProjectSelection(current, context)) {
    return current;
  }

  return projectSelectionsAreEqual(current, initialSelection) ? current : initialSelection;
}
