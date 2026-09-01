import { useRef, ReactNode, useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useClientActivity } from "@/hooks/use-client-activity";
import { useAppVisible } from "@/hooks/use-app-visible";
import { startPushNotifications } from "@/push-notifications";
import {
  createSetAgentInitializing,
  refreshAgentInitializationTimeout,
} from "@/hooks/use-agent-initialization";
import type { StreamItem } from "@/types/stream";
import { deriveAgentStreamTurnLiveness } from "@/timeline/session-stream-reducers";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { requestTimelineReplacement } from "@/timeline/timeline-replacement";
import {
  consumeForcedTimelineTailReplacement,
  type TimelineDeliveryMode,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "@/timeline/viewed-timeline-sync";
import type { AgentAttachment, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  buildAgentAttentionNotificationPayload,
  type AgentAttentionReason,
  type AgentAttentionNotificationPayload,
  type NotificationPermissionRequest,
} from "@getpaseo/protocol/agent-attention-notification";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { GitSetupOptions } from "@getpaseo/protocol/messages";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVoiceRuntimeOptional } from "@/contexts/voice-context";
import {
  selectAgentTimelineState,
  useSessionStore,
  type SessionState,
} from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { sendOsNotification } from "@/utils/os-notifications";
import { getIsAppActivelyVisible, getIsAppVisible } from "@/utils/app-visibility";
import {
  getInitKey,
  getInitDeferred,
  createInitDeferred,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { encodeImages } from "@/utils/encode-images";
import { derivePendingPermissionKey } from "@/utils/agent-snapshots";
import type { AttachmentMetadata } from "@/attachments/types";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { applyCheckoutStatusUpdateFromEvent } from "@/git/checkout-status-cache";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { revalidateSessionAfterResume } from "@/contexts/session-resume-revalidation";

// Re-export types from session-store and draft-store for backward compatibility
export type { DraftInput } from "@/stores/draft-store";
export type {
  Agent,
  ExplorerEntry,
  ExplorerFile,
  ExplorerEntryKind,
  ExplorerFileKind,
  ExplorerEncoding,
  AgentFileExplorerState,
} from "@/stores/session-store";

// COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
function getTimelineDeliveryMode(selectiveAgentTimeline?: boolean): TimelineDeliveryMode {
  return selectiveAgentTimeline ? "selective" : "legacy";
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

interface AgentAttentionNotificationInput {
  notification?: AgentAttentionNotificationPayload;
  reason: AgentAttentionReason;
  serverId: string;
  workspaceId: string | undefined;
  agentId: string;
  assistantMessage: string | null;
  permissionRequest: NotificationPermissionRequest | null;
}

function resolveAgentAttentionNotification(
  input: AgentAttentionNotificationInput,
): AgentAttentionNotificationPayload | null {
  if (input.notification) {
    return input.notification.data.workspaceId ? input.notification : null;
  }
  if (!input.workspaceId) {
    return null;
  }
  return buildAgentAttentionNotificationPayload({
    reason: input.reason,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    assistantMessage: input.reason === "finished" ? input.assistantMessage : null,
    permissionRequest: input.reason === "permission" ? input.permissionRequest : null,
  });
}

type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

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
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();

  // Zustand store actions
  const setIsPlayingAudio = useSessionStore((state) => state.setIsPlayingAudio);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead);
  const applyAgentTurnLiveness = useSessionStore((state) => state.applyAgentTurnLiveness);
  const clearAgentTurnLiveness = useSessionStore((state) => state.clearAgentTurnLiveness);
  const clearAgentStreamHead = useSessionStore((state) => state.clearAgentStreamHead);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const bumpHistorySyncGeneration = useSessionStore((state) => state.bumpHistorySyncGeneration);
  const setAgents = useSessionStore((state) => state.setAgents);
  const flushAgentLastActivity = useSessionStore((state) => state.flushAgentLastActivity);
  const setPendingPermissions = useSessionStore((state) => state.setPendingPermissions);
  const updateSessionServerInfo = useSessionStore((state) => state.updateSessionServerInfo);
  const setViewedTimelineSync = useSessionStore((state) => state.setViewedTimelineSync);
  const upsertWorkspaceSetupProgress = useWorkspaceSetupStore((state) => state.upsertProgress);

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
  const forcedTimelineTailReplacements = useRef(new Set<string>());
  const viewedTimelineSyncRef = useRef<ViewedTimelineOwner | null>(null);
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

  const handleAppResumed = useCallback(
    (awayMs: number) => {
      void revalidateSessionAfterResume({
        awayMs,
        serverId,
        bumpHistorySyncGeneration,
      });
    },
    [bumpHistorySyncGeneration, serverId],
  );

  // Client activity tracking (heartbeat, push token registration)
  useClientActivity({
    client,
    focusedAgentId,
    focusedTerminalId,
    onAppResumed: handleAppResumed,
  });
  useEffect(() => startPushNotifications({ client, serverId }), [client, serverId]);

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
      const workspaceId = session?.agents?.get(params.agentId)?.workspaceId;

      const notification = resolveAgentAttentionNotification({
        notification: params.notification,
        reason: params.reason,
        serverId,
        workspaceId,
        agentId: params.agentId,
        assistantMessage,
        permissionRequest,
      });
      if (!notification) {
        return;
      }

      void sendOsNotification({
        title: notification.title,
        body: notification.body,
        data: notification.data,
      });
    },
    [serverId],
  );

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
    const unregister = voiceRuntime?.registerSession({
      serverId,
      startCall: async (context, transports) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        return client.startVoiceCall(context, transports);
      },
      stopCall: async (callId) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.stopVoiceCall(callId);
      },
      updateCallContext: async (callId, context) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.updateVoiceCallContext(callId, context);
      },
      sendTransportMessage: (callId, data) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        client.sendVoiceCallTransportMessage(callId, data);
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

  useEffect(
    () =>
      client.subscribeConnectionStatus((connection) => {
        if (connection.status === "connected") return;
        clearAgentTurnLiveness(serverId);
      }),
    [clearAgentTurnLiveness, client, serverId],
  );

  const applyWorkspaceSetupProgress = useCallback(
    (payload: WorkspaceSetupProgressPayload) => {
      upsertWorkspaceSetupProgress({ serverId, payload });
    },
    [serverId, upsertWorkspaceSetupProgress],
  );

  const applyTimelineResponse = useCallback((receivedPayload: TimelineResponsePayload) => {
    const payload = consumeForcedTimelineTailReplacement(
      receivedPayload,
      forcedTimelineTailReplacements.current,
    );
    const owner = viewedTimelineSyncRef.current;
    if (!owner) throw new Error("Viewed timeline owner is unavailable");
    owner.applyTimelineResponse(payload);
  }, []);

  useEffect(() => {
    const setAgentInitializing = createSetAgentInitializing(serverId, setInitializingAgents);
    const initialDeliveryMode = getTimelineDeliveryMode(
      client.getLastServerInfoMessage()?.features?.selectiveAgentTimeline,
    );
    const sync = getHostRuntimeStore().createViewedTimelineOwner(serverId, {
      initialDeliveryMode,
      setSubscription: (agentIds) => client.setAgentTimelineSubscription(agentIds),
      readCursor: (agentId) => {
        const timeline = selectAgentTimelineState(
          useSessionStore.getState().sessions[serverId],
          agentId,
        );
        return timeline.status === "synced" && timeline.range
          ? { epoch: timeline.range.epoch, endSeq: timeline.range.endSeq }
          : undefined;
      },
      fetchPage: async (agentId, request) => {
        const session = useSessionStore.getState().sessions[serverId];
        const initKey = getInitKey(serverId, agentId);
        const shouldInitialize = selectAgentTimelineState(session, agentId).status !== "synced";
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
      fetchLatestTail: async (agentId) => {
        forcedTimelineTailReplacements.current.add(agentId);
        try {
          return await getHostRuntimeStore().fetchAgentTimeline(
            serverId,
            agentId,
            planTimelineTailFetch(),
          );
        } finally {
          forcedTimelineTailReplacements.current.delete(agentId);
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
    const owner = viewedTimelineSyncRef.current;
    if (!owner) throw new Error("Viewed timeline owner is unavailable");

    const unsubAgentStream = client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp, seq, epoch } = message.payload;
      const parsedTimestamp = new Date(timestamp);
      const streamEvent = event;
      const turnLiveness = deriveAgentStreamTurnLiveness([
        { event: streamEvent, seq, epoch, timestamp: parsedTimestamp },
      ]);
      if (turnLiveness.length > 0) {
        applyAgentTurnLiveness(serverId, agentId, turnLiveness);
      }
      owner.enqueueStreamEvent(agentId, {
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
      owner.flushStreamAgent(message.payload.agentId);
      applyTimelineResponse(message.payload);
    });

    const unsubTimelineReplacement = client.on("agent.timeline.replacement", (message) => {
      if (message.type !== "agent.timeline.replacement") return;
      void requestTimelineReplacement(
        {
          fetchAgentTimeline: (agentId, request) =>
            getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, request),
        },
        message.payload.agentId,
      ).catch((error: unknown) => {
        console.warn("[Session] timeline replacement refresh failed", { serverId, error });
      });
    });

    const unsubProviderSubagentUpdate = client.on("agent.provider_subagents.update", (message) => {
      if (message.type !== "agent.provider_subagents.update") return;
      useProviderSubagentStore.getState().applyUpdate(serverId, message.payload);
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

    const unsubVoiceCallTransport = client.on("voice.call.transport.server", (message) => {
      if (message.type !== "voice.call.transport.server" || !voiceRuntime) return;
      voiceRuntime.handleTransportMessage(serverId, message.payload.callId, message.payload.data);
    });

    const unsubVoiceCallState = client.on("voice.call.state", (message) => {
      if (message.type !== "voice.call.state") return;
      voiceRuntime?.handleCallState(serverId, message.payload);
    });

    const unsubVoiceCallEvent = client.on("voice.call.event", (message) => {
      if (message.type !== "voice.call.event") return;
      voiceRuntime?.handleCallEvent(serverId, message.payload.callId, message.payload.event);
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
      unsubTimelineReplacement();
      unsubAgentStream();
      unsubAgentTimeline();
      unsubProviderSubagentUpdate();
      unsubAgentAttention();
      unsubCheckoutStatusUpdate();
      unsubWorkspaceSetupProgress();
      unsubWorkspaceSetupStatusResponse();
      unsubStatus();
      unsubPermissionRequest();
      unsubPermissionResolved();
      unsubVoiceCallTransport();
      unsubVoiceCallState();
      unsubVoiceCallEvent();
      unsubTerminalAttention();
    };
  }, [
    client,
    queryClient,
    serverId,
    setIsPlayingAudio,
    setAgentStreamTail,
    setAgentStreamHead,
    applyAgentTurnLiveness,
    clearAgentStreamHead,
    setInitializingAgents,
    setAgents,
    setPendingPermissions,
    notifyAgentAttention,
    applyWorkspaceSetupProgress,
    applyTimelineResponse,
    updateSessionServerInfo,
    toast,
    voiceRuntime,
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

  return children;
}
