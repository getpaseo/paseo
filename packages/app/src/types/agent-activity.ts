import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * Discriminated union types for session updates
 */
export type SessionUpdate =
  | UserMessageChunk
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate
  | Plan
  | AvailableCommandsUpdate
  | CurrentModeUpdate;

export interface UserMessageChunk {
  kind: 'user_message_chunk';
  content: {
    type: 'text';
    text: string;
  };
}

export interface AgentMessageChunk {
  kind: 'agent_message_chunk';
  content: {
    type: 'text';
    text: string;
  };
}

export interface AgentThoughtChunk {
  kind: 'agent_thought_chunk';
  content: {
    type: 'text';
    text: string;
  };
}

export interface ToolCall {
  kind: 'tool_call';
  toolCallId: string;
  title: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  toolKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: unknown[];
  locations?: unknown[];
}

export interface ToolCallUpdate {
  kind: 'tool_call_update';
  toolCallId: string;
  title?: string | null;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
  toolKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other' | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: unknown[] | null;
  locations?: unknown[] | null;
}

export interface Plan {
  kind: 'plan';
  entries: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority: 'high' | 'medium' | 'low';
  }>;
}

export interface AvailableCommandsUpdate {
  kind: 'available_commands_update';
  availableCommands: Array<{
    name: string;
    description: string;
  }>;
}

export interface CurrentModeUpdate {
  kind: 'current_mode_update';
  currentModeId: string;
}

/**
 * Activity item with timestamp
 */
export interface AgentActivity {
  timestamp: Date;
  update: SessionUpdate;
}

/**
 * Grouped text message (consecutive chunks combined)
 */
export interface GroupedTextMessage {
  kind: 'grouped_text';
  messageType: 'user' | 'agent' | 'thought';
  text: string;
  startTimestamp: Date;
  endTimestamp: Date;
}

/**
 * Merged tool call (initial call + all updates combined)
 */
export interface MergedToolCall {
  kind: 'merged_tool_call';
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  toolKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: unknown[];
  locations?: unknown[];
  startTimestamp: Date;
  endTimestamp: Date;
}

/**
 * Parse SessionNotification into typed SessionUpdate
 */
export function parseSessionUpdate(notification: SessionNotification): SessionUpdate | null {
  const update = (notification as any).update;

  if (!update || !update.sessionUpdate) {
    return null;
  }

  const kind = update.sessionUpdate;

  switch (kind) {
    case 'user_message_chunk':
      return {
        kind: 'user_message_chunk',
        content: update.content,
      };

    case 'agent_message_chunk':
      return {
        kind: 'agent_message_chunk',
        content: update.content,
      };

    case 'agent_thought_chunk':
      return {
        kind: 'agent_thought_chunk',
        content: update.content,
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

    case 'available_commands_update':
      return {
        kind: 'available_commands_update',
        availableCommands: update.availableCommands,
      };

    case 'current_mode_update':
      return {
        kind: 'current_mode_update',
        currentModeId: update.currentModeId,
      };

    default:
      return null;
  }
}

/**
 * Group consecutive text chunks into messages and merge tool calls by ID
 */
export function groupActivities(activities: AgentActivity[]): Array<GroupedTextMessage | MergedToolCall | AgentActivity> {
  const result: Array<GroupedTextMessage | MergedToolCall | AgentActivity> = [];

  // Track current text group
  let currentTextGroup: {
    messageType: 'user' | 'agent' | 'thought';
    chunks: string[];
    startTimestamp: Date;
    endTimestamp: Date;
  } | null = null;

  // Track tool calls by ID
  const toolCallsById = new Map<string, {
    toolCallId: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    toolKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
    rawInput?: Record<string, unknown>;
    rawOutput?: Record<string, unknown>;
    content?: unknown[];
    locations?: unknown[];
    startTimestamp: Date;
    endTimestamp: Date;
    insertIndex: number; // Track where to insert in result
  }>();

  function flushTextGroup() {
    if (currentTextGroup) {
      result.push({
        kind: 'grouped_text',
        messageType: currentTextGroup.messageType,
        text: currentTextGroup.chunks.join(''),
        startTimestamp: currentTextGroup.startTimestamp,
        endTimestamp: currentTextGroup.endTimestamp,
      });
      currentTextGroup = null;
    }
  }

  for (const activity of activities) {
    const update = activity.update;

    // Handle text chunks
    if (
      update.kind === 'user_message_chunk' ||
      update.kind === 'agent_message_chunk' ||
      update.kind === 'agent_thought_chunk'
    ) {
      const messageType =
        update.kind === 'user_message_chunk' ? 'user' :
        update.kind === 'agent_message_chunk' ? 'agent' :
        'thought';

      const text = update.content.text;

      // If we have a current group of the same type, add to it
      if (currentTextGroup && currentTextGroup.messageType === messageType) {
        currentTextGroup.chunks.push(text);
        currentTextGroup.endTimestamp = activity.timestamp;
      } else {
        flushTextGroup();

        // Start new group
        currentTextGroup = {
          messageType,
          chunks: [text],
          startTimestamp: activity.timestamp,
          endTimestamp: activity.timestamp,
        };
      }
    }
    // Handle tool calls and updates
    else if (update.kind === 'tool_call' || update.kind === 'tool_call_update') {
      flushTextGroup();

      const toolCallId = update.toolCallId;
      const existing = toolCallsById.get(toolCallId);

      if (update.kind === 'tool_call') {
        // Initial tool call
        if (!existing) {
          // Create new entry and placeholder in result
          const insertIndex = result.length;
          result.push(null as any); // Placeholder

          toolCallsById.set(toolCallId, {
            toolCallId,
            title: update.title,
            status: update.status || 'pending',
            toolKind: update.toolKind,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
            locations: update.locations,
            startTimestamp: activity.timestamp,
            endTimestamp: activity.timestamp,
            insertIndex,
          });
        } else {
          // Update existing
          existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.toolKind) existing.toolKind = update.toolKind;
          if (update.rawInput) existing.rawInput = update.rawInput;
          if (update.rawOutput) existing.rawOutput = update.rawOutput;
          if (update.content) existing.content = update.content;
          if (update.locations) existing.locations = update.locations;
          existing.endTimestamp = activity.timestamp;
        }
      } else {
        // Tool call update
        if (existing) {
          // Merge update into existing
          if (update.title) existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.toolKind) existing.toolKind = update.toolKind;
          if (update.rawInput) existing.rawInput = { ...existing.rawInput, ...update.rawInput };
          if (update.rawOutput) existing.rawOutput = { ...existing.rawOutput, ...update.rawOutput };
          if (update.content) existing.content = update.content;
          if (update.locations) existing.locations = update.locations;
          existing.endTimestamp = activity.timestamp;
        } else {
          // Update without initial call - create entry
          const insertIndex = result.length;
          result.push(null as any); // Placeholder

          toolCallsById.set(toolCallId, {
            toolCallId,
            title: update.title || 'Tool Call',
            status: update.status || 'pending',
            toolKind: update.toolKind || undefined,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content || undefined,
            locations: update.locations || undefined,
            startTimestamp: activity.timestamp,
            endTimestamp: activity.timestamp,
            insertIndex,
          });
        }
      }
    }
    // Handle other activities
    else {
      flushTextGroup();
      result.push(activity);
    }
  }

  // Flush final text group
  flushTextGroup();

  // Replace placeholders with merged tool calls
  for (const toolCall of toolCallsById.values()) {
    result[toolCall.insertIndex] = {
      kind: 'merged_tool_call',
      toolCallId: toolCall.toolCallId,
      title: toolCall.title,
      status: toolCall.status,
      toolKind: toolCall.toolKind,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      content: toolCall.content,
      locations: toolCall.locations,
      startTimestamp: toolCall.startTimestamp,
      endTimestamp: toolCall.endTimestamp,
    };
  }

  return result;
}
