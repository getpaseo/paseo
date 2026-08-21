import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

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

export function shouldSeedWorkspaceSetupTab(snapshot: WorkspaceSetupSnapshot | null): boolean {
  return snapshot?.status === "failed";
}

interface WorkspaceSetupStoreState {
  pendingWorkspaceSetup: PendingWorkspaceSetup | null;
  snapshots: Record<string, WorkspaceSetupSnapshot>;
  requestedKeys: Set<string>;
  surfacedFailedSetupKeys: Set<string>;
  beginWorkspaceSetup: (value: PendingWorkspaceSetup) => void;
  clearWorkspaceSetup: () => void;
  upsertProgress: (input: { serverId: string; payload: WorkspaceSetupProgressPayload }) => void;
  claimFailedSetupSurface: (input: { serverId: string; workspaceId: string }) => boolean;
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

export const useWorkspaceSetupStore = create<WorkspaceSetupStoreState>()((set, get) => ({
  pendingWorkspaceSetup: null,
  snapshots: {},
  requestedKeys: new Set(),
  surfacedFailedSetupKeys: new Set(),
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

    set((state) => {
      const surfacedFailedSetupKeys = new Set(state.surfacedFailedSetupKeys);
      if (payload.status !== "failed") {
        surfacedFailedSetupKeys.delete(key);
      }
      return {
        snapshots: {
          ...state.snapshots,
          [key]: {
            ...payload,
            updatedAt: Date.now(),
          },
        },
        surfacedFailedSetupKeys,
      };
    });
  },
  claimFailedSetupSurface: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return false;
    }

    let claimed = false;
    set((state) => {
      if (state.snapshots[key]?.status !== "failed" || state.surfacedFailedSetupKeys.has(key)) {
        return state;
      }
      claimed = true;
      return { surfacedFailedSetupKeys: new Set(state.surfacedFailedSetupKeys).add(key) };
    });
    return claimed;
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

    // requestedKeys is a pure in-flight marker: it dedupes concurrent fetches and is
    // released once the request settles. A settle that stored no snapshot (null snapshot,
    // mismatched workspace, or error) leaves no marker, so a later call can retry; once a
    // snapshot lands, the snapshots[key] guard above prevents redundant refetches.
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
      // Swallowed: the finally clears the in-flight marker so a later call retries.
    } finally {
      set((current) => {
        const next = new Set(current.requestedKeys);
        next.delete(key);
        return { requestedKeys: next };
      });
    }
  },
  removeWorkspace: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }

    set((state) => {
      if (!(key in state.snapshots) && !state.surfacedFailedSetupKeys.has(key)) {
        return state;
      }
      const next = { ...state.snapshots };
      delete next[key];
      const surfacedFailedSetupKeys = new Set(state.surfacedFailedSetupKeys);
      surfacedFailedSetupKeys.delete(key);
      return { snapshots: next, surfacedFailedSetupKeys };
    });
  },
  clearServer: (serverId) => {
    set((state) => {
      const nextEntries = Object.entries(state.snapshots).filter(
        ([key]) => !key.startsWith(`${serverId}:`),
      );
      const surfacedFailedSetupKeys = new Set(
        [...state.surfacedFailedSetupKeys].filter((key) => !key.startsWith(`${serverId}:`)),
      );
      if (
        nextEntries.length === Object.keys(state.snapshots).length &&
        surfacedFailedSetupKeys.size === state.surfacedFailedSetupKeys.size
      ) {
        return state;
      }
      return { snapshots: Object.fromEntries(nextEntries), surfacedFailedSetupKeys };
    });
  },
}));
