import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * Sidebar folders group projects for organization only. They are client-local, like the
 * project order, so a folder never reaches a host and has no meaning beyond this sidebar.
 */
export interface SidebarFolder {
  id: string;
  name: string;
}

/** The identities a folder assignment hangs on, as on `SidebarProjectEntry`. */
export interface SidebarFolderProject {
  viewKey: string;
  hosts: readonly { serverId: string; projectId: string }[];
}

export interface SidebarFoldersState {
  /** Render order. */
  folders: SidebarFolder[];
  /**
   * One record per foldered project, holding every ref that project has ever had. A project
   * matching no record sits at the root.
   *
   * A project has several refs because neither identity survives everything on its own:
   * `serverId:projectId` is stable per host but is lost when that host goes away, and
   * `view:<viewKey>` spans hosts but follows `projectKey`, which changes with the git remote.
   * `reconcileSidebarFolderAssignments` adds any ref a project gains to its record. Keeping a
   * project's refs in one record is what lets a move replace all of them at once, so a ref from
   * a host or remote the project left cannot pull it back into a folder it was moved out of.
   */
  projectAssignments: SidebarFolderAssignment[];
  collapsedFolderIds: string[];
}

export interface SidebarFolderAssignment {
  folderId: string;
  refs: string[];
}

const SidebarFoldersPersistedStateSchema = z.strictObject({
  folders: z.array(z.strictObject({ id: z.string(), name: z.string() })).optional(),
  projectAssignments: z
    .array(z.strictObject({ folderId: z.string(), refs: z.array(z.string()) }))
    .optional(),
  collapsedFolderIds: z.array(z.string()).optional(),
});

function projectRefs(project: SidebarFolderProject): string[] {
  return [
    ...project.hosts.map((host) => `${host.serverId}:${host.projectId}`),
    `view:${project.viewKey}`,
  ];
}

function sharesRef(assignment: SidebarFolderAssignment, refs: readonly string[]): boolean {
  return refs.some((ref) => assignment.refs.includes(ref));
}

/** The folder a project sits in: the first record sharing a ref, if its folder still exists. */
export function resolveSidebarProjectFolderId(
  state: {
    folders: readonly SidebarFolder[];
    projectAssignments: readonly SidebarFolderAssignment[];
  },
  project: SidebarFolderProject,
): string | null {
  const refs = projectRefs(project);
  const assignment = state.projectAssignments.find((candidate) => sharesRef(candidate, refs));
  if (!assignment) return null;
  return state.folders.some((folder) => folder.id === assignment.folderId)
    ? assignment.folderId
    : null;
}

export function normalizeSidebarFolderName(name: string): string {
  return name.trim();
}

function createFolderId(): string {
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSidebarFolder(
  state: SidebarFoldersState,
  input: { id: string; name: string },
): SidebarFoldersState {
  const name = normalizeSidebarFolderName(input.name);
  if (!name) return state;
  return { ...state, folders: [...state.folders, { id: input.id, name }] };
}

export function renameSidebarFolder(
  state: SidebarFoldersState,
  folderId: string,
  rawName: string,
): SidebarFoldersState {
  const name = normalizeSidebarFolderName(rawName);
  if (!name) return state;
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder)),
  };
}

/** Deleting a folder returns its projects to the root; it never removes a project. */
export function deleteSidebarFolder(
  state: SidebarFoldersState,
  folderId: string,
): SidebarFoldersState {
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    projectAssignments: state.projectAssignments.filter(
      (assignment) => assignment.folderId !== folderId,
    ),
    collapsedFolderIds: state.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

export function moveSidebarFolder(
  state: SidebarFoldersState,
  folderId: string,
  offset: -1 | 1,
): SidebarFoldersState {
  const index = state.folders.findIndex((folder) => folder.id === folderId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= state.folders.length) return state;
  const folders = [...state.folders];
  [folders[index], folders[target]] = [folders[target], folders[index]];
  return { ...state, folders };
}

/**
 * Replaces every record that shares a ref with the project — including refs from hosts or
 * remotes it has since left — with one record under `folderId`, or with none for the root.
 */
export function assignProjectToSidebarFolder(
  state: SidebarFoldersState,
  project: SidebarFolderProject,
  folderId: string | null,
): SidebarFoldersState {
  const refs = projectRefs(project);
  const matched = state.projectAssignments.filter((assignment) => sharesRef(assignment, refs));
  const projectAssignments = state.projectAssignments.filter(
    (assignment) => !matched.includes(assignment),
  );
  if (folderId && state.folders.some((folder) => folder.id === folderId)) {
    const allRefs = new Set([...matched.flatMap((assignment) => assignment.refs), ...refs]);
    projectAssignments.push({ folderId, refs: [...allRefs] });
  }
  return { ...state, projectAssignments };
}

/**
 * Adds any ref a foldered project has gained — a host it just joined, a `viewKey` it just took —
 * to its record. Returns `state` untouched when nothing is missing, so an effect calling this on
 * every project change settles after one write.
 */
export function reconcileSidebarFolderAssignments(
  state: SidebarFoldersState,
  projects: readonly SidebarFolderProject[],
): SidebarFoldersState {
  let projectAssignments: SidebarFolderAssignment[] | null = null;
  for (const project of projects) {
    const refs = projectRefs(project);
    const current = projectAssignments ?? state.projectAssignments;
    const index = current.findIndex((assignment) => sharesRef(assignment, refs));
    if (index < 0) continue;
    const assignment = current[index]!;
    const missing = refs.filter((ref) => !assignment.refs.includes(ref));
    if (missing.length === 0) continue;
    projectAssignments ??= [...state.projectAssignments];
    projectAssignments[index] = { ...assignment, refs: [...assignment.refs, ...missing] };
  }
  return projectAssignments ? { ...state, projectAssignments } : state;
}

export function toggleSidebarFolderCollapsed(
  state: SidebarFoldersState,
  folderId: string,
): SidebarFoldersState {
  const collapsedFolderIds = state.collapsedFolderIds.includes(folderId)
    ? state.collapsedFolderIds.filter((id) => id !== folderId)
    : [...state.collapsedFolderIds, folderId];
  return { ...state, collapsedFolderIds };
}

interface SidebarFoldersStore extends SidebarFoldersState {
  /** Creates a folder and returns its id, or null when the name is blank. */
  createFolder: (name: string) => string | null;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, offset: -1 | 1) => void;
  assignProject: (project: SidebarFolderProject, folderId: string | null) => void;
  reconcileProjects: (projects: readonly SidebarFolderProject[]) => void;
  toggleFolderCollapsed: (folderId: string) => void;
}

export const useSidebarFoldersStore = create<SidebarFoldersStore>()(
  persist(
    (set) => ({
      folders: [],
      projectAssignments: [],
      collapsedFolderIds: [],
      createFolder: (name) => {
        if (!normalizeSidebarFolderName(name)) return null;
        const id = createFolderId();
        set((state) => createSidebarFolder(state, { id, name }));
        return id;
      },
      renameFolder: (folderId, name) => set((state) => renameSidebarFolder(state, folderId, name)),
      deleteFolder: (folderId) => set((state) => deleteSidebarFolder(state, folderId)),
      moveFolder: (folderId, offset) => set((state) => moveSidebarFolder(state, folderId, offset)),
      assignProject: (project, folderId) =>
        set((state) => assignProjectToSidebarFolder(state, project, folderId)),
      reconcileProjects: (projects) =>
        set((state) => reconcileSidebarFolderAssignments(state, projects)),
      toggleFolderCollapsed: (folderId) =>
        set((state) => toggleSidebarFolderCollapsed(state, folderId)),
    }),
    {
      name: "sidebar-folders",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarFoldersPersistedStateSchema),
      partialize: (state) => ({
        folders: state.folders,
        projectAssignments: state.projectAssignments,
        collapsedFolderIds: state.collapsedFolderIds,
      }),
    },
  ),
);
