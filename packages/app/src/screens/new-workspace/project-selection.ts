import type { HostProjectListItem } from "@/projects/host-projects";

export type ProjectSelectionSource = "initial" | "manual";
export type InitialProjectSelectionSource = "route" | "lastActive" | "fallback" | null;

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
  initialProjectSource: InitialProjectSelectionSource;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  shouldPreserveMissingProject: (project: HostProjectListItem) => boolean;
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

export function resolveInitialProjectSelectionSource(input: {
  initialProject: HostProjectListItem | null;
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}): InitialProjectSelectionSource {
  if (!input.initialProject) {
    return null;
  }
  if (input.routeProject?.projectKey === input.initialProject.projectKey) {
    return "route";
  }
  if (input.lastActiveProject?.projectKey === input.initialProject.projectKey) {
    return "lastActive";
  }
  return "fallback";
}

function resolveProjectSelectionKey(selection: ProjectSelection): string | null {
  const projectKey = selection.projectKey?.trim() ?? "";
  return projectKey || null;
}

function resolveSelectedProjectFromInitialInputs(
  projectKey: string,
  context: ProjectSelectionContext,
): HostProjectListItem | null {
  return (
    (context.routeProject?.projectKey === projectKey ? context.routeProject : null) ??
    (context.lastActiveProject?.projectKey === projectKey ? context.lastActiveProject : null)
  );
}

function refreshSelectionProject(
  selection: ProjectSelection,
  project: HostProjectListItem,
): ProjectSelection {
  if (selection.projectKey === project.projectKey && selection.project === project) {
    return selection;
  }
  return {
    ...selection,
    projectKey: project.projectKey,
    project,
  };
}

function shouldResetInitialFallbackSelection(
  selection: ProjectSelection,
  context: ProjectSelectionContext,
): boolean {
  if (
    selection.source !== "initial" ||
    !context.initialProject ||
    context.initialProjectSource !== "lastActive"
  ) {
    return false;
  }

  return selection.projectKey !== context.initialProject.projectKey;
}

export function resolveProjectSelection(
  selection: ProjectSelection,
  context: ProjectSelectionContext,
): HostProjectListItem | null {
  const projectKey = resolveProjectSelectionKey(selection);
  if (!projectKey) {
    return null;
  }

  const selectableProject = context.projects.find((project) => project.projectKey === projectKey);
  if (selectableProject) {
    return selectableProject;
  }

  if (
    selection.project?.projectKey === projectKey &&
    context.shouldPreserveMissingProject(selection.project)
  ) {
    return selection.project;
  }

  if (selection.source !== "manual") {
    return resolveSelectedProjectFromInitialInputs(projectKey, context);
  }

  return null;
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

  if (shouldResetInitialFallbackSelection(current, context)) {
    return initialSelection;
  }

  const resolvedProject = resolveProjectSelection(current, context);
  if (resolvedProject) {
    return refreshSelectionProject(current, resolvedProject);
  }

  return initialSelection;
}
