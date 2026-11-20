import { createNameId } from "mnemonic-id";
import { generateDraftId } from "@/stores/draft-keys";
import type {
  WorkspaceSetupSnapshot as SetupDetailSnapshot,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
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

export interface WorkspaceSetupSnapshot extends WorkspaceSetupProgressPayload {
  updatedAt: number;
}

export type WorkspaceSetupStatus = WorkspaceSetupSnapshot["status"] | null;

export function shouldShowWorkspaceSetup(status: WorkspaceSetupStatus, supported = true): boolean {
  return !supported || status !== null;
}

export function shouldSeedWorkspaceSetupTab(status: WorkspaceSetupStatus): boolean {
  return status === "failed" || status === "blocked";
}

interface WorkspaceSetupStoreState {
  pendingWorkspaceSetup:
    | (PendingWorkspaceSetup & { creationId: string; worktreeSlug: string })
    | null;
  snapshots: Record<string, WorkspaceSetupSnapshot>;
  surfacedFailedSetupKeys: Set<string>;
  beginWorkspaceSetup: (value: PendingWorkspaceSetup) => void;
  clearWorkspaceSetup: () => void;
  applySnapshot: (input: {
    serverId: string;
    workspaceId: string;
    snapshot: SetupDetailSnapshot | null;
  }) => void;
  applySetupStatus: (input: {
    serverId: string;
    workspaceId: string;
    status: WorkspaceSetupStatus;
  }) => void;
  claimFailedSetupSurface: (input: {
    serverId: string;
    workspaceId: string;
    status: WorkspaceSetupStatus;
  }) => boolean;
  removeWorkspace: (input: { serverId: string; workspaceId: string }) => void;
  clearServer: (serverId: string) => void;
}

function buildWorkspaceSetupKey(input: { serverId: string; workspaceId: string }): string | null {
  return buildWorkspaceTabPersistenceKey(input);
}

export const useWorkspaceSetupStore = create<WorkspaceSetupStoreState>()((set) => ({
  pendingWorkspaceSetup: null,
  snapshots: {},
  surfacedFailedSetupKeys: new Set(),
  beginWorkspaceSetup: (value) => {
    set({
      pendingWorkspaceSetup: {
        ...value,
        creationId: generateDraftId(),
        worktreeSlug: createNameId(),
      },
    });
  },
  clearWorkspaceSetup: () => {
    set({ pendingWorkspaceSetup: null });
  },
  applySnapshot: ({ serverId, workspaceId, snapshot }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) return;
    set((state) => {
      const snapshots = { ...state.snapshots };
      if (snapshot) snapshots[key] = { ...snapshot, workspaceId, updatedAt: Date.now() };
      else delete snapshots[key];
      return { snapshots };
    });
  },
  applySetupStatus: ({ serverId, workspaceId, status }) => {
    if (shouldSeedWorkspaceSetupTab(status)) return;
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) return;
    set((state) => {
      if (!state.surfacedFailedSetupKeys.has(key)) return state;
      const surfacedFailedSetupKeys = new Set(state.surfacedFailedSetupKeys);
      surfacedFailedSetupKeys.delete(key);
      return { surfacedFailedSetupKeys };
    });
  },
  claimFailedSetupSurface: ({ serverId, workspaceId, status }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return false;
    }

    let claimed = false;
    set((state) => {
      if (!shouldSeedWorkspaceSetupTab(status) || state.surfacedFailedSetupKeys.has(key)) {
        return state;
      }
      claimed = true;
      return { surfacedFailedSetupKeys: new Set(state.surfacedFailedSetupKeys).add(key) };
    });
    return claimed;
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
