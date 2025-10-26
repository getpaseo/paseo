import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { ToolCallPayload } from './stream';

/**
 * Generic tool call selection for bottom sheet
 * Reuses ToolCallPayload so we don't duplicate shapes
 */
export interface SelectedToolCall {
  payload: ToolCallPayload;
}

/**
 * Pending permission structure
 * Uses actual ACP types instead of any
 */
export interface PendingPermission {
  agentId: string;
  requestId: string;
  sessionId: string;
  toolCall: RequestPermissionRequest['toolCall'];
  options: RequestPermissionRequest['options'];
}

// Agent info interface is provided by SessionContext's Agent type
