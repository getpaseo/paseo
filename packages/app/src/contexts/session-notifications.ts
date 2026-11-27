import {
  buildAgentAttentionNotificationPayload,
  type AgentAttentionNotificationPayload,
  type AgentAttentionReason,
  type NotificationPermissionRequest,
} from "@getpaseo/protocol/agent-attention-notification";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  normalizeNotificationPreferences,
  shouldDeliverNotification,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { QueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, type AppSettings } from "@/hooks/use-settings/storage";
import type { SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";

type TerminalAttentionPayload = Extract<
  SessionOutboundMessage,
  { type: "terminal_attention_required" }
>["payload"];

type PluginNotificationPayload = Extract<
  SessionOutboundMessage,
  { type: "plugin.notification" }
>["payload"];

export type OsNotificationSender = (payload: {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}) => Promise<boolean>;

export function getCurrentNotificationPreferences(
  queryClient: Pick<QueryClient, "getQueryData">,
): NotificationPreferences {
  return normalizeNotificationPreferences(
    queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.notifications,
  );
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

export function resolveAgentAttentionNotification(
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

export function deliverAgentAttentionOsNotification(input: {
  serverId: string;
  params: {
    agentId: string;
    reason: "finished" | "error" | "permission";
    timestamp: string;
    notification?: AgentAttentionNotificationPayload;
  };
  appState?: string;
  isActivelyVisible?: boolean;
  session: SessionState | undefined;
  attentionNotified: Map<string, number>;
  preferences: NotificationPreferences;
  sendNotification: OsNotificationSender;
}): boolean {
  const attentionFocusedAgentId = input.session?.focusedAgentId ?? null;
  const isActivelyVisible =
    input.isActivelyVisible ?? getIsAppActivelyVisible(input.appState ?? "active");
  const isAwayFromAgent = !isActivelyVisible || attentionFocusedAgentId !== input.params.agentId;
  if (!isAwayFromAgent) {
    return false;
  }

  if (
    !shouldDeliverNotification(input.preferences, {
      kind: "agent",
      reason: input.params.reason,
    })
  ) {
    return false;
  }

  const timestampMs = new Date(input.params.timestamp).getTime();
  const lastNotified = input.attentionNotified.get(input.params.agentId);
  if (lastNotified && lastNotified >= timestampMs) {
    return false;
  }
  input.attentionNotified.set(input.params.agentId, timestampMs);

  const head = input.session?.agentStreamHead.get(input.params.agentId) ?? [];
  const tail = input.session?.agentStreamTail.get(input.params.agentId) ?? [];
  const assistantMessage =
    findLatestAssistantMessageText(head) ?? findLatestAssistantMessageText(tail);
  const permissionRequest = getLatestPermissionRequest(input.session, input.params.agentId);
  const workspaceId = input.session?.agents?.get(input.params.agentId)?.workspaceId;

  const notification = resolveAgentAttentionNotification({
    notification: input.params.notification,
    reason: input.params.reason,
    serverId: input.serverId,
    workspaceId,
    agentId: input.params.agentId,
    assistantMessage,
    permissionRequest,
  });
  if (!notification) {
    return false;
  }

  void input.sendNotification({
    title: notification.title,
    body: notification.body,
    data: notification.data,
  });
  return true;
}

export function deliverTerminalAttentionOsNotification(input: {
  serverId: string;
  payload: TerminalAttentionPayload;
  preferences: NotificationPreferences;
  sendNotification: OsNotificationSender;
}): boolean {
  if (!input.payload.shouldNotify) {
    return false;
  }
  if (
    !shouldDeliverNotification(input.preferences, {
      kind: "terminal",
      reason: input.payload.reason,
    })
  ) {
    return false;
  }
  void input.sendNotification({
    title: input.payload.title,
    body: input.payload.body,
    data: {
      serverId: input.payload.serverId ?? input.serverId,
      terminalId: input.payload.terminalId,
      cwd: input.payload.cwd,
      ...(input.payload.workspaceId ? { workspaceId: input.payload.workspaceId } : {}),
    },
  });
  return true;
}

export function deliverPluginOsNotification(input: {
  serverId: string;
  payload: PluginNotificationPayload;
  preferences: NotificationPreferences;
  sendNotification: OsNotificationSender;
}): boolean {
  if (!input.payload.shouldNotify) {
    return false;
  }
  if (
    !shouldDeliverNotification(input.preferences, {
      kind: "plugin",
      pluginId: input.payload.pluginId,
    })
  ) {
    return false;
  }
  void input.sendNotification({
    title: input.payload.title,
    body: input.payload.body,
    data: {
      kind: "plugin",
      serverId: input.payload.serverId ?? input.serverId,
      pluginId: input.payload.pluginId,
      notificationId: input.payload.notificationId,
      ...(input.payload.open ? { open: input.payload.open } : {}),
      ...(input.payload.data ? { data: input.payload.data } : {}),
    },
  });
  return true;
}
