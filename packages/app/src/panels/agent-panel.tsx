import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Bot } from "lucide-react-native";
import invariant from "tiny-invariant";
import { AgentStreamView, type AgentStreamViewHandle } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/components/message-input";
import { getProviderIcon } from "@/components/provider-icons";
import { ToastViewport, useToastHost } from "@/components/toast-host";
import { useAgentAttentionClear } from "@/hooks/use-agent-attention-clear";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import {
  useAgentScreenStateMachine,
  type AgentScreenAgent,
  type AgentScreenMissingState,
} from "@/hooks/use-agent-screen-state-machine";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useStableEvent } from "@/hooks/use-stable-event";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
  useHostRuntimeLastError,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { mergePendingCreateImages } from "@/utils/pending-create-images";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import {
  deriveRouteBottomAnchorIntent,
  deriveRouteBottomAnchorRequest,
} from "@/screens/agent/agent-ready-screen-bottom-anchor";
import { isNative } from "@/constants/platform";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveWorkspaceAgentTabLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

function useAgentPanelDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const agent = state.sessions[context.serverId]?.agents?.get(target.agentId) ?? null;
      return {
        provider: agent?.provider ?? "codex",
        title: agent?.title ?? null,
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
      };
    }),
  );
  const provider = descriptorState.provider;
  const label = resolveWorkspaceAgentTabLabel(descriptorState.title);
  const icon = getProviderIcon(provider) ?? Bot;

  return {
    label: label ?? "",
    subtitle: `${formatProviderLabel(provider)} agent`,
    titleState: label ? "ready" : "loading",
    icon,
    statusBucket: descriptorState.status
      ? deriveSidebarStateBucket({
          status: descriptorState.status,
          pendingPermissionCount: descriptorState.pendingPermissionCount,
          requiresAttention: descriptorState.requiresAttention,
          attentionReason: descriptorState.attentionReason,
        })
      : null,
  };
}

function AgentPanel() {
  const { serverId, target, isPaneFocused, openFileInWorkspace } = usePaneContext();
  invariant(target.kind === "agent", "AgentPanel requires agent target");

  function openWorkspaceFile(input: { filePath: string }) {
    openFileInWorkspace(input.filePath);
  }

  const handleOpenWorkspaceFile = useStableEvent(openWorkspaceFile);

  return (
    <AgentPanelContent
      serverId={serverId}
      agentId={target.agentId}
      isPaneFocused={isPaneFocused}
      onOpenWorkspaceFile={handleOpenWorkspaceFile}
    />
  );
}

export const agentPanelRegistration: PanelRegistration<"agent"> = {
  kind: "agent",
  component: AgentPanel,
  useDescriptor: useAgentPanelDescriptor,
};

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

function logWebStickyBottom(_event: string, _details: Record<string, unknown>): void {}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

function AgentPanelContent({
  serverId,
  agentId,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (input: { filePath: string }) => void;
}) {
  const resolvedAgentId = agentId.trim() || undefined;
  const resolvedServerId = serverId.trim() || undefined;
  const daemons = useHosts();
  const runtimeServerId = resolvedServerId ?? "";
  const runtimeClient = useHostRuntimeClient(runtimeServerId);
  const runtimeIsConnected = useHostRuntimeIsConnected(runtimeServerId);
  const runtimeConnectionStatus = useHostRuntimeConnectionStatus(runtimeServerId);
  const runtimeLastError = useHostRuntimeLastError(runtimeServerId);

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? (daemons.find((entry) => entry.serverId === connectionServerId) ?? null)
    : null;
  const serverLabel = daemon?.label ?? connectionServerId ?? "Selected host";
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    isUnknownDaemon && runtimeConnectionStatus === "connecting"
      ? "offline"
      : runtimeConnectionStatus;
  const lastConnectionError = runtimeLastError;

  if (!resolvedServerId || !runtimeClient) {
    return (
      <AgentSessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
      />
    );
  }

  return (
    <AgentPanelBody
      serverId={resolvedServerId}
      agentId={resolvedAgentId}
      isPaneFocused={isPaneFocused}
      client={runtimeClient}
      isConnected={runtimeIsConnected}
      connectionStatus={connectionStatus}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function AgentPanelBody({
  serverId,
  agentId,
  isPaneFocused,
  client,
  isConnected,
  connectionStatus,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  agentId?: string;
  isPaneFocused: boolean;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  isConnected: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
  onOpenWorkspaceFile?: (input: { filePath: string }) => void;
}) {
  const { theme } = useUnistyles();
  const panelToast = useToastHost();
  const { isArchivingAgent } = useArchiveAgent();
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const clearOnAgentBlurRef = useRef<() => void>(() => {});
  const wasPaneFocusedRef = useRef(isPaneFocused);
  const reconnectToastArmedRef = useRef(false);
  const initAttemptTokenRef = useRef(0);
  const routeBottomAnchorRequestRef = useRef<{
    routeKey: string;
    reason: "initial-entry" | "resume";
  } | null>(null);
  const agentInputDraft = useAgentInputDraft(
    buildDraftStoreKey({
      serverId,
      agentId: agentId ?? "__pending__",
    }),
  );

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const agentState = useSessionStore(
    useShallow((state) => {
      const agent = agentId ? (state.sessions[serverId]?.agents?.get(agentId) ?? null) : null;
      return {
        serverId: agent?.serverId ?? null,
        id: agent?.id ?? null,
        status: agent?.status ?? null,
        cwd: agent?.cwd ?? null,
        archivedAt: agent?.archivedAt ?? null,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
      };
    }),
  );
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      agentId ? (state.sessions[serverId]?.agents?.get(agentId)?.projectPlacement ?? null) : null,
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const streamItemsRaw = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamTail?.get(agentId) : undefined,
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const pendingByDraftId = useCreateFlowStore((state) => state.pendingByDraftId);
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle);
  const clearPendingCreate = useCreateFlowStore((state) => state.clear);
  const isInitializingFromMap = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.initializingAgents?.get(agentId) ?? false) : false,
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0,
  );
  const hasAppliedAuthoritativeHistory = useSessionStore((state) =>
    agentId
      ? state.sessions[serverId]?.agentAuthoritativeHistoryApplied?.get(agentId) === true
      : false,
  );
  const agentHistorySyncGeneration = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.agentHistorySyncGeneration?.get(agentId) ?? -1) : -1,
  );
  const allPendingPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions,
  );
  const setAgents = useSessionStore((state) => state.setAgents);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setPendingPermissions = useSessionStore((state) => state.setPendingPermissions);
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const { ensureAgentIsInitialized } = useAgentInitialization({
    serverId,
    client: hasSession ? client : null,
  });
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });

  const pendingCreate = useMemo(() => {
    if (!agentId) {
      return null;
    }
    const values = Object.values(pendingByDraftId);
    for (const entry of values) {
      if (
        entry.lifecycle === "active" &&
        entry.serverId === serverId &&
        entry.agentId === agentId
      ) {
        return entry;
      }
    }
    return null;
  }, [agentId, pendingByDraftId, serverId]);
  const isPendingCreateForPanel = Boolean(pendingCreate);
  const hasHydratedHistoryBefore = hasAppliedAuthoritativeHistory;

  const pendingPermissions = useMemo(() => {
    if (!allPendingPermissions || !agentId) {
      return new Map<string, PendingPermission>();
    }
    const filtered = new Map<string, PendingPermission>();
    for (const [key, permission] of allPendingPermissions) {
      if (permission.agentId === agentId) {
        filtered.set(key, permission);
      }
    }
    return filtered;
  }, [agentId, allPendingPermissions]);

  const attentionController = useAgentAttentionClear({
    agentId,
    client,
    isConnected,
    requiresAttention: agentState.requiresAttention,
    attentionReason: agentState.attentionReason,
    isScreenFocused: isPaneFocused,
  });
  useEffect(() => {
    clearOnAgentBlurRef.current = attentionController.clearOnAgentBlur;
  }, [attentionController.clearOnAgentBlur]);

  const { style: animatedKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const handleHistorySyncFailure = useCallback(
    ({ origin, error }: { origin: "focus" | "entry"; error: unknown }) => {
      if (agentId) {
        console.warn("[AgentPanel] history sync failed", {
          origin,
          agentId,
          error,
        });
      }
      const message = toErrorMessage(error);
      setMissingAgentState((previous) => {
        if (previous.kind === "error" && previous.message === message) {
          return previous;
        }
        return { kind: "error", message };
      });
    },
    [agentId],
  );

  const ensureInitializedWithSyncErrorHandling = useCallback(
    (origin: "focus" | "entry") => {
      if (!agentId) {
        return;
      }
      ensureAgentIsInitialized(agentId).catch((error) => {
        handleHistorySyncFailure({ origin, error });
      });
    },
    [agentId, ensureAgentIsInitialized, handleHistorySyncFailure],
  );

  useEffect(() => {
    if (connectionStatus === "online") {
      reconnectToastArmedRef.current = false;
      return;
    }
    if (connectionStatus === "idle") {
      return;
    }
    if (!reconnectToastArmedRef.current) {
      reconnectToastArmedRef.current = true;
      panelToast.api.show("Reconnecting...", {
        durationMs: 2200,
        testID: "agent-reconnecting-toast",
      });
    }
  }, [connectionStatus, panelToast.api]);

  useEffect(() => {
    if (!isPaneFocused || !agentId || !isConnected || !hasSession) {
      return;
    }
    ensureInitializedWithSyncErrorHandling("focus");
  }, [agentId, ensureInitializedWithSyncErrorHandling, hasSession, isConnected, isPaneFocused]);

  const isArchivingCurrentAgent = Boolean(agentId && isArchivingAgent({ serverId, agentId }));

  useEffect(() => {
    if (wasPaneFocusedRef.current && !isPaneFocused) {
      clearOnAgentBlurRef.current();
    }
    wasPaneFocusedRef.current = isPaneFocused;
  }, [isPaneFocused]);

  useEffect(() => {
    return () => {
      if (wasPaneFocusedRef.current) {
        clearOnAgentBlurRef.current();
      }
    };
  }, []);

  const isInitializing = agentId ? isInitializingFromMap !== false : false;
  const isHistorySyncing = useMemo(() => {
    if (!agentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, agentId);
    return Boolean(getInitDeferred(initKey));
  }, [agentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!agentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, agentId, historySyncGeneration]);

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (!isPendingCreateForPanel || !pendingCreate) {
      return EMPTY_STREAM_ITEMS;
    }
    return [
      {
        kind: "user_message",
        id: pendingCreate.clientMessageId,
        text: pendingCreate.text,
        timestamp: new Date(pendingCreate.timestamp),
        ...(pendingCreate.images && pendingCreate.images.length > 0
          ? { images: pendingCreate.images }
          : {}),
      },
    ];
  }, [isPendingCreateForPanel, pendingCreate]);

  const mergedStreamItems = useMemo<StreamItem[]>(() => {
    if (optimisticStreamItems.length === 0) {
      return streamItems;
    }
    const optimistic = optimisticStreamItems[0];
    if (!optimistic) {
      return streamItems;
    }
    const alreadyHasOptimistic = streamItems.some(
      (item) => item.kind === "user_message" && item.id === optimistic.id,
    );
    return alreadyHasOptimistic ? streamItems : [...optimisticStreamItems, ...streamItems];
  }, [optimisticStreamItems, streamItems]);

  const shouldUseOptimisticStream = isPendingCreateForPanel && optimisticStreamItems.length > 0;
  const authoritativeStatus = agentState.status;
  const isAuthoritativeBootstrapping =
    authoritativeStatus === "initializing" || authoritativeStatus === "idle";
  const showPendingCreateSubmitLoading =
    isPendingCreateForPanel && (!authoritativeStatus || isAuthoritativeBootstrapping);
  const canFinalizePendingCreate = Boolean(authoritativeStatus) && !isAuthoritativeBootstrapping;

  const agent = useMemo<AgentScreenAgent | null>(
    () =>
      agentState.serverId && agentState.id && agentState.status && agentState.cwd
        ? {
            serverId: agentState.serverId,
            id: agentState.id,
            status: agentState.status,
            cwd: agentState.cwd,
            projectPlacement,
          }
        : null,
    [agentState.serverId, agentState.id, agentState.status, agentState.cwd, projectPlacement],
  );

  const placeholderAgent: AgentScreenAgent | null = useMemo(() => {
    if (!shouldUseOptimisticStream || !agentId) {
      return null;
    }
    return {
      serverId,
      id: agentId,
      status: "running",
      cwd: ".",
      projectPlacement: null,
    };
  }, [agentId, serverId, shouldUseOptimisticStream]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${agentId ?? ""}`,
    input: {
      agent: agent ?? null,
      placeholderAgent,
      missingAgentState,
      isConnected,
      isArchivingCurrentAgent,
      isHistorySyncing,
      needsAuthoritativeSync,
      shouldUseOptimisticStream,
      hasHydratedHistoryBefore,
    },
  });

  const effectiveAgent = viewState.tag === "ready" ? viewState.agent : null;
  const routeEntryKey = agentId ? `${serverId}:${agentId}` : null;
  routeBottomAnchorRequestRef.current = deriveRouteBottomAnchorIntent({
    cachedIntent: routeBottomAnchorRequestRef.current,
    routeKey: routeEntryKey,
    hasAppliedAuthoritativeHistoryAtEntry: hasAppliedAuthoritativeHistory,
  });
  const routeBottomAnchorRequest = useMemo(
    () =>
      deriveRouteBottomAnchorRequest({
        intent: routeBottomAnchorRequestRef.current,
        effectiveAgentId: effectiveAgent?.id ?? null,
      }),
    [effectiveAgent?.id],
  );

  useEffect(() => {
    if (!isPendingCreateForPanel || !pendingCreate) {
      return;
    }
    const hasUserMessage = streamItems.some(
      (item) => item.kind === "user_message" && item.id === pendingCreate.clientMessageId,
    );
    if (hasUserMessage && canFinalizePendingCreate) {
      if (agentId && pendingCreate.images && pendingCreate.images.length > 0) {
        setAgentStreamTail(serverId, (previous) => {
          const current = previous.get(agentId);
          if (!current) {
            return previous;
          }

          const merged = mergePendingCreateImages({
            streamItems: current,
            clientMessageId: pendingCreate.clientMessageId,
            images: pendingCreate.images,
          });
          if (merged === current) {
            return previous;
          }

          const next = new Map(previous);
          next.set(agentId, merged);
          return next;
        });
      }
      markPendingCreateLifecycle({
        draftId: pendingCreate.draftId,
        lifecycle: "sent",
      });
      clearPendingCreate({ draftId: pendingCreate.draftId });
    }
  }, [
    agentId,
    canFinalizePendingCreate,
    clearPendingCreate,
    isPendingCreateForPanel,
    markPendingCreateLifecycle,
    pendingCreate,
    serverId,
    setAgentStreamTail,
    streamItems,
  ]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (!isConnected || !hasSession) {
      return;
    }
    const shouldSyncOnEntry = needsAuthoritativeSync || isNative;
    if (!shouldSyncOnEntry) {
      return;
    }

    ensureInitializedWithSyncErrorHandling("entry");
  }, [
    agentId,
    ensureInitializedWithSyncErrorHandling,
    hasSession,
    isConnected,
    needsAuthoritativeSync,
  ]);

  useEffect(() => {
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.id || shouldUseOptimisticStream) {
      if (missingAgentState.kind !== "idle") {
        setMissingAgentState({ kind: "idle" });
      }
      return;
    }
    if (!isConnected || !hasSession) {
      return;
    }
    if (missingAgentState.kind === "resolving" || missingAgentState.kind === "not_found") {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    ensureAgentIsInitialized(agentId)
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentAgent = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
        if (!currentAgent) {
          const result = await client.fetchAgent(agentId);
          if (attemptToken !== initAttemptTokenRef.current) {
            return;
          }
          if (!result) {
            setMissingAgentState({
              kind: "not_found",
              message: `Agent not found: ${agentId}`,
            });
            return;
          }
          const normalized = normalizeAgentSnapshot(result.agent, serverId);
          const hydrated = {
            ...normalized,
            projectPlacement: result.project,
          };
          setAgents(serverId, (previous) => {
            const next = new Map(previous);
            next.set(hydrated.id, hydrated);
            return next;
          });
          setPendingPermissions(serverId, (previous) => {
            const next = new Map(previous);
            for (const [key, pending] of next.entries()) {
              if (pending.agentId === hydrated.id) {
                next.delete(key);
              }
            }
            for (const request of hydrated.pendingPermissions) {
              const key = derivePendingPermissionKey(hydrated.id, request);
              next.set(key, { key, agentId: hydrated.id, request });
            }
            return next;
          });
        }
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
      })
      .catch((error) => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setMissingAgentState({ kind: "not_found", message });
          return;
        }
        setMissingAgentState({ kind: "error", message });
      });
  }, [
    agentState.id,
    agentId,
    client,
    ensureAgentIsInitialized,
    hasSession,
    isConnected,
    missingAgentState.kind,
    serverId,
    setAgents,
    setPendingPermissions,
    shouldUseOptimisticStream,
  ]);

  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  if (viewState.tag === "error") {
    return (
      <View style={styles.container} testID="agent-load-error">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Failed to load agent</Text>
          <Text style={styles.statusText}>{viewState.message}</Text>
        </View>
      </View>
    );
  }

  if (viewState.tag === "boot" || !effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FileDropZone onFilesDropped={handleFilesDropped} disabled={isArchivingCurrentAgent}>
        <View style={styles.container}>
          <View style={styles.contentContainer}>
            <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
              <AgentStreamView
                ref={streamViewRef}
                agentId={effectiveAgent.id}
                serverId={serverId}
                agent={effectiveAgent}
                streamItems={shouldUseOptimisticStream ? mergedStreamItems : streamItems}
                pendingPermissions={pendingPermissions}
                routeBottomAnchorRequest={routeBottomAnchorRequest}
                isAuthoritativeHistoryReady={hasAppliedAuthoritativeHistory}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            </ReanimatedAnimated.View>
          </View>

          {agentId && !isArchivingCurrentAgent && !agentState.archivedAt ? (
            <AgentInputArea
              agentId={agentId}
              serverId={serverId}
              isPaneFocused={isPaneFocused}
              value={agentInputDraft.text}
              onChangeText={agentInputDraft.setText}
              images={agentInputDraft.images}
              onChangeImages={agentInputDraft.setImages}
              clearDraft={agentInputDraft.clear}
              autoFocus={isPaneFocused}
              isSubmitLoading={showPendingCreateSubmitLoading}
              onAttentionInputFocus={attentionController.clearOnInputFocus}
              onAttentionPromptSend={attentionController.clearOnPromptSend}
              onAddImages={handleAddImagesCallback}
              onComposerHeightChange={(height) => {
                logWebStickyBottom("screen_composer_height_change", {
                  agentId,
                  height,
                });
                streamViewRef.current?.prepareForViewportChange();
              }}
              onMessageSent={() => {
                logWebStickyBottom("screen_message_sent_scroll_to_bottom", {
                  agentId,
                });
                streamViewRef.current?.scrollToBottom("message-sent");
              }}
            />
          ) : agentId && agentState.archivedAt ? (
            <ArchivedAgentCallout serverId={serverId} agentId={agentId} />
          ) : null}

          {viewState.tag === "ready" &&
          viewState.sync.status === "catching_up" &&
          viewState.sync.ui === "overlay" ? (
            <View style={styles.historySyncOverlay} testID="agent-history-overlay">
              <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
            </View>
          ) : null}

          <ToastViewport
            toast={panelToast.toast}
            onDismiss={panelToast.dismiss}
            placement="panel"
          />
        </View>
      </FileDropZone>

      {isArchivingCurrentAgent ? (
        <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <Text style={styles.archivingTitle}>Archiving agent...</Text>
          <Text style={styles.archivingSubtitle}>Please wait while we archive this agent.</Text>
        </View>
      ) : null}
    </View>
  );
}

function AgentSessionUnavailableState({
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
}: {
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            Cannot open this agent because {serverLabel} is not configured on this device.
          </Text>
          <Text style={styles.statusText}>
            Add the host in Settings or open an agent on a configured server to continue.
          </Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";
  const isPreparingSession = connectionStatus === "online";

  return (
    <View style={styles.container}>
      <View style={styles.centerState}>
        {isConnecting || isPreparingSession ? (
          <>
            <ActivityIndicator size="large" />
            <Text style={styles.loadingText}>
              {isPreparingSession
                ? `Preparing ${serverLabel} session...`
                : `Connecting to ${serverLabel}...`}
            </Text>
            <Text style={styles.statusText}>
              {isPreparingSession
                ? "We will show this agent in a moment."
                : "We will show this agent once the host is online."}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>Reconnecting to {serverLabel}...</Text>
            <Text style={styles.offlineDescription}>
              We will show this agent again as soon as the host is reachable.
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  historySyncOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
  },
  archivingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 10, 14, 0.86)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    gap: theme.spacing[3],
    zIndex: 50,
  },
  archivingTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  archivingSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  offlineTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  offlineDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  offlineDetails: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
