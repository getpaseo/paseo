export interface InAppNotificationData {
  serverId?: string;
  workspaceId?: string;
  agentId?: string;
  [key: string]: unknown;
}

export interface InAppNotificationItem {
  id: string;
  title: string;
  body?: string;
  data?: InAppNotificationData;
  durationMs?: number | null;
  createdAt: number;
}
