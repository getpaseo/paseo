import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import type { ComboboxOption } from "@/components/ui/combobox";
import {
  getWorktreeSupportForHostProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";
import {
  buildProjectPickerOptions,
  type ProjectPickerOption,
} from "@/components/project-picker-options";
import { pathBaseName } from "@/add-project-flow/options";
import { shortenPath } from "@/utils/shorten-path";

// Folder-mode option ids carry the absolute path after this prefix. Any other id
// is a project option from useNewWorkspaceProjectPicker.
export const FOLDER_OPTION_PREFIX = "dir:";

export type ProjectPickerMode = "project" | "folder";

/**
 * An ad-hoc folder target: the workspace runs in a directory picked from the
 * host filesystem without a pre-registered project. The daemon registers the
 * directory's project implicitly on workspace.create. A /new?dir= route without
 * projectId seeds it via initialFolderTarget.
 */
export function useNewWorkspaceFolderTarget(initialFolderTarget: string | null) {
  const [folderTarget, setFolderTarget] = useState<string | null>(initialFolderTarget);
  const selectFolderTarget = useCallback((path: string) => {
    const trimmed = path.trim();
    if (trimmed) setFolderTarget(trimmed);
  }, []);
  const clearFolderTarget = useCallback(() => setFolderTarget(null), []);
  return { folderTarget, selectFolderTarget, clearFolderTarget };
}

// A dir-only /new route (no projectId) targets that folder ad hoc.
export function resolveInitialFolderTarget(input: {
  sourceDirectory?: string;
  projectId?: string;
}): string | null {
  const dir = input.sourceDirectory?.trim() ?? "";
  return dir && !input.projectId?.trim() ? dir : null;
}

export function folderOptionId(path: string): string {
  return `${FOLDER_OPTION_PREFIX}${path}`;
}

export function pathFromFolderOptionId(id: string): string | null {
  return id.startsWith(FOLDER_OPTION_PREFIX) ? id.slice(FOLDER_OPTION_PREFIX.length) : null;
}

export function resolveFolderTriggerLabel(folderTarget: string): string {
  return pathBaseName(folderTarget) || folderTarget;
}

export function buildFolderPickerComboboxOptions(input: {
  serverPaths: string[];
  query: string;
  t: TFunction;
}): ComboboxOption[] {
  return buildProjectPickerOptions({
    recommendedPaths: [],
    serverPaths: input.serverPaths,
    query: input.query,
  }).map((option) => folderPickerComboboxOption(option, input.t));
}

function folderPickerComboboxOption(option: ProjectPickerOption, t: TFunction): ComboboxOption {
  const shortPath = shortenPath(option.path);
  if (option.kind === "path") {
    return {
      id: folderOptionId(option.path),
      label: t("newWorkspace.folderPicker.usePath", { path: option.path }),
      description: t("newWorkspace.folderPicker.openPath"),
    };
  }
  return {
    id: folderOptionId(option.path),
    label: shortPath,
    description: shortPath === option.path ? undefined : option.path,
  };
}

export function folderPickerEmptyText(input: { isFetching: boolean; t: TFunction }): string {
  return input.isFetching
    ? input.t("newWorkspace.folderPicker.searching")
    : input.t("newWorkspace.folderPicker.noMatchingFolders");
}

export interface FolderTargetView {
  /** Null while a folder target is active: the project stops scoping the workspace. */
  project: HostProjectListItem | null;
  sourceDirectory: string | null;
  /** Drives clearPickerSelectionForTargetChange when the picker target changes. */
  pickerTargetId: string;
  triggerLabel: string;
  /** The combobox shows no selected project while a folder target is active. */
  comboboxValue: string;
}

export function resolveFolderTargetView(input: {
  folderTarget: string | null;
  selectedProject: HostProjectListItem | null;
  selectedSourceDirectory: string | null;
  projectTriggerLabel: string;
  selectedProjectOptionId: string;
}): FolderTargetView {
  const folderTarget = input.folderTarget;
  return {
    project: folderTarget ? null : input.selectedProject,
    sourceDirectory: folderTarget ?? input.selectedSourceDirectory,
    pickerTargetId: folderTarget ? folderOptionId(folderTarget) : input.selectedProjectOptionId,
    triggerLabel: folderTarget
      ? resolveFolderTriggerLabel(folderTarget)
      : input.projectTriggerLabel,
    comboboxValue: folderTarget ? "" : input.selectedProjectOptionId,
  };
}

export interface ProjectPickerPresentation {
  options: ComboboxOption[];
  value: string;
  searchPlaceholder: string;
  title: string;
  emptyText: string;
  onSearchQueryChange: ((query: string) => void) | undefined;
  footer: ReactNode;
}

// The project combobox has two modes: registered projects, or a host directory
// search fed by the daemon's directory_suggestions RPC.
export function resolveProjectPickerPresentation(input: {
  mode: ProjectPickerMode;
  projectOptions: ComboboxOption[];
  comboboxValue: string;
  folderOptions: ComboboxOption[];
  folderEmptyText: string;
  onFolderQueryChange: (query: string) => void;
  footer: ReactNode;
  folderFooter: ReactNode;
  t: TFunction;
}): ProjectPickerPresentation {
  if (input.mode === "folder") {
    return {
      options: input.folderOptions,
      value: "",
      searchPlaceholder: input.t("newWorkspace.folderPicker.searchPlaceholder"),
      title: input.t("newWorkspace.folderPicker.title"),
      emptyText: input.folderEmptyText,
      onSearchQueryChange: input.onFolderQueryChange,
      footer: input.folderFooter,
    };
  }
  return {
    options: input.projectOptions,
    value: input.comboboxValue,
    searchPlaceholder: "Search projects",
    title: "Project",
    emptyText: "No projects available.",
    onSearchQueryChange: undefined,
    footer: input.footer,
  };
}

// A folder target is a plain directory: no worktrees, no ref picker. Treat it as
// worktree-unsupported so isolation collapses to local.
export function resolveFolderAwareWorktreeSupport(input: {
  folderTarget: string | null;
  selectedProject: HostProjectListItem | null;
  serverId: string;
}): WorkspaceStructureHostPlacement["worktreeSupport"] {
  const project = input.folderTarget ? null : input.selectedProject;
  return project
    ? getWorktreeSupportForHostProject({ project, serverId: input.serverId })
    : "unsupported";
}

export function resolveFolderPickerQueryEnabled(input: {
  pickerOpen: boolean;
  mode: ProjectPickerMode;
  clientReady: boolean;
}): boolean {
  return input.pickerOpen && input.mode === "folder" && input.clientReady;
}

export function folderAwareShowRefPicker(
  showRefPicker: boolean,
  folderTarget: string | null,
): boolean {
  return showRefPicker && !folderTarget;
}

export function dispatchProjectPickerSelect(input: {
  mode: ProjectPickerMode;
  id: string;
  onFolderPath: (path: string) => void;
  onProjectOption: (id: string) => void;
}): void {
  if (input.mode === "folder") {
    const path = pathFromFolderOptionId(input.id);
    if (path) input.onFolderPath(path);
    return;
  }
  input.onProjectOption(input.id);
}
