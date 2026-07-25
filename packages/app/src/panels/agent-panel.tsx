import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TFunction } from "i18next";
import { SquarePen } from "lucide-react-native";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { shallow, useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { SidebarCallout } from "@/components/sidebar-callout";
import { Composer } from "@/composer";
import { RewindComposerRestoreProvider } from "@/components/rewind/composer-restore";
import { getProviderIcon } from "@/components/provider-icons";
import {
  ToastViewport,
  useToastHost,
  type ToastApi,
  type ToastState,
} from "@/components/toast-host";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useAgentAttentionClear } from "@/hooks/use-agent-attention-clear";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import { useAgentInputDraft, type AgentInputDraft } from "@/composer/draft/input-draft";
import {
  type AgentScreenAgent,
  type AgentScreenContinuity,
  type AgentScreenMissingState,
  type AgentScreenViewState,
  useAgentScreenStateMachine,
} from "@/hooks/use-agent-screen-state-machine";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { reconcileMissingAgentStateWithPresentAgent } from "@/panels/agent-panel-load-state";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { RenderProfile } from "@/utils/render-profiler";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
  useHostRuntimeLastError,
  useHosts,
} from "@/runtime/host-runtime";
import {
  deriveRouteBottomAnchorIntent,
  deriveRouteBottomAnchorRequest,
} from "@/screens/agent/agent-ready-screen-bottom-anchor";
import { WorkspaceDraftAgentTab } from "@/composer/draft/workspace-tab";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { usePanelStore } from "@/stores/panel-store";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { Theme } from "@/styles/theme";
import {
  useHideFinishedProviderSubagents,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentsForParent,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { buildDraftAgentSetup, type ClientSlashCommand } from "@/client-slash-commands";

interface ChatAgentStateShape {
  serverId: string | null;
  id: string | null;
  provider?: Agent["provider"];
  status: Agent["status"] | null;
  cwd: string | null;
  workspaceId?: string;
  capabilities?: Agent["capabilities"];
  currentModeId?: Agent["currentModeId"];
  model?: Agent["model"];
  thinkingOptionId?: Agent["thinkingOptionId"];
  runtimeInfo?: Agent["runtimeInfo"];
  features?: Agent["features"];
  lastError?: Agent["lastError"] | null;
}

interface ChatAgentSelectedState extends ChatAgentStateShape {
  archivedAt: Date | null;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"] | null;
}

function resolveChatAgentFromSession(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): Agent | null {
  if (!agentId) return null;
  const session = state.sessions[serverId];
  return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null;
}

const EMPTY_CHAT_AGENT_STATE: ChatAgentSelectedState = {
  serverId: null,
  id: null,
  status: null,
  cwd: null,
  lastError: null,
  archivedAt: null,
  requiresAttention: false,
  attentionReason: null,
};

function selectChatAgentState(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): ChatAgentSelectedState {
  const agent = resolveChatAgentFromSession(state, serverId, agentId);
  if (!agent) return EMPTY_CHAT_AGENT_STATE;
  return {
    serverId: agent.serverId,
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    runtimeInfo: agent.runtimeInfo,
    features: agent.features,
    lastError: agent.lastError ?? null,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
  };
}

function buildChatAgentFromState(
  state: ChatAgentStateShape,
  projectPlacement: Agent["projectPlacement"] | null,
): AgentScreenAgent | null {
  if (!state.serverId || !state.id || !state.status || !state.cwd) {
    return null;
  }
  return {
    serverId: state.serverId,
    id: state.id,
    provider: state.provider,
    status: state.status,
    cwd: state.cwd,
    workspaceId: state.workspaceId,
    capabilities: state.capabilities,
    currentModeId: state.currentModeId,
    model: state.model,
    thinkingOptionId: state.thinkingOptionId,
    runtimeInfo: state.runtimeInfo,
    features: state.features,
    lastError: state.lastError ?? null,
    projectPlacement,
  };
}

function renderChatAgentNonReadyView(args: {
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
}): React.ReactElement | null {
  const { viewState, effectiveAgent, t } = args;
  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }
  if (viewState.tag === "error") {
    return (
      <View style={styles.container} testID="agent-load-error">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
          <Text style={styles.statusText}>{viewState.message}</Text>
        </View>
      </View>
    );
  }
  if (viewState.tag === "boot" || !effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedActivityIndicator size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }
  return null;
}

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

function shouldStoreFetchedAgentInActiveDirectory(agent: Agent): boolean {
  return !agent.archivedAt && Boolean(agent.projectPlacement);
}

type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

function storeFetchedAgentDetail(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const hydrated: Agent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: {
      ...normalized,
      projectPlacement: input.result.project,
    },
  });
  const store = useSessionStore.getState();

  if (shouldStoreFetchedAgentInActiveDirectory(hydrated)) {
    store.setAgents(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  } else {
    store.setAgentDetails(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  }

  store.setPendingPermissions(input.serverId, (previous) => {
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

  return hydrated;
}

function useAgentPanelDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId) ?? null;
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
  const icon = getProviderIcon(provider);

  return {
    label: label ?? "",
    subtitle: `${formatProviderLabel(provider)} agent`,
    tooltip: label ?? `${formatProviderLabel(provider)} agent`,
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
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "agent", "AgentPanel requires agent target");

  return (
    <AgentPanelContent
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={target.agentId}
      isPaneFocused={isInteractive}
      onOpenWorkspaceFile={openFileInWorkspace}
    />
  );
}

function DraftPanel() {
  const {
    serverId,
    workspaceId,
    tabId,
    target,
    openFileInWorkspace,
    openImportSheet,
    retargetCurrentTab,
  } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "draft", "DraftPanel requires draft target");

  const handleCreated = useCallback(
    (agentSnapshot: Parameters<typeof normalizeAgentSnapshot>[0]) => {
      const normalized = normalizeAgentSnapshot(agentSnapshot, serverId);
      const agent = applyLegacyDaemonWorkspaceOwnership({ serverId, agent: normalized });
      useSessionStore.getState().setAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentSnapshot.id, agent);
        return next;
      });
      retargetCurrentTab({ kind: "agent", agentId: agentSnapshot.id });
    },
    [retargetCurrentTab, serverId],
  );

  return (
    <WorkspaceDraftAgentTab
      serverId={serverId}
      workspaceId={workspaceId}
      tabId={tabId}
      draftId={target.draftId}
      initialSetup={target.setup}
      isPaneFocused={isInteractive}
      onOpenWorkspaceFile={openFileInWorkspace}
      onCreated={handleCreated}
      onOpenImportSheet={openImportSheet}
    />
  );
}

export function AgentConversationPanel() {
  const { target } = usePaneContext();
  if (target.kind === "draft") {
    return <DraftPanel />;
  }
  if (target.kind === "agent") {
    return <AgentPanel />;
  }
  invariant(false, "AgentConversationPanel requires an agent or draft target");
}

export const agentPanelRegistration: PanelRegistration<"agent"> = {
  kind: "agent",
  component: AgentConversationPanel,
  useDescriptor: useAgentPanelDescriptor,
};

export function useDraftPanelDescriptor(
  target: { kind: "draft"; draftId: string },
  context: { serverId: string },
) {
  const createDescriptorState = useCreateFlowStore(
    useShallow((state) => {
      const pending = state.pendingByDraftId[target.draftId];
      if (pending?.serverId !== context.serverId || pending.lifecycle !== "active") {
        return {
          isCreating: false,
          pendingPrompt: null,
        };
      }
      return {
        isCreating: true,
        pendingPrompt: pending.text,
      };
    }),
  );

  return buildDraftPanelDescriptor({
    ...createDescriptorState,
    icon: SquarePen,
  });
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_PENDING_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_PENDING_PERMISSION_LIST: PendingPermission[] = [];

type RouteBottomAnchorRequest = ReturnType<typeof deriveRouteBottomAnchorRequest>;

function findActiveCreateHandoff(input: {
  pendingByDraftId: ReturnType<typeof useCreateFlowStore.getState>["pendingByDraftId"];
  serverId: string;
  agentId?: string;
}): boolean {
  if (!input.agentId) {
    return false;
  }
  return Object.values(input.pendingByDraftId).some(
    (pending) =>
      pending.lifecycle === "sent" &&
      pending.serverId === input.serverId &&
      pending.agentId === input.agentId,
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

type AgentLookupState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "not_found"; message: string }
  | { tag: "error"; message: string };

function AgentPanelContent({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const resolvedAgentId = agentId.trim() || undefined;
  const resolvedServerId = serverId.trim() || undefined;
  const daemons = useHosts();
  const runtimeServerId = resolvedServerId ?? "";
  const runtimeClient = useHostRuntimeClient(runtimeServerId);
  const runtimeIsConnected = useHostRuntimeIsConnected(runtimeServerId);
  const runtimeConnectionStatus = useHostRuntimeConnectionStatus(runtimeServerId);
  const runtimeLastError = useHostRuntimeLastError(runtimeServerId);
  const hasCachedAgent = useSessionStore((state) => {
    if (!resolvedServerId || !resolvedAgentId) return false;
    const session = state.sessions[resolvedServerId];
    return Boolean(
      session?.agents.has(resolvedAgentId) || session?.agentDetails.has(resolvedAgentId),
    );
  });

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? (daemons.find((entry) => entry.serverId === connectionServerId) ?? null)
    : null;
  const serverLabel =
    daemon?.label ?? connectionServerId ?? t("agentPanel.unavailable.selectedHost");
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    isUnknownDaemon && runtimeConnectionStatus === "connecting"
      ? "offline"
      : runtimeConnectionStatus;
  const lastConnectionError = runtimeLastError;

  if (!resolvedServerId || (!runtimeClient && !hasCachedAgent)) {
    return (
      <AgentSessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
        t={t}
      />
    );
  }

  return (
    <AgentPanelBody
      serverId={resolvedServerId}
      workspaceId={workspaceId}
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
  workspaceId,
  agentId,
  isPaneFocused,
  client,
  isConnected,
  connectionStatus,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const { isArchivingAgent: _isArchivingAgent } = useArchiveAgent();
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const [lookupState, setLookupState] = useState<AgentLookupState>({ tag: "idle" });
  const lookupAttemptTokenRef = useRef(0);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const resolvePendingAgent = useWorkspaceLayoutStore((state) => state.resolvePendingAgent);

  useEffect(() => {
    lookupAttemptTokenRef.current += 1;
    setLookupState({ tag: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.id) {
      if (workspaceKey) {
        resolvePendingAgent(workspaceKey, agentId);
      }
      if (lookupState.tag !== "idle") {
        setLookupState({ tag: "idle" });
      }
      return;
    }
    if (!client || !isConnected || !hasSession) {
      return;
    }
    if (lookupState.tag === "loading" || lookupState.tag === "not_found") {
      return;
    }

    setLookupState({ tag: "loading" });
    const attemptToken = ++lookupAttemptTokenRef.current;

    client
      .fetchAgent({ agentId })
      .then((result) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        if (!result) {
          if (workspaceKey) {
            resolvePendingAgent(workspaceKey, agentId);
          }
          setLookupState({
            tag: "not_found",
            message: `Agent not found: ${agentId}`,
          });
          return;
        }

        storeFetchedAgentDetail({ serverId, result });
        if (workspaceKey) {
          resolvePendingAgent(workspaceKey, agentId);
        }
        setLookupState({ tag: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          if (workspaceKey) {
            resolvePendingAgent(workspaceKey, agentId);
          }
          setLookupState({ tag: "not_found", message });
          return;
        }
        setLookupState({ tag: "error", message });
      });
  }, [
    agentId,
    agentState.id,
    client,
    hasSession,
    isConnected,
    lookupState.tag,
    resolvePendingAgent,
    serverId,
    workspaceKey,
  ]);

  if (lookupState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }

  if (lookupState.tag === "error") {
    return (
      <View style={styles.container} testID="agent-load-error">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
          <Text style={styles.statusText}>{lookupState.message}</Text>
        </View>
      </View>
    );
  }

  const agent: AgentScreenAgent | null =
    agentState.serverId && agentState.id && agentState.status && agentState.cwd
      ? {
          serverId: agentState.serverId,
          id: agentState.id,
          provider: agentState.provider,
          status: agentState.status,
          cwd: agentState.cwd,
          workspaceId: agentState.workspaceId,
          capabilities: agentState.capabilities,
          currentModeId: agentState.currentModeId,
          model: agentState.model,
          thinkingOptionId: agentState.thinkingOptionId,
          runtimeInfo: agentState.runtimeInfo,
          features: agentState.features,
          lastError: agentState.lastError ?? null,
          projectPlacement,
        }
      : null;

  if (!agent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedActivityIndicator size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }

  return (
    <ChatAgentContent
      serverId={serverId}
      agentId={agentId}
      isPaneFocused={isPaneFocused}
      client={client}
      isConnected={isConnected}
      connectionStatus={connectionStatus}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function ChatAgentContent({
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
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  connectionStatus: HostRuntimeConnectionStatus;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const isPaneVisible = useRetainedPanelActive();
  const { api: toastApi, toast: toastState, dismiss: dismissToast } = useToastHost();
  const { isArchivingAgent } = useArchiveAgent();
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const clearOnAgentBlurRef = useRef<() => void>(() => {});
  const wasPaneFocusedRef = useRef(isPaneFocused);
  const reconnectToastArmedRef = useRef(false);
  const initAttemptTokenRef = useRef(0);
  const routeBottomAnchorRequestRef = useRef<{
    routeKey: string;
    reason: "initial-entry" | "resume";
  } | null>(null);
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
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
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const subscribeToVisibilityCatchUp = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTimelineStatus = useCallback(
    () =>
      !agentId || !viewedTimelineSync
        ? ("ready" as const)
        : viewedTimelineSync.getAgentTimelineStatus(agentId),
    [agentId, viewedTimelineSync],
  );
  const timelineStatus = useSyncExternalStore(
    subscribeToVisibilityCatchUp,
    readTimelineStatus,
    readTimelineStatus,
  );
  const visibilityCatchUpStatus = isPaneVisible ? timelineStatus : "ready";
  const hasActiveCreateHandoff = useCreateFlowStore((state) =>
    findActiveCreateHandoff({ pendingByDraftId: state.pendingByDraftId, serverId, agentId }),
  );
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const { ensureAgentIsInitialized } = useAgentInitialization({
    serverId,
    client: hasSession ? client : null,
  });
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });

  const hasHydratedHistoryBefore = hasAppliedAuthoritativeHistory;

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

  useEffect(() => {
    if (connectionStatus === "online") {
      if (reconnectToastArmedRef.current) {
        reconnectToastArmedRef.current = false;
        dismissToast();
      }
      return;
    }
    if (connectionStatus === "idle") {
      return;
    }
    if (!reconnectToastArmedRef.current) {
      reconnectToastArmedRef.current = true;
      toastApi.show(t("agentPanel.states.reconnecting"), {
        durationMs: null,
        testID: "agent-reconnecting-toast",
      });
    }
  }, [connectionStatus, dismissToast, toastApi, t]);

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

  const isInitializing = agentId ? isInitializingFromMap : false;
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

  const agent = useMemo<AgentScreenAgent | null>(
    () => buildChatAgentFromState(agentState, projectPlacement),
    [agentState, projectPlacement],
  );
  const continuity = useMemo<AgentScreenContinuity>(() => {
    if (!hasActiveCreateHandoff || !agentId) {
      return { kind: "none" };
    }
    return {
      kind: "optimistic-create",
      agent: {
        serverId,
        id: agentId,
        status: "running",
        cwd: agent?.cwd ?? ".",
        projectPlacement: agent?.projectPlacement ?? null,
      },
    };
  }, [agent, agentId, hasActiveCreateHandoff, serverId]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${agentId ?? ""}`,
    input: {
      agent: agent ?? null,
      isArchived: agentState.archivedAt !== null,
      missingAgentState,
      isConnected,
      isArchivingCurrentAgent,
      isHistorySyncing,
      needsAuthoritativeSync,
      visibilityCatchUpStatus,
      continuity,
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

  const handleComposerHeightChange = useCallback(
    (_height: number) => {
      if (!agentId) {
        return;
      }
      streamViewRef.current?.prepareForViewportChange();
    },
    [agentId],
  );

  const handleMessageSent = useCallback(() => {
    if (!agentId) {
      return;
    }
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [agentId]);

  useEffect(() => {
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.archivedAt) {
      return;
    }
    if (agentState.id && hasAppliedAuthoritativeHistory) {
      if (
        missingAgentState.kind === "resolving" ||
        missingAgentState.kind === "not_found" ||
        missingAgentState.kind === "error"
      ) {
        setMissingAgentState(reconcileMissingAgentStateWithPresentAgent);
      }
      return;
    }
    if (!client || !isPaneVisible || !isConnected || !hasSession) {
      return;
    }
    if (
      missingAgentState.kind === "resolving" ||
      missingAgentState.kind === "not_found" ||
      missingAgentState.kind === "error"
    ) {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    ensureAgentIsInitialized(agentId)
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentSession = useSessionStore.getState().sessions[serverId];
        const currentAgent =
          currentSession?.agents.get(agentId) ?? currentSession?.agentDetails.get(agentId);
        if (!currentAgent) {
          const result = await client.fetchAgent({ agentId });
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
          storeFetchedAgentDetail({ serverId, result });
        }
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
        return;
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
    agentState.archivedAt,
    hasAppliedAuthoritativeHistory,
    agentId,
    client,
    ensureAgentIsInitialized,
    hasSession,
    isConnected,
    isPaneVisible,
    missingAgentState.kind,
    serverId,
  ]);

  const animatedContentStyle = useMemo(
    () => [animatedStaticStyles.content, animatedKeyboardStyle],
    [animatedKeyboardStyle],
  );

  const nonReadyView = renderChatAgentNonReadyView({
    viewState,
    effectiveAgent,
    t,
  });
  if (nonReadyView) return nonReadyView;
  invariant(agentId, "agent id is defined when agent content is ready");
  invariant(effectiveAgent, "effectiveAgent is defined when the non-ready view is absent");
  const agentCwd = agentState.cwd;
  invariant(agentCwd, "agent cwd is defined when agent content is ready");
  const showHistorySyncOverlay =
    viewState.tag === "ready" &&
    viewState.sync.status === "catching_up" &&
    viewState.sync.ui === "overlay";
  const showHistorySyncError = viewState.tag === "ready" && viewState.sync.status === "sync_error";

  return (
    <ChatAgentReadyContent
      serverId={serverId}
      agentId={agentId}
      isPaneFocused={isPaneFocused}
      isArchivingCurrentAgent={isArchivingCurrentAgent}
      agentState={agentState}
      effectiveAgent={effectiveAgent}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
      toastApi={toastApi}
      toast={toastState}
      dismiss={dismissToast}
      streamViewRef={streamViewRef}
      animatedContentStyle={animatedContentStyle}
      handleComposerHeightChange={handleComposerHeightChange}
      handleMessageSent={handleMessageSent}
      showHistorySyncOverlay={showHistorySyncOverlay}
      showHistorySyncError={showHistorySyncError}
      cwd={agentCwd}
      onAttentionInputFocus={attentionController.clearOnInputFocus}
      onAttentionPromptSend={attentionController.clearOnPromptSend}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

const ChatAgentReadyContent = memo(function ChatAgentReadyContent({
  serverId,
  agentId,
  isPaneFocused,
  isArchivingCurrentAgent,
  agentState,
  effectiveAgent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  toastApi,
  toast,
  dismiss,
  streamViewRef,
  animatedContentStyle,
  handleComposerHeightChange,
  handleMessageSent,
  showHistorySyncOverlay,
  showHistorySyncError,
  cwd,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  agentState: ChatAgentSelectedState;
  effectiveAgent: AgentScreenAgent;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  toastApi: ToastApi;
  toast: ToastState | null;
  dismiss: () => void;
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  animatedContentStyle: object[];
  handleComposerHeightChange: (height: number) => void;
  handleMessageSent: () => void;
  showHistorySyncOverlay: boolean;
  showHistorySyncError: boolean;
  cwd: string;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const rawAgentInputDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId,
    }),
  });
  // Stabilize the agentInputDraft object identity so that memo(AgentComposerSection) can bail out
  // when only toast state changes (which does not affect any draft field).
  const {
    text,
    setText,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  } = rawAgentInputDraft;
  const agentInputDraft = useMemo(
    (): AgentInputDraft => ({
      text,
      setText,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    }),
    [
      text,
      setText,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    ],
  );
  const streamSection = (
    <RenderProfile id={`AgentStreamSection:${agentId}`}>
      <AgentStreamSection
        streamViewRef={streamViewRef}
        serverId={serverId}
        agentId={agentId}
        agent={effectiveAgent}
        routeBottomAnchorRequest={routeBottomAnchorRequest}
        hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
        toast={toastApi}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    </RenderProfile>
  );
  const composerSection = (
    <RenderProfile id={`AgentComposerSection:${agentId}`}>
      <AgentComposerSection
        agentId={agentId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        isArchivingCurrentAgent={isArchivingCurrentAgent}
        archivedAt={agentState.archivedAt}
        cwd={cwd}
        isSubmitLoading={false}
        agentInputDraft={agentInputDraft}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={handleComposerHeightChange}
        onMessageSent={handleMessageSent}
      />
    </RenderProfile>
  );
  const streamContent = (
    <ReanimatedAnimated.View style={animatedContentStyle}>{streamSection}</ReanimatedAnimated.View>
  );
  const contentContainer = <View style={styles.contentContainer}>{streamContent}</View>;

  return (
    <RewindComposerRestoreProvider text={agentInputDraft.text} setText={agentInputDraft.setText}>
      <View style={styles.root}>
        <FileDropZone style={styles.container} disabled={isArchivingCurrentAgent}>
          {contentContainer}

          {showHistorySyncError ? (
            <SidebarCallout
              title={t("agentPanel.states.timelineSyncFailed")}
              variant="error"
              testID="agent-timeline-sync-error"
            />
          ) : null}

          {composerSection}

          {showHistorySyncOverlay ? (
            <View style={styles.historySyncOverlay} testID="agent-history-overlay">
              <ThemedActivityIndicator size="large" uniProps={foregroundMutedColorMapping} />
            </View>
          ) : null}

          <ToastViewport toast={toast} onDismiss={dismiss} placement="panel" />
        </FileDropZone>

        {isArchivingCurrentAgent ? (
          <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
            <ThemedActivityIndicator size="large" uniProps={foregroundColorMapping} />
            <Text style={styles.archivingTitle}>{t("agentPanel.states.archivingTitle")}</Text>
            <Text style={styles.archivingSubtitle}>{t("agentPanel.states.archivingSubtitle")}</Text>
          </View>
        ) : null}
      </View>
    </RewindComposerRestoreProvider>
  );
});

const AgentStreamSection = memo(function AgentStreamSection({
  streamViewRef,
  serverId,
  agentId,
  agent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  toast,
  onOpenWorkspaceFile,
}: {
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  serverId: string;
  agentId?: string;
  agent: AgentScreenAgent;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  toast: ReturnType<typeof useToastHost>["api"];
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const streamItemsRaw = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamTail?.get(agentId) : undefined,
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const pendingPermissionList = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const allPendingPermissions = state.sessions[serverId]?.pendingPermissions;
      if (!allPendingPermissions) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const filtered: PendingPermission[] = [];
      for (const permission of allPendingPermissions.values()) {
        if (permission.agentId === agentId) {
          filtered.push(permission);
        }
      }
      return filtered.length > 0 ? filtered : EMPTY_PENDING_PERMISSION_LIST;
    },
    shallow,
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) {
      return EMPTY_PENDING_PERMISSIONS;
    }
    return new Map(pendingPermissionList.map((permission) => [permission.key, permission]));
  }, [pendingPermissionList]);

  return (
    <AgentStreamView
      ref={streamViewRef}
      agentId={agent.id}
      serverId={serverId}
      context={agent}
      streamItems={streamItems}
      pendingPermissions={pendingPermissions}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      isAuthoritativeHistoryReady={hasAppliedAuthoritativeHistory}
      toast={toast}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
});

const AgentComposerSection = memo(function AgentComposerSection({
  agentId,
  serverId,
  isPaneFocused,
  isArchivingCurrentAgent,
  archivedAt,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
}: {
  agentId?: string;
  serverId: string;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  archivedAt: Date | null;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  if (!agentId) {
    return null;
  }
  if (archivedAt) {
    return <ArchivedAgentCallout serverId={serverId} agentId={agentId} />;
  }
  if (isArchivingCurrentAgent) {
    return null;
  }

  return (
    <ActiveAgentComposer
      agentId={agentId}
      serverId={serverId}
      isPaneFocused={isPaneFocused}
      cwd={cwd}
      isSubmitLoading={isSubmitLoading}
      agentInputDraft={agentInputDraft}
      onAttentionInputFocus={onAttentionInputFocus}
      onAttentionPromptSend={onAttentionPromptSend}
      onComposerHeightChange={onComposerHeightChange}
      onMessageSent={onMessageSent}
    />
  );
});

function ActiveAgentComposer({
  agentId,
  serverId,
  isPaneFocused,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
}: {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  const insets = useSafeAreaInsets();
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const paneContext = usePaneContext();
  const { workspaceId, tabId, retargetCurrentTab, openTab } = paneContext;
  const { archiveAgent } = useArchiveAgent();
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const subagentRows = useSubagentsForParent({
    serverId,
    parentAgentId: agentId,
  });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [serverId],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );
  const handleArchiveSubagent = useArchiveSubagent({ serverId });
  const handleDetachSubagent = useDetachSubagent({ serverId });
  const handleHideFinishedProviderSubagents = useHideFinishedProviderSubagents({
    serverId,
    parentAgentId: agentId,
  });
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd,
    workspaceId,
  });
  const attachmentScopeKeys = useMemo(
    () => [workspaceAttachmentScopeKey],
    [workspaceAttachmentScopeKey],
  );
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      const checkout = {
        serverId,
        cwd: attachment.attachment.cwd,
        isGit: true,
      };
      openFileExplorerForCheckout({
        checkout,
        isCompact: isCompactFormFactor,
      });
      setExplorerTabForCheckout({
        ...checkout,
        tab: "changes",
      });
    },
    [isCompactFormFactor, openFileExplorerForCheckout, serverId, setExplorerTabForCheckout],
  );

  const handleClientSlashCommand = useCallback(
    async (command: ClientSlashCommand) => {
      const agent = resolveChatAgentFromSession(useSessionStore.getState(), serverId, agentId);
      if (!agent) {
        throw new Error("Agent not found");
      }

      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (workspaceKey) {
        unpinWorkspaceAgent(workspaceKey, agentId);
        hideWorkspaceAgent(workspaceKey, agentId);
      }

      if (command.kind === "replace-agent-with-draft") {
        retargetCurrentTab({
          kind: "draft",
          draftId: generateDraftId(),
          setup: buildDraftAgentSetup(agent),
        });
      } else if (workspaceKey) {
        closeWorkspaceTab(workspaceKey, tabId);
      }

      await archiveAgent({ serverId, agentId });
    },
    [
      agentId,
      archiveAgent,
      closeWorkspaceTab,
      hideWorkspaceAgent,
      retargetCurrentTab,
      serverId,
      tabId,
      unpinWorkspaceAgent,
      workspaceId,
    ],
  );

  const { style: composerKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const inputAreaStyle = useMemo(
    () => [
      animatedStaticStyles.inputAreaWrapper,
      { paddingBottom: insets.bottom },
      composerKeyboardStyle,
    ],
    [insets.bottom, composerKeyboardStyle],
  );

  return (
    <ReanimatedAnimated.View style={inputAreaStyle} onLayout={onInputAreaLayout}>
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={handleArchiveSubagent}
        onArchiveFinished={handleHideFinishedProviderSubagents}
        onDetachSubagent={canDetachSubagents ? handleDetachSubagent : undefined}
      />
      <Composer
        agentId={agentId}
        serverId={serverId}
        workspaceId={workspaceId}
        externalKeyboardShift
        isPaneFocused={isPaneFocused}
        value={agentInputDraft.text}
        onChangeText={agentInputDraft.setText}
        attachments={agentInputDraft.attachments}
        attachmentScopeKeys={attachmentScopeKeys}
        onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
        onChangeAttachments={agentInputDraft.setAttachments}
        cwd={cwd}
        clearDraft={agentInputDraft.clear}
        autoFocus={isPaneFocused}
        autoFocusKey={String(agentInputDraft.attachmentFocusRequestId)}
        isSubmitLoading={isSubmitLoading}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={onComposerHeightChange}
        onMessageSent={onMessageSent}
        onClientSlashCommand={handleClientSlashCommand}
        isCompactLayout={isCompactComposerLayout}
      />
    </ReanimatedAnimated.View>
  );
}

function AgentSessionUnavailableState({
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
  t,
}: {
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
  t: TFunction;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            {t("agentPanel.unavailable.unknownHost", { serverLabel })}
          </Text>
          <Text style={styles.statusText}>{t("agentPanel.unavailable.addHost")}</Text>
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
                ? t("agentPanel.unavailable.preparingSession", { serverLabel })
                : t("agentPanel.unavailable.connecting", { serverLabel })}
            </Text>
            <Text style={styles.statusText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.showSoon")
                : t("agentPanel.unavailable.showWhenOnline")}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              {t("agentPanel.unavailable.reconnectingTo", { serverLabel })}
            </Text>
            <Text style={styles.offlineDescription}>
              {t("agentPanel.unavailable.showAgainWhenReachable")}
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const animatedStaticStyles = RNStyleSheet.create({
  content: {
    flex: 1,
  },
  inputAreaWrapper: {
    width: "100%",
  },
});

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
    ...(isWeb ? { userSelect: "none" as const } : {}),
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
