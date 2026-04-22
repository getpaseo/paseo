import type { SessionOutboundMessage } from "@server/shared/messages";
import { create } from "zustand";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";

export type WorkspaceSetupNavigationMethod = "navigate" | "replace";
export type WorkspaceCreationMethod = "open_project" | "create_worktree";

export interface PendingWorkspaceSetup {
  serverId: string;
  sourceDirectory: string;
  sourceWorkspaceId?: string;
  displayName?: string;
  creationMethod: WorkspaceCreationMethod;
  navigationMethod: WorkspaceSetupNavigationMethod;
}

export type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

export interface WorkspaceSetupSnapshot extends WorkspaceSetupProgressPayload {
  updatedAt: number;
}

export function shouldShowWorkspaceSetup(snapshot: WorkspaceSetupSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }
  return snapshot.error !== null || snapshot.detail.commands.length > 0;
}

interface WorkspaceSetupStoreState {
  pendingWorkspaceSetup: PendingWorkspaceSetup | null;
  snapshots: Record<string, WorkspaceSetupSnapshot>;
  beginWorkspaceSetup: (value: PendingWorkspaceSetup) => void;
  clearWorkspaceSetup: () => void;
  upsertProgress: (input: { serverId: string; payload: WorkspaceSetupProgressPayload }) => void;
  removeWorkspace: (input: { serverId: string; workspaceId: string }) => void;
  clearServer: (serverId: string) => void;
}

function buildWorkspaceSetupKey(input: { serverId: string; workspaceId: string }): string | null {
  return buildWorkspaceTabPersistenceKey(input);
}

export const useWorkspaceSetupStore = create<WorkspaceSetupStoreState>()((set) => ({
  pendingWorkspaceSetup: null,
  snapshots: {},
  beginWorkspaceSetup: (value) => {
    set({ pendingWorkspaceSetup: value });
  },
  clearWorkspaceSetup: () => {
    set({ pendingWorkspaceSetup: null });
  },
  upsertProgress: ({ serverId, payload }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId: payload.workspaceId });
    if (!key) {
      return;
    }

    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [key]: {
          ...payload,
          updatedAt: Date.now(),
        },
      },
    }));
  },
  removeWorkspace: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }

    set((state) => {
      if (!(key in state.snapshots)) {
        return state;
      }
      const next = { ...state.snapshots };
      delete next[key];
      return { snapshots: next };
    });
  },
  clearServer: (serverId) => {
    set((state) => {
      const nextEntries = Object.entries(state.snapshots).filter(
        ([key]) => !key.startsWith(`${serverId}:`),
      );
      if (nextEntries.length === Object.keys(state.snapshots).length) {
        return state;
      }
      return { snapshots: Object.fromEntries(nextEntries) };
    });
  },
}));
