import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useTranslation } from "react-i18next";
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

interface TerminalProfileInput {
  name: string;
  command: string;
  args?: string[];
}

interface PendingTerminalCreateInput {
  paneId?: string;
  profile?: TerminalProfileInput;
}

export type { TerminalProfileInput };

interface UseWorkspaceTerminalsInput {
  client: DaemonClient | null;
  isConnected: boolean;
  isRouteFocused: boolean;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
  workspaceScripts: WorkspaceDescriptor["scripts"];
  hasHydratedWorkspaces: boolean;
  isMissingWorkspaceDirectory: boolean;
  onTerminalCreated: (input: { terminalId: string; paneId?: string }) => void;
  onScriptTerminalSelected: (terminalId: string) => void;
  onWorkspacePathUnavailable: () => void;
  onTerminalCreateQueued: () => void;
  onTerminalCreateFailed: (reason: string) => void;
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
    isMissingWorkspaceDirectory,
    onTerminalCreated,
    onScriptTerminalSelected,
    onWorkspacePathUnavailable,
    onTerminalCreateQueued,
    onTerminalCreateFailed,
  } = input;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pendingCreateInput, setPendingCreateInput] = useState<PendingTerminalCreateInput | null>(
    null,
  );
  const canCreateNow = useMemo(
    () => canCreateWorkspaceTerminal({ isRouteFocused, client, isConnected, workspaceDirectory }),
    [isRouteFocused, client, isConnected, workspaceDirectory],
  );
  const queryKey = useMemo(
    () =>
      buildTerminalsQueryKey(normalizedServerId, workspaceDirectory, normalizedWorkspaceId || null),
    [normalizedServerId, normalizedWorkspaceId, workspaceDirectory],
  );

  const query = useQuery({
    queryKey,
    enabled: canCreateNow,
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return await client.listTerminals(workspaceDirectory, undefined, {
        workspaceId: normalizedWorkspaceId || undefined,
      });
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
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = _input?.profile
        ? await client.createTerminal(workspaceDirectory, _input.profile.name, undefined, {
            command: _input.profile.command,
            args: _input.profile.args,
            workspaceId: normalizedWorkspaceId || undefined,
          })
        : await client.createTerminal(workspaceDirectory, undefined, undefined, {
            workspaceId: normalizedWorkspaceId || undefined,
          });
      // The daemon reports a failed spawn (e.g. a profile command that isn't
      // installed) via payload.error with a null terminal. Surface it instead
      // of silently treating the create as a no-op success.
      if (!payload.terminal && payload.error) {
        throw new Error(payload.error);
      }
      return payload;
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
    onError: (error: unknown) => {
      onTerminalCreateFailed(error instanceof Error ? error.message : String(error));
    },
  });
  const killMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
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

    const paneWorkspaceId = normalizedWorkspaceId || undefined;

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      // The terminal subscription is keyed by cwd at the protocol level, so this
      // gate only routes the event to the pane watching that cwd; it is not an
      // ownership decision.
      if (message.payload.cwd !== workspaceDirectory) {
        return;
      }

      // Two workspaces can share a cwd, so the push can carry terminals from a
      // sibling workspace. A terminal belongs to a workspace only by its
      // workspaceId, so keep only the ones whose workspaceId matches this pane.
      const matchingTerminals = message.payload.terminals.filter(
        (terminal) => terminal.workspaceId === paneWorkspaceId,
      );

      queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) => ({
        cwd: message.payload.cwd,
        terminals: matchingTerminals,
        requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
      }));
    });

    client.subscribeTerminals({
      cwd: workspaceDirectory,
      workspaceId: paneWorkspaceId,
    });

    return () => {
      unsubscribeChanged();
      client.unsubscribeTerminals({ cwd: workspaceDirectory, workspaceId: paneWorkspaceId });
    };
  }, [
    client,
    isConnected,
    isRouteFocused,
    normalizedWorkspaceId,
    queryClient,
    queryKey,
    workspaceDirectory,
  ]);

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

    if (hasHydratedWorkspaces && isMissingWorkspaceDirectory) {
      setPendingCreateInput(null);
      onWorkspacePathUnavailable();
    }
  }, [
    canCreateNow,
    createMutation,
    hasHydratedWorkspaces,
    isMissingWorkspaceDirectory,
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

      if (hasHydratedWorkspaces && isMissingWorkspaceDirectory) {
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
      isMissingWorkspaceDirectory,
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
