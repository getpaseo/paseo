/**
 * Stream item types — ported from packages/app/src/types/stream.ts.
 *
 * These represent the normalized timeline items rendered in the message list.
 * Phase 1 includes only the item kinds used in real-time message display.
 * Tool call details and provider-specific fields are kept as opaque records.
 */

// ---------------------------------------------------------------------------
// StreamItem discriminated union
// ---------------------------------------------------------------------------

export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | ActivityLogItem;

export interface UserMessageItem {
  kind: 'user_message';
  id: string;
  text: string;
  timestamp: number; // epoch ms
  optimistic?: boolean;
}

export interface AssistantMessageItem {
  kind: 'assistant_message';
  id: string;
  text: string;
  timestamp: number;
}

export type ThoughtStatus = 'loading' | 'ready';

export interface ThoughtItem {
  kind: 'thought';
  id: string;
  text: string;
  timestamp: number;
  status: ThoughtStatus;
}

export type AgentToolCallStatus = 'running' | 'completed' | 'failed' | 'canceled';

export interface AgentToolCallData {
  provider: string;
  callId: string;
  name: string;
  status: AgentToolCallStatus;
  detail: ESObject;
}

export interface ToolCallItem {
  kind: 'tool_call';
  id: string;
  timestamp: number;
  callId: string;
  provider: string;
  name: string;
  status: AgentToolCallStatus;
  detail: ESObject;
}

export type ActivityLogType = 'system' | 'info' | 'success' | 'error';

export interface ActivityLogItem {
  kind: 'activity_log';
  id: string;
  timestamp: number;
  activityType: ActivityLogType;
  message: string;
}

// ---------------------------------------------------------------------------
// Timeline event (what the daemon sends)
// ---------------------------------------------------------------------------

export interface TimelineEventItem {
  type: 'user_message' | 'assistant_message' | 'reasoning' | 'tool_call' | 'error' | 'turn';
  text?: string;
  messageId?: string;
  status?: string;
  callId?: string;
  name?: string;
  detail?: ESObject;
  message?: string;
}

export interface TimelineEvent {
  provider: string;
  item: TimelineEventItem;
}

// ---------------------------------------------------------------------------
// Cursor types
// ---------------------------------------------------------------------------

export interface TimelineCursor {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

// ---------------------------------------------------------------------------
// Helper: generate unique IDs
// ---------------------------------------------------------------------------

let idCounter = 0;

export function generateStreamId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}
