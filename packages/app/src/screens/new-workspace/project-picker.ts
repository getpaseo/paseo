import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import {
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  resolveInitialWorkspaceProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import {
  createManualProjectSelectionContextKey,
  createProjectSelectionContextKey,
  createProjectSelection,
  reconcileProjectSelection,
  resolveProjectSelection,
  type ProjectSelection,
  type ProjectSelectionContext,
} from "./project-selection";

const PROJECT_OPTION_PREFIX = "project:";

interface NewWorkspaceProjectPickerInput {
  selectedServerId: string;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  allowAllProjects: boolean;
}

interface NewWorkspaceProjectPickerState {
  selectedProject: HostProjectListItem | null;
  selectedSourceDirectory: string | null;
  projectPickerOptions: ComboboxOptionType[];
  projectByOptionId: Map<string, HostProjectListItem>;
  selectedProjectOptionId: string;
  projectTriggerLabel: string;
  handleSelectProjectOption: (id: string) => void;
}

function projectOptionId(projectId: string): string {
  return `${PROJECT_OPTION_PREFIX}${projectId}`;
}

function computeProjectOptionData(projects: readonly HostProjectListItem[]) {
  const projectByOptionId = new Map<string, HostProjectListItem>();
  const options = projects.map((project) => {
    const id = projectOptionId(project.projectKey);
    projectByOptionId.set(id, project);
    return { id, label: project.projectName };
  });
  return { options, projectByOptionId };
}

export function useNewWorkspaceProjectPicker({
  selectedServerId,
  projects,
  routeProject,
  lastActiveProject,
  allowAllProjects,
}: NewWorkspaceProjectPickerInput): NewWorkspaceProjectPickerState {
  const selectableProjects = useMemo(
    () =>
      filterWorkspaceProjectsForHost({ projects, serverId: selectedServerId, allowAllProjects }),
    [allowAllProjects, projects, selectedServerId],
  );
  const initialProject = useMemo(
    () =>
      resolveInitialWorkspaceProject({
        routeProject,
        lastActiveProject,
        projects: selectableProjects,
        serverId: selectedServerId,
        allowAllProjects,
      }),
    [allowAllProjects, lastActiveProject, routeProject, selectableProjects, selectedServerId],
  );

  const routeProjectKey = routeProject?.projectKey ?? null;
  const selectionContextKey = createProjectSelectionContextKey({
    selectedServerId,
    routeProjectKey,
    allowAllProjects,
  });
  const manualSelectionContextKey = createManualProjectSelectionContextKey({
    selectedServerId,
    routeProjectKey,
  });
  const selectionContext = useMemo<ProjectSelectionContext>(
    () => ({
      contextKey: selectionContextKey,
      manualContextKey: manualSelectionContextKey,
      initialProject,
      projects: selectableProjects,
      routeProject,
      lastActiveProject,
    }),
    [
      initialProject,
      lastActiveProject,
      manualSelectionContextKey,
      routeProject,
      selectableProjects,
      selectionContextKey,
    ],
  );
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>(() =>
    createProjectSelection(selectionContext),
  );

  useEffect(() => {
    setProjectSelection((current) => reconcileProjectSelection(current, selectionContext));
  }, [selectionContext]);

  const activeSelection = reconcileProjectSelection(projectSelection, selectionContext);
  const selectedProject = resolveProjectSelection(activeSelection, selectionContext);
  const { options: projectPickerOptions, projectByOptionId } = useMemo(
    () => computeProjectOptionData(selectableProjects),
    [selectableProjects],
  );
  const handleSelectProjectOption = useCallback(
    (id: string) => {
      const project = projectByOptionId.get(id);
      if (!project) return;
      if (!allowAllProjects && !project.hosts.some((host) => host.canCreateWorktree)) return;
      setProjectSelection({
        contextKey: manualSelectionContextKey,
        projectKey: project.projectKey,
        project,
        source: "manual",
      });
    },
    [allowAllProjects, manualSelectionContextKey, projectByOptionId],
  );

  return {
    selectedProject,
    selectedSourceDirectory: selectedProject
      ? getHostProjectSourceDirectory(selectedProject, selectedServerId)
      : null,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId: selectedProject ? projectOptionId(selectedProject.projectKey) : "",
    projectTriggerLabel: selectedProject?.projectName ?? "Choose project",
    handleSelectProjectOption,
  };
}
