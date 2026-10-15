import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { WorkspaceScriptLinkKind } from "@/utils/workspace-script-links";

interface WorkspaceServiceRoutePreferencesState {
  byServerId: Record<string, WorkspaceScriptLinkKind>;
  /** Dev-preview service choice, keyed by `buildWorkspaceTabPersistenceKey`. */
  preferredScriptByWorkspace: Record<string, string>;
  setPreferredRoute: (serverId: string, kind: WorkspaceScriptLinkKind) => void;
  setPreferredScript: (workspaceKey: string, scriptName: string) => void;
}

const WorkspaceScriptLinkKindSchema = z.enum(["public", "paseo", "direct"]);
const WorkspaceServiceRoutePreferencesSchema = z.strictObject({
  byServerId: z.record(z.string(), WorkspaceScriptLinkKindSchema),
  // Optional at read: blobs written before preview choices existed parse unchanged.
  preferredScriptByWorkspace: z.record(z.string(), z.string()).optional(),
});

export function createWorkspaceServiceRoutePreferencesStore(storage: StateStorage) {
  return create<WorkspaceServiceRoutePreferencesState>()(
    persist<
      WorkspaceServiceRoutePreferencesState,
      [],
      [],
      z.infer<typeof WorkspaceServiceRoutePreferencesSchema>
    >(
      (set) => ({
        byServerId: {},
        preferredScriptByWorkspace: {},
        setPreferredRoute: (serverId, kind) =>
          set((state) => ({ byServerId: { ...state.byServerId, [serverId]: kind } })),
        setPreferredScript: (workspaceKey, scriptName) =>
          set((state) => ({
            preferredScriptByWorkspace: {
              ...state.preferredScriptByWorkspace,
              [workspaceKey]: scriptName,
            },
          })),
      }),
      {
        name: "workspace-service-route-preferences",
        version: 1,
        storage: createValidatedPersistStorage(storage, WorkspaceServiceRoutePreferencesSchema),
        partialize: (state) => ({
          byServerId: state.byServerId,
          preferredScriptByWorkspace: state.preferredScriptByWorkspace,
        }),
        merge: (persistedState, currentState) => {
          const result = WorkspaceServiceRoutePreferencesSchema.safeParse(persistedState);
          return {
            ...currentState,
            byServerId: result.success ? result.data.byServerId : {},
            preferredScriptByWorkspace: result.success
              ? (result.data.preferredScriptByWorkspace ?? {})
              : {},
          };
        },
      },
    ),
  );
}

export const useWorkspaceServiceRoutePreferencesStore =
  createWorkspaceServiceRoutePreferencesStore(AsyncStorage);
