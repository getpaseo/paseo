import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";

export type WorkspaceCreationMethod = "open_project" | "create_worktree";

export interface PendingWorkspaceSetup {
  serverId: string;
  sourceDirectory: string;
  sourceWorkspaceId?: string;
  displayName?: string;
  creationMethod: WorkspaceCreationMethod;
}

export type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

export type WorkspaceSetupStatusResult = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_status_response" }
>["payload"];

export interface WorkspaceSetupStatusClient {
  fetchWorkspaceSetupStatus: (workspaceId: string) => Promise<WorkspaceSetupStatusResult>;
}

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
  requestedKeys: Set<string>;
  beginWorkspaceSetup: (value: PendingWorkspaceSetup) => void;
  clearWorkspaceSetup: () => void;
  upsertProgress: (input: { serverId: string; payload: WorkspaceSetupProgressPayload }) => void;
  ensureSetupStatus: (input: {
    serverId: string;
    workspaceId: string;
    client: WorkspaceSetupStatusClient;
  }) => void;
  removeWorkspace: (input: { serverId: string; workspaceId: string }) => void;
  clearServer: (serverId: string) => void;
}

function buildWorkspaceSetupKey(input: { serverId: string; workspaceId: string }): string | null {
  return buildWorkspaceTabPersistenceKey(input);
}

function forgetRequestedKey(requestedKeys: Set<string>, key: string): Set<string> {
  if (!requestedKeys.has(key)) {
    return requestedKeys;
  }
  const next = new Set(requestedKeys);
  next.delete(key);
  return next;
}

export const useWorkspaceSetupStore = create<WorkspaceSetupStoreState>()((set, get) => ({
  pendingWorkspaceSetup: null,
  snapshots: {},
  requestedKeys: new Set(),
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
  ensureSetupStatus: async ({ serverId, workspaceId, client }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }
    const state = get();
    if (state.snapshots[key] || state.requestedKeys.has(key)) {
      return;
    }

    set((current) => ({ requestedKeys: new Set(current.requestedKeys).add(key) }));

    try {
      const response = await client.fetchWorkspaceSetupStatus(workspaceId);
      if (response.workspaceId === workspaceId && response.snapshot) {
        get().upsertProgress({
          serverId,
          payload: { workspaceId: response.workspaceId, ...response.snapshot },
        });
      }
    } catch {
      set((current) => ({ requestedKeys: forgetRequestedKey(current.requestedKeys, key) }));
    }
  },
  removeWorkspace: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }

    set((state) => {
      if (!(key in state.snapshots) && !state.requestedKeys.has(key)) {
        return state;
      }
      const next = { ...state.snapshots };
      delete next[key];
      return { snapshots: next, requestedKeys: forgetRequestedKey(state.requestedKeys, key) };
    });
  },
  clearServer: (serverId) => {
    set((state) => {
      const prefix = `${serverId}:`;
      const nextEntries = Object.entries(state.snapshots).filter(
        ([key]) => !key.startsWith(prefix),
      );
      const nextRequestedKeys = new Set(
        Array.from(state.requestedKeys).filter((key) => !key.startsWith(prefix)),
      );
      const snapshotsUnchanged = nextEntries.length === Object.keys(state.snapshots).length;
      const requestedUnchanged = nextRequestedKeys.size === state.requestedKeys.size;
      if (snapshotsUnchanged && requestedUnchanged) {
        return state;
      }
      return {
        snapshots: Object.fromEntries(nextEntries),
        requestedKeys: nextRequestedKeys,
      };
    });
  },
}));
