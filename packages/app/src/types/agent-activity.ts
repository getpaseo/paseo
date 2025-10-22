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
 * Group consecutive text chunks into messages
 */
export function groupTextChunks(activities: AgentActivity[]): Array<GroupedTextMessage | AgentActivity> {
  const result: Array<GroupedTextMessage | AgentActivity> = [];
  let currentGroup: {
    messageType: 'user' | 'agent' | 'thought';
    chunks: string[];
    startTimestamp: Date;
    endTimestamp: Date;
  } | null = null;

  for (const activity of activities) {
    const update = activity.update;

    // Check if this is a text chunk
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
      if (currentGroup && currentGroup.messageType === messageType) {
        currentGroup.chunks.push(text);
        currentGroup.endTimestamp = activity.timestamp;
      } else {
        // Flush current group if exists
        if (currentGroup) {
          result.push({
            kind: 'grouped_text',
            messageType: currentGroup.messageType,
            text: currentGroup.chunks.join(''),
            startTimestamp: currentGroup.startTimestamp,
            endTimestamp: currentGroup.endTimestamp,
          });
        }

        // Start new group
        currentGroup = {
          messageType,
          chunks: [text],
          startTimestamp: activity.timestamp,
          endTimestamp: activity.timestamp,
        };
      }
    } else {
      // Flush current group if exists
      if (currentGroup) {
        result.push({
          kind: 'grouped_text',
          messageType: currentGroup.messageType,
          text: currentGroup.chunks.join(''),
          startTimestamp: currentGroup.startTimestamp,
          endTimestamp: currentGroup.endTimestamp,
        });
        currentGroup = null;
      }

      // Add non-text activity as-is
      result.push(activity);
    }
  }

  // Flush final group if exists
  if (currentGroup) {
    result.push({
      kind: 'grouped_text',
      messageType: currentGroup.messageType,
      text: currentGroup.chunks.join(''),
      startTimestamp: currentGroup.startTimestamp,
      endTimestamp: currentGroup.endTimestamp,
    });
  }

  return result;
}
