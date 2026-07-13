import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarProjectPreferencesState {
  pinnedProjectKeys: string[];
  collections: SidebarProjectCollection[];
  collectionIdByProjectKey: Record<string, string>;
  toggleProjectPinned: (projectKey: string) => void;
  createCollection: (name: string) => string;
  renameCollection: (collectionId: string, name: string) => void;
  deleteCollection: (collectionId: string) => void;
  assignProjectToCollection: (projectKey: string, collectionId: string | null) => void;
}

// Project pins and groups describe how this client presents the sidebar. They are deliberately
// device-local view preferences; workspace pins and labels remain daemon-backed shared metadata.

export interface SidebarProjectCollection {
  id: string;
  name: string;
  createdAt: string;
}

function normalizeProjectKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function migrateSidebarProjectPreferencesState(persistedState: unknown): {
  pinnedProjectKeys: string[];
  collections: SidebarProjectCollection[];
  collectionIdByProjectKey: Record<string, string>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { pinnedProjectKeys: [], collections: [], collectionIdByProjectKey: {} };
  }
  const source = persistedState as {
    pinnedProjectKeys?: unknown;
    collections?: unknown;
    collectionIdByProjectKey?: unknown;
  };
  const seenCollectionIds = new Set<string>();
  const collections = Array.isArray(source.collections)
    ? source.collections.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as { id?: unknown; name?: unknown; createdAt?: unknown };
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!id || !name || seenCollectionIds.has(id)) return [];
        seenCollectionIds.add(id);
        return [
          {
            id,
            name,
            createdAt:
              typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
          },
        ];
      })
    : [];
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const collectionIdByProjectKey: Record<string, string> = {};
  if (source.collectionIdByProjectKey && typeof source.collectionIdByProjectKey === "object") {
    for (const [rawProjectKey, rawCollectionId] of Object.entries(
      source.collectionIdByProjectKey,
    )) {
      const projectKey = rawProjectKey.trim();
      if (projectKey && typeof rawCollectionId === "string" && collectionIds.has(rawCollectionId)) {
        collectionIdByProjectKey[projectKey] = rawCollectionId;
      }
    }
  }
  return {
    pinnedProjectKeys: normalizeProjectKeys(source.pinnedProjectKeys),
    collections,
    collectionIdByProjectKey,
  };
}

function newCollectionId(): string {
  return `project-collection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSidebarProjectPreferencesStore = create<SidebarProjectPreferencesState>()(
  persist(
    (set) => ({
      pinnedProjectKeys: [],
      collections: [],
      collectionIdByProjectKey: {},
      toggleProjectPinned: (projectKey) => {
        const key = projectKey.trim();
        if (!key) return;
        set((state) => ({
          pinnedProjectKeys: state.pinnedProjectKeys.includes(key)
            ? state.pinnedProjectKeys.filter((existing) => existing !== key)
            : [...state.pinnedProjectKeys, key],
        }));
      },
      createCollection: (name) => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project group name is required");
        const id = newCollectionId();
        set((state) => ({
          collections: [
            ...state.collections,
            { id, name: trimmedName, createdAt: new Date().toISOString() },
          ],
        }));
        return id;
      },
      renameCollection: (collectionId, name) => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project group name is required");
        set((state) => ({
          collections: state.collections.map((collection) =>
            collection.id === collectionId ? { ...collection, name: trimmedName } : collection,
          ),
        }));
      },
      deleteCollection: (collectionId) => {
        set((state) => ({
          collections: state.collections.filter((collection) => collection.id !== collectionId),
          collectionIdByProjectKey: Object.fromEntries(
            Object.entries(state.collectionIdByProjectKey).filter(
              ([, assignedCollectionId]) => assignedCollectionId !== collectionId,
            ),
          ),
        }));
      },
      assignProjectToCollection: (projectKey, collectionId) => {
        const key = projectKey.trim();
        if (!key) return;
        set((state) => {
          const next = { ...state.collectionIdByProjectKey };
          if (
            collectionId &&
            state.collections.some((collection) => collection.id === collectionId)
          ) {
            next[key] = collectionId;
          } else {
            delete next[key];
          }
          return { collectionIdByProjectKey: next };
        });
      },
    }),
    {
      name: "sidebar-project-preferences",
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        pinnedProjectKeys: state.pinnedProjectKeys,
        collections: state.collections,
        collectionIdByProjectKey: state.collectionIdByProjectKey,
      }),
      migrate: migrateSidebarProjectPreferencesState,
    },
  ),
);
