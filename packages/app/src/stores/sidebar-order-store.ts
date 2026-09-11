import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface SidebarOrderStoreState {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
  workspaceSectionsByProject: Record<string, SidebarWorkspaceSection[]>;
  getProjectOrder: () => string[];
  setProjectOrder: (keys: string[]) => void;
  getPinnedWorkspaceOrder: () => string[];
  setPinnedWorkspaceOrder: (keys: string[]) => void;
  getWorkspaceOrder: (projectViewKey: string) => string[];
  setWorkspaceOrder: (projectViewKey: string, keys: string[]) => void;
  getWorkspaceSections: (projectViewKey: string) => SidebarWorkspaceSection[];
  createWorkspaceSection: (projectViewKey: string, name: string) => void;
  renameWorkspaceSection: (projectViewKey: string, sectionId: string, name: string) => void;
  reorderWorkspaceSections: (projectViewKey: string, sectionIds: string[]) => void;
  setWorkspaceSectionWorkspaceOrder: (
    projectViewKey: string,
    sectionId: string,
    workspaceKeys: string[],
  ) => void;
  deleteWorkspaceSection: (projectViewKey: string, sectionId: string) => void;
  moveWorkspaceToSection: (
    projectViewKey: string,
    workspaceKey: string,
    sectionId: string | null,
  ) => void;
}

interface SidebarOrderPersistedState {
  projectOrder?: string[];
  pinnedWorkspaceOrder?: string[];
  workspaceOrderByProject?: Record<string, string[]>;
  workspaceSectionsByProject?: Record<string, SidebarWorkspaceSection[]>;
  projectOrderByServerId?: Record<string, string[]>;
  workspaceOrderByServerAndProject?: Record<string, string[]>;
}

const SidebarWorkspaceSectionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  workspaceKeys: z.array(z.string()),
});

export type SidebarWorkspaceSection = z.infer<typeof SidebarWorkspaceSectionSchema>;

const StringArrayRecordSchema = z.record(z.string(), z.array(z.string()));
const WorkspaceSectionsRecordSchema = z.record(z.string(), z.array(SidebarWorkspaceSectionSchema));
const SidebarOrderPersistedStateSchema = z.strictObject({
  projectOrder: z.array(z.string()).optional(),
  pinnedWorkspaceOrder: z.array(z.string()).optional(),
  workspaceOrderByProject: StringArrayRecordSchema.optional(),
  workspaceSectionsByProject: WorkspaceSectionsRecordSchema.optional(),
  projectOrderByServerId: StringArrayRecordSchema.optional(),
  workspaceOrderByServerAndProject: StringArrayRecordSchema.optional(),
});

interface SidebarWorkspaceOrderScope {
  serverId: string;
  projectViewKey: string;
}

function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

function normalizeWorkspaceOrderByProject(
  workspaceOrderByProject: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [projectViewKey, order] of Object.entries(workspaceOrderByProject ?? {})) {
    const scope = projectViewKey.trim();
    if (!scope) continue;
    normalized[scope] = normalizeKeys(order);
  }
  return normalized;
}

function normalizeWorkspaceSections(
  sections: readonly SidebarWorkspaceSection[],
): SidebarWorkspaceSection[] {
  const seenSectionIds = new Set<string>();
  const placedWorkspaceKeys = new Set<string>();
  const normalized: SidebarWorkspaceSection[] = [];

  for (const section of sections) {
    const id = section.id.trim();
    const name = section.name.trim();
    if (!id || !name || seenSectionIds.has(id)) continue;

    const workspaceKeys = normalizeKeys(section.workspaceKeys).filter((workspaceKey) => {
      if (placedWorkspaceKeys.has(workspaceKey)) return false;
      placedWorkspaceKeys.add(workspaceKey);
      return true;
    });
    seenSectionIds.add(id);
    normalized.push({ id, name, workspaceKeys });
  }

  return normalized;
}

function normalizeWorkspaceSectionsByProject(
  workspaceSectionsByProject: Record<string, SidebarWorkspaceSection[]> | undefined,
): Record<string, SidebarWorkspaceSection[]> {
  const normalized: Record<string, SidebarWorkspaceSection[]> = {};
  for (const [projectViewKey, sections] of Object.entries(workspaceSectionsByProject ?? {})) {
    const scope = projectViewKey.trim();
    if (!scope) continue;
    normalized[scope] = normalizeWorkspaceSections(sections);
  }
  return normalized;
}

function withWorkspaceSections(
  workspaceSectionsByProject: Record<string, SidebarWorkspaceSection[]>,
  projectViewKey: string,
  update: (sections: SidebarWorkspaceSection[]) => SidebarWorkspaceSection[],
): Record<string, SidebarWorkspaceSection[]> {
  const scope = projectViewKey.trim();
  if (!scope) return workspaceSectionsByProject;
  const current = workspaceSectionsByProject[scope] ?? [];
  const next = normalizeWorkspaceSections(update(current));
  return { ...workspaceSectionsByProject, [scope]: next };
}

function renameSection(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
  name: string,
): SidebarWorkspaceSection[] {
  return sections.map((section) => (section.id === sectionId ? { ...section, name } : section));
}

function reorderSections(
  sections: SidebarWorkspaceSection[],
  sectionIds: readonly string[],
): SidebarWorkspaceSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const reordered: SidebarWorkspaceSection[] = [];
  for (const id of sectionIds) {
    const section = byId.get(id);
    if (section) reordered.push(section);
  }
  const reorderedIds = new Set(reordered.map((section) => section.id));
  return [...reordered, ...sections.filter((section) => !reorderedIds.has(section.id))];
}

function reorderSectionWorkspaceKeys(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
  workspaceKeys: readonly string[],
): SidebarWorkspaceSection[] {
  return sections.map((section) => {
    if (section.id !== sectionId) return section;
    const currentKeys = new Set(section.workspaceKeys);
    const orderedKeys = workspaceKeys.filter((key) => currentKeys.has(key));
    const orderedKeySet = new Set(orderedKeys);
    return {
      ...section,
      workspaceKeys: [
        ...orderedKeys,
        ...section.workspaceKeys.filter((key) => !orderedKeySet.has(key)),
      ],
    };
  });
}

function removeSection(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
): SidebarWorkspaceSection[] {
  return sections.filter((section) => section.id !== sectionId);
}

function moveWorkspaceSection(
  sections: SidebarWorkspaceSection[],
  workspaceKey: string,
  sectionId: string | null,
): SidebarWorkspaceSection[] {
  const targetExists = sectionId === null || sections.some((section) => section.id === sectionId);
  if (!targetExists) return sections;
  return sections.map((section) => {
    const workspaceKeys = section.workspaceKeys.filter((key) => key !== workspaceKey);
    if (section.id !== sectionId) return { ...section, workspaceKeys };
    return { ...section, workspaceKeys: [...workspaceKeys, workspaceKey] };
  });
}

function extractWorkspaceOrderScope(scopeKey: string): SidebarWorkspaceOrderScope | null {
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) return null;
  const serverId = scopeKey.slice(0, separatorIndex).trim();
  const projectViewKey = scopeKey.slice(separatorIndex + 2).trim();
  if (!serverId || !projectViewKey) return null;
  return { serverId, projectViewKey };
}

function normalizeLegacyWorkspaceKey(serverId: string, rawWorkspaceKey: string): string | null {
  const workspaceKey = rawWorkspaceKey.trim();
  if (!workspaceKey) return null;
  const serverPrefix = `${serverId}:`;
  return workspaceKey.startsWith(serverPrefix) ? workspaceKey : `${serverPrefix}${workspaceKey}`;
}

export function migrateSidebarOrderState(persistedState: unknown): {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
  workspaceSectionsByProject: Record<string, SidebarWorkspaceSection[]>;
} {
  const result = SidebarOrderPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
      workspaceSectionsByProject: {},
    };
  }
  const state: SidebarOrderPersistedState = result.data;

  const projectOrder = normalizeKeys(state.projectOrder ?? []);
  const seenProjects = new Set(projectOrder);
  for (const keys of Object.values(state.projectOrderByServerId ?? {})) {
    for (const key of normalizeKeys(keys)) {
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projectOrder.push(key);
    }
  }

  const workspaceOrderByProject = normalizeWorkspaceOrderByProject(state.workspaceOrderByProject);
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject ?? {})) {
    const scope = extractWorkspaceOrderScope(scopeKey);
    if (!scope) continue;
    const existing = workspaceOrderByProject[scope.projectViewKey] ?? [];
    const merged = [...existing];
    const seen = new Set(merged);
    for (const key of order) {
      const workspaceKey = normalizeLegacyWorkspaceKey(scope.serverId, key);
      if (!workspaceKey || seen.has(workspaceKey)) continue;
      seen.add(workspaceKey);
      merged.push(workspaceKey);
    }
    workspaceOrderByProject[scope.projectViewKey] = merged;
  }

  return {
    projectOrder,
    pinnedWorkspaceOrder: normalizeKeys(state.pinnedWorkspaceOrder ?? []),
    workspaceOrderByProject,
    workspaceSectionsByProject: normalizeWorkspaceSectionsByProject(
      state.workspaceSectionsByProject,
    ),
  };
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
      workspaceSectionsByProject: {},
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys) => {
        const normalized = normalizeKeys(keys);
        set({ projectOrder: normalized });
      },
      getPinnedWorkspaceOrder: () => get().pinnedWorkspaceOrder,
      setPinnedWorkspaceOrder: (keys) => {
        const normalized = normalizeKeys(keys);
        set({ pinnedWorkspaceOrder: normalized });
      },
      getWorkspaceOrder: (projectViewKey) => {
        const scope = projectViewKey.trim();
        if (!scope) return [];
        return get().workspaceOrderByProject[scope] ?? [];
      },
      setWorkspaceOrder: (projectViewKey, keys) => {
        const scope = projectViewKey.trim();
        if (!scope) return;
        const normalized = normalizeKeys(keys);
        set((state) => ({
          workspaceOrderByProject: {
            ...state.workspaceOrderByProject,
            [scope]: normalized,
          },
        }));
      },
      getWorkspaceSections: (projectViewKey) => {
        const scope = projectViewKey.trim();
        if (!scope) return [];
        return get().workspaceSectionsByProject[scope] ?? [];
      },
      createWorkspaceSection: (projectViewKey, name) => {
        const sectionName = name.trim();
        if (!sectionName || !projectViewKey.trim()) return;
        const randomId =
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const section: SidebarWorkspaceSection = {
          id: `section_${randomId}`,
          name: sectionName,
          workspaceKeys: [],
        };
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) => [...sections, section],
          ),
        }));
      },
      renameWorkspaceSection: (projectViewKey, sectionId, name) => {
        const sectionName = name.trim();
        const normalizedSectionId = sectionId.trim();
        if (!sectionName || !normalizedSectionId || !projectViewKey.trim()) return;
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) => renameSection(sections, normalizedSectionId, sectionName),
          ),
        }));
      },
      reorderWorkspaceSections: (projectViewKey, sectionIds) => {
        const normalizedSectionIds = normalizeKeys(sectionIds);
        if (!projectViewKey.trim()) return;
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) => reorderSections(sections, normalizedSectionIds),
          ),
        }));
      },
      setWorkspaceSectionWorkspaceOrder: (projectViewKey, sectionId, workspaceKeys) => {
        const normalizedSectionId = sectionId.trim();
        const reorderedWorkspaceKeys = normalizeKeys(workspaceKeys);
        if (!normalizedSectionId || !projectViewKey.trim()) return;
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) =>
              reorderSectionWorkspaceKeys(sections, normalizedSectionId, reorderedWorkspaceKeys),
          ),
        }));
      },
      deleteWorkspaceSection: (projectViewKey, sectionId) => {
        const normalizedSectionId = sectionId.trim();
        if (!normalizedSectionId || !projectViewKey.trim()) return;
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) => removeSection(sections, normalizedSectionId),
          ),
        }));
      },
      moveWorkspaceToSection: (projectViewKey, workspaceKey, sectionId) => {
        const normalizedWorkspaceKey = workspaceKey.trim();
        const normalizedSectionId = sectionId?.trim() || null;
        if (!normalizedWorkspaceKey || !projectViewKey.trim()) return;
        set((state) => ({
          workspaceSectionsByProject: withWorkspaceSections(
            state.workspaceSectionsByProject,
            projectViewKey,
            (sections) =>
              moveWorkspaceSection(sections, normalizedWorkspaceKey, normalizedSectionId),
          ),
        }));
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarOrderPersistedStateSchema),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        pinnedWorkspaceOrder: state.pinnedWorkspaceOrder,
        workspaceOrderByProject: state.workspaceOrderByProject,
        workspaceSectionsByProject: state.workspaceSectionsByProject,
      }),
      version: 1,
      migrate: migrateSidebarOrderState,
    },
  ),
);
