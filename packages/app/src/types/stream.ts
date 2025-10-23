import type { AgentNotification } from '@server/server/acp/types';
import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * Simple hash function for deterministic ID generation
 * Uses a basic string hash algorithm for consistency across runs
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate a simple unique ID (timestamp + random)
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Derive deterministic ID for user message based on timestamp and content
 * If messageId is provided from server, use that instead
 */
function deriveUserMessageId(text: string, timestamp: Date, messageId?: string): string {
  if (messageId) {
    return messageId;
  }
  return `user_${timestamp.getTime()}_${simpleHash(text)}`;
}

/**
 * Derive deterministic ID for assistant message
 * Now uses stable messageId from server if available
 */
function deriveAssistantMessageId(messageId: string | undefined, timestamp: Date): string {
  if (messageId) {
    return `assistant_${messageId}`;
  }
  // Fallback for messages without messageId (shouldn't happen with enriched updates)
  return `assistant_${timestamp.getTime()}`;
}

/**
 * Derive deterministic ID for thought
 * Now uses stable messageId from server if available
 */
function deriveThoughtId(messageId: string | undefined, timestamp: Date): string {
  if (messageId) {
    return `thought_${messageId}`;
  }
  // Fallback for thoughts without messageId (shouldn't happen with enriched updates)
  return `thought_${timestamp.getTime()}`;
}

/**
 * Unified stream item types for both orchestrator and agent views
 */
export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | PlanItem
  | ActivityLogItem
  | ArtifactItem;

export interface UserMessageItem {
  kind: 'user_message';
  id: string;
  text: string;
  timestamp: Date;
}

export interface AssistantMessageItem {
  kind: 'assistant_message';
  id: string;
  text: string;
  timestamp: Date;
}

export interface ThoughtItem {
  kind: 'thought';
  id: string;
  text: string;
  timestamp: Date;
}

// Extract the actual ACP tool_call type from SDK
type ACPToolCall = Extract<SessionNotification['update'], { sessionUpdate: 'tool_call' }>;

// Orchestrator tool call data (from activity_log messages)
interface OrchestratorToolCallData {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  status: 'executing' | 'completed' | 'failed';
}

// Tagged union for tool call sources
export type ToolCallPayload =
  | { source: 'acp'; data: ACPToolCall }
  | { source: 'orchestrator'; data: OrchestratorToolCallData };

// Simplified ToolCallItem with payload
export interface ToolCallItem {
  kind: 'tool_call';
  id: string;
  timestamp: Date;
  payload: ToolCallPayload;
}

export interface PlanItem {
  kind: 'plan';
  id: string;
  entries: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority: 'high' | 'medium' | 'low';
  }>;
  timestamp: Date;
}

export interface ActivityLogItem {
  kind: 'activity_log';
  id: string;
  activityType: 'system' | 'transcript' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface ArtifactItem {
  kind: 'artifact';
  id: string;
  artifactId: string;
  artifactType: 'markdown' | 'diff' | 'image' | 'code';
  title: string;
  timestamp: Date;
}

// Extract ACP types for tool calls
type ACPToolCallUpdate = Extract<SessionNotification['update'], { sessionUpdate: 'tool_call_update' }>;

/**
 * Parsed notification types (internal representation before converting to StreamItem)
 */
type ParsedNotification =
  | { kind: 'user_message_chunk'; text: string; messageId?: string }
  | { kind: 'agent_message_chunk'; text: string; messageId?: string }
  | { kind: 'agent_thought_chunk'; text: string; messageId?: string }
  | { kind: 'tool_call'; data: ACPToolCall }
  | { kind: 'tool_call_update'; data: ACPToolCallUpdate }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { kind: 'current_mode_update'; currentModeId: string }
  | { kind: 'available_commands_update'; availableCommands: Array<{ name: string; description: string }> }
  | null;

/**
 * Parse AgentNotification into typed ParsedNotification
 * Only processes session notifications, ignoring permission and status notifications
 */
function parseNotification(notification: AgentNotification): ParsedNotification {
  // Only process session notifications (discriminated union)
  if (notification.type !== 'session') {
    return null;
  }

  const update = notification.notification.update;

  if (!update || !update.sessionUpdate) {
    return null;
  }

  const kind = update.sessionUpdate;

  switch (kind) {
    case 'user_message_chunk': {
      const content = update.content;
      const text = content && content.type === 'text' ? content.text : '';
      const messageId = 'messageId' in update ? update.messageId : undefined;
      return {
        kind: 'user_message_chunk',
        text,
        messageId,
      };
    }

    case 'agent_message_chunk': {
      const content = update.content;
      const text = content && content.type === 'text' ? content.text : '';
      const messageId = 'messageId' in update ? update.messageId : undefined;
      return {
        kind: 'agent_message_chunk',
        text,
        messageId,
      };
    }

    case 'agent_thought_chunk': {
      const content = update.content;
      const text = content && content.type === 'text' ? content.text : '';
      const messageId = 'messageId' in update ? update.messageId : undefined;
      return {
        kind: 'agent_thought_chunk',
        text,
        messageId,
      };
    }

    case 'tool_call': {
      return {
        kind: 'tool_call' as const,
        data: update as ACPToolCall,
      };
    }

    case 'tool_call_update': {
      return {
        kind: 'tool_call_update' as const,
        data: update as ACPToolCallUpdate,
      };
    }

    case 'plan':
      return {
        kind: 'plan',
        entries: update.entries,
      };

    case 'current_mode_update':
      return {
        kind: 'current_mode_update',
        currentModeId: update.currentModeId,
      };

    case 'available_commands_update':
      return {
        kind: 'available_commands_update',
        availableCommands: update.availableCommands,
      };

    default:
      return null;
  }
}

/**
 * Core reducer function that processes stream updates one at a time
 *
 * This function handles:
 * - Message chunks (accumulates text into single message)
 * - Tool call updates (finds and merges with existing)
 * - New items (appends to stream)
 *
 * Can be used for:
 * - Hydration: updates.reduce(reduceStreamUpdate, [])
 * - Real-time: setState(prev => reduceStreamUpdate(prev, update))
 */
export function reduceStreamUpdate(
  state: StreamItem[],
  notification: AgentNotification,
  timestamp: Date
): StreamItem[] {
  const parsed = parseNotification(notification);

  if (!parsed) {
    return state;
  }

  // User message chunks - always create new message (they're complete from server)
  if (parsed.kind === 'user_message_chunk') {
    const id = deriveUserMessageId(parsed.text, timestamp, parsed.messageId);

    // Idempotency check - if this exact message already exists, don't add it again
    if (state.some(item => item.id === id)) {
      return state;
    }

    return [...state, {
      kind: 'user_message',
      id,
      text: parsed.text,
      timestamp,
    }];
  }

  // Agent message chunks - accumulate into message with matching ID or create new
  if (parsed.kind === 'agent_message_chunk') {
    const id = deriveAssistantMessageId(parsed.messageId, timestamp);

    // Find existing message with this ID
    const existingIndex = state.findIndex(
      item => item.kind === 'assistant_message' && item.id === id
    );

    if (existingIndex >= 0) {
      // Append to existing message
      const existing = state[existingIndex] as AssistantMessageItem;
      return state.map((item, idx) =>
        idx === existingIndex
          ? { ...existing, text: existing.text + parsed.text }
          : item
      );
    }

    // Create new message with stable ID
    return [...state, {
      kind: 'assistant_message',
      id,
      text: parsed.text,
      timestamp,
    }];
  }

  // Thought chunks - accumulate into thought with matching ID or create new
  if (parsed.kind === 'agent_thought_chunk') {
    const id = deriveThoughtId(parsed.messageId, timestamp);

    // Find existing thought with this ID
    const existingIndex = state.findIndex(
      item => item.kind === 'thought' && item.id === id
    );

    if (existingIndex >= 0) {
      // Append to existing thought
      const existing = state[existingIndex] as ThoughtItem;
      return state.map((item, idx) =>
        idx === existingIndex
          ? { ...existing, text: existing.text + parsed.text }
          : item
      );
    }

    // Create new thought with stable ID
    return [...state, {
      kind: 'thought',
      id,
      text: parsed.text,
      timestamp,
    }];
  }

  // Tool call updates - find existing and merge
  if (parsed.kind === 'tool_call_update') {
    return state.map(item => {
      if (item.kind === 'tool_call' &&
          item.payload.source === 'acp' &&
          item.payload.data.toolCallId === parsed.data.toolCallId) {
        // Merge the update data with existing ACP data
        const updatedData = { ...item.payload.data };

        // Apply non-null updates from parsed.data
        Object.entries(parsed.data).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            (updatedData as any)[key] = value;
          }
        });

        return {
          ...item,
          payload: { source: 'acp' as const, data: updatedData },
          timestamp,
        };
      }
      return item;
    });
  }

  // New tool call - check if exists first (server may send multiple notifications for same tool)
  if (parsed.kind === 'tool_call') {
    const existingIndex = state.findIndex(
      item => item.kind === 'tool_call' &&
              item.payload.source === 'acp' &&
              item.payload.data.toolCallId === parsed.data.toolCallId
    );

    if (existingIndex >= 0) {
      // Update existing tool call
      return state.map((item, idx) => {
        if (idx === existingIndex && item.kind === 'tool_call') {
          return {
            ...item,
            payload: { source: 'acp' as const, data: parsed.data },
            timestamp,
          };
        }
        return item;
      });
    }

    // Create new tool call
    const newToolCall: ToolCallItem = {
      kind: 'tool_call',
      id: parsed.data.toolCallId,
      timestamp,
      payload: { source: 'acp', data: parsed.data },
    };

    return [...state, newToolCall];
  }

  // Plan - replace existing or create new (uses constant ID since only one plan exists)
  if (parsed.kind === 'plan') {
    const withoutPlan = state.filter(item => item.kind !== 'plan');
    return [...withoutPlan, {
      kind: 'plan',
      id: 'plan_latest',
      entries: parsed.entries as any,
      timestamp,
    }];
  }

  // Mode updates and other types don't create stream items
  // They're handled separately in state management
  return state;
}

/**
 * Hydrate stream state from batch of notifications
 */
export function hydrateStreamState(
  notifications: Array<{ timestamp: Date; notification: AgentNotification }>
): StreamItem[] {
  return notifications.reduce(
    (state, { notification, timestamp }) => reduceStreamUpdate(state, notification, timestamp),
    [] as StreamItem[]
  );
}
