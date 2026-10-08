import { createNameId } from "mnemonic-id";
import { generateDraftId } from "@/stores/draft-keys";
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
  return (
    snapshot.status === "running" ||
    snapshot.status === "blocked" ||
    snapshot.error !== null ||
    snapshot.detail.commands.length > 0
  );
}

export function shouldSeedWorkspaceSetupTab(snapshot: WorkspaceSetupSnapshot | null): boolean {
  return snapshot?.status === "failed" || snapshot?.status === "blocked";
}

interface WorkspaceSetupStoreState {
  pendingWorkspaceSetup:
    | (PendingWorkspaceSetup & { creationId: string; worktreeSlug: string })
    | null;
  snapshots: Record<string, WorkspaceSetupSnapshot>;
  requestedKeys: Set<string>;
  requestedSetupRevealKeys: Set<string>;
  surfacedFailedSetupKeys: Set<string>;
  beginWorkspaceSetup: (value: PendingWorkspaceSetup) => void;
  clearWorkspaceSetup: () => void;
  upsertProgress: (input: { serverId: string; payload: WorkspaceSetupProgressPayload }) => void;
  requestSetupReveal: (input: { serverId: string; workspaceId: string }) => void;
  clearSetupRevealRequest: (input: { serverId: string; workspaceId: string }) => void;
  claimFailedSetupSurface: (input: { serverId: string; workspaceId: string }) => boolean;
  ensureSetupStatus: (input: {
    serverId: string;
    workspaceId: string;
    client: WorkspaceSetupStatusClient;
    refresh?: boolean;
  }) => Promise<void>;
  refreshServer: (input: { serverId: string; client: WorkspaceSetupStatusClient }) => Promise<void>;
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
  requestedSetupRevealKeys: new Set(),
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
  upsertProgress: ({ serverId, payload }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId: payload.workspaceId });
    if (!key) {
      return;
    }

    set((state) => {
      const surfacedFailedSetupKeys = new Set(state.surfacedFailedSetupKeys);
      if (payload.status !== "failed" && payload.status !== "blocked") {
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
  requestSetupReveal: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }
    set((state) => ({
      requestedSetupRevealKeys: new Set(state.requestedSetupRevealKeys).add(key),
    }));
  },
  clearSetupRevealRequest: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }
    set((state) => {
      if (!state.requestedSetupRevealKeys.has(key)) {
        return state;
      }
      const requestedSetupRevealKeys = new Set(state.requestedSetupRevealKeys);
      requestedSetupRevealKeys.delete(key);
      return { requestedSetupRevealKeys };
    });
  },
  claimFailedSetupSurface: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return false;
    }

    let claimed = false;
    set((state) => {
      if (
        !["failed", "blocked"].includes(state.snapshots[key]?.status ?? "") ||
        state.surfacedFailedSetupKeys.has(key)
      ) {
        return state;
      }
      claimed = true;
      return { surfacedFailedSetupKeys: new Set(state.surfacedFailedSetupKeys).add(key) };
    });
    return claimed;
  },
  ensureSetupStatus: async ({ serverId, workspaceId, client, refresh = false }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }
    const state = get();
    const previousSnapshot = state.snapshots[key];
    const hasCachedSnapshot = previousSnapshot !== undefined && !refresh;
    if (hasCachedSnapshot || state.requestedKeys.has(key)) {
      return;
    }

    // requestedKeys is a pure in-flight marker: it dedupes concurrent fetches and is
    // released once the request settles. Ordinary reads reuse the cached snapshot;
    // reconnects explicitly refresh it because live progress is not replayed.
    set((current) => ({ requestedKeys: new Set(current.requestedKeys).add(key) }));

    try {
      const response = await client.fetchWorkspaceSetupStatus(workspaceId);
      const receivedProgress = get().snapshots[key] !== previousSnapshot;
      if (response.workspaceId !== workspaceId || receivedProgress) {
        return;
      }
      if (response.snapshot) {
        get().upsertProgress({
          serverId,
          payload: { workspaceId: response.workspaceId, ...response.snapshot },
        });
      } else if (previousSnapshot) {
        // Completed setup has no runtime snapshot after a daemon restart.
        set((current) => {
          const snapshots = { ...current.snapshots };
          delete snapshots[key];
          return { snapshots };
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
  refreshServer: async ({ serverId, client }) => {
    // Setup progress is a live feed, so reconnect must recover events missed offline.
    const requests = Object.entries(get().snapshots)
      .filter(([key]) => key.startsWith(`${serverId}:`))
      .map(([, snapshot]) =>
        get().ensureSetupStatus({
          serverId,
          workspaceId: snapshot.workspaceId,
          client,
          refresh: true,
        }),
      );
    await Promise.all(requests);
  },
  removeWorkspace: ({ serverId, workspaceId }) => {
    const key = buildWorkspaceSetupKey({ serverId, workspaceId });
    if (!key) {
      return;
    }

    set((state) => {
      if (
        !(key in state.snapshots) &&
        !state.requestedSetupRevealKeys.has(key) &&
        !state.surfacedFailedSetupKeys.has(key)
      ) {
        return state;
      }
      const next = { ...state.snapshots };
      delete next[key];
      const requestedSetupRevealKeys = new Set(state.requestedSetupRevealKeys);
      requestedSetupRevealKeys.delete(key);
      const surfacedFailedSetupKeys = new Set(state.surfacedFailedSetupKeys);
      surfacedFailedSetupKeys.delete(key);
      return { snapshots: next, requestedSetupRevealKeys, surfacedFailedSetupKeys };
    });
  },
  clearServer: (serverId) => {
    set((state) => {
      const nextEntries = Object.entries(state.snapshots).filter(
        ([key]) => !key.startsWith(`${serverId}:`),
      );
      const requestedSetupRevealKeys = new Set(
        [...state.requestedSetupRevealKeys].filter((key) => !key.startsWith(`${serverId}:`)),
      );
      const surfacedFailedSetupKeys = new Set(
        [...state.surfacedFailedSetupKeys].filter((key) => !key.startsWith(`${serverId}:`)),
      );
      if (
        nextEntries.length === Object.keys(state.snapshots).length &&
        requestedSetupRevealKeys.size === state.requestedSetupRevealKeys.size &&
        surfacedFailedSetupKeys.size === state.surfacedFailedSetupKeys.size
      ) {
        return state;
      }
      return {
        snapshots: Object.fromEntries(nextEntries),
        requestedSetupRevealKeys,
        surfacedFailedSetupKeys,
      };
    });
  },
}));
