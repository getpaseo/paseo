import { useRef, ReactNode, useCallback, useEffect, useMemo } from "react";
import { AppState, Platform } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { useClientActivity } from "@/hooks/use-client-activity";
import { usePushTokenRegistration } from "@/hooks/use-push-token-registration";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import {
  applyStreamEvent,
  generateMessageId,
  hydrateStreamState,
  reduceStreamUpdate,
  type StreamItem,
} from "@/types/stream";
import {
  deriveOptimisticLifecycleStatus,
} from "@/contexts/session-stream-lifecycle";
import {
  deriveBootstrapTailTimelinePolicy,
  shouldResolveTimelineInit,
} from "@/contexts/session-timeline-bootstrap-policy";
import { classifySessionTimelineSeq } from "@/contexts/session-timeline-seq-gate";
import type {
  ActivityLogPayload,
  AgentStreamEventPayload,
  SessionOutboundMessage,
} from "@server/shared/messages";
import { parseServerInfoStatusPayload } from "@server/shared/messages";
import {
  buildAgentAttentionNotificationPayload,
  type AgentAttentionNotificationPayload,
  type NotificationPermissionRequest,
} from "@server/shared/agent-attention-notification";
import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { DaemonClient } from "@server/client/daemon-client";
import { File } from "expo-file-system";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import {
  useSessionStore,
  type Agent,
  type SessionState,
} from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { sendOsNotification } from "@/utils/os-notifications";
import {
  getInitKey,
  getInitDeferred,
  resolveInitDeferred,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { encodeImages } from "@/utils/encode-images";
import {
  derivePendingPermissionKey,
  normalizeAgentSnapshot,
} from "@/utils/agent-snapshots";
import { resolveProjectPlacement } from "@/utils/project-placement";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { AttachmentMetadata } from "@/attachments/types";

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

const HISTORY_STALE_AFTER_MS = 60_000;

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
  agentId: string
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

type FileExplorerPayload = Extract<
  SessionOutboundMessage,
  { type: "file_explorer_response" }
>["payload"];

type FileDownloadTokenPayload = Extract<
  SessionOutboundMessage,
  { type: "file_download_token_response" }
>["payload"];

type AgentUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

const getAgentIdFromUpdate = (update: AgentUpdatePayload): string =>
  update.kind === "remove" ? update.agentId : update.agent.id;

const createExplorerState = () => ({
  directories: new Map(),
  files: new Map(),
  isLoading: false,
  lastError: null,
  pendingRequest: null,
  currentPath: ".",
  history: ["."],
  lastVisitedPath: ".",
  selectedEntryPath: null,
});

const pushHistory = (history: string[], path: string): string[] => {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  const last = normalizedHistory[normalizedHistory.length - 1];
  if (last === path) {
    return normalizedHistory;
  }
  return [...normalizedHistory, path];
};

interface SessionProviderSharedProps {
  children: ReactNode;
  serverId: string;
}

interface SessionProviderClientProps extends SessionProviderSharedProps {
  client: DaemonClient;
}

export type SessionProviderProps = SessionProviderClientProps;

function SessionProviderWithClient({
  children,
  serverId,
  client,
}: SessionProviderClientProps) {
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

function SessionProviderInternal({
  children,
  serverId,
  client,
}: SessionProviderClientProps) {
  const queryClient = useQueryClient();
  const { isConnected } = useHostRuntimeSession(serverId);

  // Zustand store actions
  const initializeSession = useSessionStore((state) => state.initializeSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setIsPlayingAudio = useSessionStore((state) => state.setIsPlayingAudio);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setCurrentAssistantMessage = useSessionStore(
    (state) => state.setCurrentAssistantMessage
  );
  const setAgentStreamTail = useSessionStore(
    (state) => state.setAgentStreamTail
  );
  const setAgentStreamHead = useSessionStore(
    (state) => state.setAgentStreamHead
  );
  const setAgentStreamState = useSessionStore(
    (state) => state.setAgentStreamState
  );
  const clearAgentStreamHead = useSessionStore(
    (state) => state.clearAgentStreamHead
  );
  const setAgentTimelineCursor = useSessionStore(
    (state) => state.setAgentTimelineCursor
  );
  const setInitializingAgents = useSessionStore(
    (state) => state.setInitializingAgents
  );
  const bumpHistorySyncGeneration = useSessionStore(
    (state) => state.bumpHistorySyncGeneration
  );
  const markAgentHistorySynchronized = useSessionStore(
    (state) => state.markAgentHistorySynchronized
  );
  const setHasHydratedAgents = useSessionStore(
    (state) => state.setHasHydratedAgents
  );
  const setAgents = useSessionStore((state) => state.setAgents);
  const setAgentLastActivity = useSessionStore(
    (state) => state.setAgentLastActivity
  );
  const flushAgentLastActivity = useSessionStore(
    (state) => state.flushAgentLastActivity
  );
  const setPendingPermissions = useSessionStore(
    (state) => state.setPendingPermissions
  );
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const clearDraftInput = useDraftStore((state) => state.clearDraftInput);
  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const updateSessionClient = useSessionStore((state) => state.updateSessionClient);
  const updateSessionServerInfo = useSessionStore((state) => state.updateSessionServerInfo);

  // Track focused agent for heartbeat
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null
  );
  const sessionAgents = useSessionStore(
    (state) => state.sessions[serverId]?.agents
  );

  const handleAppResumed = useCallback(
    (awayMs: number) => {
      if (awayMs < HISTORY_STALE_AFTER_MS) {
        return;
      }
      bumpHistorySyncGeneration(serverId);
    },
    [bumpHistorySyncGeneration, serverId]
  );

  // Client activity tracking (heartbeat, push token registration)
  useClientActivity({ client, focusedAgentId, onAppResumed: handleAppResumed });
  usePushTokenRegistration({ client, serverId });

  // State for voice detection flags (will be set by RealtimeContext)
  const isDetectingRef = useRef(false);
  const isSpeakingRef = useRef(false);

  const audioPlayer = useAudioPlayer({
    isDetecting: () => isDetectingRef.current,
    isSpeaking: () => isSpeakingRef.current,
  });

  const activeAudioGroupsRef = useRef<Set<string>>(new Set());
  const previousAgentStatusRef = useRef<Map<string, AgentLifecycleStatus>>(
    new Map()
  );
  const sendAgentMessageRef = useRef<
    | ((
        agentId: string,
        message: string,
        images?: AttachmentMetadata[]
      ) => Promise<void>)
    | null
  >(null);
  const sessionStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const attentionNotifiedRef = useRef<Map<string, number>>(new Map());
  const appStateRef = useRef(AppState.currentState);
  const pendingAgentUpdatesRef = useRef<Map<string, AgentUpdatePayload>>(
    new Map()
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!sessionAgents) {
      previousAgentStatusRef.current.clear();
      return;
    }
    const nextStatuses = new Map<string, AgentLifecycleStatus>();
    for (const nextAgent of sessionAgents.values()) {
      nextStatuses.set(nextAgent.id, nextAgent.status);
    }
    previousAgentStatusRef.current = nextStatuses;
  }, [sessionAgents]);

  const notifyAgentAttention = useCallback(
    (params: {
      agentId: string;
      reason: "finished" | "error" | "permission";
      timestamp: string;
      notification?: AgentAttentionNotificationPayload;
    }) => {
      const appState = appStateRef.current;
      const session = useSessionStore.getState().sessions[serverId];
      const focusedAgentId = session?.focusedAgentId ?? null;
      if (params.reason === "error") {
        return;
      }
      const isActive = appState ? appState === "active" : true;
      const isAwayFromAgent = !isActive || focusedAgentId !== params.agentId;
      if (!isAwayFromAgent) {
        console.log(
          "[OSNotifications] Skipping attention notification: user already focused on agent",
          {
            agentId: params.agentId,
            reason: params.reason,
            appState,
            focusedAgentId,
          }
        );
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
        findLatestAssistantMessageText(head) ??
        findLatestAssistantMessageText(tail);
      const permissionRequest = getLatestPermissionRequest(
        session,
        params.agentId
      );

      const notification =
        params.notification ??
        buildAgentAttentionNotificationPayload({
          reason: params.reason,
          serverId,
          agentId: params.agentId,
          assistantMessage: params.reason === "finished" ? assistantMessage : null,
          permissionRequest:
            params.reason === "permission"
              ? permissionRequest
              : null,
        });

      void sendOsNotification({
        title: notification.title,
        body: notification.body,
        data: notification.data,
      });
    },
    [serverId]
  );

  // Buffer for streaming audio chunks
  interface AudioChunk {
    chunkIndex: number;
    audio: string; // base64
    format: string;
    id: string;
  }
  const audioChunkBuffersRef = useRef<Map<string, AudioChunk[]>>(new Map());

  // Initialize session in store
  useEffect(() => {
    initializeSession(serverId, client, audioPlayer);
  }, [serverId, client, audioPlayer, initializeSession]);

  useEffect(() => {
    updateSessionClient(serverId, client);
  }, [serverId, client, updateSessionClient]);

  // If the client drops mid-initialization, clear pending flags
  useEffect(() => {
    if (!isConnected) {
      flushAgentLastActivity();
      pendingAgentUpdatesRef.current.clear();
      setInitializingAgents(serverId, new Map());
    }
  }, [flushAgentLastActivity, serverId, isConnected, setInitializingAgents]);

  const applyAgentUpdatePayload = useCallback(
    (update: AgentUpdatePayload) => {
      if (update.kind === "remove") {
        const agentId = update.agentId;
        previousAgentStatusRef.current.delete(agentId);
        pendingAgentUpdatesRef.current.delete(agentId);
        clearArchiveAgentPending({ queryClient, serverId, agentId });

        setAgents(serverId, (prev) => {
          if (!prev.has(agentId)) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(agentId);
          return next;
        });

        setPendingPermissions(serverId, (prev) => {
          if (prev.size === 0) {
            return prev;
          }
          let changed = false;
          const next = new Map(prev);
          for (const [key, pending] of Array.from(next.entries())) {
            if (pending.agentId === agentId) {
              next.delete(key);
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        setQueuedMessages(serverId, (prev) => {
          if (!prev.has(agentId)) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(agentId);
          return next;
        });

        setAgentTimelineCursor(serverId, (prev) => {
          if (!prev.has(agentId)) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(agentId);
          return next;
        });
        return;
      }

      const normalized = normalizeAgentSnapshot(update.agent, serverId);
      const agent = {
        ...normalized,
        projectPlacement: resolveProjectPlacement({
          projectPlacement: update.project,
          cwd: normalized.cwd,
        }),
      };

      setAgents(serverId, (prev) => {
        const current = prev.get(agent.id);
        if (current && agent.updatedAt.getTime() < current.updatedAt.getTime()) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });

      if (agent.archivedAt) {
        clearArchiveAgentPending({
          queryClient,
          serverId,
          agentId: agent.id,
        });
      }

      // Update agentLastActivity slice (top-level)
      setAgentLastActivity(agent.id, agent.lastActivityAt);

      setPendingPermissions(serverId, (prev) => {
        const existingKeysForAgent: string[] = [];
        for (const [key, pending] of prev.entries()) {
          if (pending.agentId === agent.id) {
            existingKeysForAgent.push(key);
          }
        }

        const nextEntries = agent.pendingPermissions.map((request) => ({
          key: derivePendingPermissionKey(agent.id, request),
          agentId: agent.id,
          request,
        }));

        let changed = existingKeysForAgent.length !== nextEntries.length;
        if (!changed) {
          const existingKeySet = new Set(existingKeysForAgent);
          for (const entry of nextEntries) {
            const existing = prev.get(entry.key);
            if (!existingKeySet.has(entry.key) || !existing) {
              changed = true;
              break;
            }

            const currentRequest = existing.request;
            if (
              currentRequest.id !== entry.request.id ||
              currentRequest.kind !== entry.request.kind ||
              currentRequest.name !== entry.request.name ||
              currentRequest.title !== entry.request.title ||
              currentRequest.description !== entry.request.description
            ) {
              changed = true;
              break;
            }
          }
        }

        if (!changed) {
          return prev;
        }

        const next = new Map(prev);
        for (const key of existingKeysForAgent) {
          next.delete(key);
        }
        for (const entry of nextEntries) {
          next.set(entry.key, entry);
        }
        return next;
      });

      // Flush queued messages when agent transitions from running to not running
      const prevStatus = previousAgentStatusRef.current.get(agent.id);
      if (prevStatus === "running" && agent.status !== "running") {
        const session = useSessionStore.getState().sessions[serverId];
        const queue = session?.queuedMessages.get(agent.id);
        if (queue && queue.length > 0) {
          const [next, ...rest] = queue;
          console.log(
            "[Session] Flushing queued message for agent:",
            agent.id,
            next.text
          );
          if (sendAgentMessageRef.current) {
            void sendAgentMessageRef.current(agent.id, next.text, next.images);
          }
          setQueuedMessages(serverId, (prev) => {
            const updated = new Map(prev);
            updated.set(agent.id, rest);
            return updated;
          });
        }
      }

      previousAgentStatusRef.current.set(agent.id, agent.status);
    },
    [
      queryClient,
      serverId,
      setAgents,
      setAgentLastActivity,
      setPendingPermissions,
      setQueuedMessages,
      setAgentTimelineCursor,
    ]
  );

  const updateExplorerState = useCallback(
    (agentId: string, updater: (state: any) => any) => {
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(agentId) ?? createExplorerState();
        next.set(agentId, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer]
  );

  const directoryListingMutation = useMutation({
    mutationFn: async ({ agentId, path }: { agentId: string; path: string }) => {
      if (!agentId) {
        throw new Error("Agent id is required");
      }
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const resolvedPath = path && path.length > 0 ? path : ".";
      const payload = await client.exploreFileSystem(
        agentId,
        resolvedPath,
        "list"
      );
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
  });

  const filePreviewMutation = useMutation({
    mutationFn: async ({ agentId, path }: { agentId: string; path: string }) => {
      if (!agentId) {
        throw new Error("Agent id is required");
      }
      if (!path) {
        throw new Error("File path is required");
      }
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.exploreFileSystem(
        agentId,
        path,
        "file"
      );
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
  });

  const fileDownloadTokenMutation = useMutation({
    mutationFn: async ({ agentId, path }: { agentId: string; path: string }) => {
      if (!agentId) {
        throw new Error("Agent id is required");
      }
      if (!path) {
        throw new Error("File path is required");
      }
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.requestDownloadToken(agentId, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
  });

  const requestCanonicalCatchUp = useCallback(
    (agentId: string, cursor: { epoch: string; endSeq: number }) => {
      void client
        .fetchAgentTimeline(agentId, {
          direction: "after",
          cursor: { epoch: cursor.epoch, seq: cursor.endSeq },
          limit: 0,
          projection: "canonical",
        })
        .catch((error) => {
          console.warn(
            "[Session] failed to fetch canonical catch-up timeline",
            agentId,
            error
          );
        });
    },
    [client]
  );

  const applyTimelineResponse = useCallback(
    (
      payload: Extract<
        SessionOutboundMessage,
        { type: "fetch_agent_timeline_response" }
      >["payload"]
    ) => {
      const agentId = payload.agentId;
      const initKey = getInitKey(serverId, agentId);

      if (payload.error) {
        setInitializingAgents(serverId, (prev) => {
          if (prev.get(agentId) !== true) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
        rejectInitDeferred(initKey, new Error(payload.error));
        return;
      }

      const timelineUnits = payload.entries.map((entry) => ({
        seq: entry.seqStart,
        event: {
          type: "timeline",
          provider: entry.provider,
          item: entry.item,
        } as AgentStreamEventPayload,
        timestamp: new Date(entry.timestamp),
      }));

      const toHydratedEvents = (
        units: typeof timelineUnits
      ): Array<{ event: AgentStreamEventPayload; timestamp: Date }> =>
        units.map(({ event, timestamp }) => ({ event, timestamp }));

      const session = useSessionStore.getState().sessions[serverId];
      const isInitializing = session?.initializingAgents.get(agentId) === true;
      const activeInitDeferred = getInitDeferred(initKey);
      const hasActiveInitDeferred = Boolean(activeInitDeferred);
      const currentCursor = session?.agentTimelineCursor.get(agentId);
      const bootstrapPolicy = deriveBootstrapTailTimelinePolicy({
        direction: payload.direction,
        reset: payload.reset,
        epoch: payload.epoch,
        endCursor: payload.endCursor,
        isInitializing,
        hasActiveInitDeferred,
      });
      const replace = bootstrapPolicy.replace;

      let nextCursor:
        | { epoch: string; startSeq: number; endSeq: number }
        | null
        | undefined;
      let shouldSetCursor = false;

      if (replace) {
        const hydrated = hydrateStreamState(toHydratedEvents(timelineUnits));
        setAgentStreamTail(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, hydrated);
          return next;
        });
        clearAgentStreamHead(serverId, agentId);

        if (payload.startCursor && payload.endCursor) {
          nextCursor = {
            epoch: payload.epoch,
            startSeq: payload.startCursor.seq,
            endSeq: payload.endCursor.seq,
          };
          shouldSetCursor = true;
        } else {
          nextCursor = null;
          shouldSetCursor = true;
        }

        if (bootstrapPolicy.catchUpCursor) {
          requestCanonicalCatchUp(agentId, bootstrapPolicy.catchUpCursor);
        }

      } else if (timelineUnits.length > 0) {
        const acceptedUnits: typeof timelineUnits = [];
        let cursor = currentCursor;
        let gapCursor: { epoch: string; endSeq: number } | null = null;

        for (const unit of timelineUnits) {
          const decision = classifySessionTimelineSeq({
            cursor: cursor
              ? { epoch: cursor.epoch, endSeq: cursor.endSeq }
              : null,
            epoch: payload.epoch,
            seq: unit.seq,
          });

          if (decision === "gap") {
            gapCursor = cursor
              ? { epoch: cursor.epoch, endSeq: cursor.endSeq }
              : null;
            break;
          }
          if (decision === "drop_stale" || decision === "drop_epoch") {
            continue;
          }

          acceptedUnits.push(unit);
          if (decision === "init") {
            cursor = {
              epoch: payload.epoch,
              startSeq: unit.seq,
              endSeq: unit.seq,
            };
            continue;
          }
          if (!cursor) {
            continue;
          }
          cursor = {
            ...cursor,
            endSeq: unit.seq,
          };
        }

        if (acceptedUnits.length > 0) {
          setAgentStreamTail(serverId, (prev) => {
            const next = new Map(prev);
            const current = next.get(agentId) ?? [];
            const updated = acceptedUnits.reduce<StreamItem[]>(
              (state, { event, timestamp }) => reduceStreamUpdate(state, event, timestamp),
              current
            );
            next.set(agentId, updated);
            return next;
          });
        }

        if (
          cursor &&
          (!currentCursor ||
            currentCursor.epoch !== cursor.epoch ||
            currentCursor.startSeq !== cursor.startSeq ||
            currentCursor.endSeq !== cursor.endSeq)
        ) {
          nextCursor = cursor;
          shouldSetCursor = true;
        }

        if (gapCursor) {
          requestCanonicalCatchUp(agentId, gapCursor);
        }
      }

      if (shouldSetCursor) {
        setAgentTimelineCursor(serverId, (prev) => {
          const current = prev.get(agentId);
          if (!nextCursor) {
            if (!current) {
              return prev;
            }
            const next = new Map(prev);
            next.delete(agentId);
            return next;
          }
          if (
            current &&
            current.epoch === nextCursor.epoch &&
            current.startSeq === nextCursor.startSeq &&
            current.endSeq === nextCursor.endSeq
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, nextCursor);
          return next;
        });
      }

      const deferredUpdate = pendingAgentUpdatesRef.current.get(agentId);
      pendingAgentUpdatesRef.current.delete(agentId);
      if (deferredUpdate) {
        applyAgentUpdatePayload(deferredUpdate);
      }

      const shouldResolveDeferredInit = shouldResolveTimelineInit({
        hasActiveInitDeferred,
        isInitializing,
        initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
        responseDirection: payload.direction,
        reset: payload.reset,
      });
      const shouldClearInitializing =
        shouldResolveDeferredInit || (isInitializing && !hasActiveInitDeferred);

      if (shouldClearInitializing) {
        setInitializingAgents(serverId, (prev) => {
          if (prev.get(agentId) !== true) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
      }

      if (shouldResolveDeferredInit) {
        resolveInitDeferred(initKey);
      }
      if (shouldClearInitializing) {
        markAgentHistorySynchronized(serverId, agentId);
      }
    },
    [
      applyAgentUpdatePayload,
      clearAgentStreamHead,
      markAgentHistorySynchronized,
      requestCanonicalCatchUp,
      serverId,
      setAgentStreamTail,
      setAgentTimelineCursor,
      setInitializingAgents,
    ]
  );

  useEffect(() => {
    if (isConnected) {
      return;
    }
    pendingAgentUpdatesRef.current.clear();
  }, [isConnected]);

  // Daemon message handlers - directly update Zustand store
  useEffect(() => {
    const unsubAgentUpdate = client.on("agent_update", (message) => {
      if (message.type !== "agent_update") return;
      const update = message.payload;
      const agentId = getAgentIdFromUpdate(update);
      const initKey = getInitKey(serverId, agentId);
      const session = useSessionStore.getState().sessions[serverId];
      const isSyncingHistory =
        session?.initializingAgents.get(agentId) === true &&
        Boolean(getInitDeferred(initKey));

      if (isSyncingHistory) {
        pendingAgentUpdatesRef.current.set(agentId, update);
        return;
      }

      pendingAgentUpdatesRef.current.delete(agentId);
      applyAgentUpdatePayload(update);
    });

    const unsubAgentStream = client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp, seq, epoch } = message.payload;
      const parsedTimestamp = new Date(timestamp);
      const streamEvent = event as AgentStreamEventPayload;

      if (event.type === "attention_required") {
        if (event.shouldNotify) {
          notifyAgentAttention({
            agentId,
            reason: event.reason,
            timestamp: event.timestamp,
            notification: event.notification,
          });
        }
      }

      const session = useSessionStore.getState().sessions[serverId];
      const currentTail = session?.agentStreamTail.get(agentId) ?? [];
      const currentHead = session?.agentStreamHead.get(agentId) ?? [];
      const currentCursor = session?.agentTimelineCursor.get(agentId);

      let shouldApplyStreamEvent = true;
      let nextTimelineCursor: { epoch: string; startSeq: number; endSeq: number } | null = null;

      if (
        streamEvent.type === "timeline" &&
        typeof seq === "number" &&
        typeof epoch === "string"
      ) {
        const decision = classifySessionTimelineSeq({
          cursor: currentCursor
            ? { epoch: currentCursor.epoch, endSeq: currentCursor.endSeq }
            : null,
          epoch,
          seq,
        });

        if (decision === "init") {
          nextTimelineCursor = { epoch, startSeq: seq, endSeq: seq };
        } else if (decision === "accept") {
          nextTimelineCursor = {
            ...(currentCursor ?? { epoch, startSeq: seq, endSeq: seq }),
            epoch,
            endSeq: seq,
          };
        } else if (decision === "gap") {
          shouldApplyStreamEvent = false;
          if (currentCursor) {
            requestCanonicalCatchUp(agentId, {
              epoch: currentCursor.epoch,
              endSeq: currentCursor.endSeq,
            });
          }
        } else {
          shouldApplyStreamEvent = false;
        }
      }

      const { tail, head, changedTail, changedHead } = shouldApplyStreamEvent
        ? applyStreamEvent({
            tail: currentTail,
            head: currentHead,
            event: streamEvent,
            timestamp: parsedTimestamp,
          })
        : {
            tail: currentTail,
            head: currentHead,
            changedTail: false,
            changedHead: false,
          };

      if (changedTail || changedHead) {
        setAgentStreamState(serverId, agentId, {
          ...(changedTail ? { tail } : {}),
          ...(changedHead ? { head } : {}),
        });
      }

      if (nextTimelineCursor) {
        setAgentTimelineCursor(serverId, (prev) => {
          const current = prev.get(agentId);
          if (
            current &&
            current.epoch === nextTimelineCursor.epoch &&
            current.startSeq === nextTimelineCursor.startSeq &&
            current.endSeq === nextTimelineCursor.endSeq
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, nextTimelineCursor);
          return next;
        });
      }

      if (
        streamEvent.type === "turn_completed" ||
        streamEvent.type === "turn_canceled" ||
        streamEvent.type === "turn_failed"
      ) {
        setAgents(serverId, (prev) => {
          const current = prev.get(agentId);
          if (!current) {
            return prev;
          }
          const optimisticStatus = deriveOptimisticLifecycleStatus(
            current.status,
            streamEvent
          );
          if (!optimisticStatus) {
            return prev;
          }
          const nextUpdatedAtMs = Math.max(
            current.updatedAt.getTime(),
            parsedTimestamp.getTime()
          );
          const nextLastActivityAtMs = Math.max(
            current.lastActivityAt.getTime(),
            parsedTimestamp.getTime()
          );
          const next = new Map(prev);
          next.set(agentId, {
            ...current,
            status: optimisticStatus,
            updatedAt: new Date(nextUpdatedAtMs),
            lastActivityAt: new Date(nextLastActivityAtMs),
          });
          return next;
        });
      }

      // NOTE: We don't update lastActivityAt on every stream event to prevent
      // cascading rerenders. The agent_update handler updates agent.lastActivityAt
      // on status changes, which is sufficient for sorting and display purposes.
    });

    const unsubAgentTimeline = client.on(
      "fetch_agent_timeline_response",
      (message) => {
        if (message.type !== "fetch_agent_timeline_response") return;
        applyTimelineResponse(message.payload);
      }
    );

    const unsubStatus = client.on("status", (message) => {
      if (message.type !== "status") return;
      const serverInfo = parseServerInfoStatusPayload(message.payload);
      if (serverInfo) {
        updateSessionServerInfo(serverId, {
          serverId: serverInfo.serverId,
          hostname: serverInfo.hostname,
          version: serverInfo.version,
          ...(serverInfo.capabilities
            ? { capabilities: serverInfo.capabilities }
            : {}),
        });
        return;
      }
    });

    const unsubPermissionRequest = client.on(
      "agent_permission_request",
      (message) => {
        if (message.type !== "agent_permission_request") return;
        const { agentId, request } = message.payload;

        console.log(
          "[Session] Permission request:",
          request.id,
          "for agent:",
          agentId
        );

        setPendingPermissions(serverId, (prev) => {
          const next = new Map(prev);
          const key = derivePendingPermissionKey(agentId, request);
          next.set(key, { key, agentId, request });
          return next;
        });
      }
    );

    const unsubPermissionResolved = client.on(
      "agent_permission_resolved",
      (message) => {
        if (message.type !== "agent_permission_resolved") return;
        const { requestId, agentId } = message.payload;

        console.log(
          "[Session] Permission resolved:",
          requestId,
          "for agent:",
          agentId
        );

        setPendingPermissions(serverId, (prev) => {
          const next = new Map(prev);
          const derivedKey = `${agentId}:${requestId}`;
          if (!next.delete(derivedKey)) {
            for (const [key, pending] of next.entries()) {
              if (
                pending.agentId === agentId &&
                pending.request.id === requestId
              ) {
                next.delete(key);
                break;
              }
            }
          }
          return next;
        });
      }
    );

    const unsubAudioOutput = client.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      const data = message.payload;
      const playbackGroupId = data.groupId ?? data.id;
      const isFinalChunk = data.isLastChunk ?? true;
      const chunkIndex = data.chunkIndex ?? 0;

      activeAudioGroupsRef.current.add(playbackGroupId);
      setIsPlayingAudio(serverId, true);

      if (!audioChunkBuffersRef.current.has(playbackGroupId)) {
        audioChunkBuffersRef.current.set(playbackGroupId, []);
      }

      const buffer = audioChunkBuffersRef.current.get(playbackGroupId)!;
      buffer.push({
        chunkIndex,
        audio: data.audio,
        format: data.format,
        id: data.id,
      });

      if (!isFinalChunk) {
        return;
      }
      buffer.sort((a, b) => a.chunkIndex - b.chunkIndex);

      let playbackFailed = false;
      const chunkIds = buffer.map((chunk) => chunk.id);

      const confirmAudioPlayed = (ids: string[]) => {
        if (!client) {
          console.warn("[Session] audio_played skipped: daemon unavailable");
          return;
        }
        ids.forEach((chunkId) => {
          void client.audioPlayed(chunkId).catch((error) => {
            console.warn("[Session] Failed to confirm audio playback:", error);
          });
        });
      };

      try {
        const mimeType =
          data.format === "mp3" ? "audio/mpeg" : `audio/${data.format}`;

        const decodedChunks: Uint8Array[] = [];
        let totalSize = 0;

        for (const chunk of buffer) {
          const binaryString = atob(chunk.audio);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          decodedChunks.push(bytes);
          totalSize += bytes.length;
        }

        const concatenatedBytes = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of decodedChunks) {
          concatenatedBytes.set(chunk, offset);
          offset += chunk.length;
        }

        const audioBlob = {
          type: mimeType,
          size: totalSize,
          arrayBuffer: async () => {
            return concatenatedBytes.buffer;
          },
        } as Blob;

        await audioPlayer.play(audioBlob);

        confirmAudioPlayed(chunkIds);
      } catch (error: any) {
        playbackFailed = true;
        console.error("[Session] Audio playback error:", error);

        confirmAudioPlayed(chunkIds);
      } finally {
        audioChunkBuffersRef.current.delete(playbackGroupId);
        activeAudioGroupsRef.current.delete(playbackGroupId);

        if (activeAudioGroupsRef.current.size === 0) {
          setIsPlayingAudio(serverId, false);
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
        const {
          toolCallId,
          toolName,
          arguments: args,
        } = data.metadata as {
          toolCallId: string;
          toolName: string;
          arguments: unknown;
        };

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
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: unknown;
        };

        setMessages(serverId, (prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, result, status: "completed" as const }
              : msg
          )
        );
        return;
      }

      if (
        data.type === "error" &&
        data.metadata &&
        "toolCallId" in data.metadata
      ) {
        const { toolCallId, error } = data.metadata as {
          toolCallId: string;
          error: unknown;
        };

        setMessages(serverId, (prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, error, status: "failed" as const }
              : msg
          )
        );
      }

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
      setCurrentAssistantMessage(
        serverId,
        (prev) => prev + message.payload.chunk
      );
    });

    const unsubTranscription = client.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;

      const transcriptText = message.payload.text.trim();

      if (!transcriptText) {
      } else {
        audioPlayer.stop();
        setIsPlayingAudio(serverId, false);
        setCurrentAssistantMessage(serverId, "");
      }
    });

    const unsubAgentDeleted = client.on("agent_deleted", (message) => {
      if (message.type !== "agent_deleted") {
        return;
      }
      const { agentId } = message.payload;
      console.log("[Session] Agent deleted:", agentId);
      pendingAgentUpdatesRef.current.delete(agentId);
      clearArchiveAgentPending({ queryClient, serverId, agentId });

      setAgents(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      // Remove from agentLastActivity slice (top-level)
      useSessionStore.setState((state) => {
        if (!state.agentLastActivity.has(agentId)) {
          return state;
        }
        const nextActivity = new Map(state.agentLastActivity);
        nextActivity.delete(agentId);
        return {
          ...state,
          agentLastActivity: nextActivity,
        };
      });

      setAgentStreamTail(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      clearAgentStreamHead(serverId, agentId);
      setAgentTimelineCursor(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      // Remove draft input
      clearDraftInput({
        draftKey: buildDraftStoreKey({ serverId, agentId }),
      });

      setPendingPermissions(serverId, (prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, pending] of prev.entries()) {
          if (pending.agentId === agentId) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      setInitializingAgents(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setFileExplorer(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    });

    const unsubAgentArchived = client.on("agent_archived", (message) => {
      if (message.type !== "agent_archived") {
        return;
      }
      const { agentId, archivedAt } = message.payload;
      console.log("[Session] Agent archived:", agentId);
      clearArchiveAgentPending({ queryClient, serverId, agentId });

      setAgents(serverId, (prev) => {
        const existing = prev.get(agentId);
        if (!existing) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, {
          ...existing,
          archivedAt: new Date(archivedAt),
        });
        return next;
      });
    });

    return () => {
      unsubAgentUpdate();
      unsubAgentStream();
      unsubAgentTimeline();
      unsubStatus();
      unsubPermissionRequest();
      unsubPermissionResolved();
      unsubAudioOutput();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubAgentDeleted();
      unsubAgentArchived();
    };
  }, [
    client,
    audioPlayer,
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
    setAgentLastActivity,
    setPendingPermissions,
    setFileExplorer,
    setHasHydratedAgents,
    clearDraftInput,
    notifyAgentAttention,
    requestCanonicalCatchUp,
    applyAgentUpdatePayload,
    applyTimelineResponse,
  ]);

  const sendAgentMessage = useCallback(
    async (
      agentId: string,
      message: string,
      images?: AttachmentMetadata[]
    ) => {
      const messageId = generateMessageId();
      const userMessage: StreamItem = {
        kind: "user_message",
        id: messageId,
        text: message,
        timestamp: new Date(),
      };

      // Append to head if streaming (keeps the user message with the current
      // turn so late text_deltas still find the existing assistant_message).
      // Otherwise append to tail.
      const currentHead = useSessionStore.getState().sessions[serverId]?.agentStreamHead?.get(agentId);
      if (currentHead && currentHead.length > 0) {
        setAgentStreamHead(serverId, (prev) => {
          const head = prev.get(agentId) || [];
          const updated = new Map(prev);
          updated.set(agentId, [...head, userMessage]);
          return updated;
        });
      } else {
        setAgentStreamTail(serverId, (prev) => {
          const currentStream = prev.get(agentId) || [];
          const updated = new Map(prev);
          updated.set(agentId, [...currentStream, userMessage]);
          return updated;
        });
      }

      const imagesData = await encodeImages(images);
      if (!client) {
        console.warn("[Session] sendAgentMessage skipped: daemon unavailable");
        return;
      }
      void client
        .sendAgentMessage(agentId, message, {
          messageId,
          ...(imagesData && imagesData.length > 0
            ? { images: imagesData }
            : {}),
        })
        .catch((error) => {
          console.error("[Session] Failed to send agent message:", error);
        });
    },
    [encodeImages, serverId, client, setAgentStreamTail, setAgentStreamHead]
  );

  // Keep the ref updated so the agent_update handler can call it
  sendAgentMessageRef.current = sendAgentMessage;

  const cancelAgentRun = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] cancelAgent skipped: daemon unavailable");
        return;
      }
      void client.cancelAgent(agentId).catch((error) => {
        console.error("[Session] Failed to cancel agent:", error);
      });
    },
    [client]
  );

  const deleteAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] deleteAgent skipped: daemon unavailable");
        return;
      }
      void client.deleteAgent(agentId).catch((error) => {
        console.error("[Session] Failed to delete agent:", error);
      });
    },
    [client]
  );

  const archiveAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] archiveAgent skipped: daemon unavailable");
        return;
      }
      void client.archiveAgent(agentId).catch((error) => {
        console.error("[Session] Failed to archive agent:", error);
      });
    },
    [client]
  );

  const restartServer = useCallback(
    (reason?: string) => {
      if (!client) {
        console.warn("[Session] restartServer skipped: daemon unavailable");
        return;
      }
      void client.restartServer(reason).catch((error) => {
        console.error("[Session] Failed to restart server:", error);
      });
    },
    [client]
  );

  const createAgent = useCallback(
    async ({
      config,
      initialPrompt,
      images,
      git,
      worktreeName,
      requestId,
    }: {
      config: any;
      initialPrompt: string;
      images?: AttachmentMetadata[];
      git?: any;
      worktreeName?: string;
      requestId?: string;
    }) => {
      console.log(
        "[Session] createAgent called with images:",
        images?.length ?? 0,
        images
      );
      if (!client) {
        console.warn("[Session] createAgent skipped: daemon unavailable");
        return;
      }
      const trimmedPrompt = initialPrompt.trim();
      let imagesData: Array<{ data: string; mimeType: string }> | undefined;
      try {
        imagesData = await encodeImages(images);
        console.log(
          "[Session] encodeImages result:",
          imagesData?.length ?? 0,
          imagesData?.map((img) => ({
            dataLength: img.data?.length ?? 0,
            mimeType: img.mimeType,
          }))
        );
      } catch (error) {
        console.error(
          "[Session] Failed to prepare images for agent creation:",
          error
        );
      }
      return client.createAgent({
        config,
        labels: { ui: "true" },
        ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
        ...(git ? { git } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(requestId ? { requestId } : {}),
      });
    },
    [encodeImages, client]
  );

  const setAgentMode = useCallback(
    (agentId: string, modeId: string) => {
      if (!client) {
        console.warn("[Session] setAgentMode skipped: daemon unavailable");
        return;
      }
      void client.setAgentMode(agentId, modeId).catch((error) => {
        console.error("[Session] Failed to set agent mode:", error);
      });
    },
    [client]
  );

  const setAgentModel = useCallback(
    (agentId: string, modelId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentModel skipped: daemon unavailable");
        return;
      }
      void client.setAgentModel(agentId, modelId).catch((error) => {
        console.error("[Session] Failed to set agent model:", error);
      });
    },
    [client]
  );

  const setAgentThinkingOption = useCallback(
    (agentId: string, thinkingOptionId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentThinkingOption skipped: daemon unavailable");
        return;
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .catch((error) => {
          console.error("[Session] Failed to set agent thinking option:", error);
        });
    },
    [client]
  );

  const respondToPermission = useCallback(
    (agentId: string, requestId: string, response: any) => {
      if (!client) {
        console.warn("[Session] respondToPermission skipped: daemon unavailable");
        return;
      }
      void client
        .respondToPermission(agentId, requestId, response)
        .catch((error) => {
          console.error("[Session] Failed to respond to permission:", error);
        });
    },
    [client]
  );

  const setVoiceDetectionFlags = useCallback(
    (isDetecting: boolean, isSpeaking: boolean) => {
      isDetectingRef.current = isDetecting;
      isSpeakingRef.current = isSpeaking;
    },
    []
  );

  const requestDirectoryListing = useCallback(
    (agentId: string, path: string, options?: { recordHistory?: boolean }) => {
      const normalizedPath = path && path.length > 0 ? path : ".";
      const shouldRecordHistory = options?.recordHistory ?? true;

      updateExplorerState(agentId, (state: any) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "list" },
        currentPath: normalizedPath,
        history: shouldRecordHistory
          ? pushHistory(state.history, normalizedPath)
          : state.history,
        lastVisitedPath: normalizedPath,
      }));

      directoryListingMutation
        .mutateAsync({ agentId, path: normalizedPath })
        .then((payload) => {
          updateExplorerState(agentId, (state: any) => {
            const nextState: any = {
              ...state,
              isLoading: false,
              lastError: payload.error ?? null,
              pendingRequest: null,
              directories: state.directories,
              files: state.files,
            };

            if (!payload.error && payload.directory) {
              const directories = new Map(state.directories);
              directories.set(payload.directory.path, payload.directory);
              nextState.directories = directories;
            }

            return nextState;
          });
        })
        .catch((error) => {
          updateExplorerState(agentId, (state: any) => ({
            ...state,
            isLoading: false,
            lastError: error.message,
            pendingRequest: null,
          }));
        });
    },
    [directoryListingMutation, updateExplorerState]
  );

  const requestFilePreview = useCallback(
    (agentId: string, path: string) => {
      const normalizedPath = path && path.length > 0 ? path : ".";
      updateExplorerState(agentId, (state: any) => ({
        ...state,
        isLoading: true,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));

      filePreviewMutation
        .mutateAsync({ agentId, path: normalizedPath })
        .then((payload) => {
          updateExplorerState(agentId, (state: any) => {
            const nextState: any = {
              ...state,
              isLoading: false,
              pendingRequest: null,
              directories: state.directories,
              files: state.files,
            };

            if (!payload.error && payload.file) {
              const files = new Map(state.files);
              files.set(payload.file.path, payload.file);
              nextState.files = files;
            }

            return nextState;
          });
        })
        .catch((error) => {
          updateExplorerState(agentId, (state: any) => ({
            ...state,
            isLoading: false,
            pendingRequest: null,
          }));
        });
    },
    [filePreviewMutation, updateExplorerState]
  );

  const requestFileDownloadToken = useCallback(
    (agentId: string, path: string) => {
      return fileDownloadTokenMutation.mutateAsync({ agentId, path });
    },
    [fileDownloadTokenMutation]
  );

  const navigateExplorerBack = useCallback(
    (agentId: string) => {
      let targetPath: string | null = null;

      updateExplorerState(agentId, (state: any) => {
        if (!state.history || state.history.length <= 1) {
          return state;
        }

        const nextHistory = state.history.slice(0, -1);
        targetPath = nextHistory[nextHistory.length - 1] ?? ".";

        return {
          ...state,
          isLoading: true,
          lastError: null,
          pendingRequest: { path: targetPath, mode: "list" },
          currentPath: targetPath,
          history: nextHistory,
          lastVisitedPath: targetPath,
        };
      });

      if (!targetPath) {
        return null;
      }

      directoryListingMutation
        .mutateAsync({ agentId, path: targetPath })
        .then((payload) => {
          updateExplorerState(agentId, (state: any) => {
            const nextState: any = {
              ...state,
              isLoading: false,
              lastError: payload.error ?? null,
              pendingRequest: null,
              directories: state.directories,
              files: state.files,
            };

            if (!payload.error && payload.directory) {
              const directories = new Map(state.directories);
              directories.set(payload.directory.path, payload.directory);
              nextState.directories = directories;
            }

            return nextState;
          });
        })
        .catch((error) => {
          updateExplorerState(agentId, (state: any) => ({
            ...state,
            isLoading: false,
            lastError: error.message,
            pendingRequest: null,
          }));
        });
      return targetPath;
    },
    [directoryListingMutation, updateExplorerState]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSession(serverId);
    };
  }, [serverId, clearSession]);

  return children;
}
