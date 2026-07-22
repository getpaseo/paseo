import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import {
  recoverWorkspaceSelection,
  resolveWorkspaceRecoveryModel,
  type WorkspaceRecoveryController,
} from "./model";

export type { WorkspaceRecoveryController, WorkspaceRecoveryModel } from "./model";

const MIN_RECOVERY_LOADING_MS = 350;

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForRecoveryLoadingPresentation(): Promise<void> {
  // The first callback runs before paint. Waiting for the following frame gives
  // React a paint opportunity before a fast daemon response adds the workspace.
  await waitForAnimationFrame();
  await waitForAnimationFrame();
}

function waitForMinimumRecoveryLoadingTime(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MIN_RECOVERY_LOADING_MS));
}

export function useWorkspaceRecovery(input: {
  serverId: string;
  workspaceId: string;
  agentId?: string | null;
  enabled: boolean;
}): WorkspaceRecoveryController {
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const serverInfo = useSessionStore((store) => store.sessions[input.serverId]?.serverInfo ?? null);
  const supportsRecovery = serverInfo?.features?.workspaceRecovery === true;

  const inspection = useFetchQuery({
    queryKey: ["workspaceRecovery", input.serverId, input.workspaceId],
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: Boolean(input.enabled && client && isConnected && supportsRecovery),
    queryFn: async () => {
      if (!client) {
        throw new Error("The host client is unavailable.");
      }
      return client.inspectWorkspaceRecovery(input.workspaceId);
    },
    retry: false,
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!client || !isConnected) {
        throw new Error("The host disconnected before the workspace could be recovered.");
      }
      await waitForRecoveryLoadingPresentation();
      await waitForMinimumRecoveryLoadingTime();
      await recoverWorkspaceSelection({
        client,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      });
    },
  });

  const state = useMemo(
    () =>
      resolveWorkspaceRecoveryModel({
        enabled: input.enabled,
        connected: isConnected,
        hasClient: client !== null,
        hasServerInfo: serverInfo !== null,
        supportsRecovery,
        inspection: {
          pending: inspection.isPending,
          error: inspection.isError ? toErrorMessage(inspection.error) : null,
          data: inspection.data,
        },
        restore: {
          pending: restoreMutation.isPending,
          error: restoreMutation.isError ? toErrorMessage(restoreMutation.error) : null,
        },
      }),
    [
      client,
      input.enabled,
      inspection.data,
      inspection.error,
      inspection.isError,
      inspection.isPending,
      isConnected,
      restoreMutation.error,
      restoreMutation.isError,
      restoreMutation.isPending,
      serverInfo,
      supportsRecovery,
    ],
  );

  const restore = useCallback(() => {
    restoreMutation.mutate();
  }, [restoreMutation]);
  const retryInspection = useCallback(() => {
    void inspection.refetch();
  }, [inspection]);

  return { state, restore, retryInspection };
}
