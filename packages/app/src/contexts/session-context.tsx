import { useRef, ReactNode, useCallback, useEffect } from "react";
import { Buffer } from "buffer";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useClientActivity } from "@/hooks/use-client-activity";
import { useAppVisible } from "@/hooks/use-app-visible";
import { usePushTokenRegistration } from "@/hooks/use-push-token-registration";
import {
  createSetAgentInitializing,
  refreshAgentInitializationTimeout,
} from "@/hooks/use-agent-initialization";
import { prefetchProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { generateMessageId, type StreamItem } from "@/types/stream";
import {
  createSessionAgentStreamReducerQueue,
  processTimelineResponse,
  type ProcessTimelineResponseOutput,
  type TimelineReducerSideEffect,
} from "@/timeline/session-stream-reducers";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { isTimelineCatchUpComplete } from "@/timeline/timeline-sync-plan";
import {
  createViewedTimelineSync,
  type TimelineDeliveryMode,
  type ViewedTimelineSync,
} from "@/timeline/viewed-timeline-sync";
import type { AgentAttachment, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  buildAgentAttentionNotificationPayload,
  type AgentAttentionNotificationPayload,
  type NotificationPermissionRequest,
} from "@getpaseo/protocol/agent-attention-notification";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { GitSetupOptions } from "@getpaseo/protocol/messages";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVoiceAudioEngineOptional, useVoiceRuntimeOptional } from "@/contexts/voice-context";
import type { AudioPlaybackSource } from "@/voice/audio-engine-types";
import { useSessionStore, type MessageEntry, type SessionState } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { sendOsNotification } from "@/utils/os-notifications";
import { getIsAppActivelyVisible, getIsAppVisible } from "@/utils/app-visibility";
import {
  getInitKey,
  getInitDeferred,
  createInitDeferred,
  resolveInitDeferred,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { encodeImages } from "@/utils/encode-images";
import { derivePendingPermissionKey } from "@/utils/agent-snapshots";
import type { AttachmentMetadata } from "@/attachments/types";
import { patchWorkspaceScripts } from "@/contexts/session-workspace-scripts";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { applyCheckoutStatusUpdateFromEvent } from "@/git/checkout-status-cache";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { revalidateSessionAfterResume } from "@/contexts/session-resume-revalidation";

// Re-export types from session-store and draft-store for backward compatibility
export type { DraftInput } from "@/stores/draft-store";
export type {
  MessageEntry,
  Agent,
  ExplorerEntry,
  ExplorerFile,
  ExplorerEntryKind,
  ExplorerFileKind,
  ExplorerEncoding,
  AgentFileExplorerState,
} from "@/stores/session-store";

type AudioOutputPayload = Extract<SessionOutboundMessage, { type: "audio_output" }>["payload"];

interface BufferedAudioChunk {
  chunkIndex: number;
  audio: string;
  format: string;
  id: string;
}

// COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
function getTimelineDeliveryMode(selectiveAgentTimeline?: boolean): TimelineDeliveryMode {
  return selectiveAgentTimeline ? "selective" : "legacy";
}

function decodeBase64Chunk(base64: string): Uint8Array {
  return Buffer.from(base64, "base64");
}

function buildAudioPlaybackSource(chunks: BufferedAudioChunk[]): AudioPlaybackSource {
  const decodedChunks = chunks.map((chunk) => decodeBase64Chunk(chunk.audio));
  const totalSize = decodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of decodedChunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  const format = chunks[0]?.format ?? "pcm";
  let mimeType: string;
  if (format === "pcm") mimeType = "audio/pcm;rate=24000;bits=16";
  else if (format === "mp3") mimeType = "audio/mpeg";
  else mimeType = `audio/${format}`;

  const bytes = output.slice();
  return {
    size: bytes.byteLength,
    type: mimeType,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

const findLatestAssistantMessageText = (items: StreamItem[]): string | null => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "assistant_message") {
      return item.text;
    }
  }
  return null;
};

const getLatestPermissionRequest = (
  session: SessionState | undefined,
  agentId: string,
): NotificationPermissionRequest | null => {
  if (!session) {
    return null;
  }

  let latest: NotificationPermissionRequest | null = null;
  for (const pending of session.pendingPermissions.values()) {
    if (pending.agentId === agentId) {
      latest = pending.request;
    }
  }
  if (latest) {
    return latest;
  }

  const agentPending = session.agents.get(agentId)?.pendingPermissions;
  if (agentPending && agentPending.length > 0) {
    return agentPending[agentPending.length - 1] as NotificationPermissionRequest;
  }

  return null;
};

type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

type SessionStoreActions = ReturnType<typeof useSessionStore.getState>;
type SetInitializingAgents = SessionStoreActions["setInitializingAgents"];
type SetAgentStreamTail = SessionStoreActions["setAgentStreamTail"];
type SetAgentStreamHead = SessionStoreActions["setAgentStreamHead"];
type ClearAgentStreamHead = SessionStoreActions["clearAgentStreamHead"];
type SetAgentTimelineCursor = SessionStoreActions["setAgentTimelineCursor"];
type MarkAgentHistorySynchronized = SessionStoreActions["markAgentHistorySynchronized"];
type SetAgentAuthoritativeHistoryApplied =
  SessionStoreActions["setAgentAuthoritativeHistoryApplied"];

function clearAgentInitializingFlag(
  setInitializingAgents: SetInitializingAgents,
  serverId: string,
  agentId: string,
): void {
  setInitializingAgents(serverId, (prev) => {
    if (prev.get(agentId) !== true) {
      return prev;
    }
    const next = new Map(prev);
    next.set(agentId, false);
    return next;
  });
}

function handleTimelineError(input: {
  result: ProcessTimelineResponseOutput;
  agentId: string;
  initKey: string;
  serverId: string;
  setInitializingAgents: SetInitializingAgents;
}): void {
  const { result, agentId, initKey, serverId, setInitializingAgents } = input;
  if (result.clearInitializing) {
    clearAgentInitializingFlag(setInitializingAgents, serverId, agentId);
  }
  if (result.initResolution === "reject" && result.error) {
    rejectInitDeferred(initKey, new Error(result.error));
  }
}

function applyTimelineStreamPatches(input: {
  result: ProcessTimelineResponseOutput;
  agentId: string;
  serverId: string;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  setAgentStreamTail: SetAgentStreamTail;
  setAgentStreamHead: SetAgentStreamHead;
  clearAgentStreamHead: ClearAgentStreamHead;
  setAgentTimelineCursor: SetAgentTimelineCursor;
}): void {
  const {
    result,
    agentId,
    serverId,
    currentTail,
    currentHead,
    setAgentStreamTail,
    setAgentStreamHead,
    clearAgentStreamHead,
    setAgentTimelineCursor,
  } = input;

  if (result.tail !== currentTail) {
    setAgentStreamTail(serverId, (prev) => {
      const next = new Map(prev);
      next.set(agentId, result.tail);
      return next;
    });
  }

  if (result.head !== currentHead) {
    if (result.head.length === 0) {
      clearAgentStreamHead(serverId, agentId);
    } else {
      setAgentStreamHead(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, result.head);
        return next;
      });
    }
  }

  if (result.cursorChanged) {
    setAgentTimelineCursor(serverId, (prev) => {
      const current = prev.get(agentId);
      if (!result.cursor) {
        if (!current) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      }
      if (
        current &&
        current.epoch === result.cursor.epoch &&
        current.startSeq === result.cursor.startSeq &&
        current.endSeq === result.cursor.endSeq
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(agentId, result.cursor);
      return next;
    });
  }
}

function executeTimelineSideEffects(input: {
  sideEffects: TimelineReducerSideEffect[];
  agentId: string;
  recoverTimelineGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
}): void {
  const { sideEffects, agentId, recoverTimelineGap } = input;
  for (const effect of sideEffects) {
    if (effect.type === "catch_up") {
      recoverTimelineGap(agentId, effect.cursor);
    }
  }
}

function finalizeTimelineApplication(input: {
  result: ProcessTimelineResponseOutput;
  agentId: string;
  initKey: string;
  serverId: string;
  shouldMarkAuthoritativeHistoryApplied: boolean;
  setInitializingAgents: SetInitializingAgents;
  setAgentAuthoritativeHistoryApplied: SetAgentAuthoritativeHistoryApplied;
  markAgentHistorySynchronized: MarkAgentHistorySynchronized;
}): void {
  const {
    result,
    agentId,
    initKey,
    serverId,
    shouldMarkAuthoritativeHistoryApplied,
    setInitializingAgents,
    setAgentAuthoritativeHistoryApplied,
    markAgentHistorySynchronized,
  } = input;

  if (result.clearInitializing) {
    clearAgentInitializingFlag(setInitializingAgents, serverId, agentId);
  }
  if (shouldMarkAuthoritativeHistoryApplied) {
    setAgentAuthoritativeHistoryApplied(serverId, agentId, true);
    useCreateFlowStore.getState().clearByAgent({ serverId, agentId });
    markAgentHistorySynchronized(serverId, agentId);
    const session = useSessionStore.getState().sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (agent && agent.status !== "running") {
      getHostRuntimeStore().drainQueuedAgentMessage(serverId, agentId);
    }
  }
  if (result.initResolution === "resolve") {
    resolveInitDeferred(initKey);
  }
}

function applyToolResultToMessages(
  toolCallId: string,
  result: unknown,
): (prev: MessageEntry[]) => MessageEntry[] {
  return (prev) =>
    prev.map((msg) =>
      msg.type === "tool_call" && msg.id === toolCallId
        ? { ...msg, result, status: "completed" as const }
        : msg,
    );
}

function applyToolErrorToMessages(
  toolCallId: string,
  error: unknown,
): (prev: MessageEntry[]) => MessageEntry[] {
  return (prev) =>
    prev.map((msg) =>
      msg.type === "tool_call" && msg.id === toolCallId
        ? { ...msg, error, status: "failed" as const }
        : msg,
    );
}

function notifyVoiceAbortFailure(
  data: Extract<SessionOutboundMessage, { type: "activity_log" }>["payload"],
  notifyError: (message: string) => void,
): void {
  if (data.type === "error" && data.metadata?.voiceAbortFailed === true) {
    notifyError(data.content);
  }
}

interface SessionProviderSharedProps {
  children: ReactNode;
  serverId: string;
}

interface SessionProviderClientProps extends SessionProviderSharedProps {
  client: DaemonClient;
}

export type SessionProviderProps = SessionProviderClientProps;

function SessionProviderWithClient({ children, serverId, client }: SessionProviderClientProps) {
  return (
    <SessionProviderInternal serverId={serverId} client={client}>
      {children}
    </SessionProviderInternal>
  );
}

// SessionProvider: Daemon client message handler that updates Zustand store
export function SessionProvider(props: SessionProviderProps) {
  return <SessionProviderWithClient {...props} />;
}

function SessionProviderInternal({ children, serverId, client }: SessionProviderClientProps) {
  const { t } = useTranslation();
  const voiceRuntime = useVoiceRuntimeOptional();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();

  // Zustand store actions
  const initializeSession = useSessionStore((state) => state.initializeSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setIsPlayingAudio = useSessionStore((state) => state.setIsPlayingAudio);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setCurrentAssistantMessage = useSessionStore((state) => state.setCurrentAssistantMessage);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead);
  const setAgentStreamState = useSessionStore((state) => state.setAgentStreamState);
  const clearAgentStreamHead = useSessionStore((state) => state.clearAgentStreamHead);
  const setAgentTimelineCursor = useSessionStore((state) => state.setAgentTimelineCursor);
  const setAgentTimelineHasOlder = useSessionStore((state) => state.setAgentTimelineHasOlder);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const bumpHistorySyncGeneration = useSessionStore((state) => state.bumpHistorySyncGeneration);
  const markAgentHistorySynchronized = useSessionStore(
    (state) => state.markAgentHistorySynchronized,
  );
  const setAgentAuthoritativeHistoryApplied = useSessionStore(
    (state) => state.setAgentAuthoritativeHistoryApplied,
  );
  const setAgents = useSessionStore((state) => state.setAgents);
  const setWorkspaces = useSessionStore((state) => state.setWorkspaces);
  const flushAgentLastActivity = useSessionStore((state) => state.flushAgentLastActivity);
  const setPendingPermissions = useSessionStore((state) => state.setPendingPermissions);
  const updateSessionClient = useSessionStore((state) => state.updateSessionClient);
  const updateSessionServerInfo = useSessionStore((state) => state.updateSessionServerInfo);
  const setViewedTimelineSync = useSessionStore((state) => state.setViewedTimelineSync);
  const upsertWorkspaceSetupProgress = useWorkspaceSetupStore((state) => state.upsertProgress);
  const clearWorkspaceSetupServer = useWorkspaceSetupStore((state) => state.clearServer);

  // Track focused agent for heartbeat
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null,
  );
  const focusedTerminalId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedTerminalId ?? null,
  );
  const _sessionStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attentionNotifiedRef = useRef<Map<string, number>>(new Map());
  const appStateRef = useRef(AppState.currentState);
  const viewedTimelineSyncRef = useRef<ViewedTimelineSync | null>(null);
  const audioOutputBuffersRef = useRef<Map<string, BufferedAudioChunk[]>>(new Map());
  const activeAudioGroupsRef = useRef<Set<string>>(new Set());
  const isAppVisible = useAppVisible();

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setActive(isAppVisible);
  }, [isAppVisible]);

  const recoverTimelineGap = useCallback(
    (agentId: string, cursor: { epoch: string; endSeq: number }) => {
      viewedTimelineSyncRef.current?.recoverGap(agentId, cursor);
    },
    [],
  );

  const handleAppResumed = useCallback(
    (awayMs: number) => {
      void revalidateSessionAfterResume({
        awayMs,
        serverId,
        bumpHistorySyncGeneration,
        refreshDirectories: () => getHostRuntimeStore().refreshDirectories(serverId),
      }).catch((error) => {
        console.error("[SessionProvider] resume revalidation failed", {
          serverId,
          error: toErrorMessage(error),
        });
      });
    },
    [bumpHistorySyncGeneration, serverId],
  );

  // Client activity tracking (heartbeat, push token registration)
  useClientActivity({ client, focusedAgentId, focusedTerminalId, onAppResumed: handleAppResumed });
  usePushTokenRegistration({ client, serverId });

  const notifyAgentAttention = useCallback(
    (params: {
      agentId: string;
      reason: "finished" | "error" | "permission";
      timestamp: string;
      notification?: AgentAttentionNotificationPayload;
    }) => {
      const appState = appStateRef.current;
      const session = useSessionStore.getState().sessions[serverId];
      const attentionFocusedAgentId = session?.focusedAgentId ?? null;
      if (params.reason === "error") {
        return;
      }
      const isActivelyVisible = getIsAppActivelyVisible(appState);
      const isAwayFromAgent = !isActivelyVisible || attentionFocusedAgentId !== params.agentId;
      if (!isAwayFromAgent) {
        return;
      }

      const timestampMs = new Date(params.timestamp).getTime();
      const lastNotified = attentionNotifiedRef.current.get(params.agentId);
      if (lastNotified && lastNotified >= timestampMs) {
        return;
      }
      attentionNotifiedRef.current.set(params.agentId, timestampMs);

      const head = session?.agentStreamHead.get(params.agentId) ?? [];
      const tail = session?.agentStreamTail.get(params.agentId) ?? [];
      const assistantMessage =
        findLatestAssistantMessageText(head) ?? findLatestAssistantMessageText(tail);
      const permissionRequest = getLatestPermissionRequest(session, params.agentId);

      const notification =
        params.notification ??
        buildAgentAttentionNotificationPayload({
          reason: params.reason,
          serverId,
          agentId: params.agentId,
          assistantMessage: params.reason === "finished" ? assistantMessage : null,
          permissionRequest: params.reason === "permission" ? permissionRequest : null,
        });

      void sendOsNotification({
        title: notification.title,
        body: notification.body,
        data: notification.data,
      });
    },
    [serverId],
  );

  // Initialize session in store
  useEffect(() => {
    const generation = getHostRuntimeStore().getSnapshot(serverId)?.clientGeneration ?? 0;
    initializeSession(serverId, client, generation);
  }, [serverId, client, initializeSession]);

  useEffect(() => {
    const generation = getHostRuntimeStore().getSnapshot(serverId)?.clientGeneration ?? 0;
    updateSessionClient(serverId, client, generation);
  }, [serverId, client, updateSessionClient]);

  useEffect(() => {
    const serverInfo = client.getLastServerInfoMessage();
    if (!serverInfo) {
      return;
    }

    updateSessionServerInfo(serverId, {
      serverId: serverInfo.serverId,
      hostname: serverInfo.hostname,
      version: serverInfo.version,
      ...(serverInfo.desktopManaged !== undefined
        ? { desktopManaged: serverInfo.desktopManaged }
        : {}),
      ...(serverInfo.capabilities ? { capabilities: serverInfo.capabilities } : {}),
      ...(serverInfo.features ? { features: serverInfo.features } : {}),
    });
  }, [client, serverId, updateSessionServerInfo]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const serverInfo = client.getLastServerInfoMessage();
    if (!serverInfo?.features?.providersSnapshot) {
      return;
    }

    prefetchProvidersSnapshot(serverId, client);
  }, [client, isConnected, serverId]);

  useEffect(() => {
    const unregister = voiceRuntime?.registerSession({
      serverId,
      setVoiceMode: async (enabled, agentId) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.setVoiceMode(enabled, agentId);
      },
      sendVoiceAudioChunk: async (audioData, mimeType) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.sendVoiceAudioChunk(audioData, mimeType);
      },
      audioPlayed: async (chunkId) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.audioPlayed(chunkId);
      },
      abortRequest: async () => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.abortRequest();
      },
      setAssistantAudioPlaying: (isPlaying) => {
        setIsPlayingAudio(serverId, isPlaying);
      },
    });
    return () => unregister?.();
  }, [client, serverId, setIsPlayingAudio, t, voiceRuntime]);

  useEffect(() => {
    voiceRuntime?.updateSessionConnection(serverId, isConnected);
  }, [isConnected, serverId, voiceRuntime]);

  // If the client drops mid-initialization, clear pending flags
  useEffect(() => {
    if (!isConnected) {
      flushAgentLastActivity();
      setInitializingAgents(serverId, new Map());
    }
  }, [flushAgentLastActivity, serverId, isConnected, setInitializingAgents]);

  const applyWorkspaceSetupProgress = useCallback(
    (payload: WorkspaceSetupProgressPayload) => {
      upsertWorkspaceSetupProgress({ serverId, payload });
    },
    [serverId, upsertWorkspaceSetupProgress],
  );

  const applyTimelineResponse = useCallback(
    (
      payload: Extract<
        SessionOutboundMessage,
        { type: "fetch_agent_timeline_response" }
      >["payload"],
    ) => {
      const agentId = payload.agentId;
      const initKey = getInitKey(serverId, agentId);
      const catchUpComplete = isTimelineCatchUpComplete({
        direction: payload.direction,
        hasNewer: payload.hasNewer,
        error: payload.error,
      });
      const shouldMarkAuthoritativeHistoryApplied =
        payload.direction === "tail" || (payload.direction === "after" && catchUpComplete);

      // Read current store state
      const session = useSessionStore.getState().sessions[serverId];
      const isInitializing = session?.initializingAgents.get(agentId) === true;
      const activeInitDeferred = getInitDeferred(initKey);
      const hasActiveInitDeferred = Boolean(activeInitDeferred);
      const currentCursor = session?.agentTimelineCursor.get(agentId);
      const currentTail = session?.agentStreamTail.get(agentId) ?? [];
      const currentHead = session?.agentStreamHead.get(agentId) ?? [];

      setAgentTimelineHasOlder(serverId, (prev) => {
        if (prev.get(agentId) === payload.hasOlder) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, payload.hasOlder);
        return next;
      });

      // Call pure reducer
      const result = processTimelineResponse({
        payload,
        currentTail,
        currentHead,
        currentCursor,
        isInitializing,
        hasActiveInitDeferred,
        initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
      });

      if (result.error) {
        handleTimelineError({
          result,
          agentId,
          initKey,
          serverId,
          setInitializingAgents,
        });
        return;
      }

      applyTimelineStreamPatches({
        result,
        agentId,
        serverId,
        currentTail,
        currentHead,
        setAgentStreamTail,
        setAgentStreamHead,
        clearAgentStreamHead,
        setAgentTimelineCursor,
      });

      executeTimelineSideEffects({
        sideEffects: result.sideEffects,
        agentId,
        recoverTimelineGap,
      });

      finalizeTimelineApplication({
        result,
        agentId,
        initKey,
        serverId,
        shouldMarkAuthoritativeHistoryApplied,
        setInitializingAgents,
        setAgentAuthoritativeHistoryApplied,
        markAgentHistorySynchronized,
      });
    },
    [
      clearAgentStreamHead,
      markAgentHistorySynchronized,
      recoverTimelineGap,
      serverId,
      setAgentAuthoritativeHistoryApplied,
      setAgentStreamHead,
      setAgentStreamTail,
      setAgentTimelineCursor,
      setAgentTimelineHasOlder,
      setInitializingAgents,
    ],
  );

  useEffect(() => {
    const setAgentInitializing = createSetAgentInitializing(serverId, setInitializingAgents);
    const initialDeliveryMode = getTimelineDeliveryMode(
      client.getLastServerInfoMessage()?.features?.selectiveAgentTimeline,
    );
    const sync = createViewedTimelineSync({
      initialDeliveryMode,
      setSubscription: (agentIds) => client.setAgentTimelineSubscription(agentIds),
      readCursor: (agentId) =>
        useSessionStore.getState().sessions[serverId]?.agentTimelineCursor.get(agentId),
      hasAuthoritativeHistory: (agentId) =>
        useSessionStore
          .getState()
          .sessions[serverId]?.agentAuthoritativeHistoryApplied.get(agentId) === true,
      fetchPage: async (agentId, request) => {
        const session = useSessionStore.getState().sessions[serverId];
        const initKey = getInitKey(serverId, agentId);
        const shouldInitialize = session?.agentAuthoritativeHistoryApplied.get(agentId) !== true;
        if (shouldInitialize) {
          if (!getInitDeferred(initKey)) {
            const deferred = createInitDeferred(initKey, request.direction ?? "tail");
            void deferred.promise.catch(() => undefined);
          }
          refreshAgentInitializationTimeout({
            key: initKey,
            agentId,
            setAgentInitializing,
          });
          setAgentInitializing(agentId, true);
        }
        try {
          const page = await getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, request);
          if (shouldInitialize && getInitDeferred(initKey)) {
            refreshAgentInitializationTimeout({ key: initKey, agentId, setAgentInitializing });
          }
          return page;
        } catch (error) {
          if (shouldInitialize) {
            setAgentInitializing(agentId, false);
            rejectInitDeferred(initKey, error instanceof Error ? error : new Error(String(error)));
          }
          throw error;
        }
      },
      reportError: (error) => {
        console.warn("[Session] viewed timeline synchronization failed", { serverId, error });
      },
      schedule: (task, delayMs) => {
        const timeout = setTimeout(task, delayMs);
        return () => clearTimeout(timeout);
      },
    });
    viewedTimelineSyncRef.current = sync;
    setViewedTimelineSync(serverId, sync);
    sync.setActive(getIsAppVisible(appStateRef.current));

    return () => {
      if (viewedTimelineSyncRef.current === sync) {
        viewedTimelineSyncRef.current = null;
      }
      setViewedTimelineSync(serverId, null);
      sync.dispose();
    };
  }, [client, serverId, setInitializingAgents, setViewedTimelineSync]);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setConnected(isConnected);
  }, [isConnected]);

  // Daemon message handlers - directly update Zustand store
  useEffect(() => {
    const agentStreamReducerQueue = createSessionAgentStreamReducerQueue({
      serverId,
      setAgentStreamState,
      setAgentTimelineCursor,
      setAgents,
      recoverTimelineGap,
    });

    const unsubAgentStream = client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp, seq, epoch } = message.payload;
      const parsedTimestamp = new Date(timestamp);
      const streamEvent = event;
      if (
        event.type === "turn_started" ||
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        voiceRuntime?.onTurnEvent(serverId, agentId, event.type);
      }

      agentStreamReducerQueue.enqueue(agentId, {
        event: streamEvent,
        seq,
        epoch,
        timestamp: parsedTimestamp,
      });

      // NOTE: We don't update lastActivityAt on every stream event to prevent
      // cascading rerenders. The agent_update handler updates agent.lastActivityAt
      // on status changes, which is sufficient for sorting and display purposes.
    });

    const unsubAgentAttention = client.onAgentAttentionRequired((notification) => {
      if (notification.shouldNotify) {
        notifyAgentAttention(notification);
      }
    });

    const unsubAgentTimeline = client.on("fetch_agent_timeline_response", (message) => {
      if (message.type !== "fetch_agent_timeline_response") return;
      agentStreamReducerQueue.flushAgent(message.payload.agentId);
      applyTimelineResponse(message.payload);
    });

    const unsubProviderSubagentUpdate = client.on("agent.provider_subagents.update", (message) => {
      if (message.type !== "agent.provider_subagents.update") return;
      useProviderSubagentStore.getState().applyUpdate(serverId, message.payload);
    });

    const unsubScriptStatusUpdate = client.on("script_status_update", (message) => {
      if (message.type !== "script_status_update") return;
      setWorkspaces(serverId, (prev) => patchWorkspaceScripts(prev, message.payload));
    });

    const unsubCheckoutStatusUpdate = client.on("checkout_status_update", (message) => {
      if (message.type !== "checkout_status_update") return;
      applyCheckoutStatusUpdateFromEvent({ queryClient, serverId, message });
    });

    const unsubWorkspaceSetupProgress = client.on("workspace_setup_progress", (message) => {
      if (message.type !== "workspace_setup_progress") return;
      applyWorkspaceSetupProgress(message.payload);
    });

    const unsubWorkspaceSetupStatusResponse = client.on(
      "workspace_setup_status_response",
      (message) => {
        if (message.type !== "workspace_setup_status_response") return;
        const { workspaceId, snapshot } = message.payload;
        if (snapshot) {
          applyWorkspaceSetupProgress({ workspaceId, ...snapshot });
        }
      },
    );

    const unsubStatus = client.on("status", (message) => {
      if (message.type !== "status") return;
      const serverInfo = parseServerInfoStatusPayload(message.payload);
      if (serverInfo) {
        viewedTimelineSyncRef.current?.setDeliveryMode(
          getTimelineDeliveryMode(serverInfo.features?.selectiveAgentTimeline),
        );
        updateSessionServerInfo(serverId, {
          serverId: serverInfo.serverId,
          hostname: serverInfo.hostname,
          version: serverInfo.version,
          ...(serverInfo.desktopManaged !== undefined
            ? { desktopManaged: serverInfo.desktopManaged }
            : {}),
          ...(serverInfo.capabilities ? { capabilities: serverInfo.capabilities } : {}),
          ...(serverInfo.features ? { features: serverInfo.features } : {}),
        });
        return;
      }
    });

    const unsubPermissionRequest = client.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") return;
      const { agentId, request } = message.payload;

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const key = derivePendingPermissionKey(agentId, request);
        next.set(key, { key, agentId, request });
        return next;
      });
    });

    const unsubPermissionResolved = client.on("agent_permission_resolved", (message) => {
      if (message.type !== "agent_permission_resolved") return;
      const { requestId, agentId } = message.payload;

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const derivedKey = `${agentId}:${requestId}`;
        if (!next.delete(derivedKey)) {
          for (const [key, pending] of next.entries()) {
            if (pending.agentId === agentId && pending.request.id === requestId) {
              next.delete(key);
              break;
            }
          }
        }
        return next;
      });
    });

    const unsubAudioOutput = client.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      if (!voiceAudioEngine) {
        return;
      }

      const payload: AudioOutputPayload = message.payload;
      if (payload.isVoiceMode && voiceRuntime) {
        voiceRuntime.handleAudioOutput(serverId, payload);
        return;
      }

      const playbackGroupId = payload.groupId ?? payload.id;
      const chunkIndex = payload.chunkIndex ?? 0;
      const isFinalChunk = payload.isLastChunk ?? true;

      if (!audioOutputBuffersRef.current.has(playbackGroupId)) {
        audioOutputBuffersRef.current.set(playbackGroupId, []);
      }

      const bufferedChunks = audioOutputBuffersRef.current.get(playbackGroupId)!;
      bufferedChunks.push({
        chunkIndex,
        audio: payload.audio,
        format: payload.format,
        id: payload.id,
      });

      activeAudioGroupsRef.current.add(playbackGroupId);
      setIsPlayingAudio(serverId, true);

      if (!isFinalChunk) {
        return;
      }

      bufferedChunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
      const chunkIds = bufferedChunks.map((chunk) => chunk.id);
      const shouldPlay =
        !payload.isVoiceMode || (voiceRuntime?.shouldPlayVoiceAudio(serverId) ?? false);
      const audioBlob = buildAudioPlaybackSource(bufferedChunks);
      function logAudioPlayedError(error: unknown): void {
        console.warn("[Session] Failed to confirm audio playback:", error);
      }
      const confirmAudioPlayed = async () => {
        await Promise.all(
          chunkIds.map((chunkId) => client.audioPlayed(chunkId).catch(logAudioPlayedError)),
        );
      };

      let startedVoicePlayback = false;
      try {
        if (shouldPlay) {
          if (payload.isVoiceMode) {
            startedVoicePlayback = true;
            voiceRuntime?.onAssistantAudioStarted(serverId);
          }
          await voiceAudioEngine.play(audioBlob);
        }
        await confirmAudioPlayed();
      } catch (error) {
        console.error("[Session] Audio playback error:", error);
        await confirmAudioPlayed();
      } finally {
        audioOutputBuffersRef.current.delete(playbackGroupId);
        activeAudioGroupsRef.current.delete(playbackGroupId);
        setIsPlayingAudio(serverId, activeAudioGroupsRef.current.size > 0);

        if (startedVoicePlayback) {
          voiceRuntime?.onAssistantAudioFinished(serverId);
        }
      }
    });

    const unsubActivity = client.on("activity_log", (message) => {
      if (message.type !== "activity_log") return;
      const data = message.payload;
      if (data.type === "system" && data.content.includes("Transcribing")) {
        return;
      }

      if (data.type === "tool_call" && data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const toolName = typeof data.metadata.toolName === "string" ? data.metadata.toolName : "";
        const args = data.metadata.arguments;

        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "tool_call",
            id: toolCallId,
            timestamp: Date.now(),
            toolName,
            args,
            status: "executing",
          },
        ]);
        return;
      }

      if (data.type === "tool_result" && data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const result = data.metadata.result;

        const applyToolResult = applyToolResultToMessages(toolCallId, result);
        setMessages(serverId, applyToolResult);
        return;
      }

      if (data.type === "error" && data.metadata && "toolCallId" in data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const error = data.metadata.error;

        const applyToolError = applyToolErrorToMessages(toolCallId, error);
        setMessages(serverId, applyToolError);
      }

      notifyVoiceAbortFailure(data, toast.error);

      let activityType: "system" | "info" | "success" | "error" = "info";
      if (data.type === "error") activityType = "error";

      if (data.type === "transcript") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "user",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        return;
      }

      if (data.type === "assistant") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "assistant",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        setCurrentAssistantMessage(serverId, "");
        return;
      }

      setMessages(serverId, (prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType,
          message: data.content,
          metadata: data.metadata,
        },
      ]);
    });

    const unsubChunk = client.on("assistant_chunk", (message) => {
      if (message.type !== "assistant_chunk") return;
      setCurrentAssistantMessage(serverId, (prev) => prev + message.payload.chunk);
    });

    const unsubTranscription = client.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;

      const transcriptText = message.payload.text.trim();
      voiceRuntime?.onTranscriptionResult(serverId, transcriptText);
      if (!transcriptText) {
        return;
      }

      setCurrentAssistantMessage(serverId, "");
    });

    const unsubVoiceInputState = client.on("voice_input_state", (message) => {
      if (message.type !== "voice_input_state") return;
      voiceRuntime?.onServerSpeechStateChanged(serverId, message.payload.isSpeaking);
    });

    const unsubTerminalAttention = client.on("terminal_attention_required", (message) => {
      if (message.type !== "terminal_attention_required") {
        return;
      }
      if (!message.payload.shouldNotify) {
        return;
      }
      void sendOsNotification({
        title: message.payload.title,
        body: message.payload.body,
        // serverId + workspaceId + terminalId route a tap to the terminal tab; cwd is
        // carried as a fallback identifier when the daemon resolved no workspace.
        data: {
          serverId: message.payload.serverId ?? serverId,
          terminalId: message.payload.terminalId,
          cwd: message.payload.cwd,
          ...(message.payload.workspaceId ? { workspaceId: message.payload.workspaceId } : {}),
        },
      });
    });

    return () => {
      unsubAgentStream();
      unsubAgentTimeline();
      unsubProviderSubagentUpdate();
      unsubAgentAttention();
      unsubScriptStatusUpdate();
      unsubCheckoutStatusUpdate();
      unsubWorkspaceSetupProgress();
      unsubWorkspaceSetupStatusResponse();
      unsubStatus();
      unsubPermissionRequest();
      unsubPermissionResolved();
      unsubAudioOutput();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubVoiceInputState();
      unsubTerminalAttention();
      agentStreamReducerQueue.dispose({ flush: true });
    };
  }, [
    client,
    queryClient,
    serverId,
    setIsPlayingAudio,
    setMessages,
    setCurrentAssistantMessage,
    setAgentStreamTail,
    setAgentStreamHead,
    setAgentStreamState,
    clearAgentStreamHead,
    setAgentTimelineCursor,
    setInitializingAgents,
    setAgents,
    setWorkspaces,
    setPendingPermissions,
    notifyAgentAttention,
    recoverTimelineGap,
    applyWorkspaceSetupProgress,
    applyTimelineResponse,
    updateSessionServerInfo,
    toast,
    voiceRuntime,
    voiceAudioEngine,
  ]);

  const _cancelAgentRun = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] cancelAgent skipped: daemon unavailable");
        return;
      }
      void client.cancelAgent(agentId).catch((error) => {
        console.error("[Session] Failed to cancel agent:", error);
      });
    },
    [client],
  );

  const _deleteAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] deleteAgent skipped: daemon unavailable");
        return;
      }
      void client.deleteAgent(agentId).catch((error) => {
        console.error("[Session] Failed to delete agent:", error);
      });
    },
    [client],
  );

  const _archiveAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] archiveAgent skipped: daemon unavailable");
        return;
      }
      void client.archiveAgent(agentId).catch((error) => {
        console.error("[Session] Failed to archive agent:", error);
      });
    },
    [client],
  );

  const _restartServer = useCallback(
    (reason?: string) => {
      if (!client) {
        console.warn("[Session] restartServer skipped: daemon unavailable");
        return;
      }
      void client.restartServer(reason).catch((error) => {
        console.error("[Session] Failed to restart server:", error);
      });
    },
    [client],
  );

  const _createAgent = useCallback(
    async ({
      config,
      initialPrompt,
      images,
      attachments,
      git,
      worktreeName,
      requestId,
    }: {
      config: AgentSessionConfig;
      initialPrompt: string;
      images?: AttachmentMetadata[];
      attachments?: AgentAttachment[];
      git?: GitSetupOptions;
      worktreeName?: string;
      requestId?: string;
    }) => {
      if (!client) {
        console.warn("[Session] createAgent skipped: daemon unavailable");
        return;
      }
      const trimmedPrompt = initialPrompt.trim();
      let imagesData: Array<{ data: string; mimeType: string }> | undefined;
      try {
        imagesData = await encodeImages(images);
      } catch (error) {
        console.error("[Session] Failed to prepare images for agent creation:", error);
      }
      await client.createAgent({
        config,
        ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(git ? { git } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(requestId ? { requestId } : {}),
      });
    },
    [client],
  );

  const _setAgentMode = useCallback(
    (agentId: string, modeId: string) => {
      if (!client) {
        console.warn("[Session] setAgentMode skipped: daemon unavailable");
        return;
      }
      void client
        .setAgentMode(agentId, modeId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.error("[Session] Failed to set agent mode:", error);
          toast.error(toErrorMessage(error));
        });
    },
    [client, toast],
  );

  const _setAgentModel = useCallback(
    (agentId: string, modelId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentModel skipped: daemon unavailable");
        return;
      }
      void client.setAgentModel(agentId, modelId).catch((error) => {
        console.error("[Session] Failed to set agent model:", error);
        toast.error(toErrorMessage(error));
      });
    },
    [client, toast],
  );

  const _setAgentThinkingOption = useCallback(
    (agentId: string, thinkingOptionId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentThinkingOption skipped: daemon unavailable");
        return;
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.error("[Session] Failed to set agent thinking option:", error);
          toast.error(toErrorMessage(error));
        });
    },
    [client, toast],
  );

  const _respondToPermission = useCallback(
    (agentId: string, requestId: string, response: AgentPermissionResponse) => {
      if (!client) {
        console.warn("[Session] respondToPermission skipped: daemon unavailable");
        return;
      }
      void client.respondToPermission(agentId, requestId, response).catch((error) => {
        console.error("[Session] Failed to respond to permission:", error);
      });
    },
    [client],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearWorkspaceSetupServer(serverId);
      clearSession(serverId);
    };
  }, [clearSession, clearWorkspaceSetupServer, serverId]);

  return children;
}
