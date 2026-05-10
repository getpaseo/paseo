import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildTerminalsQueryKey,
  canCreateWorkspaceTerminal,
  collectKnownTerminalIds,
  collectScriptTerminalIds,
  collectStandaloneTerminalIds,
  reconcilePendingScriptTerminals,
  removeTerminalFromPayload,
  TERMINALS_QUERY_STALE_TIME,
  type ListTerminalsPayload,
  upsertCreatedTerminalPayload,
} from "@/screens/workspace/terminals/state";

interface PendingTerminalCreateInput {
  paneId?: string;
}

interface UseWorkspaceTerminalsInput {
  client: DaemonClient | null;
  isConnected: boolean;
  isRouteFocused: boolean;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
  workspaceScripts: WorkspaceDescriptor["scripts"];
  hasHydratedWorkspaces: boolean;
  isMissingWorkspaceExecutionAuthority: boolean;
  onTerminalCreated: (input: { terminalId: string; paneId?: string }) => void;
  onScriptTerminalSelected: (terminalId: string) => void;
  onWorkspacePathUnavailable: () => void;
  onTerminalCreateQueued: () => void;
}

export function useWorkspaceTerminals(input: UseWorkspaceTerminalsInput) {
  const {
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
    workspaceScripts,
    hasHydratedWorkspaces,
    isMissingWorkspaceExecutionAuthority,
    onTerminalCreated,
    onScriptTerminalSelected,
    onWorkspacePathUnavailable,
    onTerminalCreateQueued,
  } = input;
  const queryClient = useQueryClient();
  const [pendingCreateInput, setPendingCreateInput] = useState<PendingTerminalCreateInput | null>(
    null,
  );
  const canCreateNow = useMemo(
    () => canCreateWorkspaceTerminal({ isRouteFocused, client, isConnected, workspaceDirectory }),
    [isRouteFocused, client, isConnected, workspaceDirectory],
  );
  const queryKey = useMemo(
    () => buildTerminalsQueryKey(normalizedServerId, workspaceDirectory),
    [normalizedServerId, workspaceDirectory],
  );

  const query = useQuery({
    queryKey,
    enabled: canCreateNow,
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(workspaceDirectory);
    },
    staleTime: TERMINALS_QUERY_STALE_TIME,
  });
  const terminals = useMemo(() => query.data?.terminals ?? [], [query.data]);
  const liveTerminalIds = useMemo(() => terminals.map((terminal) => terminal.id), [terminals]);
  const [pendingScriptTerminalIds, setPendingScriptTerminalIds] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    setPendingScriptTerminalIds(new Map());
  }, [normalizedServerId, normalizedWorkspaceId]);

  const dataUpdatedAt = query.dataUpdatedAt;
  useEffect(() => {
    setPendingScriptTerminalIds(reconcilePendingScriptTerminals(liveTerminalIds, dataUpdatedAt));
  }, [liveTerminalIds, dataUpdatedAt]);

  const knownTerminalIds = useMemo(
    () => collectKnownTerminalIds({ liveTerminalIds, pendingScriptTerminalIds }),
    [liveTerminalIds, pendingScriptTerminalIds],
  );
  const scriptTerminalIds = useMemo(
    () => collectScriptTerminalIds({ pendingScriptTerminalIds, scripts: workspaceScripts }),
    [pendingScriptTerminalIds, workspaceScripts],
  );
  const standaloneTerminalIds = useMemo(
    () => collectStandaloneTerminalIds({ terminals, scriptTerminalIds }),
    [scriptTerminalIds, terminals],
  );

  const createMutation = useMutation({
    mutationFn: async (_input?: PendingTerminalCreateInput) => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(workspaceDirectory);
    },
    onSuccess: (payload, createInput) => {
      const createdTerminal = payload.terminal;
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) =>
          upsertCreatedTerminalPayload({
            current,
            terminal: createdTerminal,
            workspaceDirectory,
          }),
        );
      }

      void queryClient.invalidateQueries({ queryKey });
      if (createdTerminal) {
        onTerminalCreated({
          terminalId: createdTerminal.id,
          paneId: createInput?.paneId,
        });
      }
    },
  });
  const killMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.killTerminal(terminalId);
      if (!payload.success) {
        throw new Error("Unable to close terminal");
      }
      return payload;
    },
  });

  useEffect(() => {
    if (!isRouteFocused || !client || !isConnected || !workspaceDirectory) {
      return;
    }

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      if (message.payload.cwd !== workspaceDirectory) {
        return;
      }

      queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) => ({
        cwd: message.payload.cwd,
        terminals: message.payload.terminals,
        requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
      }));
    });

    client.subscribeTerminals({ cwd: workspaceDirectory });

    return () => {
      unsubscribeChanged();
      client.unsubscribeTerminals({ cwd: workspaceDirectory });
    };
  }, [client, isConnected, isRouteFocused, queryClient, queryKey, workspaceDirectory]);

  useEffect(() => {
    if (!pendingCreateInput) {
      return;
    }

    if (canCreateNow && !createMutation.isPending) {
      const pendingInput = pendingCreateInput;
      setPendingCreateInput(null);
      createMutation.mutate(pendingInput);
      return;
    }

    if (hasHydratedWorkspaces && isMissingWorkspaceExecutionAuthority) {
      setPendingCreateInput(null);
      onWorkspacePathUnavailable();
    }
  }, [
    canCreateNow,
    createMutation,
    hasHydratedWorkspaces,
    isMissingWorkspaceExecutionAuthority,
    onWorkspacePathUnavailable,
    pendingCreateInput,
  ]);

  const createTerminal = useCallback(
    (createInput?: PendingTerminalCreateInput) => {
      if (createMutation.isPending || pendingCreateInput) {
        return;
      }

      if (canCreateNow) {
        createMutation.mutate(createInput);
        return;
      }

      if (hasHydratedWorkspaces && isMissingWorkspaceExecutionAuthority) {
        onWorkspacePathUnavailable();
        return;
      }

      setPendingCreateInput(createInput ?? {});
      onTerminalCreateQueued();
    },
    [
      canCreateNow,
      createMutation,
      hasHydratedWorkspaces,
      isMissingWorkspaceExecutionAuthority,
      onTerminalCreateQueued,
      onWorkspacePathUnavailable,
      pendingCreateInput,
    ],
  );

  const handleScriptTerminalStarted = useCallback(
    (terminalId: string) => {
      setPendingScriptTerminalIds((pendingTerminalIds) => {
        if (pendingTerminalIds.get(terminalId) === query.dataUpdatedAt) {
          return pendingTerminalIds;
        }
        const nextTerminalIds = new Map(pendingTerminalIds);
        nextTerminalIds.set(terminalId, query.dataUpdatedAt);
        return nextTerminalIds;
      });
      onScriptTerminalSelected(terminalId);
      void queryClient.invalidateQueries({ queryKey });
    },
    [onScriptTerminalSelected, query.dataUpdatedAt, queryClient, queryKey],
  );

  const handleViewScriptTerminal = useCallback(
    (terminalId: string) => {
      onScriptTerminalSelected(terminalId);
    },
    [onScriptTerminalSelected],
  );

  const removeTerminalFromCache = useCallback(
    (terminalId: string) => {
      queryClient.setQueryData<ListTerminalsPayload>(
        queryKey,
        removeTerminalFromPayload(terminalId),
      );
    },
    [queryClient, queryKey],
  );

  const invalidateTerminals = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    canCreateNow,
    createMutation,
    createTerminal,
    handleScriptTerminalStarted,
    handleViewScriptTerminal,
    invalidateTerminals,
    killMutation,
    knownTerminalIds,
    liveTerminalIds,
    pendingCreateInput,
    query,
    queryKey,
    removeTerminalFromCache,
    standaloneTerminalIds,
    terminals,
  };
}
