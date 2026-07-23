import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { WorkspaceScriptLinkKind } from "@/utils/workspace-script-links";

interface WorkspaceServiceRoutePreferencesState {
  byServerId: Record<string, WorkspaceScriptLinkKind>;
  setPreferredRoute: (serverId: string, kind: WorkspaceScriptLinkKind) => void;
}

function isWorkspaceScriptLinkKind(value: unknown): value is WorkspaceScriptLinkKind {
  return value === "public" || value === "paseo" || value === "direct";
}

function sanitizePreferences(value: unknown): Record<string, WorkspaceScriptLinkKind> {
  if (!value || typeof value !== "object") return {};
  const byServerId = (value as { byServerId?: unknown }).byServerId;
  if (!byServerId || typeof byServerId !== "object") return {};

  const result: Record<string, WorkspaceScriptLinkKind> = {};
  for (const [serverId, kind] of Object.entries(byServerId)) {
    if (isWorkspaceScriptLinkKind(kind)) result[serverId] = kind;
  }
  return result;
}

export function createWorkspaceServiceRoutePreferencesStore(storage: StateStorage) {
  return create<WorkspaceServiceRoutePreferencesState>()(
    persist(
      (set) => ({
        byServerId: {},
        setPreferredRoute: (serverId, kind) =>
          set((state) => ({ byServerId: { ...state.byServerId, [serverId]: kind } })),
      }),
      {
        name: "workspace-service-route-preferences",
        version: 1,
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({ byServerId: state.byServerId }),
        merge: (persistedState, currentState) => ({
          ...currentState,
          byServerId: sanitizePreferences(persistedState),
        }),
      },
    ),
  );
}

export const useWorkspaceServiceRoutePreferencesStore =
  createWorkspaceServiceRoutePreferencesStore(AsyncStorage);
