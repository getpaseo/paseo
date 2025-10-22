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
 * Derive deterministic ID for assistant message based on index in state
 */
function deriveAssistantMessageId(state: StreamItem[]): string {
  const count = state.filter(s => s.kind === 'assistant_message').length;
  return `assistant_${count}`;
}

/**
 * Derive deterministic ID for thought based on index in state
 */
function deriveThoughtId(state: StreamItem[]): string {
  const count = state.filter(s => s.kind === 'thought').length;
  return `thought_${count}`;
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

export interface ToolCallItem {
  kind: 'tool_call';
  id: string;
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  toolKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: unknown[];
  locations?: unknown[];
  timestamp: Date;
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

/**
 * Parsed notification types (internal representation before converting to StreamItem)
 */
type ParsedNotification =
  | { kind: 'user_message_chunk'; text: string; messageId?: string }
  | { kind: 'agent_message_chunk'; text: string }
  | { kind: 'agent_thought_chunk'; text: string }
  | { kind: 'tool_call'; toolCallId: string; title: string; status?: string; toolKind?: string; rawInput?: any; rawOutput?: any; content?: any[]; locations?: any[] }
  | { kind: 'tool_call_update'; toolCallId: string; title?: string | null; status?: string | null; toolKind?: string | null; rawInput?: any; rawOutput?: any; content?: any[] | null; locations?: any[] | null }
  | { kind: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { kind: 'current_mode_update'; currentModeId: string }
  | { kind: 'available_commands_update'; availableCommands: Array<{ name: string; description: string }> }
  | null;

/**
 * Parse SessionNotification into typed ParsedNotification
 */
function parseNotification(notification: SessionNotification | any): ParsedNotification {
  const update = (notification as any).update;

  if (!update || !update.sessionUpdate) {
    return null;
  }

  const kind = update.sessionUpdate;

  switch (kind) {
    case 'user_message_chunk':
      return {
        kind: 'user_message_chunk',
        text: update.content?.text || '',
        messageId: update.messageId,
      };

    case 'agent_message_chunk':
      return {
        kind: 'agent_message_chunk',
        text: update.content?.text || '',
      };

    case 'agent_thought_chunk':
      return {
        kind: 'agent_thought_chunk',
        text: update.content?.text || '',
      };

    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        toolKind: update.kind,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        locations: update.locations,
      };

    case 'tool_call_update':
      return {
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        toolKind: update.kind,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        locations: update.locations,
      };

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
  notification: SessionNotification | any,
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

  // Agent message chunks - accumulate into last assistant message or create new
  if (parsed.kind === 'agent_message_chunk') {
    const last = state[state.length - 1];
    if (last?.kind === 'assistant_message') {
      // Append to existing message
      return [
        ...state.slice(0, -1),
        {
          ...last,
          text: last.text + parsed.text,
        },
      ];
    }
    // Create new message with deterministic ID
    const id = deriveAssistantMessageId(state);
    return [...state, {
      kind: 'assistant_message',
      id,
      text: parsed.text,
      timestamp,
    }];
  }

  // Thought chunks - accumulate into last thought or create new
  if (parsed.kind === 'agent_thought_chunk') {
    const last = state[state.length - 1];
    if (last?.kind === 'thought') {
      // Append to existing thought
      return [
        ...state.slice(0, -1),
        {
          ...last,
          text: last.text + parsed.text,
        },
      ];
    }
    // Create new thought with deterministic ID
    const id = deriveThoughtId(state);
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
      if (item.kind === 'tool_call' && item.toolCallId === parsed.toolCallId) {
        return {
          ...item,
          ...(parsed.title !== undefined && parsed.title !== null ? { title: parsed.title } : {}),
          ...(parsed.status !== undefined && parsed.status !== null ? { status: parsed.status as any } : {}),
          ...(parsed.toolKind !== undefined && parsed.toolKind !== null ? { toolKind: parsed.toolKind as any } : {}),
          ...(parsed.rawInput ? { rawInput: { ...item.rawInput, ...parsed.rawInput } } : {}),
          ...(parsed.rawOutput ? { rawOutput: { ...item.rawOutput, ...parsed.rawOutput } } : {}),
          ...(parsed.content !== undefined && parsed.content !== null ? { content: parsed.content } : {}),
          ...(parsed.locations !== undefined && parsed.locations !== null ? { locations: parsed.locations } : {}),
          timestamp,
        };
      }
      return item;
    });
  }

  // New tool call - check if exists first (server may send multiple notifications for same tool)
  if (parsed.kind === 'tool_call') {
    const existingIndex = state.findIndex(
      item => item.kind === 'tool_call' && item.toolCallId === parsed.toolCallId
    );

    if (existingIndex >= 0) {
      // Update existing tool call
      return state.map((item, idx) => {
        if (idx === existingIndex && item.kind === 'tool_call') {
          return {
            ...item,
            title: parsed.title,
            status: (parsed.status as any) || item.status,
            toolKind: (parsed.toolKind as any) || item.toolKind,
            rawInput: parsed.rawInput ? { ...item.rawInput, ...parsed.rawInput } : item.rawInput,
            rawOutput: parsed.rawOutput ? { ...item.rawOutput, ...parsed.rawOutput } : item.rawOutput,
            content: parsed.content || item.content,
            locations: parsed.locations || item.locations,
            timestamp,
          };
        }
        return item;
      });
    }

    // Create new tool call
    return [...state, {
      kind: 'tool_call',
      id: parsed.toolCallId,
      toolCallId: parsed.toolCallId,
      title: parsed.title,
      status: (parsed.status as any) || 'pending',
      toolKind: parsed.toolKind as any,
      rawInput: parsed.rawInput,
      rawOutput: parsed.rawOutput,
      content: parsed.content,
      locations: parsed.locations,
      timestamp,
    }];
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
  notifications: Array<{ timestamp: Date; notification: SessionNotification }>
): StreamItem[] {
  return notifications.reduce(
    (state, { notification, timestamp }) => reduceStreamUpdate(state, notification, timestamp),
    [] as StreamItem[]
  );
}
