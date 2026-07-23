import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import { isWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import {
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  resolveInitialWorkspaceProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import {
  createChatProjectSelection,
  createManualProjectSelectionContextKey,
  createProjectSelectionContextKey,
  createProjectSelection,
  isChatProjectSelection,
  reconcileProjectSelection,
  resolveInitialProjectSelectionSource,
  resolveProjectSelection,
  type ProjectSelection,
  type ProjectSelectionContext,
} from "./project-selection";

const PROJECT_OPTION_PREFIX = "project:";
export const CHAT_WORKSPACE_OPTION_ID = "chat-workspace";

interface NewWorkspaceProjectPickerInput {
  selectedServerId: string;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  allowAllProjects: boolean;
  allowChatWorkspace: boolean;
  initialChatWorkspace: boolean;
  chatWorkspaceLabel: string;
}

interface NewWorkspaceProjectPickerState {
  selectedProject: HostProjectListItem | null;
  isChatWorkspace: boolean;
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

function resolveSelectedProjectOptionId(input: {
  isChatWorkspace: boolean;
  selectedProject: HostProjectListItem | null;
}): string {
  if (input.isChatWorkspace) return CHAT_WORKSPACE_OPTION_ID;
  if (input.selectedProject) return projectOptionId(input.selectedProject.projectKey);
  return "";
}

export function computeProjectOptionData(input: {
  projects: readonly HostProjectListItem[];
  allowChatWorkspace: boolean;
  chatWorkspaceLabel: string;
}) {
  const projectByOptionId = new Map<string, HostProjectListItem>();
  const projectOptions = input.projects.map((project) => {
    const id = projectOptionId(project.projectKey);
    projectByOptionId.set(id, project);
    return { id, label: project.projectName };
  });
  const options = input.allowChatWorkspace
    ? [{ id: CHAT_WORKSPACE_OPTION_ID, label: input.chatWorkspaceLabel }, ...projectOptions]
    : projectOptions;
  return { options, projectByOptionId };
}

function resolveWorkspaceIdFromProjectWorkspaceKey(input: {
  selectedServerId: string;
  workspaceKey: string;
}): string | null {
  const prefix = `${input.selectedServerId}:`;
  return input.workspaceKey.startsWith(prefix) ? input.workspaceKey.slice(prefix.length) : null;
}

function hasPendingArchiveForProject(input: {
  selectedServerId: string;
  project: HostProjectListItem;
}): boolean {
  for (const workspaceKey of input.project.workspaceKeys) {
    const workspaceId = resolveWorkspaceIdFromProjectWorkspaceKey({
      selectedServerId: input.selectedServerId,
      workspaceKey,
    });
    if (
      workspaceId &&
      isWorkspaceArchivePending({ serverId: input.selectedServerId, workspaceId })
    ) {
      return true;
    }
  }

  return false;
}

export function useNewWorkspaceProjectPicker({
  selectedServerId,
  projects,
  routeProject,
  lastActiveProject,
  allowAllProjects,
  allowChatWorkspace,
  initialChatWorkspace,
  chatWorkspaceLabel,
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
  const baseSelectionContextKey = createProjectSelectionContextKey({
    selectedServerId,
    routeProjectKey,
    allowAllProjects,
  });
  const selectionContextKey = `${baseSelectionContextKey}:${
    allowChatWorkspace ? "chat-enabled" : "chat-disabled"
  }:${initialChatWorkspace ? "initial-chat" : ""}`;
  const manualSelectionContextKey = createManualProjectSelectionContextKey({
    selectedServerId,
    routeProjectKey,
  });
  const shouldPreserveMissingProject = useCallback(
    (project: HostProjectListItem) =>
      hasPendingArchiveForProject({
        selectedServerId,
        project,
      }),
    [selectedServerId],
  );
  const selectionContext = useMemo<ProjectSelectionContext>(
    () => ({
      contextKey: selectionContextKey,
      manualContextKey: manualSelectionContextKey,
      initialProject,
      initialProjectSource: resolveInitialProjectSelectionSource({
        initialProject,
        routeProject,
        lastActiveProject,
      }),
      projects: selectableProjects,
      routeProject,
      lastActiveProject,
      allowChatWorkspace,
      initialChatWorkspace,
      shouldPreserveMissingProject,
    }),
    [
      allowChatWorkspace,
      initialChatWorkspace,
      initialProject,
      lastActiveProject,
      manualSelectionContextKey,
      routeProject,
      selectableProjects,
      selectionContextKey,
      shouldPreserveMissingProject,
    ],
  );
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>(() =>
    createProjectSelection(selectionContext),
  );

  useEffect(() => {
    setProjectSelection((current) => reconcileProjectSelection(current, selectionContext));
  }, [selectionContext]);

  const activeSelection = reconcileProjectSelection(projectSelection, selectionContext);
  const isChatWorkspace = isChatProjectSelection(activeSelection);
  const selectedProject = resolveProjectSelection(activeSelection, selectionContext);
  const { options: projectPickerOptions, projectByOptionId } = useMemo(
    () =>
      computeProjectOptionData({
        projects: selectableProjects,
        allowChatWorkspace,
        chatWorkspaceLabel,
      }),
    [allowChatWorkspace, chatWorkspaceLabel, selectableProjects],
  );
  const handleSelectProjectOption = useCallback(
    (id: string) => {
      if (id === CHAT_WORKSPACE_OPTION_ID && allowChatWorkspace) {
        setProjectSelection(createChatProjectSelection(manualSelectionContextKey, "manual"));
        return;
      }
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
    [allowAllProjects, allowChatWorkspace, manualSelectionContextKey, projectByOptionId],
  );

  return {
    selectedProject,
    isChatWorkspace,
    selectedSourceDirectory: selectedProject
      ? getHostProjectSourceDirectory(selectedProject, selectedServerId)
      : null,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId: resolveSelectedProjectOptionId({
      isChatWorkspace,
      selectedProject,
    }),
    projectTriggerLabel: isChatWorkspace
      ? chatWorkspaceLabel
      : (selectedProject?.projectName ?? "Choose project"),
    handleSelectProjectOption,
  };
}
