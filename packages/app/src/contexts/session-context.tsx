import { useRef, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation } from "@tanstack/react-query";
import { useDaemonClient } from "@/hooks/use-daemon-client";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { useClientActivity } from "@/hooks/use-client-activity";
import { usePushTokenRegistration } from "@/hooks/use-push-token-registration";
import {
  applyStreamEvent,
  generateMessageId,
  hydrateStreamState,
  type StreamItem,
} from "@/types/stream";
import type {
  ActivityLogPayload,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  SessionOutboundMessage,
} from "@server/shared/messages";
import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { AgentPermissionRequest } from "@server/server/agent/agent-sdk-types";
import type { DaemonClient, ConnectionState } from "@server/client/daemon-client";
import { File } from "expo-file-system";
import { useDaemonConnections } from "./daemon-connections-context";
import {
  useSessionStore,
  type SessionState,
  type DaemonConnectionSnapshot,
} from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { sendOsNotification } from "@/utils/os-notifications";
import { getInitKey, getInitDeferred, resolveInitDeferred, rejectInitDeferred, createInitDeferred } from "@/utils/agent-initialization";
import { encodeImages } from "@/utils/encode-images";

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

const derivePendingPermissionKey = (
  agentId: string,
  request: AgentPermissionRequest
) => {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string"
      ? request.metadata.id
      : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(
      request.input ?? request.metadata ?? {}
    )}`;

  return `${agentId}:${fallbackId}`;
};

const NOTIFICATION_PREVIEW_LIMIT = 220;

const normalizeNotificationText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const truncateNotificationText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  const trimmed = text.slice(0, Math.max(0, limit - 3)).trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : text.slice(0, limit);
};

const buildNotificationPreview = (
  text: string | null | undefined
): string | null => {
  if (!text) {
    return null;
  }
  const normalized = normalizeNotificationText(text);
  if (!normalized) {
    return null;
  }
  return truncateNotificationText(normalized, NOTIFICATION_PREVIEW_LIMIT);
};

const safeStringify = (value: unknown): string | null => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const findLatestAssistantMessageText = (items: StreamItem[]): string | null => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "assistant_message") {
      return item.text;
    }
  }
  return null;
};

const mapConnectionState = (
  state: ConnectionState,
  lastError: string | null
): DaemonConnectionSnapshot => ({
  isConnected: state.status === "connected",
  isConnecting: state.status === "connecting",
  lastError: state.status === "disconnected" ? state.reason ?? lastError : null,
});

const getLatestPermissionRequest = (
  session: SessionState | undefined,
  agentId: string
): AgentPermissionRequest | null => {
  if (!session) {
    return null;
  }

  let latest: AgentPermissionRequest | null = null;
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
    return agentPending[agentPending.length - 1] as AgentPermissionRequest;
  }

  return null;
};

const buildPermissionDetails = (
  request: AgentPermissionRequest | null
): string | null => {
  if (!request) {
    return null;
  }
  const title = request.title?.trim();
  const description = request.description?.trim();
  const details: string[] = [];
  if (title) {
    details.push(title);
  }
  if (description && description !== title) {
    details.push(description);
  }
  if (details.length > 0) {
    return details.join(" - ");
  }

  const inputPreview = request.input ? safeStringify(request.input) : null;
  if (inputPreview) {
    return inputPreview;
  }

  const metadataPreview = request.metadata
    ? safeStringify(request.metadata)
    : null;
  if (metadataPreview) {
    return metadataPreview;
  }

  return request.name?.trim() || request.kind;
};

type FileExplorerPayload = Extract<
  SessionOutboundMessage,
  { type: "file_explorer_response" }
>["payload"];

type FileDownloadTokenPayload = Extract<
  SessionOutboundMessage,
  { type: "file_download_token_response" }
>["payload"];

function normalizeAgentSnapshot(
  snapshot: AgentSnapshotPayload,
  serverId: string
) {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  const lastUserMessageAt = snapshot.lastUserMessageAt
    ? new Date(snapshot.lastUserMessageAt)
    : null;
  const attentionTimestamp = snapshot.attentionTimestamp
    ? new Date(snapshot.attentionTimestamp)
    : null;
  const archivedAt = snapshot.archivedAt
    ? new Date(snapshot.archivedAt)
    : null;
  return {
    serverId,
    id: snapshot.id,
    provider: snapshot.provider,
    status: snapshot.status as AgentLifecycleStatus,
    createdAt,
    updatedAt,
    lastUserMessageAt,
    lastActivityAt: updatedAt,
    capabilities: snapshot.capabilities,
    currentModeId: snapshot.currentModeId,
    availableModes: snapshot.availableModes ?? [],
    pendingPermissions: snapshot.pendingPermissions ?? [],
    persistence: snapshot.persistence ?? null,
    runtimeInfo: snapshot.runtimeInfo,
    lastUsage: snapshot.lastUsage,
    lastError: snapshot.lastError ?? null,
    title: snapshot.title ?? null,
    cwd: snapshot.cwd,
    model: snapshot.model ?? null,
    thinkingOptionId: snapshot.thinkingOptionId ?? null,
    requiresAttention: snapshot.requiresAttention ?? false,
    attentionReason: snapshot.attentionReason ?? null,
    attentionTimestamp,
    archivedAt,
    labels: snapshot.labels,
  };
}

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

interface SessionProviderProps {
  children: ReactNode;
  serverUrl: string;
  serverId: string;
}

// SessionProvider: Daemon client message handler that updates Zustand store
export function SessionProvider({
  children,
  serverUrl,
  serverId,
}: SessionProviderProps) {
  const client = useDaemonClient(serverUrl);
  const [connectionSnapshot, setConnectionSnapshot] =
    useState<DaemonConnectionSnapshot>(() =>
      mapConnectionState(client.getConnectionState(), client.lastError)
    );
  const { updateConnectionStatus } = useDaemonConnections();

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
  const clearAgentStreamHead = useSessionStore(
    (state) => state.clearAgentStreamHead
  );
  const setInitializingAgents = useSessionStore(
    (state) => state.setInitializingAgents
  );
  const setHasHydratedAgents = useSessionStore(
    (state) => state.setHasHydratedAgents
  );
  const setAgents = useSessionStore((state) => state.setAgents);
  const setAgentLastActivity = useSessionStore(
    (state) => state.setAgentLastActivity
  );
  const setPendingPermissions = useSessionStore(
    (state) => state.setPendingPermissions
  );
  const setGitDiffs = useSessionStore((state) => state.setGitDiffs);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const clearDraftInput = useDraftStore((state) => state.clearDraftInput);
  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const getSession = useSessionStore((state) => state.getSession);
  const updateSessionClient = useSessionStore((state) => state.updateSessionClient);
  const updateSessionConnection = useSessionStore(
    (state) => state.updateSessionConnection
  );

  // Track focused agent for heartbeat
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null
  );

  // Client activity tracking (heartbeat, push token registration)
  useClientActivity({ client, focusedAgentId });
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
        images?: Array<{ uri: string; mimeType?: string }>
      ) => Promise<void>)
    | null
  >(null);
  const hasRequestedInitialSnapshotRef = useRef(false);
  const agentUpdatesSubscriptionIdRef = useRef<string | null>(null);
  const sessionStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const attentionNotifiedRef = useRef<Map<string, number>>(new Map());
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const notifyAgentAttention = useCallback(
    (params: {
      agentId: string;
      reason: "finished" | "error" | "permission";
      timestamp: string;
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
        return;
      }

      const timestampMs = new Date(params.timestamp).getTime();
      const lastNotified = attentionNotifiedRef.current.get(params.agentId);
      if (lastNotified && lastNotified >= timestampMs) {
        return;
      }
      attentionNotifiedRef.current.set(params.agentId, timestampMs);

      const title =
        params.reason === "permission"
          ? "Agent needs permission"
          : "Agent finished";
      let preview: string | null = null;

      if (params.reason === "finished") {
        const head = session?.agentStreamHead.get(params.agentId) ?? [];
        const tail = session?.agentStreamTail.get(params.agentId) ?? [];
        const lastMessage =
          findLatestAssistantMessageText(head) ??
          findLatestAssistantMessageText(tail);
        preview = buildNotificationPreview(lastMessage);
      } else if (params.reason === "permission") {
        const permissionRequest = getLatestPermissionRequest(
          session,
          params.agentId
        );
        preview = buildNotificationPreview(
          buildPermissionDetails(permissionRequest)
        );
      }

      const body =
        preview ??
        (params.reason === "permission"
          ? "Permission requested."
          : "Finished working.");

      void sendOsNotification({
        title,
        body,
        data: {
          agentId: params.agentId,
          serverId,
          reason: params.reason,
        },
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

  useEffect(() => {
    const unsubscribe = client.subscribeConnectionStatus((state) => {
      setConnectionSnapshot(mapConnectionState(state, client.lastError));
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    updateSessionConnection(serverId, connectionSnapshot);
  }, [serverId, connectionSnapshot, updateSessionConnection]);

  // Initialize session in store
  useEffect(() => {
    initializeSession(serverId, client, audioPlayer);
  }, [serverId, client, audioPlayer, initializeSession]);

  useEffect(() => {
    updateSessionClient(serverId, client);
  }, [serverId, client, updateSessionClient]);

  // Connection status tracking
  useEffect(() => {
    if (connectionSnapshot.isConnected) {
      updateConnectionStatus(serverId, {
        status: "online",
        lastOnlineAt: new Date().toISOString(),
      });
      return;
    }

    if (connectionSnapshot.isConnecting) {
      updateConnectionStatus(serverId, { status: "connecting" });
      return;
    }

    if (connectionSnapshot.lastError) {
      updateConnectionStatus(serverId, {
        status: "error",
        lastError: connectionSnapshot.lastError,
      });
      return;
    }

    updateConnectionStatus(serverId, { status: "offline" });
  }, [
    serverId,
    updateConnectionStatus,
    connectionSnapshot.isConnected,
    connectionSnapshot.isConnecting,
    connectionSnapshot.lastError,
  ]);

  // If the client drops mid-initialization, clear pending flags
  useEffect(() => {
    if (!connectionSnapshot.isConnected) {
      setInitializingAgents(serverId, new Map());
    }
  }, [serverId, connectionSnapshot.isConnected, setInitializingAgents]);

  useEffect(() => {
    return () => {
      updateConnectionStatus(serverId, { status: "offline", lastError: null });
    };
  }, [serverId, updateConnectionStatus]);

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

  const gitDiffMutation = useMutation({
    mutationFn: async ({ agentId }: { agentId: string }) => {
      if (!agentId) {
        throw new Error("Agent id is required");
      }
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.getGitDiff(agentId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { agentId: payload.agentId, diff: payload.diff ?? "" };
    },
  });

  const refreshAgentMutation = useMutation({
    mutationFn: async ({ agentId }: { agentId: string }) => {
      if (!agentId) {
        throw new Error("Agent id is required");
      }
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      return await client.refreshAgent(agentId);
    },
  });

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

  useEffect(() => {
    if (!connectionSnapshot.isConnected) {
      hasRequestedInitialSnapshotRef.current = false;
      const subscriptionId = agentUpdatesSubscriptionIdRef.current;
      if (subscriptionId && client) {
        try {
          client.unsubscribeAgentUpdates(subscriptionId);
        } catch {
          // no-op
        }
      }
      agentUpdatesSubscriptionIdRef.current = null;
      return;
    }
    if (hasRequestedInitialSnapshotRef.current) {
      return;
    }
    hasRequestedInitialSnapshotRef.current = true;

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    let cancelled = false;

    const hydrateAgents = async () => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (!agentUpdatesSubscriptionIdRef.current) {
            agentUpdatesSubscriptionIdRef.current = client.subscribeAgentUpdates({
              subscriptionId: `app:${serverId}`,
              filter: { labels: { ui: "true" } },
            });
          }

          const agentsList = await client.fetchAgents({
            filter: { labels: { ui: "true" } },
          });
          if (cancelled) {
            return;
          }

          setInitializingAgents(serverId, new Map());

          const agents = new Map();
          const pendingPermissions = new Map();
          const agentLastActivity = new Map();

          for (const agentSnapshot of agentsList) {
            const agent = normalizeAgentSnapshot(agentSnapshot, serverId);
            agents.set(agent.id, agent);
            agentLastActivity.set(agent.id, agent.lastActivityAt);
            for (const request of agent.pendingPermissions) {
              const key = derivePendingPermissionKey(agent.id, request);
              pendingPermissions.set(key, { key, agentId: agent.id, request });
            }
          }

          setAgents(serverId, agents);

          for (const [agentId, timestamp] of agentLastActivity.entries()) {
            setAgentLastActivity(agentId, timestamp);
          }

          setPendingPermissions(serverId, pendingPermissions);
          setAgentStreamTail(serverId, (prev) => {
            if (prev.size === 0) {
              return prev;
            }

            const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
            let changed = false;
            const next = new Map(prev);

            for (const agentId of prev.keys()) {
              if (!validAgentIds.has(agentId)) {
                next.delete(agentId);
                changed = true;
              }
            }

            return changed ? next : prev;
          });
          setAgentStreamHead(serverId, (prev) => {
            if (prev.size === 0) {
              return prev;
            }

            const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
            let changed = false;
            const next = new Map(prev);

            for (const agentId of prev.keys()) {
              if (!validAgentIds.has(agentId)) {
                next.delete(agentId);
                changed = true;
              }
            }

            return changed ? next : prev;
          });
          setInitializingAgents(serverId, (prev) => {
            if (prev.size === 0) {
              return prev;
            }

            const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
            let changed = false;
            const next = new Map(prev);

            for (const agentId of prev.keys()) {
              if (!validAgentIds.has(agentId)) {
                next.delete(agentId);
                changed = true;
              }
            }

            return changed ? next : prev;
          });

          setHasHydratedAgents(serverId, true);
          updateConnectionStatus(serverId, {
            status: "online",
            lastOnlineAt: new Date().toISOString(),
            agentListReady: true,
          });
          return;
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            console.warn(
              `[Session] fetchAgents failed, retrying in ${RETRY_DELAY_MS}ms`,
              { serverId, attempt: attempt + 1, maxRetries: MAX_RETRIES, err }
            );
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }

          console.error(`[Session] fetchAgents failed after ${MAX_RETRIES} retries`, {
            serverId,
            err,
          });
          setHasHydratedAgents(serverId, true);
          updateConnectionStatus(serverId, {
            status: "online",
            lastOnlineAt: new Date().toISOString(),
            agentListReady: true,
          });
          return;
        }
      }
    };

    void hydrateAgents();
    return () => {
      cancelled = true;
    };
  }, [connectionSnapshot.isConnected, client, serverId, setHasHydratedAgents, updateConnectionStatus]);

  // Daemon message handlers - directly update Zustand store
  useEffect(() => {
    const unsubAgentUpdate = client.on("agent_update", (message) => {
      if (message.type !== "agent_update") return;
      const update = message.payload;

      if (update.kind === "remove") {
        const agentId = update.agentId;
        previousAgentStatusRef.current.delete(agentId);

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

        return;
      }

      const agent = normalizeAgentSnapshot(update.agent, serverId);

      console.log("[Session] Agent update:", agent.id, agent.status);

      setAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });

      // Update agentLastActivity slice (top-level)
      setAgentLastActivity(agent.id, agent.lastActivityAt);

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        for (const [key, pending] of Array.from(next.entries())) {
          if (pending.agentId === agent.id) {
            next.delete(key);
          }
        }
        for (const request of agent.pendingPermissions) {
          const key = derivePendingPermissionKey(agent.id, request);
          next.set(key, { key, agentId: agent.id, request });
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
    });

    const unsubAgentStream = client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp } = message.payload;
      const parsedTimestamp = new Date(timestamp);

      console.log("[Session] agent_stream", { agentId, event, timestamp });

      if (event.type === "attention_required") {
        console.log("[Session] attention_required", { agentId, shouldNotify: event.shouldNotify, reason: event.reason });
        if (event.shouldNotify) {
          notifyAgentAttention({
            agentId,
            reason: event.reason,
            timestamp: event.timestamp,
          });
        }
      }

      const session = useSessionStore.getState().sessions[serverId];
      const currentTail = session?.agentStreamTail.get(agentId) ?? [];
      const currentHead = session?.agentStreamHead.get(agentId) ?? [];
      const { tail, head, changedTail, changedHead } = applyStreamEvent({
        tail: currentTail,
        head: currentHead,
        event: event as AgentStreamEventPayload,
        timestamp: parsedTimestamp,
      });

      if (changedTail) {
        setAgentStreamTail(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, tail);
          return next;
        });
      }

      if (changedHead) {
        setAgentStreamHead(serverId, (prev) => {
          const next = new Map(prev);
          if (head.length > 0) {
            next.set(agentId, head);
          } else {
            next.delete(agentId);
          }
          return next;
        });
      }

      setInitializingAgents(serverId, (prev) => {
        const currentState = prev.get(agentId);
        if (currentState === false) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, false);
        return next;
      });

      // NOTE: We don't update lastActivityAt on every stream event to prevent
      // cascading rerenders. The agent_update handler updates agent.lastActivityAt
      // on status changes, which is sufficient for sorting and display purposes.
    });

    const unsubAgentStreamSnapshot = client.on(
      "agent_stream_snapshot",
      (message) => {
        if (message.type !== "agent_stream_snapshot") return;
        const { agentId, events } = message.payload;

        console.log("[Session] agent_stream_snapshot", {
          agentId,
          eventCount: events.length,
        });

        const hydrated = hydrateStreamState(
          events.map(({ event, timestamp }) => ({
            event: event as AgentStreamEventPayload,
            timestamp: new Date(timestamp),
          }))
        );

        setAgentStreamTail(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, hydrated);
          return next;
        });
        clearAgentStreamHead(serverId, agentId);

        setInitializingAgents(serverId, (prev) => {
          if (!prev.has(agentId)) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });

        // Resolve the initialization promise (even for empty history)
        const initKey = getInitKey(serverId, agentId);
        resolveInitDeferred(initKey);
      }
    );

    const unsubStatus = client.on("status", (message) => {
      if (message.type !== "status") return;
      const status = message.payload.status;
      if (status === "agent_initialized" && "agentId" in message.payload) {
        console.log("[Session] status agent_initialized", {
          agentId: (message.payload as any).agentId,
          requestId: (message.payload as any).requestId,
        });
      }
      if (status === "agent_initialized" && "agentId" in message.payload) {
        const agentId = (message.payload as any).agentId as string | undefined;
        if (agentId) {
          setInitializingAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
        }
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
        console.log(
          `[Session] Buffered chunk ${chunkIndex} for group ${playbackGroupId}`
        );
        return;
      }

      console.log(
        `[Session] Received final chunk for group ${playbackGroupId}, total chunks: ${buffer.length}`
      );
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

        console.log(
          `[Session] Playing concatenated audio: ${buffer.length} chunks, ${totalSize} bytes`
        );

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
        console.log(
          "[Session] Empty transcription (false positive) - ignoring"
        );
      } else {
        console.log("[Session] Transcription received - stopping playback");
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

      // Remove draft input
      clearDraftInput(agentId);

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

      setGitDiffs(serverId, (prev) => {
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
      unsubAgentStreamSnapshot();
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
    serverId,
    setIsPlayingAudio,
    setMessages,
    setCurrentAssistantMessage,
    setAgentStreamTail,
    setAgentStreamHead,
    clearAgentStreamHead,
    setInitializingAgents,
    setAgents,
    setAgentLastActivity,
    setPendingPermissions,
    setGitDiffs,
    setFileExplorer,
    setHasHydratedAgents,
    updateConnectionStatus,
    getSession,
    clearDraftInput,
    notifyAgentAttention,
  ]);

  const initializeAgent = useCallback(
    ({ agentId, requestId }: { agentId: string; requestId?: string }) => {
      setInitializingAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, true);
        return next;
      });

      setAgentStreamTail(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, []);
        return next;
      });
      clearAgentStreamHead(serverId, agentId);
      if (!client) {
        console.warn("[Session] initializeAgent skipped: daemon unavailable");
        setInitializingAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
        return;
      }

      client
        .initializeAgent(agentId, requestId)
        .catch((error) => {
          console.warn("[Session] initializeAgent failed", { agentId, error });
          setInitializingAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
        });
    },
    [serverId, client, setAgentStreamTail, setInitializingAgents, clearAgentStreamHead]
  );

  const refreshAgent = useCallback(
    ({ agentId, requestId }: { agentId: string; requestId?: string }) => {
      setInitializingAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, true);
        return next;
      });

      setAgentStreamTail(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, []);
        return next;
      });
      clearAgentStreamHead(serverId, agentId);

      refreshAgentMutation
        .mutateAsync({ agentId })
        .catch((error) => {
          console.warn("[Session] refreshAgent failed", { agentId, error });
          setInitializingAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
        });
    },
    [
      serverId,
      refreshAgentMutation,
      setAgentStreamTail,
      setInitializingAgents,
      clearAgentStreamHead,
    ]
  );

  const sendAgentMessage = useCallback(
    async (
      agentId: string,
      message: string,
      images?: Array<{ uri: string; mimeType?: string }>
    ) => {
      const messageId = generateMessageId();

      setAgentStreamTail(serverId, (prev) => {
        const currentStream = prev.get(agentId) || [];
        const nextItem: any = {
          kind: "user_message",
          id: messageId,
          text: message,
          timestamp: new Date(),
        };
        const updated = new Map(prev);
        updated.set(agentId, [...currentStream, nextItem]);
        return updated;
      });

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
    [encodeImages, serverId, client, setAgentStreamTail]
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
      images?: Array<{ uri: string; mimeType?: string }>;
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

  const requestGitDiff = useCallback(
    (agentId: string) => {
      gitDiffMutation
        .mutateAsync({ agentId })
        .then((result) => {
          setGitDiffs(serverId, (prev) =>
            new Map(prev).set(result.agentId, result.diff)
          );
        })
        .catch((error) => {
          setGitDiffs(serverId, (prev) =>
            new Map(prev).set(agentId, `Error: ${error.message}`)
          );
        });
    },
    [serverId, gitDiffMutation, setGitDiffs]
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

  const refreshSession = useCallback(() => {
    console.log(`[Session] Manual refresh requested for ${serverId}`);
    if (!client) {
      console.warn("[Session] refreshSession skipped: daemon unavailable");
      return;
    }
    void (async () => {
      try {
        const agentsList = await client.fetchAgents({
          filter: { labels: { ui: "true" } },
        });

        setInitializingAgents(serverId, new Map());

        const agents = new Map();
        const pendingPermissions = new Map();
        const agentLastActivity = new Map();

        for (const agentSnapshot of agentsList) {
          const agent = normalizeAgentSnapshot(agentSnapshot, serverId);
          agents.set(agent.id, agent);
          agentLastActivity.set(agent.id, agent.lastActivityAt);
          for (const request of agent.pendingPermissions) {
            const key = derivePendingPermissionKey(agent.id, request);
            pendingPermissions.set(key, { key, agentId: agent.id, request });
          }
        }

        setAgents(serverId, agents);
        for (const [agentId, timestamp] of agentLastActivity.entries()) {
          setAgentLastActivity(agentId, timestamp);
        }
        setPendingPermissions(serverId, pendingPermissions);
      } catch (error: any) {
        console.error("[Session] Failed to refresh agents:", error);
      }
    })();
  }, [
    client,
    derivePendingPermissionKey,
    normalizeAgentSnapshot,
    serverId,
    setAgentLastActivity,
    setAgents,
    setInitializingAgents,
    setPendingPermissions,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSession(serverId);
    };
  }, [serverId, clearSession]);

  return children;
}
