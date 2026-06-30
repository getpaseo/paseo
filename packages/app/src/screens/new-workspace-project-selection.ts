import { resolveSelectedHostProject, type HostProjectListItem } from "@/projects/host-projects";

export type NewWorkspaceProjectSelectionSource = "initial" | "manual";

export interface NewWorkspaceProjectSelection {
  contextKey: string;
  projectKey: string | null;
  source: NewWorkspaceProjectSelectionSource;
}

export interface NewWorkspaceProjectSelectionContext {
  contextKey: string;
  initialProject: HostProjectListItem | null;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}

export function createInitialNewWorkspaceProjectSelection({
  contextKey,
  initialProject,
}: NewWorkspaceProjectSelectionContext): NewWorkspaceProjectSelection {
  return {
    contextKey,
    projectKey: initialProject?.projectKey ?? null,
    source: "initial",
  };
}

function projectSelectionsAreEqual(
  left: NewWorkspaceProjectSelection,
  right: NewWorkspaceProjectSelection,
): boolean {
  return (
    left.contextKey === right.contextKey &&
    left.projectKey === right.projectKey &&
    left.source === right.source
  );
}

export function resolveNewWorkspaceProjectSelection(
  selection: NewWorkspaceProjectSelection,
  context: NewWorkspaceProjectSelectionContext,
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

export function reconcileNewWorkspaceProjectSelection(
  current: NewWorkspaceProjectSelection,
  context: NewWorkspaceProjectSelectionContext,
): NewWorkspaceProjectSelection {
  const initialSelection = createInitialNewWorkspaceProjectSelection(context);
  if (current.contextKey !== context.contextKey) {
    return initialSelection;
  }

  if (resolveNewWorkspaceProjectSelection(current, context)) {
    return current;
  }

  return projectSelectionsAreEqual(current, initialSelection) ? current : initialSelection;
}
