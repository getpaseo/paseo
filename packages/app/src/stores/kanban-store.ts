// Kanban store — Zustand-based, adapted from emdash's kanbanStore.ts
// Persists kanban statuses using AsyncStorage (cross-platform)

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KanbanStatus, KanbanTask, TaskIntegrationContext } from "@/types/kanban";

interface KanbanState {
  // Status map: taskId -> kanban column
  statusByTask: Record<string, KanbanStatus>;
  // Tasks list
  tasks: KanbanTask[];
  // True after AsyncStorage rehydration completes
  _hasHydrated: boolean;

  // Actions
  getStatus: (taskId: string) => KanbanStatus;
  setStatus: (taskId: string, status: KanbanStatus) => void;
  addTask: (task: KanbanTask) => void;
  removeTask: (taskId: string) => void;
  updateTask: (taskId: string, changes: Partial<KanbanTask>) => void;
  clearAll: () => void;
  /** Archive (remove) all tasks linked to a workspace path */
  archiveByWorkspacePath: (workspacePath: string) => void;
}

export const useKanbanStore = create<KanbanState>()(
  persist(
    (set, get) => ({
      statusByTask: {},
      tasks: [],
      _hasHydrated: false,

      getStatus: (taskId: string) => {
        return get().statusByTask[taskId] || "todo";
      },

      setStatus: (taskId: string, status: KanbanStatus) => {
        set((state) => ({
          statusByTask: { ...state.statusByTask, [taskId]: status },
        }));
      },

      addTask: (task: KanbanTask) => {
        console.log(`[KanbanStore] addTask`, {
          taskId: task.id,
          name: task.name,
          hasIntegrations: !!task.integrations,
          integrationKeys: task.integrations ? Object.keys(task.integrations) : [],
          hasMetadata: !!task.metadata,
          metadataKeys: task.metadata ? Object.keys(task.metadata) : [],
        });
        set((state) => ({
          tasks: [...state.tasks, task],
          statusByTask: { ...state.statusByTask, [task.id]: "todo" },
        }));
      },

      removeTask: (taskId: string) => {
        set((state) => {
          const { [taskId]: _, ...rest } = state.statusByTask;
          return {
            tasks: state.tasks.filter((t) => t.id !== taskId),
            statusByTask: rest,
          };
        });
      },

      updateTask: (taskId: string, changes: Partial<KanbanTask>) => {
        console.log(`[KanbanStore] updateTask`, {
          taskId,
          changeKeys: Object.keys(changes),
          hasIntegrationsChange: "integrations" in changes,
          hasMetadataChange: "metadata" in changes,
        });
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, ...changes } : t)),
        }));
      },

      clearAll: () => {
        set({ statusByTask: {}, tasks: [] });
      },

      archiveByWorkspacePath: (workspacePath: string) => {
        set((state) => {
          const toRemove = new Set(
            state.tasks.filter((t) => t.path === workspacePath).map((t) => t.id),
          );
          if (toRemove.size === 0) return state;
          const statusByTask = { ...state.statusByTask };
          for (const id of toRemove) {
            delete statusByTask[id];
          }
          return {
            tasks: state.tasks.filter((t) => !toRemove.has(t.id)),
            statusByTask,
          };
        });
      },
    }),
    {
      name: "hubcode:kanban",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        statusByTask: state.statusByTask,
        tasks: state.tasks,
      }),
      onRehydrateStorage: (state) => {
        console.log(`[KanbanStore] rehydration STARTING...`);
        return (hydratedState, error) => {
          if (error) {
            console.error(`[KanbanStore] rehydration ERROR:`, error);
          }
          if (hydratedState) {
            console.log(`[KanbanStore] rehydrated from AsyncStorage`, {
              taskCount: hydratedState.tasks.length,
              tasks: hydratedState.tasks.map((t) => ({
                id: t.id,
                name: t.name,
                hasIntegrations: !!t.integrations,
                integrationKeys: t.integrations ? Object.keys(t.integrations) : [],
                hasMetadata: !!t.metadata,
                metadataKeys: t.metadata ? Object.keys(t.metadata) : [],
              })),
            });
          } else {
            console.warn(`[KanbanStore] rehydration returned NO state`);
          }
          // _hasHydrated is set via onFinishHydration below (proper Zustand
          // setState so subscribers re-render).
        };
      },
    },
  ),
);

// Mark hydration complete via proper setState so Zustand subscribers re-render.
// Direct mutation inside onRehydrateStorage doesn't trigger React updates.
useKanbanStore.persist.onFinishHydration(() => {
  useKanbanStore.setState({ _hasHydrated: true });
});

// Selectors
export function selectTasksByStatus(
  tasks: KanbanTask[],
  statusByTask: Record<string, KanbanStatus>,
): Record<KanbanStatus, KanbanTask[]> {
  const result: Record<KanbanStatus, KanbanTask[]> = {
    todo: [],
    "in-progress": [],
    done: [],
  };
  for (const task of tasks) {
    const status = statusByTask[task.id] || "todo";
    result[status].push(task);
  }
  return result;
}
