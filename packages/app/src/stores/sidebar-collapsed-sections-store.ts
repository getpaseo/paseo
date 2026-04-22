import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarCollapsedSectionsState {
  collapsedProjectKeys: Set<string>;
  toggleProjectCollapsed: (projectKey: string) => void;
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void;
}

type PersistedSidebarCollapsedSectionsState = {
  collapsedProjectKeys?: string[];
};

function serializeCollapsedProjectKeys(keys: Set<string>): string[] {
  return Array.from(keys);
}

function deserializeCollapsedProjectKeys(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(value.filter((key): key is string => typeof key === "string"));
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }

  return true;
}

export const useSidebarCollapsedSectionsStore = create<SidebarCollapsedSectionsState>()(
  persist(
    (set) => ({
      collapsedProjectKeys: new Set(),
      toggleProjectCollapsed: (projectKey) =>
        set((state) => {
          const next = new Set(state.collapsedProjectKeys);
          if (next.has(projectKey)) {
            next.delete(projectKey);
          } else {
            next.add(projectKey);
          }
          return { collapsedProjectKeys: next };
        }),
      setProjectCollapsed: (projectKey, collapsed) =>
        set((state) => {
          const next = new Set(state.collapsedProjectKeys);
          if (collapsed) {
            next.add(projectKey);
          } else {
            next.delete(projectKey);
          }
          return { collapsedProjectKeys: next };
        }),
    }),
    {
      name: "sidebar-collapsed-sections",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        collapsedProjectKeys: serializeCollapsedProjectKeys(state.collapsedProjectKeys),
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as PersistedSidebarCollapsedSectionsState | undefined;
        if (!persisted?.collapsedProjectKeys) {
          return currentState;
        }
        const collapsedProjectKeys = deserializeCollapsedProjectKeys(
          persisted.collapsedProjectKeys,
        );
        if (areSetsEqual(currentState.collapsedProjectKeys, collapsedProjectKeys)) {
          return currentState;
        }

        return {
          ...currentState,
          collapsedProjectKeys,
        };
      },
    },
  ),
);
