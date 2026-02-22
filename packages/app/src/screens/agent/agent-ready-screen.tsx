import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Platform,
  BackHandler,
} from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useQueryClient } from "@tanstack/react-query";
import ReanimatedAnimated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import {
  MoreVertical,
  GitBranch,
  Folder,
  RotateCcw,
  PanelRight,
  CheckCircle2,
} from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { BackHeader } from "@/components/headers/back-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/components/message-input";
import {
  ExplorerSidebarAnimationProvider,
} from "@/contexts/explorer-sidebar-animation-context";
import { usePanelStore } from "@/stores/panel-store";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useSessionStore } from "@/stores/session-store";
import {
  useHostRuntimeSession,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { Agent } from "@/contexts/session-context";
import type { StreamItem } from "@/types/stream";
import {
  buildAgentNavigationKey,
  endNavigationTiming,
  HOME_NAVIGATION_KEY,
  startNavigationTiming,
} from "@/utils/navigation-timing";
import { extractAgentModel } from "@/utils/extract-agent-model";
import { startPerfMonitor } from "@/utils/perf-monitor";
import { shortenPath } from "@/utils/shorten-path";
import { deriveBranchLabel, deriveProjectPath } from "@/utils/agent-display-info";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
  useCheckoutStatusQuery,
} from "@/hooks/use-checkout-status-query";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import {
  useAgentScreenStateMachine,
  type AgentScreenMissingState,
} from "@/hooks/use-agent-screen-state-machine";
import { useToast } from "@/contexts/toast-context";
import { useDelayedHistoryRefreshToast } from "@/hooks/use-delayed-history-refresh-toast";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import {
  derivePendingPermissionKey,
  normalizeAgentSnapshot,
} from "@/utils/agent-snapshots";
import { mergePendingCreateImages } from "@/utils/pending-create-images";
import { shouldClearAgentAttentionOnView } from "@/utils/agent-attention";
import type { DaemonClient } from "@server/client/daemon-client";
import { useExplorerOpenGesture } from "@/hooks/use-explorer-open-gesture";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildHostAgentDraftRoute } from "@/utils/host-routes";
import type { ExplorerCheckoutContext } from "@/stores/panel-store";

const DROPDOWN_WIDTH = 220;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const IS_DEV = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);

function logAgentExplorer(event: string, details: Record<string, unknown>): void {
  if (!IS_DEV) {
    return;
  }
  console.log(`[AgentExplorer] ${event}`, details);
}

export function AgentReadyScreen({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const router = useRouter();
  const resolvedAgentId = agentId?.trim() || undefined;
  const resolvedServerId = serverId?.trim() || undefined;
  const { daemons } = useDaemonRegistry();
  const runtimeServerId = resolvedServerId ?? "";
  const {
    snapshot: runtimeSnapshot,
    client: runtimeClient,
    isConnected: runtimeIsConnected,
  } = useHostRuntimeSession(runtimeServerId);

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? daemons.find((entry) => entry.serverId === connectionServerId) ?? null
    : null;
  const serverLabel =
    daemon?.label ?? connectionServerId ?? "Selected host";
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    runtimeSnapshot?.connectionStatus ??
    (isUnknownDaemon ? "offline" : "connecting");
  const lastConnectionError = runtimeSnapshot?.lastError ?? null;
  const isRuntimeSessionAvailable = Boolean(resolvedServerId && runtimeClient);

  const handleBackToHome = useCallback(() => {
    const targetServerId = resolvedServerId;
    const targetAgentId = resolvedAgentId ?? null;
    if (targetServerId && targetAgentId) {
      startNavigationTiming(HOME_NAVIGATION_KEY, {
        from: "agent",
        to: "home",
        targetMs: 300,
        params: {
          serverId: targetServerId,
          agentId: targetAgentId,
        },
      });
    } else {
      startNavigationTiming(HOME_NAVIGATION_KEY, {
        from: "agent",
        to: "home",
        targetMs: 300,
      });
    }
    if (targetServerId) {
      router.replace(buildHostAgentDraftRoute(targetServerId) as any);
      return;
    }
    router.replace("/" as any);
  }, [resolvedAgentId, resolvedServerId, router]);

  const focusServerId = resolvedServerId;
  const navigationStatus = isRuntimeSessionAvailable
    ? "ready"
    : "session_unavailable";

  useFocusEffect(
    useCallback(() => {
      if (!resolvedAgentId || !focusServerId) {
        return;
      }
      const navigationKey = buildAgentNavigationKey(
        focusServerId,
        resolvedAgentId
      );
      endNavigationTiming(navigationKey, {
        screen: "agent",
        status: navigationStatus,
      });
    }, [focusServerId, navigationStatus, resolvedAgentId])
  );

  if (!resolvedServerId || !runtimeClient) {
    return (
      <AgentSessionUnavailableState
        onBack={handleBackToHome}
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
      />
    );
  }

  return (
    <ExplorerSidebarAnimationProvider>
      <AgentScreenContent
        serverId={resolvedServerId}
        agentId={resolvedAgentId}
        client={runtimeClient}
        isConnected={runtimeIsConnected}
        connectionStatus={connectionStatus}
      />
    </ExplorerSidebarAnimationProvider>
  );
}

type AgentScreenContentProps = {
  serverId: string;
  agentId?: string;
  client: DaemonClient;
  isConnected: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

function AgentScreenContent({
  serverId,
  agentId,
  client,
  isConnected,
  connectionStatus,
}: AgentScreenContentProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const resolvedAgentId = agentId;
  const { isArchivingAgent } = useArchiveAgent();

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setActiveExplorerCheckout = usePanelStore((state) => state.setActiveExplorerCheckout);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout
  );

  // Derive isExplorerOpen from the unified panel state
  const isExplorerOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;
  // Select only the specific agent
  const agent = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agents?.get(resolvedAgentId)
      : undefined
  );
  // Checkout status for header subtitle + git fallback when cached project placement is absent
  const checkoutStatusQuery = useCheckoutStatusQuery({
    serverId,
    cwd: agent?.cwd ?? "",
  });
  const checkout = checkoutStatusQuery.status;
  const resolveCachedCheckoutIsGit = useCallback(
    (params: {
      cwd?: string | null;
      projectPlacementIsGit?: boolean;
      checkoutStatusIsGit?: boolean;
    }): boolean | null => {
      if (typeof params.projectPlacementIsGit === "boolean") {
        return params.projectPlacementIsGit;
      }

      const cwd = params.cwd?.trim();
      if (!cwd) {
        return null;
      }
      const cachedCheckout = queryClient.getQueryData<CheckoutStatusPayload>(
        checkoutStatusQueryKey(serverId, cwd)
      );
      if (typeof cachedCheckout?.isGit === "boolean") {
        return cachedCheckout.isGit;
      }
      if (typeof params.checkoutStatusIsGit === "boolean") {
        return params.checkoutStatusIsGit;
      }
      return null;
    },
    [queryClient, serverId]
  );
  const resolveCurrentExplorerCheckout = useCallback((): ExplorerCheckoutContext | null => {
    if (!resolvedAgentId) {
      return null;
    }
    const currentAgent = useSessionStore
      .getState()
      .sessions[serverId]
      ?.agents?.get(resolvedAgentId);
    const cwd = currentAgent?.cwd?.trim();
    const isGit = resolveCachedCheckoutIsGit({
      cwd,
      projectPlacementIsGit: currentAgent?.projectPlacement?.checkout?.isGit,
      checkoutStatusIsGit: checkout?.isGit,
    });
    if (!cwd || typeof isGit !== "boolean") {
      return null;
    }
    return { serverId, cwd, isGit };
  }, [resolveCachedCheckoutIsGit, resolvedAgentId, checkout?.isGit, serverId]);
  const openExplorerForActiveCheckout = useCallback(() => {
    const checkoutContext = resolveCurrentExplorerCheckout();
    logAgentExplorer("openExplorerForActiveCheckout", {
      hasCheckoutContext: Boolean(checkoutContext),
      checkoutContext,
    });
    if (checkoutContext) {
      activateExplorerTabForCheckout(checkoutContext);
    }
    openFileExplorer();
  }, [activateExplorerTabForCheckout, openFileExplorer, resolveCurrentExplorerCheckout]);
  const handleToggleExplorer = useCallback(() => {
    logAgentExplorer("handleToggleExplorer", {
      isExplorerOpen,
      mobileView,
      isMobile,
    });
    if (isExplorerOpen) {
      toggleFileExplorer();
      return;
    }
    openExplorerForActiveCheckout();
  }, [isExplorerOpen, isMobile, mobileView, openExplorerForActiveCheckout, toggleFileExplorer]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }
    const scope = `agent:${serverId}:${agentId ?? "unknown"}`;
    const stop = startPerfMonitor(scope);
    return stop;
  }, [serverId, agentId]);

  // Swipe-left gesture to open explorer sidebar on mobile
  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === "agent",
    onOpen: openExplorerForActiveCheckout,
  });

  // Handle hardware back button - close explorer sidebar first, then navigate back
  useEffect(() => {
    if (Platform.OS === "web") return;

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true; // Prevent default back navigation
      }
      return false; // Let default back navigation happen
    });

    return () => handler.remove();
  }, [isExplorerOpen, closeToAgent]);

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    const cwd = agent?.cwd?.trim();
    const isGit = resolveCachedCheckoutIsGit({
      cwd,
      projectPlacementIsGit: agent?.projectPlacement?.checkout?.isGit,
      checkoutStatusIsGit: checkout?.isGit,
    });
    if (!cwd || typeof isGit !== "boolean") {
      return null;
    }
    return { serverId, cwd, isGit };
  }, [
    agent?.cwd,
    agent?.projectPlacement?.checkout?.isGit,
    resolveCachedCheckoutIsGit,
    resolvedAgentId,
    checkout?.isGit,
    serverId,
  ]);

  useEffect(() => {
    setActiveExplorerCheckout(activeExplorerCheckout);
  }, [activeExplorerCheckout, setActiveExplorerCheckout]);

  useEffect(() => {
    if (!activeExplorerCheckout) {
      return;
    }
    activateExplorerTabForCheckout(activeExplorerCheckout);
  }, [activateExplorerTabForCheckout, activeExplorerCheckout]);

  useEffect(() => {
    return () => {
      setActiveExplorerCheckout(null);
    };
  }, [setActiveExplorerCheckout]);

  // Select only the specific stream tail - use stable empty array to avoid infinite loop
  const streamItemsRaw = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agentStreamTail?.get(resolvedAgentId)
      : undefined
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;

  const pendingCreate = useCreateFlowStore((state) => state.pending);
  const markPendingCreateLifecycle = useCreateFlowStore(
    (state) => state.markLifecycle
  );
  const clearPendingCreate = useCreateFlowStore((state) => state.clear);
  const isPendingCreateForRoute =
    Boolean(pendingCreate) &&
    pendingCreate?.lifecycle === "active" &&
    pendingCreate?.serverId === serverId &&
    pendingCreate?.agentId === resolvedAgentId;

  // Select only the specific initializing state
  const isInitializingFromMap = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.initializingAgents?.get(resolvedAgentId) ?? false
      : false
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0
  );
  const agentHistorySyncGeneration = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agentHistorySyncGeneration?.get(resolvedAgentId) ?? -1
      : -1
  );
  const hasHydratedHistoryBefore = agentHistorySyncGeneration >= 0;

  // Select raw pending permissions - filter with useMemo to avoid new Map on every render
  const allPendingPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions
  );
  const setAgents = useSessionStore((state) => state.setAgents);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setPendingPermissions = useSessionStore(
    (state) => state.setPendingPermissions
  );
  const pendingPermissions = useMemo(() => {
    if (!allPendingPermissions || !resolvedAgentId) return new Map();
    const filtered = new Map();
    for (const [key, perm] of allPendingPermissions) {
      if (perm.agentId === resolvedAgentId) {
        filtered.set(key, perm);
      }
    }
    return filtered;
  }, [allPendingPermissions, resolvedAgentId]);

  const hasSession = useSessionStore(
    (state) => Boolean(state.sessions[serverId])
  );
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null
  );
  const { ensureAgentIsInitialized, refreshAgent } = useAgentInitialization({
    serverId,
    client: hasSession ? client : null,
  });
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });
  const reconnectToastArmedRef = useRef(false);
  const initAttemptTokenRef = useRef(0);
  const setFocusedAgentId = useCallback(
    (agentId: string | null) => {
      useSessionStore.getState().setFocusedAgentId(serverId, agentId);
    },
    [serverId]
  );

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [insets.bottom, bottomInset]);

  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - bottomInset.value);
    return {
      transform: [{ translateY: -shift }],
    };
  });

  const handleHistorySyncFailure = useCallback(
    ({ origin, error }: { origin: "focus" | "entry"; error: unknown }) => {
      if (resolvedAgentId) {
        console.warn("[AgentScreen] history sync failed", {
          origin,
          agentId: resolvedAgentId,
          error,
        });
      }
      const message = toErrorMessage(error);
      setMissingAgentState((prev) => {
        if (prev.kind === "error" && prev.message === message) {
          return prev;
        }
        return { kind: "error", message };
      });
    },
    [resolvedAgentId]
  );

  const ensureInitializedWithSyncErrorHandling = useCallback(
    (origin: "focus" | "entry") => {
      if (!resolvedAgentId) {
        return;
      }
      ensureAgentIsInitialized(resolvedAgentId).catch((error) => {
        handleHistorySyncFailure({ origin, error });
      });
    },
    [ensureAgentIsInitialized, handleHistorySyncFailure, resolvedAgentId]
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
      toast.show("Reconnecting...", {
        durationMs: 2200,
        testID: "agent-reconnecting-toast",
      });
    }
  }, [connectionStatus, toast]);

  useFocusEffect(
    useCallback(() => {
      if (!resolvedAgentId || !isConnected || !hasSession) {
        return;
      }
      ensureInitializedWithSyncErrorHandling("focus");
    }, [
      ensureInitializedWithSyncErrorHandling,
      hasSession,
      isConnected,
      resolvedAgentId,
    ])
  );

  const isGitCheckout = activeExplorerCheckout?.isGit ?? false;
  const isArchivingCurrentAgent = Boolean(
    resolvedAgentId &&
      isArchivingAgent({ serverId, agentId: resolvedAgentId })
  );
  const hasRedirectedArchivedAgentRef = useRef(false);

  useEffect(() => {
    if (!resolvedAgentId) {
      hasRedirectedArchivedAgentRef.current = false;
      return;
    }
    if (!agent?.archivedAt) {
      hasRedirectedArchivedAgentRef.current = false;
      return;
    }
    if (hasRedirectedArchivedAgentRef.current) {
      return;
    }
    hasRedirectedArchivedAgentRef.current = true;
    router.replace(buildHostAgentDraftRoute(serverId) as any);
  }, [agent?.archivedAt, resolvedAgentId, router, serverId]);

  useEffect(() => {
    if (!resolvedAgentId) {
      setFocusedAgentId(null);
      return;
    }

    setFocusedAgentId(resolvedAgentId);
    return () => {
      setFocusedAgentId(null);
    };
  }, [resolvedAgentId, setFocusedAgentId]);

  const isInitializing = resolvedAgentId ? isInitializingFromMap !== false : false;
  const isHistorySyncing = useMemo(() => {
    if (!resolvedAgentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, resolvedAgentId);
    return Boolean(getInitDeferred(initKey));
  }, [resolvedAgentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!resolvedAgentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, historySyncGeneration, resolvedAgentId]);

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (!isPendingCreateForRoute || !pendingCreate) {
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
  }, [isPendingCreateForRoute, pendingCreate]);

  const mergedStreamItems = useMemo<StreamItem[]>(() => {
    if (optimisticStreamItems.length === 0) {
      return streamItems;
    }
    const optimistic = optimisticStreamItems[0];
    if (!optimistic) {
      return streamItems;
    }
    const alreadyHasOptimistic = streamItems.some(
      (item) => item.kind === "user_message" && item.id === optimistic.id
    );
    return alreadyHasOptimistic ? streamItems : [...optimisticStreamItems, ...streamItems];
  }, [optimisticStreamItems, streamItems]);

  const shouldUseOptimisticStream = isPendingCreateForRoute && optimisticStreamItems.length > 0;
  const authoritativeStatus = agent?.status;
  const isAuthoritativeBootstrapping =
    authoritativeStatus === "initializing" || authoritativeStatus === "idle";
  const showPendingCreateSubmitLoading =
    isPendingCreateForRoute &&
    (!authoritativeStatus || isAuthoritativeBootstrapping);
  const canFinalizePendingCreate =
    Boolean(authoritativeStatus) && !isAuthoritativeBootstrapping;

  const placeholderAgent: Agent | null = useMemo(() => {
    if (!shouldUseOptimisticStream || !resolvedAgentId) {
      return null;
    }
    const now = new Date();
    return {
      serverId,
      id: resolvedAgentId,
      provider: "claude",
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: now,
      lastActivityAt: now,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: {
        provider: "claude",
        sessionId: null,
        model: null,
        modeId: null,
      },
      title: "Agent",
      cwd: ".",
      model: null,
      labels: {},
    };
  }, [resolvedAgentId, serverId, shouldUseOptimisticStream]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${resolvedAgentId ?? ""}`,
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
  const agentModel = extractAgentModel(effectiveAgent ?? agent);
  const modelDisplayValue = agentModel ?? "Unknown";
  const providerLabel = (effectiveAgent?.provider ?? "Provider").replace(
    /^\w/,
    (m) => m.toUpperCase()
  );
  const providerSessionId =
    effectiveAgent?.runtimeInfo?.sessionId ?? effectiveAgent?.persistence?.sessionId ?? null;

  // Header subtitle: project path + branch (matching agent list row format)
  const headerProjectPath = effectiveAgent
    ? deriveProjectPath(effectiveAgent.cwd, checkout)
    : null;
  useEffect(() => {
    if (!isPendingCreateForRoute || !pendingCreate) {
      return;
    }
    const hasUserMessage = streamItems.some(
      (item) =>
        item.kind === "user_message" &&
        item.id === pendingCreate.clientMessageId
    );
    if (hasUserMessage && canFinalizePendingCreate) {
      if (
        resolvedAgentId &&
        pendingCreate.images &&
        pendingCreate.images.length > 0
      ) {
        setAgentStreamTail(serverId, (prev) => {
          const current = prev.get(resolvedAgentId);
          if (!current) {
            return prev;
          }

          const merged = mergePendingCreateImages({
            streamItems: current,
            clientMessageId: pendingCreate.clientMessageId,
            images: pendingCreate.images,
          });
          if (merged === current) {
            return prev;
          }

          const next = new Map(prev);
          next.set(resolvedAgentId, merged);
          return next;
        });
      }
      markPendingCreateLifecycle("sent");
      clearPendingCreate();
    }
  }, [
    canFinalizePendingCreate,
    clearPendingCreate,
    isPendingCreateForRoute,
    markPendingCreateLifecycle,
    pendingCreate,
    resolvedAgentId,
    serverId,
    setAgentStreamTail,
    streamItems,
  ]);

  useEffect(() => {
    if (!resolvedAgentId || !ensureAgentIsInitialized) {
      return;
    }

    if (!isConnected || !hasSession) {
      return;
    }
    // On native clients, daemon stream forwarding is focused-agent only, so switching
    // agents can leave timeline gaps unless we explicitly pull timeline catch-up.
    const shouldSyncOnEntry = needsAuthoritativeSync || Platform.OS !== "web";
    if (!shouldSyncOnEntry) {
      return;
    }

    ensureInitializedWithSyncErrorHandling("entry");
  }, [
    resolvedAgentId,
    ensureInitializedWithSyncErrorHandling,
    hasSession,
    isConnected,
    needsAuthoritativeSync,
  ]);

  useEffect(() => {
    // Clear stale resolution state when route target changes.
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [serverId, resolvedAgentId]);

  useEffect(() => {
    if (!resolvedAgentId || !ensureAgentIsInitialized) {
      return;
    }
    if (agent || shouldUseOptimisticStream) {
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

    ensureAgentIsInitialized(resolvedAgentId)
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentAgent = useSessionStore
          .getState()
          .sessions[serverId]
          ?.agents.get(resolvedAgentId);
        if (!currentAgent && client) {
          const result = await client.fetchAgent(resolvedAgentId);
          if (attemptToken !== initAttemptTokenRef.current) {
            return;
          }
          if (!result) {
            setMissingAgentState({
              kind: "not_found",
              message: `Agent not found: ${resolvedAgentId}`,
            });
            return;
          }
          const normalized = normalizeAgentSnapshot(result.agent, serverId);
          const hydrated = {
            ...normalized,
            projectPlacement: result.project,
          };
          setAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(hydrated.id, hydrated);
            return next;
          });
          setPendingPermissions(serverId, (prev) => {
            const next = new Map(prev);
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
    agent,
    client,
    ensureAgentIsInitialized,
    hasSession,
    isConnected,
    missingAgentState.kind,
    resolvedAgentId,
    serverId,
    setAgents,
    setPendingPermissions,
    shouldUseOptimisticStream,
  ]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }
    const title = agent?.title || "Agent";
    document.title = title;
  }, [agent?.title]);

  // Clear attention as soon as the user is focused on this agent screen.
  useEffect(() => {
    const clearAgentId = resolvedAgentId?.trim();
    if (!clearAgentId || !client) {
      return;
    }
    if (
      !shouldClearAgentAttentionOnView({
        agentId: clearAgentId,
        focusedAgentId,
        isConnected,
        requiresAttention: agent?.requiresAttention,
      })
    ) {
      return;
    }
    client.clearAgentAttention(clearAgentId);
  }, [
    agent?.requiresAttention,
    client,
    focusedAgentId,
    isConnected,
    resolvedAgentId,
  ]);

  const handleRefreshAgent = useCallback(() => {
    if (!resolvedAgentId || !hasSession) {
      return;
    }
    void refreshAgent(resolvedAgentId).catch((error) => {
      console.warn("[AgentScreen] refreshAgent failed", { agentId: resolvedAgentId, error });
    });
  }, [hasSession, refreshAgent, resolvedAgentId]);

  const handleCopyMeta = useCallback(
    async (label: string, value: string | null | undefined) => {
      if (!value) {
        return;
      }
      try {
        await Clipboard.setStringAsync(value);
        toast.show(`Copied ${label}`, {
          variant: "success",
          icon: <CheckCircle2 size={theme.iconSize.md} color={theme.colors.primary} />,
        });
      } catch {
        toast.error("Copy failed");
      }
    },
    [theme.colors.primary, toast]
  );

  const isHistoryRefreshCatchingUp =
    viewState.tag === "ready" &&
    viewState.sync.status === "catching_up" &&
    viewState.sync.ui === "toast";
  const shouldEmitSyncErrorToast =
    viewState.tag === "ready" &&
    viewState.sync.status === "sync_error" &&
    viewState.sync.shouldEmitSyncErrorToast;

  useDelayedHistoryRefreshToast({
    isCatchingUp: isHistoryRefreshCatchingUp,
    indicatorColor: theme.colors.primary,
  });

  useEffect(() => {
    if (!shouldEmitSyncErrorToast) {
      return;
    }
    toast.error("Failed to refresh agent. Retrying in background.");
  }, [shouldEmitSyncErrorToast, toast]);

  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <MenuHeader title="Agent" />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  if (viewState.tag === "error") {
    return (
      <View style={styles.container} testID="agent-load-error">
        <MenuHeader title="Agent" />
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
        <MenuHeader title="Agent" />
        <View style={styles.errorContainer}>
          <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
        </View>
      </View>
    );
  }

  const mainContent = (
    <View style={styles.outerContainer}>
      <FileDropZone
        onFilesDropped={handleFilesDropped}
        disabled={isArchivingCurrentAgent}
      >
      <View style={styles.container}>
        {/* Header */}
        <MenuHeader
          title={effectiveAgent.title || "Agent"}
          rightContent={
            <View style={styles.headerRightContent}>
              <HeaderToggleButton
                onPress={handleToggleExplorer}
                tooltipLabel="Toggle explorer"
                tooltipKeys={["mod", "E"]}
                tooltipSide="left"
                style={styles.menuButton}
                accessible
                accessibilityRole="button"
                accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                accessibilityState={{ expanded: isExplorerOpen }}
              >
                {isMobile ? (
                  checkout?.isGit ? (
                    <GitBranch
                      size={theme.iconSize.lg}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  ) : (
                    <Folder
                      size={theme.iconSize.lg}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  )
                ) : (
                  <PanelRight
                    size={theme.iconSize.md}
                    color={
                      isExplorerOpen
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted
                    }
                  />
                )}
              </HeaderToggleButton>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open && agent?.cwd) {
                    checkoutStatusQuery.refresh().catch(() => {});
                  }
                }}
              >
                <DropdownMenuTrigger testID="agent-overflow-menu" style={styles.menuButton}>
                  <MoreVertical
                    size={isMobile ? theme.iconSize.lg : theme.iconSize.md}
                    color={theme.colors.foregroundMuted}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={DROPDOWN_WIDTH} testID="agent-overflow-content">
                  <View style={styles.menuMetaContainer}>
                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Directory", effectiveAgent.cwd);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Directory
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {shortenPath(effectiveAgent.cwd)}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Model", modelDisplayValue);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Model
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {modelDisplayValue}
                      </Text>
                    </Pressable>

                    {checkout?.isGit && checkout.currentBranch && checkout.currentBranch !== "HEAD" ? (
                      <Pressable
                        style={({ hovered, pressed }) => [
                          styles.menuMetaRow,
                          (hovered || pressed) && styles.menuMetaRowActive,
                        ]}
                        onPress={() => {
                          if (checkoutStatusQuery.isFetching) {
                            return;
                          }
                          void handleCopyMeta("Branch", checkout.currentBranch);
                        }}
                      >
                        <Text style={styles.menuMetaLabel} numberOfLines={1}>
                          Branch
                        </Text>
                        <Text
                          style={styles.menuMetaValue}
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {checkoutStatusQuery.isFetching ? "Fetching…" : checkout.currentBranch}
                        </Text>
                      </Pressable>
                    ) : null}

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Paseo ID", effectiveAgent.id);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Paseo ID
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {effectiveAgent.id}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        providerSessionId && (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      disabled={!providerSessionId}
                      onPress={() => {
                        void handleCopyMeta(`${providerLabel} ID`, providerSessionId);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        {providerLabel} ID
                      </Text>
                      <Text
                        style={[styles.menuMetaValue, !providerSessionId && styles.menuMetaValueError]}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {providerSessionId ?? "Not available"}
                      </Text>
                    </Pressable>
                  </View>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    leading={<RotateCcw size={theme.iconSize.md} color={theme.colors.foreground} />}
                    disabled={isInitializing}
                    trailing={
                      isInitializing ? (
                        <ActivityIndicator
                          size="small"
                          color={theme.colors.primary}
                          style={styles.menuItemSpinner}
                        />
                      ) : null
                    }
                    onSelect={handleRefreshAgent}
                  >
                    {isInitializing ? "Refreshing..." : "Refresh"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </View>
          }
        />

          {/* Content Area with Keyboard Animation */}
          <View style={styles.contentContainer}>
            <ReanimatedAnimated.View
              style={[styles.content, animatedKeyboardStyle]}
            >
              <AgentStreamView
                agentId={effectiveAgent.id}
                serverId={serverId}
                agent={effectiveAgent}
                streamItems={
                  shouldUseOptimisticStream ? mergedStreamItems : streamItems
                }
                pendingPermissions={pendingPermissions}
              />
            </ReanimatedAnimated.View>
          </View>

          {/* Agent Input Area */}
          {resolvedAgentId && !isArchivingCurrentAgent && (
            <AgentInputArea
              agentId={resolvedAgentId}
              serverId={serverId}
              autoFocus
              isSubmitLoading={showPendingCreateSubmitLoading}
              onAddImages={handleAddImagesCallback}
            />
          )}

          {viewState.tag === "ready" &&
          viewState.sync.status === "catching_up" &&
          viewState.sync.ui === "overlay" ? (
            <View style={styles.historySyncOverlay} testID="agent-history-overlay">
              <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
            </View>
          ) : null}

        </View>
      </FileDropZone>

        {/* Explorer Sidebar - Desktop: inline, Mobile: overlay */}
        {!isMobile && isExplorerOpen && resolvedAgentId && (
          <ExplorerSidebar
            serverId={serverId}
            agentId={resolvedAgentId}
            cwd={effectiveAgent.cwd}
            isGit={isGitCheckout}
          />
        )}

        {isArchivingCurrentAgent ? (
          <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
            <ActivityIndicator size="large" color={theme.colors.foreground} />
            <Text style={styles.archivingTitle}>Archiving agent...</Text>
            <Text style={styles.archivingSubtitle}>
              Please wait while we archive this agent.
            </Text>
          </View>
        ) : null}
      </View>
  );

  return (
    <>
      {isMobile ? (
        <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
          {mainContent}
        </GestureDetector>
      ) : (
        mainContent
      )}

      {/* Mobile Explorer Sidebar Overlay */}
      {isMobile && resolvedAgentId && (
        <ExplorerSidebar
          serverId={serverId}
          agentId={resolvedAgentId}
          cwd={effectiveAgent.cwd}
          isGit={isGitCheckout}
        />
      )}
    </>
  );
}

function AgentSessionUnavailableState({
  onBack,
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
}: {
  onBack: () => void;
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <BackHeader title="Agent" onBack={onBack} />
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            Cannot open this agent because {serverLabel} is not configured on
            this device.
          </Text>
          <Text style={styles.statusText}>
            Add the host in Settings or open an agent on a configured server to
            continue.
          </Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";
  const isPreparingSession = connectionStatus === "online";

  return (
    <View style={styles.container}>
      <BackHeader title="Agent" onBack={onBack} />
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
            <Text style={styles.offlineTitle}>
              Reconnecting to {serverLabel}...
            </Text>
            <Text style={styles.offlineDescription}>
              We will show this agent again as soon as the host is reachable.
            </Text>
            {lastError ? (
              <Text style={styles.offlineDetails}>{lastError}</Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerContainer: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  headerRightContent: {
    flexDirection: "row",
    alignItems: "center",
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
  errorDetails: {
    marginTop: theme.spacing[1],
    textAlign: "center",
    fontSize: theme.fontSize.xs,
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
  menuButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  menuMetaContainer: {
    paddingVertical: theme.spacing[1],
  },
  menuMetaRow: {
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  menuMetaRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  menuMetaLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  menuMetaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  menuMetaValueError: {
    color: theme.colors.destructive,
  },
  menuItemSpinner: {
    marginLeft: "auto",
  },
}));
